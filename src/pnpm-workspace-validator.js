// src/pnpm-workspace-validator.js
// Validate a project's pnpm-workspace.yaml — the file that, since pnpm 9/10, holds
// both the workspace package globs AND most pnpm settings that used to live in
// .npmrc / the package.json `pnpm` field. Same contract as the other validators:
// validatePnpmWorkspace(contentOrParsed, options) => { valid, errors, warnings, info }.
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
let _yaml = null;
function loadYaml() {
  if (!_yaml) _yaml = require('yaml');
  return _yaml;
}

export class PnpmWorkspaceValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PnpmWorkspaceValidationError';
    this.code = code;
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string');

// Recognized top-level keys and the type each must have. Generous (warn-only on
// unknowns) rather than exhaustive — pnpm adds settings often.
const KNOWN_KEYS = {
  packages: isStringArray,
  catalog: isPlainObject,
  catalogs: isPlainObject,
  overrides: isPlainObject,
  packageExtensions: isPlainObject,
  peerDependencyRules: isPlainObject,
  patchedDependencies: isPlainObject,
  allowedDeprecatedVersions: isPlainObject,
  onlyBuiltDependencies: isStringArray,
  neverBuiltDependencies: isStringArray,
  ignoredBuiltDependencies: isStringArray,
  onlyBuiltDependenciesFile: (v) => typeof v === 'string',
  packageConfigs: isPlainObject,
  // Common scalar settings that legitimately live here in pnpm 9/10.
  nodeLinker: (v) => typeof v === 'string',
  shamefullyHoist: (v) => typeof v === 'boolean',
  hoistPattern: isStringArray,
  publicHoistPattern: isStringArray,
  autoInstallPeers: (v) => typeof v === 'boolean',
  dedupePeerDependents: (v) => typeof v === 'boolean',
  strictPeerDependencies: (v) => typeof v === 'boolean',
  excludeLinksFromLockfile: (v) => typeof v === 'boolean',
  enablePrePostScripts: (v) => typeof v === 'boolean',
  virtualStoreDir: (v) => typeof v === 'string',
  preferWorkspacePackages: (v) => typeof v === 'boolean',
  linkWorkspacePackages: (v) => typeof v === 'boolean' || typeof v === 'string',
  saveWorkspaceProtocol: (v) => typeof v === 'boolean' || typeof v === 'string'
};

const TYPE_LABEL = new Map([
  [isStringArray, 'an array of strings'],
  [isPlainObject, 'an object']
]);
function expectedLabel(validator) {
  return TYPE_LABEL.get(validator) || 'the correct type';
}

/**
 * Parse pnpm-workspace.yaml content into an object (lazy `yaml` dep). Throws on
 * malformed YAML so callers can report it as a single structural error.
 * @param {string} content - Raw file contents
 * @returns {object} Parsed document (an empty file yields {})
 */
export function parsePnpmWorkspace(content) {
  const data = loadYaml().parse(content);
  return data == null ? {} : data;
}

/**
 * Validate a parsed (or raw-string) pnpm-workspace.yaml.
 * @param {string|object} input - Raw YAML string or already-parsed object
 * @param {object} options - { strictMode }
 * @returns {{ valid, errors, warnings, info }}
 */
export function validatePnpmWorkspace(input, options = {}) {
  const errors = [];
  const warnings = [];
  const info = {};

  let doc;
  if (typeof input === 'string') {
    try {
      doc = parsePnpmWorkspace(input);
    } catch (e) {
      errors.push(new PnpmWorkspaceValidationError(`invalid YAML in pnpm-workspace.yaml: ${e.message}`, 'PNPM_WS_SYNTAX'));
      return { valid: false, errors, warnings, info };
    }
  } else {
    doc = input || {};
  }

  if (!isPlainObject(doc)) {
    errors.push(new PnpmWorkspaceValidationError('pnpm-workspace.yaml must be a YAML mapping', 'PNPM_WS_NOT_OBJECT'));
    return { valid: false, errors, warnings, info };
  }

  info.hasPackages = Array.isArray(doc.packages);
  info.keys = Object.keys(doc);

  for (const [key, value] of Object.entries(doc)) {
    const validator = KNOWN_KEYS[key];
    if (!validator) {
      warnings.push({ code: 'PNPM_WS_UNKNOWN_KEY', message: `unrecognized pnpm-workspace.yaml key "${key}"` });
      continue;
    }
    if (!validator(value)) {
      errors.push(new PnpmWorkspaceValidationError(`"${key}" must be ${expectedLabel(validator)}`, 'PNPM_WS_INVALID_TYPE'));
    }
  }

  const valid = errors.length === 0 && !(options.strictMode && warnings.length > 0);
  return { valid, errors, warnings, info };
}
