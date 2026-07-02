# Performance Improvements

This document describes the performance optimization features added to handle large lockfiles efficiently.

## Overview

The npm-check now includes specialized performance utilities for handling large lockfiles (10MB+) without consuming excessive memory or CPU resources. These improvements include:

1. **Memory optimization** through shallow copying and lazy evaluation
2. **Batch processing** with automatic garbage collection yielding
3. **Duplicate analysis** using Map-based lookups (O(1) instead of O(n))
4. **Chunking support** for parallel processing or streaming
5. **Performance profiling** utilities for monitoring memory usage

## Key Components

### Performance Module (`src/performance.js`)

Low-level utilities for memory-efficient operations:

```javascript
import {
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
} from '@dependably/npm-check';
```

#### Shallow Copying
```javascript
const copy = shallowCopyLockfile(lockfile);
// Creates a shallow copy to avoid deep cloning overhead
// Useful when only modifying specific nested properties
```

#### Batch Processing
```javascript
await processBatchedPackages(packagesMap, (path, pkg) => {
  // Process each package
  // Automatically yields control every 1000 packages
  // Allows garbage collection to run
}, 1000); // batch size
```

#### Memory Profiling
```javascript
const stats = getMemoryStats();
console.log(`Heap: ${stats.heapUsed}MB / ${stats.heapTotal}MB`);
// Returns: { heapUsed, heapTotal, external, rss } all in MB
```

#### Lazy Filtering
```javascript
const filtered = filterPackagesLazy(packages, (path, pkg) =>
  pkg.name.includes('react')
);
// Creates filtered object without copying unmatched packages
```

#### Efficient Deduplication
```javascript
// Instead of nested object lookups, use Map
const dedupeMap = createDedupeMap(packages);
// O(1) lookup by package name#version key
const dedupedPackages = reconstructFromDedupeMap(dedupeMap);
```

#### Chunking and Merging
```javascript
const chunks = chunkLockfile(largeLockfile, 5000); // 5000 packages per chunk
// Process chunks independently or in parallel
const merged = mergeLockfileChunks(chunks); // Combine results
```

#### Size Detection
```javascript
if (isLargeLockfile(lockfile, 10)) { // 10MB threshold
  // Use optimized functions
  console.log(`Size: ${estimateLockfileSize(lockfile)} bytes`);
}
```

### Updater utilities (`src/updater.js`)

High-level operations using performance utilities:

```javascript
import {
  upgradeIntegrityHashes,
  deduplicatePackages,
  findPackagesMatching,
  countUniquePackages,
  findDuplicatePackages
} from '@dependably/npm-check';
```

#### Optimized Hash Upgrade
```javascript
// Memory-efficient: processes packages once, uses shallow copies
const result = upgradeIntegrityHashes(lockfile, {
  all: false  // only upgrade sha1 hashes
});
```

#### Duplicate analysis

`findDuplicatePackages` reports `name -> [{path, version}, ...]` across the tree
using a Map (O(1) lookups instead of nested scans). Note: `deduplicatePackages`
is **preserve-only** for the v2/v3 packages map — it never drops path-keyed
entries (npm's real dedupe is tree hoisting, which needs full re-resolution).

```javascript
const duplicates = findDuplicatePackages(lockfile);
for (const [name, versions] of duplicates) {
  console.log(`${name} has ${versions.length} versions`);
}
```

#### Package Matching
```javascript
// Lazy evaluation: doesn't copy unmatched packages
const reactPackages = findPackagesMatching(lockfile, (path, pkg) =>
  pkg.name && pkg.name.includes('react')
);
```

#### Package Analysis
```javascript
const uniqueCount = countUniquePackages(lockfile);
// Fast Set-based counting

const duplicates = findDuplicatePackages(lockfile);
// Returns Map of name -> [{path, version}, ...]
for (const [name, versions] of duplicates) {
  console.log(`${name} has ${versions.length} versions`);
}
```

## Performance Characteristics

There is no benchmark harness in this repository, so no absolute numbers are
claimed here. The wins come from the algorithmic shape of the optimized paths:

- **Shallow copying** duplicates only the top-level structure instead of deep
  cloning every package entry, so peak memory scales with the number of
  *modified* entries rather than the whole lockfile.
- **Map-based deduplication** replaces nested object scans with O(1)
  `name#version` key lookups, turning an O(n²)-shaped pass into O(n).
- **Batch processing** yields to the event loop between batches
  (`setImmediate`), letting garbage collection reclaim memory mid-run instead
  of accumulating a single giant working set.
- **Lazy filtering** creates entries only for matches, never copying the
  unmatched majority.
- **Chunking** bounds the working set per chunk, so very large lockfiles can be
  processed (or parallelized) without ever holding a second full copy.

## Usage Examples

### Example 1: Process Large Lockfile with Limited Memory

```javascript
import {
  isLargeLockfile,
  processBatchedPackages,
  upgradeIntegrityHashes
} from '@dependably/npm-check';
import fs from 'fs';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

if (isLargeLockfile(lockfile, 10)) {
  console.log('Large lockfile detected, using optimized functions...');

  // Use batch processing to avoid memory spikes
  const upgraded = upgradeIntegrityHashes(lockfile);
  fs.writeFileSync('package-lock.json', JSON.stringify(upgraded, null, 2));
}
```

### Example 2: Find and Report Duplicates

```javascript
import { findDuplicatePackages, countUniquePackages } from '@dependably/npm-check';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const uniqueCount = countUniquePackages(lockfile);
const duplicates = findDuplicatePackages(lockfile);

console.log(`Total unique packages: ${uniqueCount}`);
console.log(`Packages with multiple versions: ${duplicates.size}`);

for (const [name, versions] of duplicates) {
  console.log(`  ${name}:`);
  for (const { path, version } of versions) {
    console.log(`    - ${version} (${path})`);
  }
}
```

### Example 3: Process in Chunks for Parallel Operations

```javascript
import { chunkLockfile, mergeLockfileChunks } from '@dependably/npm-check';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));
const chunks = chunkLockfile(lockfile, 1000); // 1000 packages per chunk

// Process chunks independently (CPU-bound operations)
const processed = chunks.map(chunk => {
  // Apply transformations to chunk
  return transformChunk(chunk);
});

const merged = mergeLockfileChunks(processed);
console.log(`Processed ${Object.keys(merged.packages).length} packages`);
```

### Example 4: Memory Monitoring During Operations

```javascript
import { getMemoryStats, processBatchedPackages } from '@dependably/npm-check';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json', 'utf8'));

console.log('Starting:', getMemoryStats());

await processBatchedPackages(lockfile.packages, (path, pkg) => {
  // Your processing logic
}, 500);

console.log('After processing:', getMemoryStats());
```

## Best Practices

1. **Use `isLargeLockfile()` to detect when optimization is needed**
   - Default threshold is 10MB, adjust as needed
   - Avoids unnecessary overhead for small lockfiles

2. **Use the parallel variants for very large files**
   - `parallelUpgradeIntegrityHashes` vs `upgradeIntegrityHashes`
   - `parallelDeduplicatePackages` vs `deduplicatePackages`
   - Distributes work across CPU cores; avoids deep-cloning the whole lockfile per operation

3. **Use batch processing for streaming scenarios**
   - Allows garbage collection between batches
   - Prevents memory fragmentation for very large files

4. **Monitor memory with `getMemoryStats()`**
   - Call before/after operations
   - Helps identify performance bottlenecks

5. **Use chunking for parallel processing**
   - Split large lockfiles into chunks
   - Process independently (CPU-bound operations)
   - Merge results afterward

## Internal Implementation Notes

- **Shallow copies**: Copy structure, not data — avoids a full deep clone
- **Batch processing**: Uses `setImmediate` to yield control, allowing GC
- **Map-based duplicate analysis**: O(1) lookups instead of nested object searches
- **Lazy filtering**: Doesn't copy unmatched packages, only creates entries for matches
- **Memory stats**: Uses Node.js `process.memoryUsage()`, values in MB

## Testing

Performance utilities are covered by `tests/unit/performance.test.js` and
`tests/unit/updater.test.js`. Run with `npm test`.
