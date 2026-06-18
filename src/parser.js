// src/parser.js
import fs from 'fs';
import { parseLockfile as parseLockfileFromFormat, stringifyLockfile } from './format-library.js';
import { BackupError } from './backup.js';
import { parseLockfileStreamSync } from './streaming-parser.js';

/**
 * Parse a lockfile from file path
 * Automatically uses streaming parser for large files
 * @param {string} filePath - Path to lockfile
 * @param {Object} options - Options
 * @param {boolean} options.useStreaming - Force streaming parser (default: auto-detect)
 * @param {number} options.streamingThreshold - File size threshold in bytes for streaming (default: 10MB)
 * @param {Function} options.onProgress - Progress callback for streaming
 * @returns {Object} Parsed lockfile object
 */
export function parseLockfile(filePath, options = {}) {
  const {
    useStreaming = null, // null = auto-detect
    streamingThreshold = 10 * 1024 * 1024, // 10MB
    onProgress = null
  } = options;
  
  // Check file size
  let shouldUseStreaming = useStreaming;
  if (shouldUseStreaming === null) {
    try {
      const stats = fs.statSync(filePath);
      shouldUseStreaming = stats.size >= streamingThreshold;
    } catch {
      // If we can't get stats, fall back to standard parsing
      shouldUseStreaming = false;
    }
  }
  
  if (shouldUseStreaming) {
    return parseLockfileStreamSync(filePath, {
      streamingThreshold,
      onProgress
    });
  }
  
  // Standard parsing for smaller files
  const content = fs.readFileSync(filePath, 'utf8');
  return parseLockfileFromFormat(content);
}

export function serializeLockfile(filePath, data, overwrite = false) {
  if (!overwrite && fs.existsSync(filePath)) {
    throw new BackupError(`File ${filePath} already exists`);
  }
  const content = stringifyLockfile(data);
  fs.writeFileSync(filePath, content, 'utf8');
}
