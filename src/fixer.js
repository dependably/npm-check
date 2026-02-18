// src/fixer.js
import { migrateToVersion } from './migrator.js';
import { LOCKFILE_VERSIONS } from './format-library.js';
import { deduplicatePackages } from './updater.js';
import { isPlaceholder } from './integrity.js';

/**
 * Fixer error class for explicit error reporting
 */
export class FixerError extends Error {
  constructor(message, fixes = []) {
    super(message);
    this.name = 'FixerError';
    this.fixes = fixes;
  }
}

/**
 * Attempt to automatically fix common package-lock issues.
 * Returns { fixedLockfile, fixes } where `fixes` is an array of descriptions.
 * @param {object} lockfile - The lockfile to fix
 * @param {object} options - Fix options
 * @returns {{fixedLockfile: object, fixes: string[]}} Result with fixed lockfile and descriptions
 * @throws {FixerError} If a critical error occurs during fixing
 */
export function fixPackageLock(lockfile, options = {}) {
  const fixes = [];
  let fixed = { ...lockfile };

  const { fillMissingIntegrity = true, dedupe = true, normalizeTo = null, throwOnError = false } = options;

  // Normalize format if requested
  if (normalizeTo && [LOCKFILE_VERSIONS.V1, LOCKFILE_VERSIONS.V2, LOCKFILE_VERSIONS.V3].includes(normalizeTo)) {
    try {
      fixed = migrateToVersion(fixed, normalizeTo);
      fixes.push(`Migrated lockfile to v${normalizeTo}`);
    } catch (e) {
      if (throwOnError) {
        throw new FixerError(`Failed to migrate lockfile to v${normalizeTo}: ${e.message}`, fixes);
      }
      fixes.push(`⚠️  Migration to v${normalizeTo} failed: ${e.message}`);
    }
  }

  // If lockfile is v1 and has dependencies but no packages map, migrate to v2 by default
  if (fixed.lockfileVersion === LOCKFILE_VERSIONS.V1 && fixed.dependencies) {
    try {
      fixed = migrateToVersion(fixed, LOCKFILE_VERSIONS.V2);
      fixes.push('Auto-migrated v1 dependencies tree to v2 packages map');
    } catch (e) {
      if (throwOnError) {
        throw new FixerError(`Auto-migration v1→v2 failed: ${e.message}`, fixes);
      }
      fixes.push(`⚠️  Auto-migration v1→v2 failed: ${e.message}`);
    }
  }

  // Fill placeholder integrity hashes when missing
  if (fillMissingIntegrity && fixed.packages && typeof fixed.packages === 'object') {
    for (const [pkgPath, pkg] of Object.entries(fixed.packages)) {
      // Skip root package - it should not have integrity field
      if (pkgPath === '') continue;
      if (pkg && typeof pkg === 'object') {
        if (!pkg.integrity) {
          pkg.integrity = 'sha512-PLACEHOLDER';
          fixes.push(`Added placeholder integrity for package at ${pkgPath}`);
        } else if (isPlaceholder(pkg.integrity)) {
          // Already has placeholder, no action needed
          continue;
        }
      }
    }
  }

  // Deduplicate packages map when requested
  if (dedupe && fixed.packages && typeof fixed.packages === 'object') {
    try {
      const beforeCount = Object.keys(fixed.packages).length;
      fixed = deduplicatePackages(fixed, { keepLatest: true });
      const afterCount = Object.keys(fixed.packages).length;
      if (afterCount < beforeCount) {
        fixes.push(`Deduplicated packages: removed ${beforeCount - afterCount} entries`);
      }
    } catch (e) {
      if (throwOnError) {
        throw new FixerError(`Deduplication failed: ${e.message}`, fixes);
      }
      fixes.push(`⚠️  Deduplication failed: ${e.message}`);
    }
  }

  return { fixedLockfile: fixed, fixes };
}

export default { fixPackageLock, FixerError };
