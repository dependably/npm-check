// src/index.js
export { parseLockfile, serializeLockfile } from './parser.js';
export { validatePackageLock, ValidationError } from './validator.js';
export { migrateToVersion, PackageLockMigrator, MigrationError } from './migrator.js';
export { upgradeIntegrityHashes, deduplicatePackages } from './updater.js';
export { fixPackageLock } from './fixer.js';
export { LOCKFILE_VERSIONS } from './format-library.js';
