// Placeholder for future updater utilities
import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree, parseLockfile } from './format-library.js';

// Helper function to compare semantic version strings
function compareVersions(v1, v2) {
  const v1Parts = v1.split('.').map(Number);
  const v2Parts = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(v1Parts.length, v2Parts.length); i++) {
    const part1 = v1Parts[i] || 0;
    const part2 = v2Parts[i] || 0;
    if (part1 > part2) return 1;
    if (part1 < part2) return -1;
  }
  return 0;
}

/**
 * Upgrade integrity hashes in a lockfile.
 * @param {object} lockfileData - Lockfile data
 * @param {object} options - Options for upgrade
 * @returns {object} Updated lockfile data
 */
export function upgradeIntegrityHashes(lockfileData, options = {}) {
  const { all = false } = options;
  const version = detectLockfileVersion(lockfileData);

  if (!hasPackagesMap(version)) {
    // No packages map to process
    return lockfileData;
  }

  const upgradeHash = (hash) => {
    if (!hash) return hash;
    if (hash.startsWith('sha1-')) {
      // Mock upgrade: replace sha1 prefix with sha256 and keep rest
      return 'sha256-' + hash.slice(5);
    }
    if (all) return hash; // Keep existing if not sha1
    return hash;
  };

  const processPackage = (pkg) => {
    if (pkg.dependencies) {
      for (const depName of Object.keys(pkg.dependencies)) {
        const dep = pkg.dependencies[depName];
        if (dep.integrity) {
          dep.integrity = upgradeHash(dep.integrity);
        }
        if (dep.dependencies) processPackage(dep);
      }
    }
    if (pkg.devDependencies) {
      for (const depName of Object.keys(pkg.devDependencies)) {
        const dep = pkg.devDependencies[depName];
        if (dep.integrity) dep.integrity = upgradeHash(dep.integrity);
        if (dep.dependencies) processPackage(dep);
      }
    }
    if (pkg.peerDependencies) {
      for (const depName of Object.keys(pkg.peerDependencies)) {
        const dep = pkg.peerDependencies[depName];
        if (dep.integrity) dep.integrity = upgradeHash(dep.integrity);
        if (dep.dependencies) processPackage(dep);
      }
    }
    if (pkg.optionalDependencies) {
      for (const depName of Object.keys(pkg.optionalDependencies)) {
        const dep = pkg.optionalDependencies[depName];
        if (dep.integrity) dep.integrity = upgradeHash(dep.integrity);
        if (dep.dependencies) processPackage(dep);
      }
    }
  };

  for (const [path, pkg] of Object.entries(lockfileData.packages || {})) {
    processPackage(pkg);
  }

  return lockfileData;
}

/**
 * Deduplicate packages in a lockfile.
 * @param {object} lockfileData - Lockfile data
 * @param {object} options - Options for deduplication
 * @returns {object} Updated lockfile data
 */
export function deduplicatePackages(lockfileData, options = {}) {
  const { keepLatest = false } = options;
  const version = detectLockfileVersion(lockfileData);

  // Deduplicate packages map
  if (hasPackagesMap(version)) {
    const uniquePackages = {};
    for (const [path, pkg] of Object.entries(lockfileData.packages || {})) {
      const name = pkg.name;
      if (!name || name === '(root)') continue;
      if (!uniquePackages[name]) {
        uniquePackages[name] = { path, pkg };
      } else {
        const existing = uniquePackages[name];
        if (keepLatest && compareVersions(pkg.version, existing.pkg.version) > 0) {
          uniquePackages[name] = { path, pkg };
        }
      }
    }
    // Rebuild packages map
    const newPackages = {};
    for (const { path, pkg } of Object.values(uniquePackages)) {
      newPackages[path] = pkg;
    }
    lockfileData.packages = newPackages;
  }

  // Deduplicate dependencies tree
  if (hasDependenciesTree(version)) {
    const dedupTree = (deps) => {
      const seen = new Set();
      const result = {};
      for (const [name, dep] of Object.entries(deps || {})) {
        if (seen.has(name)) continue;
        seen.add(name);
        result[name] = dep;
      }
      return result;
    };
    lockfileData.dependencies = dedupTree(lockfileData.dependencies);
  }

  return lockfileData;
}

export default { upgradeIntegrityHashes, deduplicatePackages };
