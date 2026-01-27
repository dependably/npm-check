# Package Lockfile Fixer

A comprehensive tool for validating, migrating, fixing, and updating npm `package-lock.json` files across versions 1, 2, and 3.

## Features

- **Validation** – Detects structural, semantic, and integrity issues.
- **Migration** – Seamlessly convert between lockfile versions (v1 ↔ v2 ↔ v3).
- **Fixing** – Automated repair strategies for common issues.
- **Updater** – Upgrade integrity hashes and deduplicate packages.
- **Streaming** – Handle very large lockfiles without loading entire file into memory.
- **Parallel Processing** – Distribute operations across CPU cores for better performance.
- **Progress Tracking** – Real-time progress reporting with ETA for long operations.
- **CLI** – Command-line interface for everyday use.

## Installation

```bash
npm install -g package-lock-fixer
```

## Quick Start

### CLI Usage

The repository includes a lightweight CLI exposed as the `npfix` binary (also aliased as `package-lock-fixer`):

```bash
# Validate a lockfile (defaults to ./package-lock.json)
npfix validate

# Migrate to latest version (v3)
npfix migrate

# Migrate to a specific version
npfix migrate 2

# Run automated fixer (adds placeholders for missing integrity, dedupes packages)
npfix fix --write

# Upgrade integrity hashes
npfix upgrade-hashes --write

# Deduplicate packages
npfix dedupe --write

# Specify a custom file path
npfix validate ./path/to/package-lock.json

# List backups
npfix backups

# Restore from latest backup
npfix restore
```

**Notes:**
- The file argument is optional and defaults to `./package-lock.json` in the current directory.
- The migrate command defaults to version 3 (latest) when no target version is specified.
- The `--write` flag creates automatic backups before modifying files.
- Aliases: `package-lock-fixer` and `npfix` both point to the same CLI.

## API

### Core Functions

```js
import {
  parseLockfile,
  serializeLockfile,
  validatePackageLock,
  migrateToVersion,
  fixPackageLock,
  upgradeIntegrityHashes,
  deduplicatePackages
} from 'package-lock-fixer';

// Parse and validate a lockfile
const lockfile = parseLockfile('package-lock.json');
const { valid, errors } = validatePackageLock(lockfile);

// Migrate between versions
const v3Lockfile = migrateToVersion(lockfile, 3);

// Apply automated fixes
const { fixedLockfile, fixes } = fixPackageLock(lockfile, {
  fillMissingIntegrity: true,
  dedupe: true
});

// Write back to file
serializeLockfile('package-lock.json', fixedLockfile, true);
```

### Performance & Large Files

```js
import {
  shallowCopyLockfile,
  processBatchedPackages,
  getMemoryStats,
  chunkLockfile,
  mergeLockfileChunks,
  isLargeLockfile
} from 'package-lock-fixer';

const lockfile = parseLockfile('large-package-lock.json');

// Check if large file
if (isLargeLockfile(lockfile, 10)) {
  // Process in batches to avoid blocking
  await processBatchedPackages(lockfile.packages, (path, pkg) => {
    // Process each package
  }, 1000);

  // Or chunk for parallel processing
  const chunks = chunkLockfile(lockfile, 5000);
  const processed = chunks.map(chunk => fixPackageLock(chunk));
  const result = mergeLockfileChunks(processed);
}

// Monitor memory usage
const stats = getMemoryStats();
console.log(`Heap: ${stats.heapUsed}MB / ${stats.heapTotal}MB`);
```

### Streaming Large Lockfiles

```js
import { StreamingParser } from 'package-lock-fixer';

const parser = new StreamingParser({
  onPackage: (path, pkg) => {
    console.log(`Parsed package at ${path}`);
  },
  onProgress: (bytesRead, totalBytes) => {
    console.log(`Progress: ${bytesRead}/${totalBytes} bytes`);
  }
});

const lockfile = await parser.parseFile('huge-package-lock.json');
```

### Parallel Processing

```js
import { parallelUpgradeIntegrityHashes, parallelDeduplicatePackages } from 'package-lock-fixer';

const lockfile = parseLockfile('package-lock.json');

// Distribute hash upgrades across CPU cores
const upgraded = await parallelUpgradeIntegrityHashes(lockfile);

// Parallel deduplication
const deduplicated = await parallelDeduplicatePackages(upgraded);
```

### Progress Tracking

```js
import { createProgressReporter } from 'package-lock-fixer';

const progress = createProgressReporter(totalPackages, {
  showMemory: true,
  updateInterval: 100
});

progress.on('update', (info) => {
  console.log(`${info.percentage}% complete, ETA: ${info.estimated}ms`);
});

// Increment progress as you process packages
progress.update();
```

## Advanced Examples

### Complete Workflow

```js
import {
  parseLockfile,
  validatePackageLock,
  fixPackageLock,
  serializeLockfile
} from 'package-lock-fixer';

// 1. Parse
const lockfile = parseLockfile('package-lock.json');

// 2. Validate
const validation = validatePackageLock(lockfile);
if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}

// 3. Fix
const { fixedLockfile, fixes } = fixPackageLock(lockfile, {
  fillMissingIntegrity: true,
  dedupe: true,
  normalizeTo: 3  // Upgrade to v3
});

console.log('Fixes applied:', fixes);

// 4. Write
serializeLockfile('package-lock.json', fixedLockfile, true);
```

### Find and Analyze Issues

```js
import {
  validatePackageLock,
  findDuplicatePackages,
  countUniquePackages
} from 'package-lock-fixer';

const lockfile = parseLockfile('package-lock.json');

// Validation details
const { errors, warnings } = validatePackageLock(lockfile);
errors.forEach(err => console.error(`[${err.code}] ${err.message}`));

// Duplicate analysis
const duplicates = findDuplicatePackages(lockfile);
duplicates.forEach((versions, packageName) => {
  console.log(`${packageName}: ${versions.length} versions found`);
});

console.log(`Total unique packages: ${countUniquePackages(lockfile)}`);
```

## Development & Tests

Run the comprehensive test suite:

```bash
npm test
```

The project includes 130 tests across 11 test suites covering:
- Format detection and validation
- All migration paths (v1 ↔ v2 ↔ v3)
- Updater operations with immutability
- Fixer workflows and error handling
- Backup and restore functionality
- Integrity hash generation
- Streaming parser operations
- Parallel processing operations
- Progress reporting

## Contributing

Pull requests are welcome. Please:
1. Run `npm test` to ensure all tests pass
2. Run `npm run lint` for code quality checks
3. Update tests for any new functionality

## License

MIT
