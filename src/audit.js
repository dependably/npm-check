// src/audit.js
import fs from 'fs';
import path from 'path';
import { forEachPackageEntry, detectLockfileFlavor } from './format-library.js';
import { validatePackageLock } from './validator.js';
import { validatePackageJson } from './package-json-validator.js';
import { validateNpmrc, parseNpmrc, NPMRC_SECURITY_CODES } from './npmrc-validator.js';
import { validatePnpmWorkspace, parsePnpmWorkspace } from './pnpm-workspace-validator.js';
import { isPlaceholder } from './integrity.js';
import { classifyRange } from './pinner.js';
import { walkOverrides } from './overrides.js';
import { findOrphanedPackages } from './pruner.js';
import { findUnusedDependencies } from './usage-scanner.js';
import { mergeConfig } from './audit-config.js';
import { matchException, isExpired } from './exceptions.js';

export class AuditError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'AuditError';
    this.code = code;
    this.context = context;
  }
}

// Rule contract: { id, description, defaultSeverity, flavors?, check(context) => findings[] }
// context = { lockfile, packageJson|null, options, filePath, flavor }
// findings = [{ packagePath, message, data? }] — the engine stamps ruleId + severity.
// `flavors` lists which lockfile flavors a rule applies to (default ['npm']); a
// rule whose flavors don't include the current flavor is skipped (e.g. the npm
// lockfile-shape rules no-op on a pnpm-lock.yaml, and vice versa).
const DEFAULT_FLAVORS = ['npm'];

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
  flavors: ['npm', 'pnpm'],
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
 * native package.json `allowScripts`. Two shapes are accepted: the map form
 * (keys are `name@version` pinned or bare `name`; values true=approved /
 * false=denied) and the array form (`["name", "name@version"]`, listing alone
 * = approved, no deny semantics). Under npm v12 a script only runs when
 * explicitly approved, so anything not approved is "blocked".
 *
 * @returns {{ total, allowed: object[], blocked: object[], v12Aware: boolean }}
 */
// Resolve a package's npm v12 `allowScripts` approval state — pinned
// `name@version` takes precedence over a bare `name` key.
function resolveScriptApproval(allowScripts, name, version) {
  if (!allowScripts || !name) return 'pending';
  const pinned = `${name}@${version}`;
  if (Array.isArray(allowScripts)) {
    // Array form: an entry approves; there is no way to express a denial.
    return allowScripts.includes(pinned) || allowScripts.includes(name) ? 'allowed' : 'pending';
  }
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
  return `${label} runs a lifecycle install script — npm v12 blocks install scripts by default; approve it in package.json "allowScripts" (\`npm approve-scripts\`) if trusted, or it will not run`;
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
  check({ lockfile, options }) {
    const { allowedHosts = ['registry.npmjs.org', 'npm.pkg.github.com'] } = options;
    const findings = [];
    if (!lockfile.packages) return findings;
    forEachPackageEntry(lockfile, ({ key, entry, name, isRoot, isWorkspaceSource, isLink, isGitDep, isFileDep }) => {
      if (isRoot || isWorkspaceSource || isLink || isGitDep || isFileDep) return;
      const resolved = entry && entry.resolved;
      if (!resolved || !/^https?:/i.test(resolved)) return;
      // Treat a URL as a registry tarball when its hostname is in the configured
      // allowedHosts list. This correctly handles GitHub Packages
      // (npm.pkg.github.com/download/...) and private registries without relying
      // on the brittle `/-/` path marker, which is absent from several registry
      // URL shapes and present in some genuine remote tarball URLs.
      let hostname;
      try {
        hostname = new URL(resolved).hostname;
      } catch {
        // Unparseable URL — secure-resolved will flag it; skip here.
        return;
      }
      if (allowedHosts.includes(hostname)) return;
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

// Flag caret/tilde ranges inside an overrides object (npm `overrides` or the
// pnpm `pnpm.overrides` field). Walks the nested/flat structure via walkOverrides
// (which skips `$`-references) and reports each unpinned range by its full path.
function collectUnpinnedOverrides(overrides, lockfile, section, ignore, pinHint) {
  if (!overrides || typeof overrides !== 'object') return [];
  const findings = [];
  for (const { path, name, range } of walkOverrides(overrides)) {
    if (ignore.includes(name) || ignore.includes(path)) continue;
    const kind = classifyRange(range);
    if (kind !== 'caret' && kind !== 'tilde') continue;

    const entry = lockfile.packages && lockfile.packages[`node_modules/${name}`];
    const resolvedNote = entry && entry.version ? ` (resolved: ${entry.version})` : '';
    findings.push({
      packagePath: `package.json#${section}/${path}`,
      message: `override range "${range}" is not pinned${resolvedNote}${pinHint}`
    });
  }
  return findings;
}

const pinnedVersionsRule = {
  id: 'pinned-versions',
  description: 'package.json dependency ranges must be exact versions',
  defaultSeverity: 'error',
  // package.json pinning is manifest-level and flavor-agnostic — pnpm projects
  // should pin too, and this is what makes the pnpm.overrides flagging below
  // actually reachable on a pnpm-lock.yaml (the `lockfile.packages` lookups are
  // guarded and degrade to an empty resolved-note for pnpm).
  flavors: ['npm', 'pnpm'],
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

    // Overrides force transitive versions and can carry floating ranges too — a
    // caret here silently defeats an otherwise fully-pinned manifest. npm
    // `overrides` are pinnable (`npm-check pin`); pnpm.overrides are flagged for
    // manual attention (pin refuses pnpm lockfiles).
    findings.push(...collectUnpinnedOverrides(packageJson.overrides, lockfile, 'overrides', ignore, ' (run `npm-check pin`)'));
    const pnpmOverrides = packageJson.pnpm && packageJson.pnpm.overrides;
    findings.push(...collectUnpinnedOverrides(pnpmOverrides, lockfile, 'pnpm.overrides', ignore, ' (pin manually or regenerate with pnpm)'));

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
  flavors: ['npm', 'pnpm'],
  check({ filePath, options, flavor }) {
    const dir = path.dirname(path.resolve(filePath));
    const npmrcPath = options.npmrcPath ? path.resolve(options.npmrcPath) : path.join(dir, '.npmrc');
    let content;
    try {
      content = fs.readFileSync(npmrcPath, 'utf8');
    } catch {
      return []; // no project .npmrc → nothing to validate (legitimate)
    }
    // For pnpm projects, flag non-auth settings that pnpm silently ignores in .npmrc.
    const result = validateNpmrc(content, { ...options, flavor });
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

const validPnpmWorkspaceRule = {
  id: 'valid-pnpm-workspace',
  description: 'pnpm-workspace.yaml must be well-formed (packages globs + valid settings)',
  defaultSeverity: 'error',
  flavors: ['pnpm'],
  check({ filePath }) {
    const dir = path.dirname(path.resolve(filePath));
    const wsPath = path.join(dir, 'pnpm-workspace.yaml');
    let content;
    try {
      content = fs.readFileSync(wsPath, 'utf8');
    } catch {
      return []; // no pnpm-workspace.yaml → nothing to validate (single-package repo)
    }
    const result = validatePnpmWorkspace(content);
    const findings = result.errors.map((err) => ({
      packagePath: 'pnpm-workspace.yaml',
      message: err.message,
      data: { code: err.code }
    }));
    const warnFindings = result.warnings.map((warn) => ({
      packagePath: 'pnpm-workspace.yaml',
      message: typeof warn === 'string' ? warn : warn.message,
      data: { forcedSeverity: 'warn', code: typeof warn === 'string' ? undefined : warn.code }
    }));
    return [...findings, ...warnFindings];
  }
};

const validPnpmFieldRule = {
  id: 'valid-pnpm-field',
  description: 'package.json "pnpm" field (overrides, build allowlists, …) must be well-typed',
  defaultSeverity: 'error',
  flavors: ['pnpm'],
  check({ packageJson }) {
    if (!packageJson || packageJson.pnpm === undefined) return [];
    // validatePackageJson already type-checks the pnpm field; surface only those.
    const result = validatePackageJson(packageJson);
    const isPnpm = (msg) => typeof msg === 'string' && msg.includes('"pnpm');
    const findings = result.errors
      .filter((err) => err.code === 'PJ_INVALID_PNPM' || err.code === 'PJ_INVALID_PNPM_FIELD')
      .map((err) => ({ packagePath: 'package.json', message: err.message, data: { code: err.code } }));
    const warnFindings = result.warnings
      .filter((warn) => warn.code === 'PJ_UNKNOWN_PNPM_KEY' || isPnpm(warn.message))
      .map((warn) => ({ packagePath: 'package.json', message: warn.message, data: { forcedSeverity: 'warn', code: warn.code } }));
    return [...findings, ...warnFindings];
  }
};

/**
 * Lockfile portability: every `resolved` URL must point at a host this project
 * pins to.
 *
 * This is deliberately NOT the same question as `secure-resolved` /
 * `no-remote-deps`, which both consult `allowedRegistryHosts` to ask "is this
 * host a legitimate, trusted registry?". Trust and portability are orthogonal:
 * an org's own private mirror is entirely trusted, yet a lockfile resolving
 * from it cannot be installed by anyone outside that network (a public CI
 * runner, an external contributor, a GitHub build). A shared
 * `allowedRegistryHosts` also unions across config levels, so it can only ever
 * grow more permissive — correct for a trust allowlist, but useless as a pin,
 * which must be able to narrow.
 *
 * Opt-in: with no `hosts` configured the rule is a no-op, so projects that
 * genuinely install from a private registry are unaffected.
 */
// Trim/lowercase the configured pin list, dropping non-string and blank entries.
// An empty result means the rule is unconfigured, i.e. off.
function normalizePinnedHosts(hosts) {
  if (!Array.isArray(hosts)) return [];
  return hosts.filter((h) => typeof h === 'string' && h.trim()).map((h) => h.trim().toLowerCase());
}

// Git/file/link/workspace entries resolve outside the registry by definition —
// no-git-deps / secure-resolved own those.
function resolvesOutsideRegistry({ isRoot, isWorkspaceSource, isLink, isGitDep, isFileDep }) {
  return Boolean(isRoot || isWorkspaceSource || isLink || isGitDep || isFileDep);
}

// Hostname of an entry's http(s) `resolved` URL, or null when it has none or the
// URL is unparseable (secure-resolved flags that; not this rule's job).
function resolvedHostname(entry) {
  const resolved = entry && entry.resolved;
  if (!resolved || !/^https?:/i.test(resolved)) return null;
  try {
    return new URL(resolved).hostname.toLowerCase();
  } catch {
    return null;
  }
}

const resolvedRegistryPinRule = {
  id: 'resolved-registry-pin',
  description: 'Resolved URLs must point only at the registry hosts this project pins to',
  defaultSeverity: 'error',
  // pnpm lockfiles carry no `resolved` URLs (the registry is implied by config),
  // so there is nothing to pin.
  flavors: ['npm'],
  check({ lockfile, options }) {
    const findings = [];
    // Unconfigured == off. Pinning is a per-project decision, not a default.
    const pinned = normalizePinnedHosts(options.hosts);
    if (pinned.length === 0 || !lockfile.packages) return findings;

    forEachPackageEntry(lockfile, (packageEntry) => {
      if (resolvesOutsideRegistry(packageEntry)) return;
      const hostname = resolvedHostname(packageEntry.entry);
      if (hostname === null || pinned.includes(hostname)) return;
      const { key, name } = packageEntry;
      findings.push({
        packagePath: key,
        message: `${name || key} resolves from "${hostname}", which is not a pinned registry host (${pinned.join(', ')}) — the lockfile will not install where that host is unreachable`
      });
    });
    return findings;
  }
};

// Supply-chain "cooldown": refuse to install versions published less than N ago.
// A compromised maintainer account's malicious release is typically detected and
// unpublished within hours, so a cooldown means you simply never resolve it.
//
// The two package managers disagree on BOTH key name and unit, which is the whole
// reason this normalizes to days before comparing:
//   npm  >= 11.10 : `.npmrc`              min-release-age    (DAYS)
//   pnpm >= 10.16 : `pnpm-workspace.yaml` minimumReleaseAge  (MINUTES)
// pnpm reads only auth/registry settings from .npmrc, so its cooldown is never
// there; npm has no equivalent yaml, so its cooldown is never in the workspace file.
const MINUTES_PER_DAY = 1440;

// Configured cooldown in DAYS for an npm project, or null when unset/unparseable.
function npmCooldownDays(npmrcPath) {
  let content;
  try {
    content = fs.readFileSync(npmrcPath, 'utf8');
  } catch {
    return null; // no committed .npmrc → no committed policy
  }
  // parseNpmrc yields an entry list, keys lowercased; last assignment wins (ini).
  const entry = parseNpmrc(content).filter((e) => e.key === 'min-release-age').pop();
  if (!entry) return null;
  const days = Number(entry.value);
  return Number.isFinite(days) ? days : null;
}

// Configured cooldown in DAYS for a pnpm project, or null when unset/unparseable.
function pnpmCooldownDays(workspacePath) {
  let content;
  try {
    content = fs.readFileSync(workspacePath, 'utf8');
  } catch {
    return null;
  }
  let doc;
  try {
    doc = parsePnpmWorkspace(content);
  } catch {
    return null; // malformed YAML — valid-pnpm-workspace owns that finding
  }
  const raw = doc && doc.minimumReleaseAge;
  if (raw === undefined) return null;
  const minutes = Number(raw);
  return Number.isFinite(minutes) ? minutes / MINUTES_PER_DAY : null;
}

// A blanket exclusion silently voids the policy, so it is worth its own finding.
function blanketExclusions(workspacePath) {
  let doc;
  try {
    doc = parsePnpmWorkspace(fs.readFileSync(workspacePath, 'utf8'));
  } catch {
    return [];
  }
  const list = doc && doc.minimumReleaseAgeExclude;
  if (!Array.isArray(list)) return [];
  return list.filter((p) => typeof p === 'string' && (p === '*' || p === '**'));
}

const minReleaseAgeRule = {
  id: 'min-release-age',
  description: 'A minimum release-age cooldown must be configured, so a freshly published (possibly compromised) version is never installed',
  defaultSeverity: 'warn',
  flavors: ['npm', 'pnpm'],
  check({ filePath, options, flavor }) {
    const { minDays = 3 } = options;
    const dir = path.dirname(path.resolve(filePath));
    const isPnpm = flavor === 'pnpm';
    const configFile = isPnpm ? 'pnpm-workspace.yaml' : '.npmrc';
    // `npmrcPath` lets a caller point at a .npmrc outside the lockfile's dir
    // (same option valid-npmrc takes); it is meaningless on the pnpm path.
    const npmrcPath = options.npmrcPath ? path.resolve(options.npmrcPath) : path.join(dir, '.npmrc');
    const configPath = isPnpm ? path.join(dir, 'pnpm-workspace.yaml') : npmrcPath;

    const configured = isPnpm ? pnpmCooldownDays(configPath) : npmCooldownDays(configPath);
    const setting = isPnpm ? 'minimumReleaseAge' : 'min-release-age';
    const findings = [];

    if (configured === null) {
      const unit = isPnpm ? `${minDays * MINUTES_PER_DAY} (minutes)` : `${minDays} (days)`;
      findings.push({
        packagePath: configFile,
        message: `no release-age cooldown configured — set "${setting}" to at least ${unit} in ${configFile} so a version published moments ago is never installed`
      });
    } else if (configured < minDays) {
      findings.push({
        packagePath: configFile,
        message: `release-age cooldown is ${formatDays(configured)}, below the required minimum of ${formatDays(minDays)} ("${setting}" in ${configFile})`
      });
    }

    if (isPnpm) {
      for (const pattern of blanketExclusions(configPath)) {
        findings.push({
          packagePath: configFile,
          message: `"minimumReleaseAgeExclude" contains the blanket pattern "${pattern}", which exempts every package and voids the cooldown`
        });
      }
    }
    return findings;
  }
};

// Render a day count the way a reader configures it: whole days, or minutes when
// the value is under a day (which is how a pnpm `minimumReleaseAge` will land here).
function formatDays(days) {
  if (days >= 1) return `${Number.isInteger(days) ? days : days.toFixed(2)} day${days === 1 ? '' : 's'}`;
  const minutes = Math.round(days * MINUTES_PER_DAY);
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
}

export const rules = [
  lockfileVersionRule,
  validStructureRule,
  validPackageJsonRule,
  integrityHygieneRule,
  secureResolvedRule,
  installScriptsRule,
  noGitDepsRule,
  noRemoteDepsRule,
  resolvedRegistryPinRule,
  pinnedVersionsRule,
  lockfileSyncRule,
  noOrphanPackagesRule,
  unusedDependenciesRule,
  noFundRule,
  validNpmrcRule,
  validPnpmWorkspaceRule,
  validPnpmFieldRule,
  minReleaseAgeRule
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

// The package name an npm-check finding is about, from its lockfile path (the
// segment after the last `node_modules/`). Used to match `package` exceptions.
function deriveFindingPackage(packagePath) {
  if (!packagePath) return undefined;
  const marker = 'node_modules/';
  const idx = packagePath.lastIndexOf(marker);
  const tail = idx >= 0 ? packagePath.slice(idx + marker.length) : packagePath;
  return tail || undefined;
}

// Partition audit findings by the resolved `.dependably` exceptions. Kept
// findings are returned untouched (same object refs); suppressed ones are copies
// stamped with `suppressed`/`suppressedBy`. Expired entries never suppress.
function applyAuditExceptions(findings, exceptions) {
  if (!Array.isArray(exceptions) || exceptions.length === 0) {
    return { kept: findings, suppressed: [], unused: [], expired: [] };
  }
  const live = [];
  const expired = [];
  for (const ex of exceptions) (isExpired(ex) ? expired : live).push(ex);

  const used = new Set();
  const kept = [];
  const suppressed = [];
  for (const finding of findings) {
    const probe = { ruleId: finding.ruleId, package: deriveFindingPackage(finding.packagePath) };
    const hit = live.find((ex) => matchException(ex, probe));
    if (hit) {
      used.add(hit);
      suppressed.push({ ...finding, suppressed: true, suppressedBy: hit.reason });
    } else {
      kept.push(finding);
    }
  }
  return { kept, suppressed, unused: live.filter((ex) => !used.has(ex)), expired };
}

export function runAudit(target, config = {}) {
  const { lockfile, packageJson = null, filePath = 'package-lock.json' } = target;
  if (!lockfile || typeof lockfile !== 'object') {
    throw new AuditError('lockfile data is required', 'MISSING_LOCKFILE');
  }

  const resolved = resolveAuditConfig(config);
  const flavor = detectLockfileFlavor(lockfile);

  const raw = [];
  for (const rule of rules) {
    // Flavor gating: a rule only runs against the lockfile flavors it supports
    // (npm-shape rules no-op on pnpm-lock.yaml; pnpm rules no-op on npm).
    if (!(rule.flavors || DEFAULT_FLAVORS).includes(flavor)) continue;

    const ruleConfig = resolved.rules[rule.id];
    if (!ruleConfig || ruleConfig.severity === 'off') continue;

    const context = { lockfile, packageJson, options: ruleConfig.options || {}, filePath, flavor };
    raw.push(...collectRuleFindings(rule, ruleConfig, context));
  }

  // Suppress findings named by `.dependably` exceptions: they no longer gate but
  // are reported separately (spec §6). Kept findings drive errors/warnings/pass.
  const { kept: findings, suppressed, unused, expired } = applyAuditExceptions(raw, config.exceptions);

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.filter((f) => f.severity === 'warn').length;
  const byRule = summarizeByRule(findings);

  const maxWarnings = resolved.maxWarnings !== undefined ? resolved.maxWarnings : -1;
  const pass = errors === 0 && (maxWarnings < 0 || warnings <= maxWarnings);

  return {
    findings,
    suppressed,
    summary: { errors, warnings, total: findings.length, byRule, suppressed: suppressed.length },
    pass,
    filePath,
    exceptionsMeta: { unused, expired }
  };
}

/**
 * Format an audit report for display.
 * @param {object} report - Result of runAudit()
 * @param {object} options - { format: 'stylish' | 'json' }
 * @returns {string}
 */
// Machine-readable half of formatAuditReport.
function formatAuditJson(report, suppressed) {
  const meta = report.exceptionsMeta || {};
  return JSON.stringify({
    filePath: report.filePath,
    pass: report.pass,
    summary: report.summary,
    findings: report.findings,
    suppressed,
    exceptionsMeta: {
      unused: (meta.unused || []).map((e) => e._raw),
      expired: (meta.expired || []).map((e) => e._raw)
    }
  }, null, 2);
}

// One aligned `severity  rule  path  message` line per finding.
function findingLines(findings) {
  const ruleWidth = Math.max(...findings.map((f) => f.ruleId.length));
  return findings.map((finding) => {
    const sev = finding.severity === 'error' ? 'error' : 'warn ';
    const loc = finding.packagePath ? `${finding.packagePath}   ` : '';
    return `  ${sev}  ${finding.ruleId.padEnd(ruleWidth)}  ${loc}${finding.message}`;
  });
}

// The closing `N problems (E errors, W warnings)` tally.
function totalsLine(summary, suppressedCount) {
  const { errors, warnings, total } = summary;
  const problemWord = total === 1 ? 'problem' : 'problems';
  const errorWord = errors === 1 ? 'error' : 'errors';
  const warningWord = warnings === 1 ? 'warning' : 'warnings';
  const suffix = suppressedCount > 0 ? ` — ${suppressedCount} suppressed by .dependably` : '';
  return `${total} ${problemWord} (${errors} ${errorWord}, ${warnings} ${warningWord})${suffix}`;
}

// Human-readable (ESLint-like) half of formatAuditReport.
function formatAuditStylish(report, suppressed, showSuppressed) {
  const lines = [report.filePath];

  if (report.findings.length === 0) {
    lines.push(suppressed.length > 0 ? `  no problems found (${suppressed.length} suppressed by .dependably)` : '  no problems found');
    appendSuppressed(lines, suppressed, showSuppressed);
    return lines.join('\n');
  }

  lines.push(...findingLines(report.findings));
  lines.push('');
  lines.push(totalsLine(report.summary, suppressed.length));
  appendSuppressed(lines, suppressed, showSuppressed);
  return lines.join('\n');
}

export function formatAuditReport(report, options = {}) {
  const { format = 'stylish', showSuppressed = false } = options;
  const suppressed = report.suppressed || [];

  if (format === 'json') return formatAuditJson(report, suppressed);
  if (format !== 'stylish') {
    throw new AuditError(`Unknown report format: ${format}`, 'UNKNOWN_FORMAT');
  }
  return formatAuditStylish(report, suppressed, showSuppressed);
}

// Optionally list the suppressed findings (with their exception reason) below the
// summary, so `--show-suppressed` keeps the audit trail visible.
function appendSuppressed(lines, suppressed, showSuppressed) {
  if (!showSuppressed || suppressed.length === 0) return;
  lines.push('');
  lines.push('suppressed by .dependably:');
  for (const f of suppressed) {
    const loc = f.packagePath ? `${f.packagePath}   ` : '';
    lines.push(`  ${f.ruleId}  ${loc}${f.message}  (${f.suppressedBy})`);
  }
}
