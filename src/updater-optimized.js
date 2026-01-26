/**
 * Performance-optimized updater for handling large lockfiles efficiently.
 * Uses batch processing and memory optimization strategies.
 */

import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree } from './format-library.js';
import {
  shallowCopyLockfile,
  createDedupeMap,
  reconstructFromDedupeMap,
  filterPackagesLazy
} from './performance.js';/**
 * Upgrade integrity hashes in a lockfile (optimized for large files)
 * @param {object} lockfileData - Lockfile data
 * @param {object} options - Options for upgrade
 * @returns {object} Updated lockfile data
 */
export function upgradeIntegrityHashesOptimized(lockfileData, options = {}) {
  const { all = false } = options;
  const version = detectLockfileVersion(lockfileData);

  if (!hasPackagesMap(version)) {
    return lockfileData;
  }

  // Use shallow copy to avoid deep cloning
  const result = shallowCopyLockfile(lockfileData);

  const upgradeHash = (hash) => {
    if (!hash) return hash;
    if (hash.startsWith('sha1-')) {
      return 'sha256-' + hash.slice(5);
    }
    if (all) return hash;
    return hash;
  };

  // Process packages directly without deep recursion
  const packages = result.packages || {};
  const upgradedPackages = {};

  for (const [path, pkg] of Object.entries(packages)) {
    if (!pkg) {
      upgradedPackages[path] = pkg;
      continue;
    }

    // Create shallow copy of package
    const upgradedPkg = { ...pkg };

    // Upgrade the package's own integrity
    if (upgradedPkg.integrity) {
      upgradedPkg.integrity = upgradeHash(upgradedPkg.integrity);
    }

    // Upgrade nested integrity hashes with single-level iteration
    if (upgradedPkg.dependencies && typeof upgradedPkg.dependencies === 'object') {
      upgradedPkg.dependencies = { ...upgradedPkg.dependencies };
      for (const [depName, dep] of Object.entries(upgradedPkg.dependencies)) {
        if (dep && dep.integrity) {
          upgradedPkg.dependencies[depName] = {
            ...dep,
            integrity: upgradeHash(dep.integrity)
          };
        }
      }
    }

    if (upgradedPkg.devDependencies && typeof upgradedPkg.devDependencies === 'object') {
      upgradedPkg.devDependencies = { ...upgradedPkg.devDependencies };
      for (const [depName, dep] of Object.entries(upgradedPkg.devDependencies)) {
        if (dep && dep.integrity) {
          upgradedPkg.devDependencies[depName] = {
            ...dep,
            integrity: upgradeHash(dep.integrity)
          };
        }
      }
    }

    if (upgradedPkg.peerDependencies && typeof upgradedPkg.peerDependencies === 'object') {
      upgradedPkg.peerDependencies = { ...upgradedPkg.peerDependencies };
      for (const [depName, dep] of Object.entries(upgradedPkg.peerDependencies)) {
        if (dep && dep.integrity) {
          upgradedPkg.peerDependencies[depName] = {
            ...dep,
            integrity: upgradeHash(dep.integrity)
          };
        }
      }
    }

    if (upgradedPkg.optionalDependencies && typeof upgradedPkg.optionalDependencies === 'object') {
      upgradedPkg.optionalDependencies = { ...upgradedPkg.optionalDependencies };
      for (const [depName, dep] of Object.entries(upgradedPkg.optionalDependencies)) {
        if (dep && dep.integrity) {
          upgradedPkg.optionalDependencies[depName] = {
            ...dep,
            integrity: upgradeHash(dep.integrity)
          };
        }
      }
    }

    upgradedPackages[path] = upgradedPkg;
  }

  result.packages = upgradedPackages;
  return result;
}

/**
 * Deduplicate packages in a lockfile (optimized for large files)
 * Uses Map-based deduplication for O(1) lookups
 * @param {object} lockfileData - Lockfile data
 * @param {object} options - Options for deduplication
 * @returns {object} Updated lockfile data
 */
export function deduplicatePackagesOptimized(lockfileData, options = {}) {
  const { keepLatest = false } = options;
  const version = detectLockfileVersion(lockfileData);

  const result = shallowCopyLockfile(lockfileData);

  // Deduplicate packages map using Map for faster lookups
  if (hasPackagesMap(version) && result.packages) {
    const dedupeMap = createDedupeMap(result.packages);

    // Optionally keep only latest versions
    if (keepLatest) {
      const keysToProcess = Array.from(dedupeMap.keys());
      for (const key of keysToProcess) {
        const entry = dedupeMap.get(key);
        if (entry && entry.pkg) {
          // For now, we keep the first occurrence
          // A full implementation would check all versions per package name
        }
      }
    }

    result.packages = reconstructFromDedupeMap(dedupeMap);
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
  upgradeIntegrityHashesOptimized,
  deduplicatePackagesOptimized,
  findPackagesMatching,
  countUniquePackages,
  findDuplicatePackages
};
