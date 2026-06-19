// src/audit.js
import fs from 'fs';
import path from 'path';
import { forEachPackageEntry } from './format-library.js';
import { validatePackageLock } from './validator.js';
import { validatePackageJson } from './package-json-validator.js';
import { validateNpmrc, NPMRC_SECURITY_CODES } from './npmrc-validator.js';
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

const validPackageJsonRule = {
  id: 'valid-package-json',
  description: 'package.json must pass schema/field validation',
  defaultSeverity: 'error',
  check({ packageJson, options }) {
    if (!packageJson) {
      return [{
        packagePath: 'package.json',
        message: 'package.json not found next to lockfile; valid-package-json rule skipped',
        data: { forcedSeverity: 'warn' }
      }];
    }
    const result = validatePackageJson(packageJson, options);
    const findings = result.errors.map((err) => ({
      packagePath: 'package.json',
      message: err.message,
      data: { code: err.code }
    }));
    const warnFindings = result.warnings.map((warn) => ({
      packagePath: 'package.json',
      message: typeof warn === 'string' ? warn : warn.message,
      data: { forcedSeverity: 'warn', code: typeof warn === 'string' ? undefined : warn.code }
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

// Validate a single non-registry resolved URL (git/file), returning a finding
// message when the dependency type is disallowed, otherwise null.
function checkSpecialResolved(resolved, { isGitDep, isFileDep, allowGit, allowFile }) {
  if (isGitDep) {
    return allowGit ? null : `git dependency not allowed: ${resolved}`;
  }
  if (isFileDep) {
    return allowFile ? null : `file dependency not allowed: ${resolved}`;
  }
  return undefined; // not a special dep — caller handles registry URL
}

// Validate a registry/tarball resolved URL for TLS and trusted host, returning
// a finding message when it fails, otherwise null.
function checkRegistryResolved(resolved, { allowHttp, allowedHosts }) {
  let url;
  try {
    url = new URL(resolved);
  } catch {
    return `unparseable resolved URL: ${resolved}`;
  }
  if (url.protocol === 'http:' && !allowHttp) {
    return `insecure (non-TLS) resolved URL: ${resolved}`;
  }
  const isHttp = url.protocol === 'https:' || url.protocol === 'http:';
  if (isHttp && !allowedHosts.includes(url.hostname)) {
    return `resolved from untrusted registry host "${url.hostname}" (allowed: ${allowedHosts.join(', ')})`;
  }
  return null;
}

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

      const special = checkSpecialResolved(resolved, { isGitDep, isFileDep, allowGit, allowFile });
      const message = special === undefined
        ? checkRegistryResolved(resolved, { allowHttp, allowedHosts })
        : special;
      if (message) findings.push({ packagePath: key, message });
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
// Resolve a package's npm v12 `allowScripts` approval state — pinned
// `name@version` takes precedence over a bare `name` key.
function resolveScriptApproval(allowScripts, name, version) {
  if (!allowScripts || !name) return 'pending';
  const pinned = `${name}@${version}`;
  if (pinned in allowScripts) return allowScripts[pinned] ? 'allowed' : 'denied';
  if (name in allowScripts) return allowScripts[name] ? 'allowed' : 'denied';
  return 'pending'; // pending | allowed | denied
}

// Build the allowed/blocked record for a single install-script package, or null
// when the entry is a root/workspace/link/script-less node that we skip.
function classifyScriptEntry({ key, entry, name }, { allowScripts, v12Aware, allow }) {
  if (!entry || entry.hasInstallScript !== true) return null;

  const approval = v12Aware ? resolveScriptApproval(allowScripts, name, entry.version) : 'pending';
  const viaRuleAllow = Boolean(name && allow.includes(name));
  return { key, name, version: entry.version, approval, viaRuleAllow };
}

export function classifyInstallScripts(lockfile, packageJson, options = {}) {
  const { allow = [] } = options;
  const allowScripts = packageJson && packageJson.allowScripts;
  const v12Aware = Boolean(allowScripts && typeof allowScripts === 'object');
  const allowed = [];
  const blocked = [];
  if (!lockfile.packages) return { total: 0, allowed, blocked, v12Aware };

  forEachPackageEntry(lockfile, ({ key, entry, name, isRoot, isWorkspaceSource, isLink }) => {
    if (isRoot || isWorkspaceSource || isLink) return;
    const rec = classifyScriptEntry({ key, entry, name }, { allowScripts, v12Aware, allow });
    if (!rec) return;
    if (rec.viaRuleAllow || rec.approval === 'allowed') allowed.push(rec);
    else blocked.push(rec);
  });

  return { total: allowed.length + blocked.length, allowed, blocked, v12Aware };
}

// Compose the finding message for a blocked install-script package, varying by
// whether it is explicitly denied, pending under an allowScripts-aware project,
// or simply unreviewed in a pre-v12 project.
function installScriptMessage(label, approval, v12Aware) {
  if (approval === 'denied') {
    return `${label} runs an install script but is denied in package.json "allowScripts" — npm v12 will not run it`;
  }
  if (v12Aware) {
    return `${label} runs an install script not yet approved in package.json "allowScripts" — npm v12 will not run it (\`npm approve-scripts\`)`;
  }
  return `${label} runs a lifecycle install script (preinstall/install/postinstall) — review and add to this rule's "allow" list if trusted, or install with \`--ignore-scripts\``;
}

const installScriptsRule = {
  id: 'install-scripts',
  description: 'Packages with lifecycle install scripts must be reviewed and allowlisted',
  defaultSeverity: 'warn',
  check({ lockfile, packageJson, options }) {
    const { blocked, v12Aware } = classifyInstallScripts(lockfile, packageJson, options);
    return blocked.map(({ key, name, approval }) => ({
      packagePath: key,
      message: installScriptMessage(name || key, approval, v12Aware)
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

// Collect unpinned (caret/tilde) ranges from one package.json section.
function collectUnpinnedRanges(lockfile, deps, section, ignore) {
  if (!deps || typeof deps !== 'object') return [];
  const findings = [];
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
  return findings;
}

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
      findings.push(...collectUnpinnedRanges(lockfile, packageJson[section], section, ignore));
    }
    return findings;
  }
};

const SYNC_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

// Compare the top-level name/version of package.json against the lockfile.
function checkRootMetadataSync(lockfile, packageJson) {
  const findings = [];
  if (packageJson.name && lockfile.name && packageJson.name !== lockfile.name) {
    findings.push({ packagePath: '', message: `name mismatch: package.json says "${packageJson.name}", lockfile says "${lockfile.name}"` });
  }
  if (packageJson.version && lockfile.version && packageJson.version !== lockfile.version) {
    findings.push({ packagePath: '', message: `version mismatch: package.json says "${packageJson.version}", lockfile says "${lockfile.version}" (run \`npm install\`)` });
  }
  return findings;
}

// Reconcile one dependency section between package.json and the lockfile root
// entry (and the packages map), both directions.
function checkSectionSync(lockfile, section, declared, locked) {
  const findings = [];

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

  return findings;
}

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

    const findings = checkRootMetadataSync(lockfile, packageJson);

    const root = lockfile.packages && lockfile.packages[''];
    if (!root) return findings;

    for (const section of SYNC_SECTIONS) {
      const declared = packageJson[section] || {};
      const locked = root[section] || {};
      findings.push(...checkSectionSync(lockfile, section, declared, locked));
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
    } catch {
      // v1 lockfiles: lockfile-version rule already covers this
      return [];
    }
    return orphans.map((orphan) => {
      const detail = orphan.version ? ` (${orphan.name}@${orphan.version})` : '';
      return {
        packagePath: orphan.key,
        message: `orphaned package${detail} unreachable from the dependency graph (run \`npm-check prune\`)`
      };
    });
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

/**
 * Does a project `.npmrc` already suppress npm's funding solicitations?
 * npm prints "N packages are looking for funding" on install unless `fund`
 * is set false. We only consult the project-level `.npmrc` (the committed,
 * reproducible artifact a CI audit can rely on) — not the machine's `~/.npmrc`,
 * which would make results differ between local and CI.
 */
function npmrcDisablesFund(dir, options = {}) {
  const npmrcPath = options.npmrcPath ? path.resolve(options.npmrcPath) : path.join(dir, '.npmrc');
  let content;
  try {
    content = fs.readFileSync(npmrcPath, 'utf8');
  } catch {
    return false; // no .npmrc → funding messages are on by default
  }
  // ini-style `fund=false` / `fund = false`, ignoring case, surrounding ws, and inline comments
  return content.split(/\r?\n/).some((line) => {
    const m = line.match(/^\s*fund\s*=\s*([^\s;#]+)/i);
    return Boolean(m) && m[1].toLowerCase() === 'false';
  });
}

const noFundRule = {
  id: 'no-fund',
  description: 'npm funding solicitations should be suppressed (fund=false in .npmrc)',
  defaultSeverity: 'warn',
  check({ lockfile, filePath, options }) {
    if (!lockfile.packages) return [];

    // Count installed packages that declare funding metadata — these are
    // exactly what npm's "N packages are looking for funding" notice tallies.
    let funded = 0;
    forEachPackageEntry(lockfile, ({ entry, isRoot, isWorkspaceSource, isLink }) => {
      if (isRoot || isWorkspaceSource || isLink) return;
      if (entry && entry.funding) funded++;
    });
    if (funded === 0) return [];

    // Already silenced by a project .npmrc → nothing to flag.
    if (npmrcDisablesFund(path.dirname(path.resolve(filePath)), options)) return [];

    return [{
      packagePath: '.npmrc',
      message: `${funded} package${funded === 1 ? '' : 's'} emit npm funding solicitations on install — disable with \`npm config set fund false\` (adds \`fund=false\` to .npmrc)`
    }];
  }
};

const validNpmrcRule = {
  id: 'valid-npmrc',
  description: '.npmrc must be well-formed and free of insecure settings',
  defaultSeverity: 'warn',
  check({ filePath, options }) {
    const dir = path.dirname(path.resolve(filePath));
    const npmrcPath = options.npmrcPath ? path.resolve(options.npmrcPath) : path.join(dir, '.npmrc');
    let content;
    try {
      content = fs.readFileSync(npmrcPath, 'utf8');
    } catch {
      return []; // no project .npmrc → nothing to validate (legitimate)
    }
    const result = validateNpmrc(content, options);
    const findings = result.errors.map((err) => ({
      packagePath: '.npmrc',
      message: err.message,
      // Security-critical findings always fail, regardless of configured severity.
      data: NPMRC_SECURITY_CODES.has(err.code)
        ? { forcedSeverity: 'error', code: err.code }
        : { code: err.code }
    }));
    const warnFindings = result.warnings.map((warn) => ({
      packagePath: '.npmrc',
      message: typeof warn === 'string' ? warn : warn.message,
      data: { forcedSeverity: 'warn', code: typeof warn === 'string' ? undefined : warn.code }
    }));
    return [...findings, ...warnFindings];
  }
};

export const rules = [
  lockfileVersionRule,
  validStructureRule,
  validPackageJsonRule,
  integrityHygieneRule,
  secureResolvedRule,
  installScriptsRule,
  noGitDepsRule,
  noRemoteDepsRule,
  pinnedVersionsRule,
  lockfileSyncRule,
  noOrphanPackagesRule,
  unusedDependenciesRule,
  noFundRule,
  validNpmrcRule
];

/**
 * Run all configured audit rules against a lockfile (and optional package.json).
 *
 * @param {object} target - { lockfile, packageJson|null, filePath }
 * @param {object} config - Resolved config from loadAuditConfig/mergeConfig,
 *                          or a raw user config object (will be merged over defaults)
 * @returns {{findings, summary, pass}}
 */
// Resolve the audit config, accepting either an already-normalized config or a
// raw user config that needs merging over the defaults.
function resolveAuditConfig(config) {
  const alreadyNormalized = config.rules
    && config.rules[rules[0].id]
    && config.rules[rules[0].id].severity;
  return alreadyNormalized ? config : mergeConfig(config);
}

// Run a single rule and map its raw findings into stamped findings (ruleId +
// resolved severity, honoring a finding's forcedSeverity).
function collectRuleFindings(rule, ruleConfig, context) {
  const raw = rule.check(context);
  return raw.map((finding) => ({
    ruleId: rule.id,
    severity: (finding.data && finding.data.forcedSeverity) || ruleConfig.severity,
    packagePath: finding.packagePath,
    message: finding.message
  }));
}

// Tally findings into the summary's per-rule error/warning breakdown.
function summarizeByRule(findings) {
  const byRule = {};
  for (const finding of findings) {
    byRule[finding.ruleId] = byRule[finding.ruleId] || { errors: 0, warnings: 0 };
    byRule[finding.ruleId][finding.severity === 'error' ? 'errors' : 'warnings']++;
  }
  return byRule;
}

export function runAudit(target, config = {}) {
  const { lockfile, packageJson = null, filePath = 'package-lock.json' } = target;
  if (!lockfile || typeof lockfile !== 'object') {
    throw new AuditError('lockfile data is required', 'MISSING_LOCKFILE');
  }

  const resolved = resolveAuditConfig(config);

  const findings = [];
  for (const rule of rules) {
    const ruleConfig = resolved.rules[rule.id];
    if (!ruleConfig || ruleConfig.severity === 'off') continue;

    const context = { lockfile, packageJson, options: ruleConfig.options || {}, filePath };
    findings.push(...collectRuleFindings(rule, ruleConfig, context));
  }

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;
  const byRule = summarizeByRule(findings);

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
