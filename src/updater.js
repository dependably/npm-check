/**
 * Updater module for package-lock.json files
 * Re-exports optimized implementations for clean, immutable operations
 */

export {
  upgradeIntegrityHashesOptimized as upgradeIntegrityHashes,
  deduplicatePackagesOptimized as deduplicatePackages,
  findPackagesMatching,
  countUniquePackages,
  findDuplicatePackages
} from './updater-optimized.js';
