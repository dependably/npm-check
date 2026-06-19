// src/fixer.js
import { migrateToVersion } from './migrator.js';
import { LOCKFILE_VERSIONS } from './format-library.js';
import { deduplicatePackages } from './updater.js';

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
 * True when the value is a non-null object with a usable packages map.
 * @param {object} lockfile - The lockfile to inspect
 * @returns {boolean} Whether `lockfile.packages` is a usable object
 */
function hasPackagesMap(lockfile) {
  return Boolean(lockfile.packages) && typeof lockfile.packages === 'object';
}

/**
 * Sync the lockfile's root identity (name/version) with package.json when
 * provided. A stale name/version here is exactly what the report's
 * "Structure & format" errors flag after a package rename or version bump,
 * and it's safe to correct without re-resolving the dependency tree.
 * Mutates `fixed` (and `fixes`); returns the possibly-replaced lockfile.
 * @param {object} fixed - The working lockfile
 * @param {object} packageJson - The package.json to sync against
 * @param {string[]} fixes - Accumulator for fix descriptions
 * @returns {object} The working lockfile
 */
function syncRootIdentity(fixed, packageJson, fixes) {
  if (!packageJson || typeof packageJson !== 'object') return fixed;

  for (const field of ['name', 'version']) {
    const desired = packageJson[field];
    if (typeof desired !== 'string' || desired === '') continue;

    if (fixed[field] !== desired) {
      fixed[field] = desired;
      fixes.push(`Synced lockfile ${field} to package.json ("${desired}")`);
    }

    if (!fixed.packages || !fixed.packages['']) continue;
    const root = fixed.packages[''];
    if (root[field] !== desired) {
      fixed.packages = { ...fixed.packages, '': { ...root, [field]: desired } };
      fixes.push(`Synced root package ${field} to package.json ("${desired}")`);
    }
  }
  return fixed;
}

/**
 * Run a migration step, translating failures into either a thrown FixerError
 * (when `throwOnError`) or a warning fix entry. Returns the migrated lockfile,
 * or the untouched input when the migration failed without throwing.
 * @param {object} fixed - The working lockfile
 * @param {number} targetVersion - The lockfile version to migrate to
 * @param {string} successMsg - Fix description on success
 * @param {string} failPrefix - Prefix for the failure message
 * @param {boolean} throwOnError - Whether to throw on failure
 * @param {string[]} fixes - Accumulator for fix descriptions
 * @returns {object} The migrated (or untouched) lockfile
 * @throws {FixerError} When migration fails and `throwOnError` is set
 */
function runMigration(fixed, targetVersion, successMsg, failPrefix, throwOnError, fixes) {
  try {
    const migrated = migrateToVersion(fixed, targetVersion);
    fixes.push(successMsg);
    return migrated;
  } catch (e) {
    if (throwOnError) {
      throw new FixerError(`${failPrefix}: ${e.message}`, fixes);
    }
    fixes.push(`⚠️  ${failPrefix}: ${e.message}`);
    return fixed;
  }
}

/**
 * Apply the requested explicit normalization plus the default v1→v2
 * auto-migration. Returns the possibly-migrated lockfile.
 * @param {object} fixed - The working lockfile
 * @param {number|null} normalizeTo - Requested target version, if any
 * @param {boolean} throwOnError - Whether to throw on failure
 * @param {string[]} fixes - Accumulator for fix descriptions
 * @returns {object} The working lockfile
 */
function applyMigrations(fixed, normalizeTo, throwOnError, fixes) {
  const supported = [LOCKFILE_VERSIONS.V1, LOCKFILE_VERSIONS.V2, LOCKFILE_VERSIONS.V3];

  // Normalize format if requested
  if (normalizeTo && supported.includes(normalizeTo)) {
    fixed = runMigration(
      fixed, normalizeTo,
      `Migrated lockfile to v${normalizeTo}`,
      `Failed to migrate lockfile to v${normalizeTo}`,
      throwOnError, fixes,
    );
  }

  // If lockfile is v1 and has dependencies but no packages map, migrate to v2 by default
  if (fixed.lockfileVersion === LOCKFILE_VERSIONS.V1 && fixed.dependencies) {
    fixed = runMigration(
      fixed, LOCKFILE_VERSIONS.V2,
      'Auto-migrated v1 dependencies tree to v2 packages map',
      'Auto-migration v1→v2 failed',
      throwOnError, fixes,
    );
  }
  return fixed;
}

/**
 * Fill placeholder integrity hashes for package entries that have none.
 * Mutates entries in place; the root entry is skipped (it carries no
 * integrity), and entries already holding a placeholder are left untouched.
 * @param {object} fixed - The working lockfile
 * @param {string[]} fixes - Accumulator for fix descriptions
 */
function fillPlaceholderIntegrity(fixed, fixes) {
  if (!hasPackagesMap(fixed)) return;

  for (const [pkgPath, pkg] of Object.entries(fixed.packages)) {
    // Skip root package - it should not have integrity field
    if (pkgPath === '') continue;
    if (!pkg || typeof pkg !== 'object') continue;
    // Already has a placeholder or a real hash, no action needed
    if (pkg.integrity) continue;

    pkg.integrity = 'sha512-PLACEHOLDER';
    fixes.push(`Added placeholder integrity for package at ${pkgPath}`);
  }
}

/**
 * Run the preserve-only deduplication step, reporting how many entries were
 * removed. Failures become a thrown FixerError or a warning fix entry.
 * @param {object} fixed - The working lockfile
 * @param {boolean} throwOnError - Whether to throw on failure
 * @param {string[]} fixes - Accumulator for fix descriptions
 * @returns {object} The working lockfile
 * @throws {FixerError} When deduplication fails and `throwOnError` is set
 */
function applyDedupe(fixed, throwOnError, fixes) {
  if (!hasPackagesMap(fixed)) return fixed;

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
  return fixed;
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

  const { fillMissingIntegrity = true, dedupe = true, normalizeTo = null, throwOnError = false, packageJson = null } = options;

  fixed = syncRootIdentity(fixed, packageJson, fixes);
  fixed = applyMigrations(fixed, normalizeTo, throwOnError, fixes);

  if (fillMissingIntegrity) {
    fillPlaceholderIntegrity(fixed, fixes);
  }

  if (dedupe) {
    fixed = applyDedupe(fixed, throwOnError, fixes);
  }

  return { fixedLockfile: fixed, fixes };
}

export default { fixPackageLock, FixerError };
