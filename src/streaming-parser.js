/**
 * Buffered parser for large package-lock.json files.
 *
 * NOTE: despite the "streaming" name, these helpers read the file in chunks (so
 * progress can be reported) but parse the fully-buffered content with the shared
 * `parseLockfile` from format-library — they do NOT parse incrementally. A true
 * incremental JSON parser is future work. The buffered approach is honest about
 * its result: it returns the actual parsed lockfile (or throws), never an empty
 * skeleton that would make every downstream integrity/vuln/license check pass
 * vacuously.
 */

import fs from 'fs';
import { EventEmitter } from 'events';
import { parseLockfile as parseLockfileFromFormat } from './format-library.js';

// Record one incremental `package` event into the accumulating lockfile: the
// root ('') merges into rootMetadata, others land in the packages map.
function recordStreamPackage(path, pkg, lockfile, rootMetadata, options) {
  if (path === '') {
    Object.assign(rootMetadata, pkg); // root package → root metadata
  } else {
    lockfile.packages[path] = pkg;
  }
  if (options.onPackage) options.onPackage(path, pkg);
}

// Assemble the final result from the buffered `complete` event. The parsed result
// is authoritative; anything the (currently no-op) incremental events collected is
// layered on WITHOUT injecting empty skeleton keys — a v3 file must not gain a
// spurious `dependencies: {}`, nor a v1 file a `packages: {}`, which a write-back
// would then persist.
function assembleStreamResult(result, lockfile, rootMetadata) {
  const parsed = (result && typeof result === 'object') ? result : {};
  const merged = { ...parsed };
  for (const [k, v] of Object.entries(rootMetadata)) {
    if (!(k in merged)) merged[k] = v;
  }
  if (Object.keys(lockfile.packages).length > 0) {
    merged.packages = { ...(parsed.packages || {}), ...lockfile.packages };
  }
  return merged;
}

/**
 * Streaming parser for package-lock.json files
 * Handles large files by parsing incrementally
 */
export class StreamingParser extends EventEmitter {
  /**
   * Create a streaming parser
   * @param {Object} options - Parser options
   * @param {Function} options.onPackage - Callback when package is parsed (path, pkg)
   * @param {Function} options.onProgress - Progress callback (bytesRead, totalBytes)
   * @param {number} options.chunkSize - Read chunk size in bytes (default: 64KB)
   */
  constructor(options = {}) {
    super();
    this.onPackageCallback = options.onPackage || null;
    this.onProgressCallback = options.onProgress || null;
    this.chunkSize = options.chunkSize || 64 * 1024;
    this.buffer = '';
    this.state = 'initial';
    this.depth = 0;
    this.currentPath = null;
    this.currentPackage = null;
    this.inString = false;
    this.escapeNext = false;
    this.bytesRead = 0;
    this.totalBytes = 0;
  }

  /**
   * Parse a lockfile from file path using streaming
   * @param {string} filePath - Path to lockfile
   * @param {Object} options - Parser options
   * @returns {Promise<Object>} Parsed lockfile object
   */
  static async parseLockfileStream(filePath, options = {}) {
    const stats = fs.statSync(filePath);
    const totalBytes = stats.size;

    const parser = new StreamingParser({
      ...options,
      onProgress: (bytesRead) => {
        if (options.onProgress) {
          options.onProgress(bytesRead, totalBytes);
        }
      }
    });

    parser.totalBytes = totalBytes;

    return new Promise((resolve, reject) => {
      const lockfile = {
        packages: {},
        dependencies: {}
      };

      // Collect root metadata
      let rootMetadata = {};

      parser.on('package', (path, pkg) => recordStreamPackage(path, pkg, lockfile, rootMetadata, options));
      parser.on('metadata', (key, value) => {
        rootMetadata[key] = value;
      });
      parser.on('error', reject);
      parser.on('complete', (result) => resolve(assembleStreamResult(result, lockfile, rootMetadata)));

      const stream = fs.createReadStream(filePath, {
        encoding: 'utf8',
        highWaterMark: parser.chunkSize
      });

      stream.on('data', (chunk) => {
        parser.processChunk(chunk);
      });

      stream.on('end', () => {
        parser.finish();
      });

      stream.on('error', reject);
    });
  }

  /**
   * Process a chunk of data
   * @param {string} chunk - Data chunk
   */
  processChunk(chunk) {
    this.buffer += chunk;
    this.bytesRead += Buffer.byteLength(chunk, 'utf8');

    if (this.onProgressCallback) {
      this.onProgressCallback(this.bytesRead);
    }

    // Simple approach: For very large files, fall back to standard parsing
    // but do it in a way that doesn't block. For now, we'll use a hybrid approach.
    // If buffer gets too large, parse what we have and continue.

    // For package-lock.json, the structure is predictable enough that we can
    // use a simpler incremental approach: read the file in chunks and parse
    // the packages map incrementally.

    // Since full streaming JSON parsing is complex, we'll use a pragmatic approach:
    // For files under a certain size, use standard parsing.
    // For larger files, we'll implement a simplified streaming parser that
    // extracts packages one by one.
  }

  /**
   * Finish parsing
   */
  finish() {
    if (this.buffer.trim()) {
      try {
        // Parse the fully-buffered content through the shared format-library
        // parser (consistent error messages; not raw JSON.parse).
        const parsed = parseLockfileFromFormat(this.buffer);
        this.emit('complete', parsed);
      } catch (error) {
        this.emit('error', error);
      }
    } else {
      // An empty stream is not a valid lockfile. Fail loudly rather than
      // resolving an empty (vacuously "clean") lockfile.
      this.emit('error', new Error('Cannot parse lockfile: stream produced no data'));
    }
  }
}

/**
 * Parse lockfile using streaming approach for large files
 * Falls back to standard parsing for smaller files
 * @param {string} filePath - Path to lockfile
 * @param {Object} options - Options
 * @param {Function} options.onPackage - Callback when package parsed
 * @param {Function} options.onProgress - Progress callback
 * @param {number} options.streamingThreshold - File size threshold in bytes for streaming (default: 10MB)
 * @returns {Promise<Object>} Parsed lockfile
 */
export async function parseLockfileStream(filePath, options = {}) {
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const threshold = options.streamingThreshold || 10 * 1024 * 1024; // 10MB default

  // For files smaller than threshold, use standard parsing
  if (fileSize < threshold) {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseLockfileFromFormat(content);
  }

  // For larger files, read the file in chunks (so we can report progress) and then
  // parse the fully-buffered content. This is buffered, not truly incremental, but
  // it returns the ACTUAL parsed lockfile (or rejects) — never an empty skeleton.
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { encoding: 'utf8' });
    let buffer = '';
    let bytesRead = 0;

    stream.on('data', (chunk) => {
      buffer += chunk;
      bytesRead += Buffer.byteLength(chunk, 'utf8');

      if (options.onProgress) {
        options.onProgress(bytesRead, fileSize);
      }
    });

    stream.on('end', () => {
      try {
        resolve(parseLockfileFromFormat(buffer));
      } catch (error) {
        reject(error);
      }
    });

    stream.on('error', reject);
  });
}

/**
 * Synchronous version with callbacks (for compatibility)
 * @param {string} filePath - Path to lockfile
 * @param {Object} options - Options
 * @returns {Object} Parsed lockfile
 */
export function parseLockfileStreamSync(filePath, options = {}) {
  const stats = fs.statSync(filePath);
  const fileSize = stats.size;
  const threshold = options.streamingThreshold || 10 * 1024 * 1024;

  // For smaller files, use standard parsing
  if (fileSize < threshold) {
    const content = fs.readFileSync(filePath, 'utf8');
    return parseLockfileFromFormat(content);
  }

  // For larger files, read in chunks but still parse at once
  // This is a compromise - true streaming would require async or more complex parsing
  const content = fs.readFileSync(filePath, 'utf8');
  return parseLockfileFromFormat(content);
}

export default {
  StreamingParser,
  parseLockfileStream,
  parseLockfileStreamSync
};
