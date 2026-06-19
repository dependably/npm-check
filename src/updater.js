/**
 * Updater module for package-lock.json files
 * Optimized implementations for handling large lockfiles efficiently.
 */

import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree, resolvePackageName } from './format-library.js';
import {
  shallowCopyLockfile,
  filterPackagesLazy,
  isLargeLockfile
} from './performance.js';
import { parallelUpgradeIntegrityHashes as parallelUpgrade, parallelDeduplicatePackages as parallelDedupe } from './parallel-processor.js';

// Dependency sections within a package entry whose integrity hashes are
// upgraded recursively alongside the entry's own integrity.
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

// Emit a progress update for the integrity-hash upgrade stage.
function reportUpgradeProgress(onProgress, processed, total) {
  if (!onProgress) return;
  onProgress({ current: processed, total, percentage: Math.round((processed / total) * 100), stage: 'Upgrading integrity hashes' });
}

// Promote a single integrity hash to sha512. sha1 hashes are always promoted;
// other non-sha512 hashes are promoted only when `all` is set.
function upgradeHash(hash, all) {
  if (!hash) return hash;
  if (hash.startsWith('sha1-')) {
    return 'sha512-' + hash.slice(5);
  }
  if (all && !hash.startsWith('sha512-')) {
    return 'sha512-' + hash.slice(hash.indexOf('-') + 1);
  }
  return hash;
}

// Recursively upgrade integrity hashes in a dependency tree, preserving
// non-object entries untouched.
function upgradeDependencies(deps, all) {
  if (!deps || typeof deps !== 'object') return deps;

  const upgraded = {};
  for (const [depName, dep] of Object.entries(deps)) {
    if (!dep || typeof dep !== 'object') {
      upgraded[depName] = dep;
      continue;
    }

    // Upgrade this dependency and recursively upgrade nested ones
    upgraded[depName] = {
      ...dep,
      ...(dep.integrity && { integrity: upgradeHash(dep.integrity, all) }),
      ...(dep.dependencies && { dependencies: upgradeDependencies(dep.dependencies, all) })
    };
  }
  return upgraded;
}

// Upgrade a single package entry's own integrity plus each of its nested
// dependency sections, returning a shallow copy.
function upgradePackageEntry(pkg, all) {
  const upgradedPkg = { ...pkg };

  if (upgradedPkg.integrity) {
    upgradedPkg.integrity = upgradeHash(upgradedPkg.integrity, all);
  }

  for (const section of DEPENDENCY_SECTIONS) {
    if (upgradedPkg[section] && typeof upgradedPkg[section] === 'object') {
      upgradedPkg[section] = upgradeDependencies(upgradedPkg[section], all);
    }
  }

  return upgradedPkg;
}

/**
 * Upgrade integrity hashes in a lockfile
 * @param {object} lockfileData - Lockfile data
 * @param {object} options - Options for upgrade
 * @param {boolean} options.all - Upgrade all hashes (default: false, only sha1)
 * @param {Function} options.onProgress - Progress callback function(progressInfo)
 * @param {boolean} options.parallel - Use parallel processing for large files (default: false)
 * @returns {object|Promise<object>} Updated lockfile data (immutable - returns Promise if parallel)
 */
export function upgradeIntegrityHashes(lockfileData, options = {}) {
  const { all = false, onProgress = null, parallel = false } = options;

  // Use parallel processing if requested and file is large
  if (parallel && isLargeLockfile(lockfileData, 10)) {
    return parallelUpgrade(lockfileData, {
      all,
      onProgress,
      ...options
    });
  }
  const version = detectLockfileVersion(lockfileData);

  if (!hasPackagesMap(version)) {
    return lockfileData;
  }

  // Use shallow copy to avoid deep cloning
  const result = shallowCopyLockfile(lockfileData);

  // Process packages directly without deep recursion
  const packageEntries = Object.entries(result.packages || {});
  const total = packageEntries.length;
  const upgradedPackages = {};
  let processed = 0;

  for (const [path, pkg] of packageEntries) {
    upgradedPackages[path] = pkg ? upgradePackageEntry(pkg, all) : pkg;
    processed++;

    // Null entries report every step; real entries report every 100th.
    if (!pkg) {
      reportUpgradeProgress(onProgress, processed, total);
    } else if (processed % 100 === 0) {
      reportUpgradeProgress(onProgress, processed, total);
    }
  }

  result.packages = upgradedPackages;
  return result;
}

/**
 * Deduplicate packages in a lockfile
 * Uses Map-based deduplication for O(1) lookups
 * @param {object} lockfileData - Lockfile data
 * @param {object} options - Options for deduplication
 * @param {boolean} options.keepLatest - Keep only latest version of duplicates (default: false)
 * @param {Function} options.onProgress - Progress callback function(progressInfo)
 * @param {boolean} options.parallel - Use parallel processing for large files (default: false)
 * @returns {object|Promise<object>} Updated lockfile data (immutable - returns Promise if parallel)
 */
export function deduplicatePackages(lockfileData, options = {}) {
  const { keepLatest = false, onProgress = null, parallel = false } = options;

  // Use parallel processing if requested and file is large
  if (parallel && isLargeLockfile(lockfileData, 10)) {
    return parallelDedupe(lockfileData, {
      keepLatest,
      onProgress,
      ...options
    });
  }
  const version = detectLockfileVersion(lockfileData);

  const result = shallowCopyLockfile(lockfileData);

  // Packages map (v2/v3): keyed by *install path*. Every entry is a distinct,
  // required node — the package name is encoded in the path, so most entries
  // carry no `.name` field at all. There is no safe way to "remove duplicates"
  // here: two entries that share a name@version live at different paths because
  // npm could not hoist them to one location (conflicting dependents), and
  // collapsing them produces an un-installable lockfile. Real npm deduplication
  // is tree hoisting, which requires full re-resolution and is out of scope.
  //
  // So we PRESERVE every path entry. (The previous implementation keyed a map by
  // `name#version` and rebuilt from it, which silently dropped every entry that
  // lacked a `.name` field — i.e. effectively the entire packages map — gutting
  // the lockfile down to the root. See deduplicatePackages preserve tests.)
  // Use `prune` to remove genuinely orphaned (unreachable) entries.
  if (hasPackagesMap(version) && result.packages) {
    const total = Object.keys(result.packages).length;
    if (onProgress) {
      onProgress({ current: total, total, percentage: 100, stage: 'Deduplication complete' });
    }
  }

  // Deduplicate dependencies tree
  if (hasDependenciesTree(version) && result.dependencies) {
    const seenDeps = new Set();
    const dedupedDeps = {};

    for (const [name, dep] of Object.entries(result.dependencies)) {
      if (!seenDeps.has(name)) {
        seenDeps.add(name);
        dedupedDeps[name] = dep;
      }
    }

    result.dependencies = dedupedDeps;
  }

  return result;
}

/**
 * Find packages matching a predicate without full copy (lazy evaluation)
 * Useful for filtering operations on large lockfiles
 * @param {object} lockfileData - Lockfile data
 * @param {Function} predicate - Function(path, pkg) => boolean
 * @returns {object} Filtered packages object
 */
export function findPackagesMatching(lockfileData, predicate) {
  return filterPackagesLazy(lockfileData.packages || {}, predicate);
}

/**
 * Count unique packages in lockfile (efficient for large files)
 * @param {object} lockfileData - Lockfile data
 * @returns {number} Number of unique packages
 */
export function countUniquePackages(lockfileData) {
  if (!lockfileData.packages || typeof lockfileData.packages !== 'object') {
    return 0;
  }

  const uniqueNames = new Set();
  for (const [path, pkg] of Object.entries(lockfileData.packages)) {
    if (!pkg || typeof pkg !== 'object') continue;
    // Derive the name from the path — v2/v3 entries usually have no `.name` field,
    // so reading `pkg.name` alone would miss nearly every real dependency.
    const name = resolvePackageName(path, pkg);
    if (name && name !== '(root)') uniqueNames.add(name);
  }

  return uniqueNames.size;
}

/**
 * Find duplicate packages efficiently
 * @param {object} lockfileData - Lockfile data
 * @returns {Map} Map of package names to array of {path, version} objects
 */
export function findDuplicatePackages(lockfileData) {
  const duplicates = new Map();

  for (const [path, pkg] of Object.entries(lockfileData.packages || {})) {
    if (!pkg || typeof pkg !== 'object') continue;
    // Derive the name from the path — v2/v3 entries usually have no `.name` field.
    const name = resolvePackageName(path, pkg);
    if (!name || name === '(root)') continue;

    if (!duplicates.has(name)) {
      duplicates.set(name, []);
    }

    duplicates.get(name).push({ path, version: pkg.version });
  }

  // Keep only actual duplicates
  for (const [name, entries] of duplicates.entries()) {
    if (entries.length === 1) {
      duplicates.delete(name);
    }
  }

  return duplicates;
}

export default {
  upgradeIntegrityHashes,
  deduplicatePackages,
  findPackagesMatching,
  countUniquePackages,
  findDuplicatePackages
};
