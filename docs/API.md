# API guide

`@dependably/npm-check` is usable as a library (ESM). Import from the package root.

## Core functions

```js
import {
  parseLockfile,
  serializeLockfile,
  validatePackageLock,
  migrateToVersion,
  fixPackageLock,
  upgradeIntegrityHashes,
  deduplicatePackages,
  checkIntegrity,
  checkLicenses,
  checkAll,
  parseLicensesCsv
} from '@dependably/npm-check';

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

## Checking integrity and licenses

```js
// Check integrity hashes
const { valid: hashesValid, passed, failed, errors } = await checkIntegrity(
  lockfile,
  {
    nodeModulesPath: './node_modules',
    onProgress: (progress) => console.log(progress.percentage + '%')
  }
);

// Check licenses
const approvedLicenses = await parseLicensesCsv('./approved-licenses.csv');
const { valid: licensesValid, approved, rejected, warnings } = await checkLicenses(
  lockfile,
  {
    nodeModulesPath: './node_modules',
    csvPath: './approved-licenses.csv',
    strict: false, // Unknown licenses are warnings, not errors
    onProgress: (progress) => console.log(progress.percentage + '%')
  }
);

// Or run both checks at once
const { valid, integrity, licenses } = await checkAll(lockfile, {
  nodeModulesPath: './node_modules',
  csvPath: './approved-licenses.csv',
  strict: false
});
```

Common options: `nodeModulesPath` (default `'./node_modules'`), `csvPath` (license check; default `'./approved-licenses.csv'`), `strict` (license check; treat unknown licenses as errors, default `false`), and `onProgress` (callback with `{ current, total, percentage, stage }`).

## Large lockfiles (performance utilities)

Utilities for processing very large lockfiles without loading or copying everything at once — batching, chunking, streaming parsing, parallel processing, and progress reporting:

```js
import {
  isLargeLockfile,
  processBatchedPackages,
  chunkLockfile,
  mergeLockfileChunks,
  StreamingParser,
  parallelUpgradeIntegrityHashes,
  createProgressReporter
} from '@dependably/npm-check';

const lockfile = parseLockfile('large-package-lock.json');

if (isLargeLockfile(lockfile, 10)) {           // 10MB threshold
  await processBatchedPackages(lockfile.packages, (path, pkg) => {
    // Process each package; yields for GC every batch
  }, 1000);
}
```

See the [performance guide](PERFORMANCE.md) for the full API (shallow copies, lazy filtering, memory stats, streaming, parallel processing, progress tracking).

## Complete workflow

```js
import {
  parseLockfile,
  validatePackageLock,
  fixPackageLock,
  serializeLockfile
} from '@dependably/npm-check';

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

## Find and analyze issues

```js
import {
  parseLockfile,
  validatePackageLock,
  findDuplicatePackages,
  countUniquePackages
} from '@dependably/npm-check';

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
