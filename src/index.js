// Package-lock JSON utilities
// Re-export core classes and helpers for external use

export { PackageLockValidator, ValidationError, ValidationResult, validatePackageLock, validateWithPackageJson } from './validator.js';
export { PackageLockMigrator, MigrationError, migrateToVersion, upgradeToV3, downgradeToV1, normalizeToV2 } from './package-lock-migrator.js';
export { LOCKFILE_VERSIONS, LOCKFILE_FORMATS, detectLockfileVersion, getFormatInfo } from './format-library.js';

export default {
  PackageLockValidator,
  ValidationError,
  ValidationResult,
  validatePackageLock,
  validateWithPackageJson,
  PackageLockMigrator,
  MigrationError,
  migrateToVersion,
  upgradeToV3,
  downgradeToV1,
  normalizeToV2,
  LOCKFILE_VERSIONS,
  LOCKFILE_FORMATS,
  detectLockfileVersion,
  getFormatInfo
};