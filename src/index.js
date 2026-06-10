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
export {
  LOCKFILE_VERSIONS,
  detectLockfileVersion,
  hasPackagesMap,
  hasDependenciesTree,
  forEachPackageEntry,
  resolvePackageName
} from './format-library.js';
export {
  createBackup,
  listBackups,
  restoreFromLatestBackup,
  cleanOldBackups,
  BackupError
} from './backup.js';
export {
  generateIntegrityFromData,
  generateIntegrityFromFile,
  generateIntegrityFromRegistry,
  generateOrPlaceholderIntegrity,
  fetchPackumentIntegrity,
  isValidIntegrity,
  isPlaceholder,
  DEFAULT_REGISTRY
} from './integrity.js';
export {
  fixChecksums,
  deriveRegistryBase,
  ChecksumFixError
} from './checksum-fixer.js';
export {
  pinVersions,
  classifyRange,
  detectIndent,
  PinnerError
} from './pinner.js';
export {
  runAudit,
  formatAuditReport,
  rules as auditRules,
  AuditError
} from './audit.js';
export {
  findOrphanedPackages,
  prunePackages,
  PrunerError
} from './pruner.js';
export {
  scanUsedPackages,
  findUnusedDependencies,
  specifierToPackageName,
  UsageScannerError
} from './usage-scanner.js';
export {
  loadAuditConfig,
  mergeConfig,
  normalizeRuleEntry,
  DEFAULT_CONFIG as DEFAULT_AUDIT_CONFIG,
  CONFIG_FILENAMES as AUDIT_CONFIG_FILENAMES,
  AuditConfigError
} from './audit-config.js';
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
  hashPackageDirectory,
  CheckError
} from './checker.js';
