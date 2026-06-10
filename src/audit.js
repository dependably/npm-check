// src/audit.js
import { forEachPackageEntry } from './format-library.js';
import { validatePackageLock } from './validator.js';
import { isPlaceholder } from './integrity.js';
import { classifyRange } from './pinner.js';
import { mergeConfig } from './audit-config.js';

export class AuditError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.context = context;
  }
}

// Rule contract: { id, description, defaultSeverity, check(context) => findings[] }
// context = { lockfile, packageJson|null, options, filePath }
// findings = [{ packagePath, message, data? }] — the engine stamps ruleId + severity.

const lockfileVersionRule = {
  id: 'lockfile-version',
  description: 'Require a modern lockfile format version',
  defaultSeverity: 'error',
  check({ lockfile, options }) {
    const minVersion = options.minVersion || 3;
    const actual = lockfile.lockfileVersion;
    if (typeof actual !== 'number' || actual < minVersion) {
      return [{
        packagePath: '',
        message: `lockfileVersion is ${actual === undefined ? 'missing' : actual}, minimum required is ${minVersion} (run \`npfix migrate ${minVersion}\`)`
      }];
    }
    return [];
  }
};

const validStructureRule = {
  id: 'valid-structure',
  description: 'Lockfile must pass structural validation',
  defaultSeverity: 'error',
  check({ lockfile }) {
    const result = validatePackageLock(lockfile);
    const findings = result.errors.map((err) => ({
      packagePath: '',
      message: err.message,
      data: { code: err.code }
    }));
    const warnFindings = result.warnings.map((warn) => ({
      packagePath: '',
      message: typeof warn === 'string' ? warn : warn.message,
      data: { forcedSeverity: 'warn' }
    }));
    return [...findings, ...warnFindings];
  }
};

const integrityHygieneRule = {
  id: 'integrity-hygiene',
  description: 'Integrity hashes must be present, real, and strong (sha512)',
  defaultSeverity: 'error',
  check({ lockfile, options }) {
    const allowSha1 = Boolean(options.allowSha1);
    const findings = [];
    if (!lockfile.packages) return findings;

    forEachPackageEntry(lockfile, ({ key, entry, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep }) => {
      if (isRoot || isWorkspaceSource || isLink || isBundled) return;

      const integrity = entry.integrity;
      if (!integrity) {
        if (isGitDep || isFileDep) return; // legitimately absent
        findings.push({ packagePath: key, message: 'missing integrity hash (run `npfix fix-checksums`)' });
        return;
      }
      if (isPlaceholder(integrity)) {
        findings.push({ packagePath: key, message: 'placeholder integrity hash (run `npfix fix-checksums`)' });
        return;
      }
      if (!allowSha1 && integrity.startsWith('sha1-')) {
        findings.push({ packagePath: key, message: 'integrity uses deprecated sha1 (run `npfix fix-checksums`)' });
      }
    });
    return findings;
  }
};

const secureResolvedRule = {
  id: 'secure-resolved',
  description: 'Resolved URLs must use TLS and trusted registries',
  defaultSeverity: 'error',
  check({ lockfile, options }) {
    const {
      allowedHosts = ['registry.npmjs.org'],
      allowHttp = false,
      allowGit = true,
      allowFile = true
    } = options;
    const findings = [];
    if (!lockfile.packages) return findings;

    forEachPackageEntry(lockfile, ({ key, entry, isRoot, isWorkspaceSource, isLink, isGitDep, isFileDep }) => {
      if (isRoot || isWorkspaceSource || isLink) return;
      const resolved = entry.resolved;
      if (!resolved) return;

      if (isGitDep) {
        if (!allowGit) {
          findings.push({ packagePath: key, message: `git dependency not allowed: ${resolved}` });
        }
        return;
      }
      if (isFileDep) {
        if (!allowFile) {
          findings.push({ packagePath: key, message: `file dependency not allowed: ${resolved}` });
        }
        return;
      }

      let url;
      try {
        url = new URL(resolved);
      } catch (e) {
        findings.push({ packagePath: key, message: `unparseable resolved URL: ${resolved}` });
        return;
      }

      if (url.protocol === 'http:' && !allowHttp) {
        findings.push({ packagePath: key, message: `insecure (non-TLS) resolved URL: ${resolved}` });
        return;
      }
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !allowedHosts.includes(url.hostname)) {
        findings.push({ packagePath: key, message: `resolved from untrusted registry host "${url.hostname}" (allowed: ${allowedHosts.join(', ')})` });
      }
    });
    return findings;
  }
};

const pinnedVersionsRule = {
  id: 'pinned-versions',
  description: 'package.json dependency ranges must be exact versions',
  defaultSeverity: 'warn',
  check({ lockfile, packageJson, options }) {
    if (!packageJson) {
      return [{
        packagePath: 'package.json',
        message: 'package.json not found next to lockfile; pinned-versions rule skipped',
        data: { forcedSeverity: 'warn' }
      }];
    }

    const {
      sections = ['dependencies', 'devDependencies', 'optionalDependencies'],
      ignore = []
    } = options;
    const findings = [];

    for (const section of sections) {
      const deps = packageJson[section];
      if (!deps || typeof deps !== 'object') continue;

      for (const [name, range] of Object.entries(deps)) {
        if (ignore.includes(name)) continue;
        const kind = classifyRange(range);
        if (kind !== 'caret' && kind !== 'tilde') continue;

        const entry = lockfile.packages && lockfile.packages[`node_modules/${name}`];
        const resolvedNote = entry && entry.version ? ` (resolved: ${entry.version})` : '';
        findings.push({
          packagePath: `package.json#${section}/${name}`,
          message: `range "${range}" is not pinned${resolvedNote} (run \`npfix pin\`)`
        });
      }
    }
    return findings;
  }
};

export const rules = [
  lockfileVersionRule,
  validStructureRule,
  integrityHygieneRule,
  secureResolvedRule,
  pinnedVersionsRule
];

/**
 * Run all configured audit rules against a lockfile (and optional package.json).
 *
 * @param {object} target - { lockfile, packageJson|null, filePath }
 * @param {object} config - Resolved config from loadAuditConfig/mergeConfig,
 *                          or a raw user config object (will be merged over defaults)
 * @returns {{findings, summary, pass}}
 */
export function runAudit(target, config = {}) {
  const { lockfile, packageJson = null, filePath = 'package-lock.json' } = target;
  if (!lockfile || typeof lockfile !== 'object') {
    throw new AuditError('lockfile data is required', 'MISSING_LOCKFILE');
  }

  const resolved = config.rules && config.rules[rules[0].id] && config.rules[rules[0].id].severity
    ? config // already normalized
    : mergeConfig(config);

  const findings = [];
  for (const rule of rules) {
    const ruleConfig = resolved.rules[rule.id];
    if (!ruleConfig || ruleConfig.severity === 'off') continue;

    const raw = rule.check({ lockfile, packageJson, options: ruleConfig.options || {}, filePath });
    for (const finding of raw) {
      const severity = (finding.data && finding.data.forcedSeverity) || ruleConfig.severity;
      findings.push({
        ruleId: rule.id,
        severity,
        packagePath: finding.packagePath,
        message: finding.message
      });
    }
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;

  const byRule = {};
  for (const finding of findings) {
    byRule[finding.ruleId] = byRule[finding.ruleId] || { errors: 0, warnings: 0 };
    byRule[finding.ruleId][finding.severity === 'error' ? 'errors' : 'warnings']++;
  }

  const maxWarnings = resolved.maxWarnings !== undefined ? resolved.maxWarnings : -1;
  const pass = errors === 0 && (maxWarnings < 0 || warnings <= maxWarnings);

  return {
    findings,
    summary: { errors, warnings, total: findings.length, byRule },
    pass,
    filePath
  };
}

/**
 * Format an audit report for display.
 * @param {object} report - Result of runAudit()
 * @param {object} options - { format: 'stylish' | 'json' }
 * @returns {string}
 */
export function formatAuditReport(report, options = {}) {
  const { format = 'stylish' } = options;

  if (format === 'json') {
    return JSON.stringify({
      filePath: report.filePath,
      pass: report.pass,
      summary: report.summary,
      findings: report.findings
    }, null, 2);
  }

  if (format !== 'stylish') {
    throw new AuditError(`Unknown report format: ${format}`, 'UNKNOWN_FORMAT');
  }

  const lines = [];
  lines.push(report.filePath);

  if (report.findings.length === 0) {
    lines.push('  ✔ no problems found');
    return lines.join('\n');
  }

  const ruleWidth = Math.max(...report.findings.map((f) => f.ruleId.length));
  for (const finding of report.findings) {
    const sev = finding.severity === 'error' ? 'error' : 'warn ';
    const loc = finding.packagePath ? `${finding.packagePath}   ` : '';
    lines.push(`  ${sev}  ${finding.ruleId.padEnd(ruleWidth)}  ${loc}${finding.message}`);
  }

  const { errors, warnings, total } = report.summary;
  const problemWord = total === 1 ? 'problem' : 'problems';
  lines.push('');
  lines.push(`✖ ${total} ${problemWord} (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})`);
  return lines.join('\n');
}
