// src/parser.js
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { parseLockfile as parseLockfileFromFormat, stringifyLockfile } from './format-library.js';
import { parseNpmrc } from './npmrc-validator.js';
import { DEFAULT_REGISTRY } from './integrity.js';
import { BackupError } from './backup.js';
import { parseLockfileStreamSync } from './streaming-parser.js';

// `yaml` is the one runtime dependency, and it is pulled in LAZILY (and
// synchronously, via createRequire) only when a pnpm-lock.yaml is actually
// parsed — the npm JSON path never loads it, preserving the zero-dependency
// core for npm-only users.
const require = createRequire(import.meta.url);
let _yaml = null;
function loadYaml() {
  if (!_yaml) _yaml = require('yaml');
  return _yaml;
}

// A lockfile is pnpm's when it's a YAML file (pnpm-lock.yaml / *.yaml / *.yml).
function isPnpmLockfilePath(filePath) {
  const base = path.basename(filePath).toLowerCase();
  return base === 'pnpm-lock.yaml' || base.endsWith('.yaml') || base.endsWith('.yml');
}

/**
 * Build the registry config for a pnpm lockfile from its sibling .npmrc — pnpm
 * reads .npmrc ONLY for registry + auth, so this is the authoritative source for
 * the per-package registry base (there is no `resolved` URL to parse).
 * @param {string} filePath - Path to the pnpm lockfile
 * @returns {{ registry: string, scopedRegistries: object }}
 */
function buildPnpmRegistryConfig(filePath) {
  const npmrcPath = path.join(path.dirname(filePath), '.npmrc');
  let registry = DEFAULT_REGISTRY;
  const scopedRegistries = {};
  if (fs.existsSync(npmrcPath)) {
    try {
      for (const { key, value } of parseNpmrc(fs.readFileSync(npmrcPath, 'utf8'))) {
        if (key === 'registry') registry = value;
        else if (key && key.startsWith('@') && key.endsWith(':registry')) {
          scopedRegistries[key.slice(0, key.indexOf(':'))] = value;
        }
      }
    } catch {
      // A malformed .npmrc shouldn't break lockfile parsing — fall back to defaults.
    }
  }
  return { registry, scopedRegistries };
}

/**
 * Parse a pnpm-lock.yaml into an object stamped with a non-enumerable
 * `__npmCheckMeta` ({ flavor, lockfileVersion, registry, scopedRegistries }).
 * The meta is non-enumerable so it never leaks into JSON output or stringify.
 * @param {string} filePath - Path to the pnpm lockfile
 * @returns {object} Parsed pnpm lockfile
 */
function parsePnpmLockfile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const data = loadYaml().parse(content);
  if (!data || typeof data !== 'object') {
    throw new Error(`Invalid pnpm-lock.yaml: ${filePath}`);
  }
  Object.defineProperty(data, '__npmCheckMeta', {
    value: {
      flavor: 'pnpm',
      lockfileVersion: data.lockfileVersion,
      ...buildPnpmRegistryConfig(filePath)
    },
    enumerable: false,
    writable: true,
    configurable: true
  });
  return data;
}

/**
 * Parse a lockfile from file path. Dispatches by flavor: pnpm-lock.yaml is parsed
 * as YAML (with the lazy `yaml` dependency); npm package-lock.json is parsed as
 * JSON, using the streaming parser for large files.
 * @param {string} filePath - Path to lockfile
 * @param {Object} options - Options
 * @param {boolean} options.useStreaming - Force streaming parser (default: auto-detect, npm only)
 * @param {number} options.streamingThreshold - File size threshold in bytes for streaming (default: 10MB)
 * @param {Function} options.onProgress - Progress callback for streaming
 * @returns {Object} Parsed lockfile object
 */
export function parseLockfile(filePath, options = {}) {
  // pnpm lockfiles are YAML and rarely huge — parse directly, no streaming.
  if (isPnpmLockfilePath(filePath)) {
    return parsePnpmLockfile(filePath);
  }

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
