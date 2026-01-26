// Package-lock.json validator

import { detectLockfileVersion, getSchemaForVersion, getFormatInfo, hasPackagesMap, hasDependenciesTree, parsePackagePath, LOCKFILE_VERSIONS, INTEGRITY_ALGORITHMS } from './format-library.js';

export class ValidationError extends Error {
  constructor(message, code, path = null, details = {}) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.path = path;
    this.details = details;
  }
}

export class ValidationResult {
  constructor() {
    this.valid = true;
    this.errors = [];
    this.warnings = [];
    this.info = {};
  }

  addError(message, code, path = null, details = {}) {
    this.valid = false;
    this.errors.push({ message, code, path, details, severity: 'error' });
  }

  addWarning(message, code, path = null, details = {}) {
    this.warnings.push({ message, code, path, details, severity: 'warning' });
  }

  addInfo(key, value) {
    this.info[key] = value;
  }
}

export class PackageLockValidator {
  constructor(options = {}) {
    this.options = {
      strictMode: options.strictMode ?? false,
      checkIntegrity: options.checkIntegrity ?? true,
      checkResolved: options.checkResolved ?? true,
      validateAgainstPackageJson: options.validateAgainstPackageJson ?? false,
      allowMissingIntegrity: options.allowMissingIntegrity ?? false,
      ...options
    };
  }

  validate(lockfileData, packageJsonData = null) {
    const result = new ValidationResult();

    try {
      const version = detectLockfileVersion(lockfileData);
      result.addInfo('version', version);
      result.addInfo('format', getFormatInfo(version));

      this.validateStructure(lockfileData, version, result);
      this.validateTopLevel(lockfileData, version, result);

      if (hasPackagesMap(version)) {
        this.validatePackages(lockfileData.packages, version, result);
      }

      if (hasDependenciesTree(version)) {
        this.validateDependenciesTree(lockfileData.dependencies, version, result);
      }

      if (packageJsonData && this.options.validateAgainstPackageJson) {
        this.validateAgainstPackageJson(lockfileData, packageJsonData, version, result);
      }

      this.validateConsistency(lockfileData, version, result);

    } catch (error) {
      result.addError(error.message, 'VALIDATION_FAILED', null, { originalError: error.message });
    }

    return result;
  }

  validateStructure(data, version, result) {
    if (!data || typeof data !== 'object') {
      result.addError('Lockfile must be an object', 'INVALID_TYPE');
      return;
    }

    const format = getFormatInfo(version);
    const requiredFields = ['name', 'version', 'lockfileVersion'];

    for (const field of requiredFields) {
      if (!(field in data)) {
        result.addError(`Missing required field: ${field}`, 'MISSING_FIELD', field);
      }
    }

    if (data.lockfileVersion !== version) {
      result.addError(
        `Lockfile version mismatch: expected ${version}, got ${data.lockfileVersion}`,
        'VERSION_MISMATCH',
        'lockfileVersion'
      );
    }

    if (version >= LOCKFILE_VERSIONS.V2 && !data.packages) {
      result.addError('Missing packages field for v2/v3 lockfile', 'MISSING_PACKAGES');
    }

    if (version === LOCKFILE_VERSIONS.V1 && !data.dependencies) {
      result.addError('Missing dependencies field for v1 lockfile', 'MISSING_DEPENDENCIES');
    }
  }

  validateTopLevel(data, version, result) {
    if (typeof data.name !== 'string' || data.name.length === 0) {
      result.addError('Package name must be a non-empty string', 'INVALID_NAME', 'name');
    }

    if (!this.isValidVersion(data.version)) {
      result.addError(`Invalid version format: ${data.version}`, 'INVALID_VERSION', 'version');
    }

    if (data.requires !== undefined && typeof data.requires !== 'boolean') {
      result.addWarning('requires field should be boolean', 'INVALID_REQUIRES', 'requires');
    }
  }

  validatePackages(packages, version, result) {
    if (!packages || typeof packages !== 'object') {
      result.addError('packages must be an object', 'INVALID_PACKAGES');
      return;
    }

    if (!packages['']) {
      result.addError('Missing root package entry', 'MISSING_ROOT_PACKAGE', 'packages[""]');
    }

    for (const [path, pkg] of Object.entries(packages)) {
      this.validatePackage(path, pkg, version, result);
    }
  }

  validatePackage(path, pkg, version, result) {
    const basePath = `packages["${path}"]`;

    if (path === '') {
      if (!pkg.name || !pkg.version) {
        result.addError('Root package must have name and version', 'INVALID_ROOT', basePath);
      }
      return;
    }

    const pathInfo = parsePackagePath(path);

    if (this.options.checkResolved && !pkg.resolved && !pkg.link) {
      result.addWarning(`Package missing resolved URL: ${pathInfo.name}`, 'MISSING_RESOLVED', basePath);
    }

    if (this.options.checkIntegrity && !pkg.integrity && !pkg.link && !this.options.allowMissingIntegrity) {
      result.addWarning(`Package missing integrity: ${pathInfo.name}`, 'MISSING_INTEGRITY', basePath);
    }

    if (pkg.integrity && !this.isValidIntegrity(pkg.integrity)) {
      result.addError(`Invalid integrity format: ${pkg.integrity}`, 'INVALID_INTEGRITY', `${basePath}.integrity`);
    }

    if (pkg.version && !this.isValidVersion(pkg.version)) {
      result.addError(`Invalid version: ${pkg.version}`, 'INVALID_VERSION', `${basePath}.version`);
    }

    if (pkg.dependencies) {
      this.validateDependencyMap(pkg.dependencies, `${basePath}.dependencies`, result);
    }

    if (pkg.peerDependencies) {
      this.validateDependencyMap(pkg.peerDependencies, `${basePath}.peerDependencies`, result);
    }

    if (pkg.optionalDependencies) {
      this.validateDependencyMap(pkg.optionalDependencies, `${basePath}.optionalDependencies`, result);
    }

    const booleanFields = ['dev', 'optional', 'peer', 'devOptional', 'inBundle', 'hasInstallScript'];
    for (const field of booleanFields) {
      if (pkg[field] !== undefined && typeof pkg[field] !== 'boolean') {
        result.addWarning(`${field} should be boolean`, 'INVALID_TYPE', `${basePath}.${field}`);
      }
    }
  }

  validateDependenciesTree(dependencies, version, result, basePath = 'dependencies') {
    if (!dependencies) return;

    if (typeof dependencies !== 'object') {
      result.addError('dependencies must be an object', 'INVALID_DEPENDENCIES', basePath);
      return;
    }

    for (const [name, dep] of Object.entries(dependencies)) {
      this.validateDependencyNode(name, dep, version, result, `${basePath}["${name}"]`);
    }
  }
}
