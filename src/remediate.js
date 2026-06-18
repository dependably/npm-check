// src/remediate.js
// Dependency remediation: turns the deprecated/vulnerable findings into action.
//
// Scope (deliberate): npm-check is lockfile-first and does not re-resolve the
// dependency graph — that is `npm install`'s job. So remediation here bumps the
// *direct* dependencies in package.json that are themselves deprecated or carry
// an advisory at/above the severity threshold, rewriting their range to the
// registry's latest version and syncing the lockfile root. Transitive findings
// (a flagged package that is not a direct dependency) are reported as guidance
// only — they clear when their parent is upgraded or via npm `overrides`. After
// writing, the caller must run `npm install` to materialize the new tree.
import { checkDeprecations } from './deprecation.js';
import { checkVulnerabilities } from './vuln.js';
import { classifyRange } from './pinner.js';
import { forEachPackageEntry } from './format-library.js';
import { deriveRegistryBase, DEFAULT_REGISTRY, fetchLatestVersion } from './integrity.js';

export class RemediationError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'RemediationError';
    this.code = code;
    this.context = context;
  }
}

const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Rewrite a range to target `version`, preserving the existing operator
 * (exact stays exact, ^ stays ^, ~ stays ~).
 */
function rewriteRange(currentRange, version, rangeType) {
  if (rangeType === 'caret') return `^${version}`;
  if (rangeType === 'tilde') return `~${version}`;
  return version; // exact
}

/**
 * Index the lockfile's top-level installed versions by package name
 * (nearest install, i.e. `node_modules/<name>`), so we know each direct
 * dependency's currently-resolved version.
 */
function topLevelVersions(lockfile) {
  const versions = new Map();
  forEachPackageEntry(lockfile, ({ key, entry, name }) => {
    if (key.startsWith('node_modules/') && key.indexOf('/node_modules/', 'node_modules/'.length) === -1) {
      if (entry.version) versions.set(name, { version: entry.version, resolved: entry.resolved });
    }
  });
  return versions;
}

/**
 * Plan (and optionally apply) remediation bumps for flagged direct dependencies.
 *
 * @param {object} lockfile - Parsed lockfile (v2/v3)
 * @param {object} packageJson - Parsed package.json
 * @param {object} options
 * @param {string} options.minSeverity - Advisory threshold that counts a dep as vulnerable (default: 'high')
 * @param {boolean} options.includeDeprecated - Treat deprecated direct deps as remediation targets (default: true)
 * @param {number} options.timeoutMs / options.concurrency / options.defaultRegistry
 * @param {Function} options.fetchManifest / options.fetchAdvisories - Injected scan transports (tests)
 * @param {Function} options.fetchLatest - Injected (name, registryBase) => Promise<version|null> (tests)
 * @param {Function} options.onProgress
 * @returns {Promise<object>} { packageJson, lockfile, bumped, guidance, skipped, warnings, changed }
 */
export async function remediateDependencies(lockfile, packageJson, options = {}) {
  const {
    minSeverity = 'high',
    includeDeprecated = true,
    timeoutMs = 10000,
    concurrency = 8,
    defaultRegistry = DEFAULT_REGISTRY,
    fetchManifest = null,
    fetchAdvisories = null,
    fetchLatest = null,
    onProgress = null
  } = options;

  if (!lockfile || typeof lockfile !== 'object') {
    throw new RemediationError('lockfile data is required', 'MISSING_LOCKFILE');
  }
  if (!packageJson || typeof packageJson !== 'object') {
    throw new RemediationError('package.json data is required', 'MISSING_PACKAGE_JSON');
  }
  if (lockfile.lockfileVersion === 1) {
    throw new RemediationError('v1 lockfiles are not supported; run `npm-check migrate 3` first', 'UNSUPPORTED_VERSION');
  }

  // 1. Gather findings (reuse the existing scanners; transports are injectable for tests).
  const [deprecationResult, vulnResult] = await Promise.all([
    includeDeprecated
      ? checkDeprecations(lockfile, { timeoutMs, concurrency, defaultRegistry, fetchManifest, onProgress })
      : Promise.resolve({ warnings: [], errors: [] }),
    checkVulnerabilities(lockfile, { timeoutMs, concurrency, defaultRegistry, minSeverity, fetchAdvisories, onProgress })
  ]);

  // Flagged package names → why. Deprecated (any) + vulnerable at/above threshold
  // (vuln errors carry an advisoryId; below-threshold ones are warnings and skipped).
  const flagged = new Map(); // name -> Set of reasons
  const flag = (name, reason) => {
    if (!flagged.has(name)) flagged.set(name, new Set());
    flagged.get(name).add(reason);
  };
  if (includeDeprecated) {
    for (const w of [...deprecationResult.warnings, ...deprecationResult.errors]) {
      if (w.package) flag(w.package, 'deprecated');
    }
  }
  for (const e of vulnResult.errors) {
    if (e.advisoryId && e.package) flag(e.package, 'vulnerable');
  }

  // 2. Map flagged names to direct dependencies in package.json.
  const directDeps = new Map(); // name -> { section, range }
  for (const section of DEP_SECTIONS) {
    const deps = packageJson[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!directDeps.has(name)) directDeps.set(name, { section, range });
    }
  }

  const installed = topLevelVersions(lockfile);

  const bumped = [];
  const guidance = [];
  const skipped = [];
  const warnings = [];

  // 3. For each flagged name: bump if it's a simple-ranged direct dep, else guide.
  for (const [name, reasons] of flagged) {
    const reasonList = [...reasons];
    const direct = directDeps.get(name);

    if (!direct) {
      // Transitive — can't bump a range we don't own; report as guidance.
      guidance.push({ package: name, reasons: reasonList, kind: 'transitive' });
      continue;
    }

    const rangeType = classifyRange(direct.range);
    if (!['exact', 'caret', 'tilde'].includes(rangeType)) {
      skipped.push({ package: name, section: direct.section, range: direct.range, reason: `${rangeType} range — bump manually` });
      continue;
    }

    const current = installed.get(name);
    const registryBase = (current && deriveRegistryBase(current.resolved, name)) || defaultRegistry;
    let latest = null;
    try {
      latest = fetchLatest
        ? await fetchLatest(name, registryBase)
        : await fetchLatestVersion(name, { registryBase, timeoutMs });
    } catch (e) {
      warnings.push({ package: name, reason: `registry unreachable (${e.message})` });
      continue;
    }

    if (!latest) {
      warnings.push({ package: name, reason: 'registry has no latest version' });
      continue;
    }

    const newRange = rewriteRange(direct.range, latest, rangeType);
    if (newRange === direct.range) {
      // Already at latest yet still flagged → latest itself is affected; guide.
      guidance.push({ package: name, reasons: reasonList, kind: 'latest-still-affected', range: direct.range });
      continue;
    }

    bumped.push({
      package: name,
      section: direct.section,
      from: direct.range,
      to: newRange,
      latest,
      fromVersion: current ? current.version : null,
      reasons: reasonList
    });
  }

  // 4. Apply bumps to a fresh package.json + sync the lockfile root entry.
  const newPackageJson = JSON.parse(JSON.stringify(packageJson));
  const newLockfile = { ...lockfile };
  if (bumped.length > 0 && newLockfile.packages && newLockfile.packages['']) {
    newLockfile.packages = { ...newLockfile.packages, '': { ...newLockfile.packages[''] } };
  }
  for (const b of bumped) {
    newPackageJson[b.section] = { ...newPackageJson[b.section], [b.package]: b.to };
    const root = newLockfile.packages && newLockfile.packages[''];
    if (root && root[b.section] && Object.prototype.hasOwnProperty.call(root[b.section], b.package)) {
      root[b.section] = { ...root[b.section], [b.package]: b.to };
    }
  }

  // Stable ordering for readable output.
  bumped.sort((a, b) => a.package.localeCompare(b.package));
  guidance.sort((a, b) => a.package.localeCompare(b.package));
  skipped.sort((a, b) => a.package.localeCompare(b.package));

  return {
    packageJson: newPackageJson,
    lockfile: newLockfile,
    bumped,
    guidance,
    skipped,
    warnings,
    changed: bumped.length > 0
  };
}
