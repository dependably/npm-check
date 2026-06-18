// src/package-json-validator.js
// Standalone validation for a package.json manifest, mirroring validator.js's
// contract: validatePackageJson(packageJson, options) => { valid, errors, warnings, info }.
// Errors/warnings are { message, code } (errors are PackageJsonValidationError instances).

export class PackageJsonValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'PackageJsonValidationError';
    this.code = code;
  }
}

// npm package-name rules (subset of validate-npm-package-name; no new deps):
// optional @scope/, lowercase, url-safe, can't start with . or _.
const NAME_RE = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
const DEP_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Accept what npm accepts as a dependency "range": semver ranges, exact versions,
 * `*`, dist-tags (latest), the npm:/file:/git:/github:/workspace:/http(s): protocols,
 * and `owner/repo` GitHub shorthand.
 */
function isValidRange(range) {
  if (typeof range !== 'string') return false;
  const r = range.trim();
  if (r === '' || r === '*' || r === 'latest' || r === 'x') return true;
  if (/^(npm|file|git|git\+ssh|git\+https|git\+http|github|http|https|workspace):/i.test(r)) return true;
  if (/^[\w.-]+\/[\w.#/-]+$/.test(r)) return true; // owner/repo[#ref] shorthand
  if (/^[a-z][a-z0-9._-]*$/i.test(r)) return true; // dist-tag (latest, next, beta, canary, ...)
  // caret/tilde/comparator/exact/x-ranges/||/hyphen/v-prefixed ranges
  return /^[v\d~^<>=*xX][\w.\-+~^<>=|\sxX*]*$/.test(r);
}

export function validatePackageJson(packageJson, options = {}) {
  const errors = [];
  const warnings = [];
  const info = {};

  if (!packageJson || typeof packageJson !== 'object' || Array.isArray(packageJson)) {
    errors.push(new PackageJsonValidationError('package.json is not an object', 'PJ_NOT_OBJECT'));
    return { valid: false, errors, warnings, info };
  }

  const isPrivate = packageJson.private === true;
  info.private = isPrivate;

  // --- name ---
  if (packageJson.name === undefined) {
    // private / workspace-root packages may legitimately omit name → warn, not error
    if (isPrivate) {
      warnings.push({ code: 'PJ_MISSING_NAME', message: 'no "name" field (allowed for private packages)' });
    } else {
      errors.push(new PackageJsonValidationError('package.json is missing "name"', 'PJ_MISSING_NAME'));
    }
  } else if (typeof packageJson.name !== 'string' || !NAME_RE.test(packageJson.name)) {
    errors.push(new PackageJsonValidationError(`invalid package name "${packageJson.name}"`, 'PJ_INVALID_NAME'));
  } else if (packageJson.name.length > 214) {
    errors.push(new PackageJsonValidationError('package name exceeds 214 characters', 'PJ_NAME_TOO_LONG'));
  }

  // --- version ---
  if (packageJson.version === undefined) {
    if (isPrivate) {
      warnings.push({ code: 'PJ_MISSING_VERSION', message: 'no "version" field (allowed for private packages)' });
    } else {
      errors.push(new PackageJsonValidationError('package.json is missing "version"', 'PJ_MISSING_VERSION'));
    }
  } else if (typeof packageJson.version !== 'string' || !SEMVER_RE.test(packageJson.version)) {
    errors.push(new PackageJsonValidationError(`invalid version "${packageJson.version}" (expected semver)`, 'PJ_INVALID_VERSION'));
  }

  // --- private flag type ---
  if (packageJson.private !== undefined && typeof packageJson.private !== 'boolean') {
    errors.push(new PackageJsonValidationError('"private" must be a boolean', 'PJ_INVALID_PRIVATE'));
  }

  // --- dependency ranges across all four sections ---
  for (const section of DEP_SECTIONS) {
    const deps = packageJson[section];
    if (deps === undefined) continue;
    if (typeof deps !== 'object' || deps === null || Array.isArray(deps)) {
      errors.push(new PackageJsonValidationError(`"${section}" must be an object`, 'PJ_INVALID_DEP_SECTION'));
      continue;
    }
    for (const [name, range] of Object.entries(deps)) {
      if (!NAME_RE.test(name)) {
        errors.push(new PackageJsonValidationError(`invalid dependency name "${name}" in ${section}`, 'PJ_INVALID_DEP_NAME'));
      }
      if (!isValidRange(range)) {
        errors.push(new PackageJsonValidationError(`invalid version range "${range}" for "${name}" in ${section}`, 'PJ_INVALID_DEP_RANGE'));
      }
    }
  }

  // --- scripts shape ---
  if (packageJson.scripts !== undefined) {
    if (typeof packageJson.scripts !== 'object' || packageJson.scripts === null || Array.isArray(packageJson.scripts)) {
      errors.push(new PackageJsonValidationError('"scripts" must be an object', 'PJ_INVALID_SCRIPTS'));
    } else {
      for (const [k, v] of Object.entries(packageJson.scripts)) {
        if (typeof v !== 'string') {
          errors.push(new PackageJsonValidationError(`script "${k}" must be a string`, 'PJ_INVALID_SCRIPT_VALUE'));
        }
      }
    }
  }

  // --- license (warn-level) ---
  if (packageJson.license === undefined && packageJson.licenses === undefined) {
    if (!isPrivate) {
      warnings.push({ code: 'PJ_MISSING_LICENSE', message: 'no "license" field (use a valid SPDX identifier)' });
    }
  } else if (packageJson.license !== undefined && typeof packageJson.license !== 'string') {
    warnings.push({ code: 'PJ_INVALID_LICENSE', message: '"license" should be an SPDX string (object/array form is deprecated)' });
  } else if (typeof packageJson.license === 'string' && /^see\s+license/i.test(packageJson.license)) {
    warnings.push({ code: 'PJ_NONSTANDARD_LICENSE', message: `non-SPDX license "${packageJson.license}"` });
  }

  // --- bin / main / exports sanity (types only; FS existence is out of scope) ---
  if (packageJson.main !== undefined && typeof packageJson.main !== 'string') {
    errors.push(new PackageJsonValidationError('"main" must be a string', 'PJ_INVALID_MAIN'));
  }
  if (packageJson.bin !== undefined && typeof packageJson.bin !== 'string' &&
      (typeof packageJson.bin !== 'object' || packageJson.bin === null || Array.isArray(packageJson.bin))) {
    errors.push(new PackageJsonValidationError('"bin" must be a string or an object', 'PJ_INVALID_BIN'));
  }
  if (packageJson.exports !== undefined &&
      typeof packageJson.exports !== 'object' && typeof packageJson.exports !== 'string') {
    errors.push(new PackageJsonValidationError('"exports" must be a string or an object', 'PJ_INVALID_EXPORTS'));
  }

  // --- workspaces shape (array of strings, or { packages: [...] }) ---
  if (packageJson.workspaces !== undefined) {
    const ws = packageJson.workspaces;
    const arr = Array.isArray(ws) ? ws : (ws && typeof ws === 'object' && Array.isArray(ws.packages) ? ws.packages : null);
    if (!arr) {
      errors.push(new PackageJsonValidationError('"workspaces" must be an array or { packages: [] }', 'PJ_INVALID_WORKSPACES'));
    } else if (!arr.every((p) => typeof p === 'string')) {
      errors.push(new PackageJsonValidationError('"workspaces" entries must be strings (glob patterns)', 'PJ_INVALID_WORKSPACE_ENTRY'));
    }
  }

  const valid = errors.length === 0 && !(options.strictMode && warnings.length > 0);
  return { valid, errors, warnings, info };
}
