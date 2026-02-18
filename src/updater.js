/**
 * Updater module for package-lock.json files
 * Optimized implementations for handling large lockfiles efficiently.
 */

import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree } from './format-library.js';
import {
  shallowCopyLockfile,
  createDedupeMap,
  reconstructFromDedupeMap,
  filterPackagesLazy,
  isLargeLockfile
} from './performance.js';
import { parallelUpgradeIntegrityHashes as parallelUpgrade, parallelDeduplicatePackages as parallelDedupe } from './parallel-processor.js';

/**
 * Compare two semver version strings
 * Returns: -1 if v1 < v2, 0 if v1 === v2, 1 if v1 > v2
 * Handles basic semver format (major.minor.patch with optional pre-release/build)
 * @param {string} v1 - First version string
 * @param {string} v2 - Second version string
 * @returns {number} Comparison result
 */
function compareVersions(v1, v2) {
  if (!v1 || !v2) return 0;
  if (v1 === v2) return 0;

  // Parse version strings (handle formats like "1.2.3", "1.2.3-alpha", "1.2.3+build")
  const parseVersion = (v) => {
    // Remove build metadata (everything after +)
    const clean = v.split('+')[0];
    // Split into version and pre-release parts
    const parts = clean.split('-');
    const version = parts[0];
    const prerelease = parts.length > 1 ? parts.slice(1).join('-') : '';

    // Parse major.minor.patch
    const numbers = version.split('.').map(n => parseInt(n, 10) || 0);
    // Ensure we have at least 3 parts (major.minor.patch)
    while (numbers.length < 3) {
      numbers.push(0);
    }

    return {
      major: numbers[0],
      minor: numbers[1],
      patch: numbers[2],
      prerelease
    };
  };

  const parsed1 = parseVersion(v1);
  const parsed2 = parseVersion(v2);

  // Compare major.minor.patch numerically
  if (parsed1.major !== parsed2.major) {
    return parsed1.major > parsed2.major ? 1 : -1;
  }
  if (parsed1.minor !== parsed2.minor) {
    return parsed1.minor > parsed2.minor ? 1 : -1;
  }
  if (parsed1.patch !== parsed2.patch) {
    return parsed1.patch > parsed2.patch ? 1 : -1;
  }

  // If versions are equal, pre-release versions are considered lower
  if (parsed1.prerelease && !parsed2.prerelease) {
    return -1;
  }
  if (!parsed1.prerelease && parsed2.prerelease) {
    return 1;
  }
  if (parsed1.prerelease && parsed2.prerelease) {
    // Simple string comparison for pre-release (could be improved)
    return parsed1.prerelease > parsed2.prerelease ? 1 : (parsed1.prerelease < parsed2.prerelease ? -1 : 0);
  }

  return 0;
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

  const upgradeHash = (hash) => {
    if (!hash) return hash;
    if (hash.startsWith('sha1-')) {
      return 'sha512-' + hash.slice(5);
    }
    if (all && !hash.startsWith('sha512-')) {
      return 'sha512-' + hash.slice(hash.indexOf('-') + 1);
    }
    return hash;
  };

  // Helper to recursively upgrade integrity hashes in dependency trees
  const upgradeDependencies = (deps) => {
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
        ...(dep.integrity && { integrity: upgradeHash(dep.integrity) }),
        ...(dep.dependencies && { dependencies: upgradeDependencies(dep.dependencies) })
      };
    }
    return upgraded;
  };

  // Process packages directly without deep recursion
  const packages = result.packages || {};
  const upgradedPackages = {};
  const packageEntries = Object.entries(packages);
  const total = packageEntries.length;
  let processed = 0;

  for (const [path, pkg] of packageEntries) {
    if (!pkg) {
      upgradedPackages[path] = pkg;
      processed++;
      if (onProgress) {
        onProgress({ current: processed, total, percentage: Math.round((processed / total) * 100), stage: 'Upgrading integrity hashes' });
      }
      continue;
    }

    // Create shallow copy of package
    const upgradedPkg = { ...pkg };

    // Upgrade the package's own integrity
    if (upgradedPkg.integrity) {
      upgradedPkg.integrity = upgradeHash(upgradedPkg.integrity);
    }

    // Upgrade nested integrity hashes recursively
    if (upgradedPkg.dependencies && typeof upgradedPkg.dependencies === 'object') {
      upgradedPkg.dependencies = upgradeDependencies(upgradedPkg.dependencies);
    }

    if (upgradedPkg.devDependencies && typeof upgradedPkg.devDependencies === 'object') {
      upgradedPkg.devDependencies = upgradeDependencies(upgradedPkg.devDependencies);
    }

    if (upgradedPkg.peerDependencies && typeof upgradedPkg.peerDependencies === 'object') {
      upgradedPkg.peerDependencies = upgradeDependencies(upgradedPkg.peerDependencies);
    }

    if (upgradedPkg.optionalDependencies && typeof upgradedPkg.optionalDependencies === 'object') {
      upgradedPkg.optionalDependencies = upgradeDependencies(upgradedPkg.optionalDependencies);
    }

    upgradedPackages[path] = upgradedPkg;
    processed++;

    if (onProgress && processed % 100 === 0) {
      onProgress({ current: processed, total, percentage: Math.round((processed / total) * 100), stage: 'Upgrading integrity hashes' });
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

  // Deduplicate packages map using Map for faster lookups
  if (hasPackagesMap(version) && result.packages) {
    const packages = result.packages;
    const total = Object.keys(packages).length;

    if (onProgress) {
      onProgress({ current: 0, total, percentage: 0, stage: 'Building deduplication map' });
    }

    const dedupeMap = createDedupeMap(packages);

    // Optionally keep only latest versions
    if (keepLatest) {
      if (onProgress) {
        onProgress({ current: Math.floor(total * 0.3), total, percentage: 30, stage: 'Grouping packages by name' });
      }

      // Group packages by name
      const packagesByName = new Map();

      for (const [key, entry] of dedupeMap.entries()) {
        if (!entry || !entry.pkg || !entry.pkg.name) continue;

        const packageName = entry.pkg.name;
        if (!packagesByName.has(packageName)) {
          packagesByName.set(packageName, []);
        }
        packagesByName.get(packageName).push({ key, entry, version: entry.pkg.version || '0.0.0' });
      }

      if (onProgress) {
        onProgress({ current: Math.floor(total * 0.6), total, percentage: 60, stage: 'Finding latest versions' });
      }

      // For each package name, keep only the latest version
      const latestVersionsMap = new Map();
      for (const [, versions] of packagesByName.entries()) {
        if (versions.length === 1) {
          // Only one version, keep it
          latestVersionsMap.set(versions[0].key, versions[0].entry);
        } else {
          // Find latest version using semver comparison
          let latest = versions[0];
          for (let i = 1; i < versions.length; i++) {
            if (compareVersions(versions[i].version, latest.version) > 0) {
              latest = versions[i];
            }
          }
          latestVersionsMap.set(latest.key, latest.entry);
        }
      }

      if (onProgress) {
        onProgress({ current: Math.floor(total * 0.9), total, percentage: 90, stage: 'Reconstructing packages' });
      }

      // Replace dedupeMap with only latest versions
      dedupeMap.clear();
      for (const [key, entry] of latestVersionsMap.entries()) {
        dedupeMap.set(key, entry);
      }
    }

    result.packages = reconstructFromDedupeMap(dedupeMap);

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
  for (const pkg of Object.values(lockfileData.packages)) {
    if (pkg && pkg.name && pkg.name !== '(root)') {
      uniqueNames.add(pkg.name);
    }
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
    if (!pkg || !pkg.name || pkg.name === '(root)') continue;

    if (!duplicates.has(pkg.name)) {
      duplicates.set(pkg.name, []);
    }

    duplicates.get(pkg.name).push({ path, version: pkg.version });
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
