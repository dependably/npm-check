// src/validator.js
import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree } from './format-library.js';

export class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// Allow calling validatePackageLock(lockfile, options) when packageJson is omitted.
function normalizeValidateArgs(argLength, packageJson, options) {
  const looksLikeOptions = argLength === 2 && packageJson && typeof packageJson === 'object' &&
    (packageJson.allowMissingIntegrity !== undefined || packageJson.validateAgainstPackageJson !== undefined);
  if (looksLikeOptions) {
    return { packageJson: null, options: packageJson };
  }
  return { packageJson, options };
}

// Basic top-level field checks (name, version, lockfileVersion).
function validateRootFields(lockfile, errors) {
  if (!lockfile.name || typeof lockfile.name !== 'string') {
    errors.push(new ValidationError('Missing or invalid package name', 'INVALID_NAME'));
  }
  if (!lockfile.version || typeof lockfile.version !== 'string') {
    errors.push(new ValidationError('Missing or invalid package version', 'INVALID_VERSION'));
  }
  // Basic semver-ish check (major.minor.patch). If format is wrong, mark invalid.
  if (typeof lockfile.version === 'string') {
    const semverLike = /^\d+\.\d+\.\d+(?:[-+].*)?$/;
    if (!semverLike.test(lockfile.version)) {
      errors.push(new ValidationError('Missing or invalid package version', 'INVALID_VERSION'));
    }
  }
  if (typeof lockfile.lockfileVersion !== 'number') {
    errors.push(new ValidationError('Missing or invalid lockfile version', 'INVALID_LOCKFILE_VERSION'));
  }
}

// Validate the version-appropriate dependencies tree and/or packages map.
function validateVersionStructure(lockfile, version, errors, warnings, options) {
  if (hasDependenciesTree(version)) {
    if (!lockfile.dependencies || typeof lockfile.dependencies !== 'object') {
      errors.push(new ValidationError('Missing dependencies object', 'MISSING_DEPENDENCIES'));
    } else {
      validateDependenciesTree(lockfile.dependencies, errors, warnings);
    }
  }

  if (hasPackagesMap(version)) {
    if (!lockfile.packages || typeof lockfile.packages !== 'object') {
      errors.push(new ValidationError('Missing packages map', 'MISSING_PACKAGES_MAP'));
    } else {
      validatePackagesMap(lockfile.packages, errors, warnings, options);
    }
  }
}

export function validatePackageLock(lockfile, packageJson = null, options = {}) {
  ({ packageJson, options } = normalizeValidateArgs(arguments.length, packageJson, options));
  const errors = [];
  const warnings = [];
  const info = {};

  // Basic structure checks
  validateRootFields(lockfile, errors);

  let version;
  try {
    version = detectLockfileVersion(lockfile);
    info.version = version;
  } catch (e) {
    // Normalize error code expected by tests
    errors.push(new ValidationError(e.message, 'VERSION_MISMATCH'));
    return { valid: false, errors, warnings, info };
  }

  validateVersionStructure(lockfile, version, errors, warnings, options);

  // Validate against package.json if provided
  if (packageJson && options.validateAgainstPackageJson) {
    validateAgainstPackageJson(lockfile, packageJson, errors);
  }

  const valid = errors.length === 0 && !(options.strictMode && warnings.length > 0);
  return { valid, errors, warnings, info };
}

// Recognise one SRI token: sha1/sha256/sha384/sha512.
const SRI_TOKEN_REGEX = /^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/;

// Accept sha1/sha256/sha384/sha512 single hashes and space-separated multi-hash
// SRI strings (e.g. 'sha512-... sha1-...'). Every whitespace-separated token
// must match a recognised algorithm.
function isValidIntegrityHash(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  return value.trim().split(/\s+/).every(token => SRI_TOKEN_REGEX.test(token));
}

// Returns true when any token in a (valid) integrity value uses the legacy sha1
// algorithm. Callers should emit a warning (not an error) suggesting an upgrade.
function hasLegacySha1(value) {
  if (typeof value !== 'string') return false;
  return value.trim().split(/\s+/).some(token => token.startsWith('sha1-'));
}

// Classify a dependency entry by shape. Returns 'leaf' for string/boolean leaves,
// 'object' for valid objects, or 'invalid' for anything that isn't an object.
function classifyDependencyEntry(dep) {
  if (typeof dep === 'string' || typeof dep === 'boolean') {
    return 'leaf';
  }
  if (typeof dep !== 'object' || Array.isArray(dep)) {
    return 'invalid';
  }
  return 'object';
}

// Validate a single dependency entry; recurses into nested dependencies.
// warnings is threaded through so sha1 hashes can be flagged without an error.
function validateDependencyEntry(name, dep, errors, warnings, depth) {
  if (dep == null) {
    errors.push(new ValidationError(`Dependency ${name} is not an object`, 'INVALID_DEPENDENCY'));
    return;
  }

  const kind = classifyDependencyEntry(dep);
  if (kind === 'invalid') {
    errors.push(new ValidationError(`Dependency ${name} is not an object`, 'INVALID_DEPENDENCY'));
    return;
  }
  if (kind === 'leaf') {
    // Top-level string/boolean entries are missing required fields; nested
    // string/boolean entries are valid range/flag leaves.
    if (depth === 0) {
      errors.push(new ValidationError(`Missing or invalid version for ${name}`, 'MISSING_DEP_VERSION'));
    }
    return;
  }

  // Validate version when dependency is an object
  if (!dep.version || typeof dep.version !== 'string') {
    errors.push(new ValidationError(`Missing or invalid version for ${name}`, 'MISSING_DEP_VERSION'));
  }

  // Validate integrity on dependency objects if present.
  // sha1 is accepted as structurally valid but emits a LEGACY_INTEGRITY warning.
  if (dep.integrity) {
    if (!isValidIntegrityHash(dep.integrity)) {
      errors.push(new ValidationError(`Invalid integrity hash for dependency ${name}`, 'INVALID_INTEGRITY'));
    } else if (hasLegacySha1(dep.integrity)) {
      warnings.push({ code: 'LEGACY_INTEGRITY', message: `Dependency ${name} uses sha1 integrity; run upgrade-hashes to convert to sha512` });
    }
  }

  if (dep.dependencies) {
    validateDependenciesTree(dep.dependencies, errors, warnings, depth + 1);
  }
}

function validateDependenciesTree(dependencies, errors, warnings, depth = 0) {
  for (const [name, dep] of Object.entries(dependencies)) {
    validateDependencyEntry(name, dep, errors, warnings, depth);
  }
}

// Validate the integrity field (and the allowMissingIntegrity policy) for a package entry.
// sha1 integrity is accepted as structurally valid but emits a LEGACY_INTEGRITY warning.
function validatePackageIntegrity(path, pkg, errors, warnings, options) {
  if (pkg.integrity) {
    if (!isValidIntegrityHash(pkg.integrity)) {
      errors.push(new ValidationError(`Invalid integrity hash for package at ${path}`, 'INVALID_INTEGRITY'));
    } else if (hasLegacySha1(pkg.integrity)) {
      warnings.push({ code: 'LEGACY_INTEGRITY', message: `Package at ${path} uses sha1 integrity; run upgrade-hashes to convert to sha512` });
    }
  }
  if (options.allowMissingIntegrity === false && !pkg.integrity) {
    // Treat missing integrity as an error when not allowed, and also record a warning
    errors.push(new ValidationError(`Missing integrity hash for package at ${path}`, 'MISSING_INTEGRITY'));
    warnings.push({ code: 'MISSING_INTEGRITY', message: `Missing integrity hash for package at ${path}` });
  }
}

// Validate the resolved-URL scheme for a package entry.
// Guards typeof before calling startsWith to avoid a crash on corrupted
// non-string resolved values (e.g. "resolved": 42 from a bad merge).
function validatePackageResolved(path, pkg, warnings) {
  if (!pkg.resolved) {
    return;
  }
  if (typeof pkg.resolved !== 'string') {
    warnings.push({ code: 'INVALID_RESOLVED', message: `Invalid resolved URL for package at ${path}: ${pkg.resolved}` });
    return;
  }
  const validSchemes = ['https://', 'http://', 'git+', 'git://', 'file:'];
  const hasValidScheme = validSchemes.some(scheme => pkg.resolved.startsWith(scheme));
  if (!hasValidScheme) {
    warnings.push({ code: 'INVALID_RESOLVED', message: `Invalid resolved URL for package at ${path}: ${pkg.resolved}` });
  }
}

// Recurse into each dependency section of a package entry. packages-map
// dependency values are version-range strings (depth 1 allows string/boolean
// leaves), unlike the v1 top-level tree.
function validatePackageDependencySections(pkg, errors, warnings) {
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    if (pkg[section]) {
      validateDependenciesTree(pkg[section], errors, warnings, 1);
    }
  }
}

// Validate a single packages-map entry.
function validatePackageEntry(path, pkg, errors, warnings, options) {
  if (!pkg || typeof pkg !== 'object') {
    errors.push(new ValidationError(`Package at ${path} is not an object`, 'INVALID_PACKAGE'));
    return;
  }
  // npm only writes `name` on the root entry (and aliased installs);
  // requiring it elsewhere would reject every real lockfile
  if (path === '' && (!pkg.name || typeof pkg.name !== 'string')) {
    errors.push(new ValidationError(`Missing or invalid name for package at ${path}`, 'INVALID_PACKAGE_NAME'));
  }
  // link entries (`link: true`) carry no version by design
  if (!pkg.link && (!pkg.version || typeof pkg.version !== 'string')) {
    errors.push(new ValidationError(`Missing or invalid version for package at ${path}`, 'INVALID_PACKAGE_VERSION'));
  }
  validatePackageIntegrity(path, pkg, errors, warnings, options);
  validatePackageResolved(path, pkg, warnings);
  validatePackageDependencySections(pkg, errors, warnings);
}

function validatePackagesMap(packages, errors, warnings, options) {
  for (const [path, pkg] of Object.entries(packages)) {
    validatePackageEntry(path, pkg, errors, warnings, options);
  }
}

// Check that every package.json dependency in a section is present in the
// lockfile root entry's matching section (v2/v3 packages map path).
function checkDependencySectionInLockfile(rootEntry, packageJson, section, label, code, errors) {
  const lockDeps = rootEntry && rootEntry[section];
  const pkgDeps = packageJson[section] || {};
  for (const [name] of Object.entries(pkgDeps)) {
    if (!lockDeps || !lockDeps[name]) {
      errors.push(new ValidationError(`Missing ${label} ${name} in lockfile`, code));
    }
  }
}

// v1 lockfile cross-check: each package.json dep section is checked against
// the top-level dependencies tree (v1 hoists all deps to the top level).
function checkDependencySectionInV1Tree(v1Deps, packageJson, section, label, code, errors) {
  const pkgDeps = packageJson[section] || {};
  for (const [name] of Object.entries(pkgDeps)) {
    if (!v1Deps[name]) {
      errors.push(new ValidationError(`Missing ${label} ${name} in lockfile`, code));
    }
  }
}

function validateAgainstPackageJson(lockfile, packageJson, errors) {
  const rootEntry = lockfile.packages && lockfile.packages[''];

  if (!rootEntry) {
    // v1 lockfile (or a degenerate v2/v3 missing the root packages[''] entry):
    // fall back to the top-level dependencies tree for the cross-check.
    if (lockfile.dependencies) {
      checkDependencySectionInV1Tree(lockfile.dependencies, packageJson, 'dependencies', 'dependency', 'MISSING_IN_LOCKFILE', errors);
      checkDependencySectionInV1Tree(lockfile.dependencies, packageJson, 'devDependencies', 'devDependency', 'MISSING_DEV_IN_LOCKFILE', errors);
      checkDependencySectionInV1Tree(lockfile.dependencies, packageJson, 'optionalDependencies', 'optionalDependency', 'MISSING_OPT_IN_LOCKFILE', errors);
      checkDependencySectionInV1Tree(lockfile.dependencies, packageJson, 'peerDependencies', 'peerDependency', 'MISSING_PEER_IN_LOCKFILE', errors);
    }
    return;
  }

  checkDependencySectionInLockfile(rootEntry, packageJson, 'dependencies', 'dependency', 'MISSING_IN_LOCKFILE', errors);
  checkDependencySectionInLockfile(rootEntry, packageJson, 'devDependencies', 'devDependency', 'MISSING_DEV_IN_LOCKFILE', errors);
  checkDependencySectionInLockfile(rootEntry, packageJson, 'optionalDependencies', 'optionalDependency', 'MISSING_OPT_IN_LOCKFILE', errors);
  checkDependencySectionInLockfile(rootEntry, packageJson, 'peerDependencies', 'peerDependency', 'MISSING_PEER_IN_LOCKFILE', errors);
}
