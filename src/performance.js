/**
 * Performance utilities for handling large lockfiles efficiently.
 * Includes streaming, memory optimization, and batch processing strategies.
 */
import { resolvePackageName } from './format-library.js';

/**
 * Create a shallow copy of a lockfile to avoid deep cloning
 * Useful when only modifying specific nested properties
 * @param {object} lockfile - The lockfile to copy
 * @returns {object} Shallow copy of lockfile
 */
export function shallowCopyLockfile(lockfile) {
  if (!lockfile || typeof lockfile !== 'object') return lockfile;

  const copy = { ...lockfile };

  // Shallow copy packages if present
  if (lockfile.packages && typeof lockfile.packages === 'object') {
    copy.packages = { ...lockfile.packages };
  }

  // Shallow copy dependencies if present
  if (lockfile.dependencies && typeof lockfile.dependencies === 'object') {
    copy.dependencies = { ...lockfile.dependencies };
  }

  return copy;
}

/**
 * Invoke a progress callback for a completed batch, computing the percentage
 * @param {Function|null} onProgress - Progress callback function(progressInfo)
 * @param {number} processed - Number of packages processed so far
 * @param {number} total - Total number of packages
 * @param {string} stage - Stage name for progress reporting
 * @returns {void}
 */
function reportBatchProgress(onProgress, processed, total, stage) {
  if (!onProgress) return;

  const percentage = total > 0 ? Math.round((processed / total) * 100) : 0;
  onProgress({
    current: processed,
    total,
    percentage,
    stage
  });
}

/**
 * Process packages in batches to reduce memory pressure
 * @param {object} packagesMap - The packages object to process
 * @param {Function} processor - Function to apply to each package (called as processor(path, pkg))
 * @param {number|Object} batchSizeOrOptions - Batch size (number) or options object
 * @param {number} batchSizeOrOptions.batchSize - Number of packages per batch (default: 1000)
 * @param {Function} batchSizeOrOptions.onProgress - Progress callback function(progressInfo)
 * @param {string} batchSizeOrOptions.stage - Stage name for progress reporting
 * @returns {Promise<void>}
 */
export async function processBatchedPackages(packagesMap, processor, batchSizeOrOptions = 1000) {
  if (!packagesMap || typeof packagesMap !== 'object') {
    return;
  }

  // Handle both old signature (batchSize as number) and new signature (options object)
  const options = typeof batchSizeOrOptions === 'object' ? batchSizeOrOptions : { batchSize: batchSizeOrOptions };
  const batchSize = options.batchSize || 1000;
  const onProgress = options.onProgress || null;
  const stage = options.stage || 'Processing packages';

  const entries = Object.entries(packagesMap);
  const total = entries.length;
  let processed = 0;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);

    for (const [path, pkg] of batch) {
      processor(path, pkg);
      processed++;
    }

    // Report progress if callback provided
    reportBatchProgress(onProgress, processed, total, stage);

    // Yield control to allow garbage collection
    if (i + batchSize < entries.length) {
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

/**
 * Get memory usage estimate for current process
 * @returns {object} Object with memory stats (heapUsed, heapTotal, external, rss in MB)
 */
export function getMemoryStats() {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const mem = process.memoryUsage();
    return {
      heapUsed: Math.round(mem.heapUsed / 1024 / 1024 * 100) / 100,
      heapTotal: Math.round(mem.heapTotal / 1024 / 1024 * 100) / 100,
      external: Math.round(mem.external / 1024 / 1024 * 100) / 100,
      rss: Math.round(mem.rss / 1024 / 1024 * 100) / 100
    };
  }
  return null;
}

/**
 * Create a filtered view of packages without full copy
 * Useful for operations that only need to inspect certain packages
 * @param {object} packagesMap - The packages map to filter
 * @param {Function} predicate - Function that returns true for packages to include
 * @returns {object} New object with only matching packages
 */
export function filterPackagesLazy(packagesMap, predicate) {
  const filtered = {};

  for (const [path, pkg] of Object.entries(packagesMap || {})) {
    if (predicate(path, pkg)) {
      filtered[path] = pkg;
    }
  }

  return filtered;
}

/**
 * Optimize deduplication by using a Map instead of nested objects
 * Faster lookups for large collections
 * @param {object} packagesMap - The packages object to deduplicate
 * @returns {Map} Map with deduped entries (key: packageName#version, value: {path, pkg})
 */
export function createDedupeMap(packagesMap) {
  const dedupeMap = new Map();

  for (const [path, pkg] of Object.entries(packagesMap || {})) {
    if (!pkg || typeof pkg !== 'object') continue;
    // Derive the name from the path — v2/v3 entries usually have no `.name` field,
    // so keying off `pkg.name` alone silently drops nearly every real entry.
    const name = resolvePackageName(path, pkg);
    if (!name) continue;

    const key = `${name}#${pkg.version || 'unknown'}`;

    if (!dedupeMap.has(key)) {
      dedupeMap.set(key, { path, pkg });
    }
  }

  return dedupeMap;
}

/**
 * Reconstruct packages object from a dedupe map
 * @param {Map} dedupeMap - Map created by createDedupeMap
 * @returns {object} Reconstructed packages object
 */
export function reconstructFromDedupeMap(dedupeMap) {
  const packages = {};

  for (const { path, pkg } of dedupeMap.values()) {
    packages[path] = pkg;
  }

  return packages;
}

/**
 * Split a large lockfile into manageable chunks for processing
 * Useful for parallel processing or streaming
 * @param {object} lockfile - The lockfile to chunk
 * @param {number} chunkSize - Number of packages per chunk (default: 5000)
 * @returns {Array<object>} Array of partial lockfile objects
 */
export function chunkLockfile(lockfile, chunkSize = 5000) {
  if (!lockfile.packages) {
    return [lockfile];
  }

  const chunks = [];
  const entries = Object.entries(lockfile.packages);

  for (let i = 0; i < entries.length; i += chunkSize) {
    const packageChunk = Object.fromEntries(
      entries.slice(i, i + chunkSize)
    );

    const chunk = {
      ...lockfile,
      packages: packageChunk
    };

    chunks.push(chunk);
  }

  return chunks.length > 0 ? chunks : [lockfile];
}

/**
 * Merge multiple processed lockfile chunks back into a single lockfile
 * Assumes chunks have the same metadata (lockfileVersion, etc)
 * @param {Array<object>} chunks - Array of lockfile chunks
 * @returns {object} Merged lockfile
 */
export function mergeLockfileChunks(chunks) {
  if (chunks.length === 0) {
    return {};
  }

  if (chunks.length === 1) {
    return chunks[0];
  }

  // Use first chunk as base
  const merged = { ...chunks[0] };
  merged.packages = {};

  // Merge all packages from all chunks
  for (const chunk of chunks) {
    if (chunk.packages && typeof chunk.packages === 'object') {
      Object.assign(merged.packages, chunk.packages);
    }
  }

  return merged;
}

/**
 * Estimate the size of a lockfile in memory (approximate)
 * @param {object} lockfile - The lockfile to measure
 * @returns {number} Approximate size in bytes
 */
export function estimateLockfileSize(lockfile) {
  // This is a rough estimate using JSON.stringify
  try {
    const json = JSON.stringify(lockfile);
    return json.length;
  } catch {
    return 0;
  }
}

/**
 * Check if a lockfile is considered "large" (over threshold)
 * @param {object} lockfile - The lockfile to check
 * @param {number} thresholdMB - Size threshold in MB (default: 10)
 * @returns {boolean} True if lockfile size exceeds threshold
 */
export function isLargeLockfile(lockfile, thresholdMB = 10) {
  // Heuristics: use JSON size estimate, but also fallback to package count for very large maps
  const estimatedBytes = estimateLockfileSize(lockfile);
  const estimatedMB = estimatedBytes / 1024 / 1024;

  if (estimatedMB > thresholdMB) return true;

  // If packages map exists and is extremely large, consider it large regardless of JSON size estimate
  try {
    if (lockfile && lockfile.packages && typeof lockfile.packages === 'object') {
      const pkgCount = Object.keys(lockfile.packages).length;
      if (pkgCount > 10000) return true;
    }
  } catch {
    // ignore and fall through
  }

  return false;
}

export default {
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
};
