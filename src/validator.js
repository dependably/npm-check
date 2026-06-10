// src/validator.js
import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree } from './format-library.js';

export class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function validatePackageLock(lockfile, packageJson = null, options = {}) {
  // Allow calling validatePackageLock(lockfile, options) when packageJson is omitted.
  if (arguments.length === 2 && packageJson && typeof packageJson === 'object' && (packageJson.allowMissingIntegrity !== undefined || packageJson.validateAgainstPackageJson !== undefined)) {
    options = packageJson;
    packageJson = null;
  }
  const errors = [];
  const warnings = [];
  const info = {};

  // Basic structure checks
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

  let version;
  try {
    version = detectLockfileVersion(lockfile);
    info.version = version;
  } catch (e) {
    // Normalize error code expected by tests
    errors.push(new ValidationError(e.message, 'VERSION_MISMATCH'));
    return { valid: false, errors, warnings, info };
  }

  // Validate dependencies structure
  if (hasDependenciesTree(version)) {
    if (!lockfile.dependencies || typeof lockfile.dependencies !== 'object') {
      errors.push(new ValidationError('Missing dependencies object', 'MISSING_DEPENDENCIES'));
    } else {
      validateDependenciesTree(lockfile.dependencies, errors);
    }
  }

  if (hasPackagesMap(version)) {
    if (!lockfile.packages || typeof lockfile.packages !== 'object') {
      errors.push(new ValidationError('Missing packages map', 'MISSING_PACKAGES_MAP'));
    } else {
      validatePackagesMap(lockfile.packages, errors, warnings, options);
    }
  }

  // Validate against package.json if provided
  if (packageJson && options.validateAgainstPackageJson) {
    validateAgainstPackageJson(lockfile, packageJson, errors);
  }

  const valid = errors.length === 0 && !(options.strictMode && warnings.length > 0);
  return { valid, errors, warnings, info };
}

function validateDependenciesTree(dependencies, errors, depth = 0) {
  for (const [name, dep] of Object.entries(dependencies)) {
    if (dep == null) {
      errors.push(new ValidationError(`Dependency ${name} is not an object`, 'INVALID_DEPENDENCY'));
      continue;
    }

    // At top-level (depth === 0) require dependency entries to be objects
    if (depth === 0) {
      if (typeof dep === 'string' || typeof dep === 'boolean') {
        // Top-level string/boolean entries are missing required fields
        errors.push(new ValidationError(`Missing or invalid version for ${name}`, 'MISSING_DEP_VERSION'));
        continue;
      }
      if (typeof dep !== 'object' || Array.isArray(dep)) {
        errors.push(new ValidationError(`Dependency ${name} is not an object`, 'INVALID_DEPENDENCY'));
        continue;
      }
    } else {
      // At nested levels, allow string or boolean leaf entries (ranges/flags)
      if (typeof dep === 'string' || typeof dep === 'boolean') {
        continue;
      }
      if (typeof dep !== 'object' || Array.isArray(dep)) {
        errors.push(new ValidationError(`Dependency ${name} is not an object`, 'INVALID_DEPENDENCY'));
        continue;
      }
    }

    // Validate version when dependency is an object
    if (!dep.version || typeof dep.version !== 'string') {
      errors.push(new ValidationError(`Missing or invalid version for ${name}`, 'MISSING_DEP_VERSION'));
    }

    // Validate integrity on dependency objects if present
    if (dep.integrity) {
      const integrityRegex = /^sha(?:256|512)-[A-Za-z0-9+/=.\-]+$/;
      if (typeof dep.integrity !== 'string' || !integrityRegex.test(dep.integrity)) {
        errors.push(new ValidationError(`Invalid integrity hash for dependency ${name}`, 'INVALID_INTEGRITY'));
      }
    }

    if (dep.dependencies) {
      validateDependenciesTree(dep.dependencies, errors, depth + 1);
    }
  }
}

function validatePackagesMap(packages, errors, warnings, options) {
  for (const [path, pkg] of Object.entries(packages)) {
    if (!pkg || typeof pkg !== 'object') {
      errors.push(new ValidationError(`Package at ${path} is not an object`, 'INVALID_PACKAGE'));
      continue;
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
    if (pkg.integrity) {
      // Basic integrity validation (sha256/sha512 prefixes)
      const integrityRegex = /^sha(?:256|512)-[A-Za-z0-9+/=.\-]+$/;
      if (typeof pkg.integrity !== 'string' || !integrityRegex.test(pkg.integrity)) {
        errors.push(new ValidationError(`Invalid integrity hash for package at ${path}`, 'INVALID_INTEGRITY'));
      }
    }
    if (options.allowMissingIntegrity === false && !pkg.integrity) {
      // Treat missing integrity as an error when not allowed, and also record a warning
      errors.push(new ValidationError(`Missing integrity hash for package at ${path}`, 'MISSING_INTEGRITY'));
      warnings.push({ code: 'MISSING_INTEGRITY', message: `Missing integrity hash for package at ${path}` });
    }
    if (pkg.resolved) {
      // Validate resolved URL format
      const validSchemes = ['https://', 'http://', 'git+', 'git://', 'file:'];
      const hasValidScheme = validSchemes.some(scheme => pkg.resolved.startsWith(scheme));
      if (typeof pkg.resolved !== 'string' || !hasValidScheme) {
        warnings.push({ code: 'INVALID_RESOLVED', message: `Invalid resolved URL for package at ${path}: ${pkg.resolved}` });
      }
    }
    // packages-map dependency values are version-range strings (depth 1
    // allows string/boolean leaves), unlike the v1 top-level tree
    if (pkg.dependencies) {
      validateDependenciesTree(pkg.dependencies, errors, 1);
    }
    if (pkg.devDependencies) {
      validateDependenciesTree(pkg.devDependencies, errors, 1);
    }
    if (pkg.peerDependencies) {
      validateDependenciesTree(pkg.peerDependencies, errors, 1);
    }
    if (pkg.optionalDependencies) {
      validateDependenciesTree(pkg.optionalDependencies, errors, 1);
    }
  }
}

function validateAgainstPackageJson(lockfile, packageJson, errors) {
  const lockDeps = lockfile.packages && lockfile.packages[''] && lockfile.packages[''].dependencies;

  // Check dependencies
  const pkgDeps = packageJson.dependencies || {};
  for (const [name] of Object.entries(pkgDeps)) {
    if (!lockDeps || !lockDeps[name]) {
      errors.push(new ValidationError(`Missing dependency ${name} in lockfile`, 'MISSING_IN_LOCKFILE'));
    }
  }

  // Check devDependencies
  const lockDevDeps = lockfile.packages && lockfile.packages[''] && lockfile.packages[''].devDependencies;
  const pkgDevDeps = packageJson.devDependencies || {};
  for (const [name] of Object.entries(pkgDevDeps)) {
    if (!lockDevDeps || !lockDevDeps[name]) {
      errors.push(new ValidationError(`Missing devDependency ${name} in lockfile`, 'MISSING_DEV_IN_LOCKFILE'));
    }
  }

  // Check optionalDependencies
  const lockOptDeps = lockfile.packages && lockfile.packages[''] && lockfile.packages[''].optionalDependencies;
  const pkgOptDeps = packageJson.optionalDependencies || {};
  for (const [name] of Object.entries(pkgOptDeps)) {
    if (!lockOptDeps || !lockOptDeps[name]) {
      errors.push(new ValidationError(`Missing optionalDependency ${name} in lockfile`, 'MISSING_OPT_IN_LOCKFILE'));
    }
  }
}
