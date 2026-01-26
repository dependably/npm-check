// src/validator.js
import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree } from './format-library.js';

export class ValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

export function validatePackageLock(lockfile, packageJson = null, options = {}) {
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
  if (typeof lockfile.lockfileVersion !== 'number') {
    errors.push(new ValidationError('Missing or invalid lockfile version', 'INVALID_LOCKFILE_VERSION'));
  }

  let version;
  try {
    version = detectLockfileVersion(lockfile);
    info.version = version;
  } catch (e) {
    errors.push(new ValidationError(e.message, 'UNSUPPORTED_VERSION'));
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

  const valid = errors.length === 0;
  return { valid, errors, warnings, info };
}

function validateDependenciesTree(dependencies, errors) {
  for (const [name, dep] of Object.entries(dependencies)) {
    if (!dep || typeof dep !== 'object') {
      errors.push(new ValidationError(`Dependency ${name} is not an object`, 'INVALID_DEPENDENCY'));
      continue;
    }
    if (!dep.version || typeof dep.version !== 'string') {
      errors.push(new ValidationError(`Missing or invalid version for ${name}`, 'MISSING_DEP_VERSION'));
    }
    if (dep.dependencies) {
      validateDependenciesTree(dep.dependencies, errors);
    }
  }
}

function validatePackagesMap(packages, errors, warnings, options) {
  for (const [path, pkg] of Object.entries(packages)) {
    if (!pkg || typeof pkg !== 'object') {
      errors.push(new ValidationError(`Package at ${path} is not an object`, 'INVALID_PACKAGE'));
      continue;
    }
    if (!pkg.name || typeof pkg.name !== 'string') {
      errors.push(new ValidationError(`Missing or invalid name for package at ${path}`, 'INVALID_PACKAGE_NAME'));
    }
    if (!pkg.version || typeof pkg.version !== 'string') {
      errors.push(new ValidationError(`Missing or invalid version for package at ${path}`, 'INVALID_PACKAGE_VERSION'));
    }
    if (pkg.integrity && typeof pkg.integrity !== 'string') {
      errors.push(new ValidationError(`Invalid integrity hash for package at ${path}`, 'INVALID_INTEGRITY'));
    }
    if (options.allowMissingIntegrity === false && !pkg.integrity) {
      warnings.push({ code: 'MISSING_INTEGRITY', message: `Missing integrity hash for package at ${path}` });
    }
    if (pkg.dependencies) {
      validateDependenciesTree(pkg.dependencies, errors);
    }
    if (pkg.devDependencies) {
      validateDependenciesTree(pkg.devDependencies, errors);
    }
    if (pkg.peerDependencies) {
      validateDependenciesTree(pkg.peerDependencies, errors);
    }
    if (pkg.optionalDependencies) {
      validateDependenciesTree(pkg.optionalDependencies, errors);
    }
  }
}

function validateAgainstPackageJson(lockfile, packageJson, errors) {
  const lockDeps = lockfile.packages && lockfile.packages[''] && lockfile.packages[''].dependencies;
  const pkgDeps = packageJson.dependencies || {};
  for (const [name, version] of Object.entries(pkgDeps)) {
    if (!lockDeps || !lockDeps[name]) {
      errors.push(new ValidationError(`Missing dependency ${name} in lockfile`, 'MISSING_IN_LOCKFILE'));
    }
  }
}
