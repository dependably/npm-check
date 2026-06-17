// src/audit.js
import path from 'path';
import { forEachPackageEntry } from './format-library.js';
import { validatePackageLock } from './validator.js';
import { isPlaceholder } from './integrity.js';
import { classifyRange } from './pinner.js';
import { findOrphanedPackages } from './pruner.js';
import { findUnusedDependencies } from './usage-scanner.js';
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
        message: `lockfileVersion is ${actual === undefined ? 'missing' : actual}, minimum required is ${minVersion} (run \`npm-check migrate ${minVersion}\`)`
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
        findings.push({ packagePath: key, message: 'missing integrity hash (run `npm-check fix-checksums`)' });
        return;
      }
      if (isPlaceholder(integrity)) {
        findings.push({ packagePath: key, message: 'placeholder integrity hash (run `npm-check fix-checksums`)' });
        return;
      }
      if (!allowSha1 && integrity.startsWith('sha1-')) {
        findings.push({ packagePath: key, message: 'integrity uses deprecated sha1 (run `npm-check fix-checksums`)' });
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

/**
 * Classify every package that declares a lifecycle install script as allowed
 * or blocked, reconciling against both this rule's `allow` list and npm v12's
 * native package.json `allowScripts` map (keys are `name@version` pinned or
 * bare `name`; values true=approved / false=denied). Under npm v12 a script
 * only runs when explicitly approved, so anything not approved is "blocked".
 *
 * @returns {{ total, allowed: object[], blocked: object[], v12Aware: boolean }}
 */
export function classifyInstallScripts(lockfile, packageJson, options = {}) {
  const { allow = [] } = options;
  const allowScripts = packageJson && packageJson.allowScripts;
  const v12Aware = Boolean(allowScripts && typeof allowScripts === 'object');
  const allowed = [];
  const blocked = [];
  if (!lockfile.packages) return { total: 0, allowed, blocked, v12Aware };

  forEachPackageEntry(lockfile, ({ key, entry, name, isRoot, isWorkspaceSource, isLink }) => {
    if (isRoot || isWorkspaceSource || isLink) return;
    if (!entry || entry.hasInstallScript !== true) return;

    let approval = 'pending'; // pending | allowed | denied
    if (v12Aware && name) {
      const pinned = `${name}@${entry.version}`;
      if (pinned in allowScripts) approval = allowScripts[pinned] ? 'allowed' : 'denied';
      else if (name in allowScripts) approval = allowScripts[name] ? 'allowed' : 'denied';
    }
    const viaRuleAllow = Boolean(name && allow.includes(name));
    const rec = { key, name, version: entry.version, approval, viaRuleAllow };
    if (viaRuleAllow || approval === 'allowed') allowed.push(rec);
    else blocked.push(rec);
  });

  return { total: allowed.length + blocked.length, allowed, blocked, v12Aware };
}

const installScriptsRule = {
  id: 'install-scripts',
  description: 'Packages with lifecycle install scripts must be reviewed and allowlisted',
  defaultSeverity: 'warn',
  check({ lockfile, packageJson, options }) {
    const { blocked, v12Aware } = classifyInstallScripts(lockfile, packageJson, options);
    return blocked.map(({ key, name, approval }) => ({
      packagePath: key,
      message: approval === 'denied'
        ? `${name || key} runs an install script but is denied in package.json "allowScripts" — npm v12 will not run it`
        : v12Aware
          ? `${name || key} runs an install script not yet approved in package.json "allowScripts" — npm v12 will not run it (\`npm approve-scripts\`)`
          : `${name || key} runs a lifecycle install script (preinstall/install/postinstall) — review and add to this rule's "allow" list if trusted, or install with \`--ignore-scripts\``
    }));
  }
};

const noGitDepsRule = {
  id: 'no-git-deps',
  description: 'Git dependencies require --allow-git under npm v12',
  defaultSeverity: 'warn',
  check({ lockfile }) {
    const findings = [];
    if (!lockfile.packages) return findings;
    forEachPackageEntry(lockfile, ({ key, name, isRoot, isWorkspaceSource, isLink, isGitDep }) => {
      if (isRoot || isWorkspaceSource || isLink || !isGitDep) return;
      findings.push({
        packagePath: key,
        message: `${name || key} is a git dependency — npm v12 will not install it without \`--allow-git\``
      });
    });
    return findings;
  }
};

const noRemoteDepsRule = {
  id: 'no-remote-deps',
  description: 'Remote-URL (non-registry) dependencies require --allow-remote under npm v12',
  defaultSeverity: 'warn',
  check({ lockfile }) {
    const findings = [];
    if (!lockfile.packages) return findings;
    forEachPackageEntry(lockfile, ({ key, entry, name, isRoot, isWorkspaceSource, isLink, isGitDep, isFileDep }) => {
      if (isRoot || isWorkspaceSource || isLink || isGitDep || isFileDep) return;
      const resolved = entry && entry.resolved;
      if (!resolved || !/^https?:/i.test(resolved)) return;
      // Registry tarballs carry the `/-/` path marker; a direct remote URL tarball does not.
      if (resolved.includes('/-/')) return;
      findings.push({
        packagePath: key,
        message: `${name || key} resolves from a remote URL (${resolved}) — npm v12 will not install it without \`--allow-remote\``
      });
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
          message: `range "${range}" is not pinned${resolvedNote} (run \`npm-check pin\`)`
        });
      }
    }
    return findings;
  }
};

const SYNC_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

const lockfileSyncRule = {
  id: 'lockfile-sync',
  description: 'package.json and the lockfile must agree',
  defaultSeverity: 'error',
  check({ lockfile, packageJson }) {
    if (!packageJson) {
      return [{
        packagePath: 'package.json',
        message: 'package.json not found next to lockfile; lockfile-sync rule skipped',
        data: { forcedSeverity: 'warn' }
      }];
    }

    const findings = [];

    if (packageJson.name && lockfile.name && packageJson.name !== lockfile.name) {
      findings.push({ packagePath: '', message: `name mismatch: package.json says "${packageJson.name}", lockfile says "${lockfile.name}"` });
    }
    if (packageJson.version && lockfile.version && packageJson.version !== lockfile.version) {
      findings.push({ packagePath: '', message: `version mismatch: package.json says "${packageJson.version}", lockfile says "${lockfile.version}" (run \`npm install\`)` });
    }

    const root = lockfile.packages && lockfile.packages[''];
    if (!root) return findings;

    for (const section of SYNC_SECTIONS) {
      const declared = packageJson[section] || {};
      const locked = root[section] || {};

      for (const [name, range] of Object.entries(declared)) {
        if (locked[name] === undefined) {
          findings.push({
            packagePath: `package.json#${section}/${name}`,
            message: `declared in package.json but missing from the lockfile root entry (run \`npm install\`)`
          });
        } else if (locked[name] !== range) {
          findings.push({
            packagePath: `package.json#${section}/${name}`,
            message: `range mismatch: package.json has "${range}", lockfile root has "${locked[name]}" (run \`npm install\`)`
          });
        }
        // peers aren't necessarily installed as their own entries
        if (section !== 'peerDependencies' && lockfile.packages[`node_modules/${name}`] === undefined) {
          findings.push({
            packagePath: `package.json#${section}/${name}`,
            message: `declared in package.json but not installed in the lockfile packages map (run \`npm install\`)`
          });
        }
      }

      for (const name of Object.keys(locked)) {
        if (declared[name] === undefined) {
          findings.push({
            packagePath: `package-lock.json#${section}/${name}`,
            message: `present in the lockfile root entry but not declared in package.json (run \`npm install\`)`
          });
        }
      }
    }

    return findings;
  }
};

const noOrphanPackagesRule = {
  id: 'no-orphan-packages',
  description: 'Lockfile must not contain packages unreachable from the dependency graph',
  defaultSeverity: 'warn',
  check({ lockfile }) {
    if (!lockfile.packages) return [];
    let orphans;
    try {
      orphans = findOrphanedPackages(lockfile).orphans;
    } catch (e) {
      // v1 lockfiles: lockfile-version rule already covers this
      return [];
    }
    return orphans.map((orphan) => ({
      packagePath: orphan.key,
      message: `orphaned package${orphan.version ? ` (${orphan.name}@${orphan.version})` : ''} unreachable from the dependency graph (run \`npm-check prune\`)`
    }));
  }
};

const unusedDependenciesRule = {
  id: 'unused-dependencies',
  description: 'Dependencies declared in package.json should be imported by the application',
  defaultSeverity: 'warn',
  check({ packageJson, options, filePath }) {
    if (!packageJson) {
      return [{
        packagePath: 'package.json',
        message: 'package.json not found next to lockfile; unused-dependencies rule skipped',
        data: { forcedSeverity: 'warn' }
      }];
    }

    const dir = path.dirname(path.resolve(filePath));
    let result;
    try {
      result = findUnusedDependencies(packageJson, dir, {
        includeDev: Boolean(options.includeDev),
        ignore: options.ignore || []
      });
    } catch (e) {
      return [{
        packagePath: 'package.json',
        message: `unused-dependencies rule skipped: ${e.message}`,
        data: { forcedSeverity: 'warn' }
      }];
    }

    return result.unused.map((dep) => ({
      packagePath: `package.json#${dep.section}/${dep.name}`,
      message: `"${dep.name}" is never imported by the application — flagged for removal (heuristic; add to the rule's ignore list if loaded indirectly)`
    }));
  }
};

export const rules = [
  lockfileVersionRule,
  validStructureRule,
  integrityHygieneRule,
  secureResolvedRule,
  installScriptsRule,
  noGitDepsRule,
  noRemoteDepsRule,
  pinnedVersionsRule,
  lockfileSyncRule,
  noOrphanPackagesRule,
  unusedDependenciesRule
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
