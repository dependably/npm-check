// src/index.js
export { parseLockfile, serializeLockfile } from './parser.js';
export { validatePackageLock, ValidationError } from './validator.js';
export { migrateToVersion, PackageLockMigrator, MigrationError } from './migrator.js';
export { 
  upgradeIntegrityHashes, 
  deduplicatePackages,
  findPackagesMatching,
  countUniquePackages,
  findDuplicatePackages
} from './updater.js';
export { fixPackageLock, FixerError } from './fixer.js';
export { LOCKFILE_VERSIONS } from './format-library.js';
export {
  shallowCopyLockfile,
  processBatchedPackages,
  getMemoryStats,
  filterPackagesLazy,
  createDedupeMap,
  reconstructFromDedupeMap,
  chunkLockfile,
  mergeLockfileChunks,
  estimateLockfileSize,
  isLargeLockfile
} from './performance.js';
export {
  ProgressReporter,
  createProgressReporter,
  formatProgress,
  createProgressBar
} from './progress-reporter.js';
export {
  StreamingParser,
  parseLockfileStream,
  parseLockfileStreamSync
} from './streaming-parser.js';
export {
  WorkerPool,
  processInParallel,
  parallelUpgradeIntegrityHashes,
  parallelDeduplicatePackages,
  parallelMigrate
} from './parallel-processor.js';
export {
  checkIntegrity,
  checkLicenses,
  checkAll,
  parseLicensesCsv,
  CheckError
} from './checker.js';
