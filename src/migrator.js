// Package-lock.json migrator

import { detectLockfileVersion, getFormatInfo, parsePackagePath, buildPackagePath, LOCKFILE_VERSIONS } from './format-library.js';

export class MigrationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'MigrationError';
    this.code = code;
    this.details = details;
  }
}

export class PackageLockMigrator {
  constructor(options = {}) {
    this.options = {
      preserveMetadata: options.preserveMetadata ?? true,
      strict: options.strict ?? false,
      ...options
    };
  }

  migrate(lockfileData, targetVersion) {
    const sourceVersion = detectLockfileVersion(lockfileData);

    if (sourceVersion === targetVersion) {
      return { ...lockfileData };
    }

    if (![1, 2, 3].includes(targetVersion)) {
      throw new MigrationError(
        `Invalid target version: ${targetVersion}`,
        'INVALID_TARGET_VERSION'
      );
    }

    const migrationPath = this.getMigrationPath(sourceVersion, targetVersion);
    let result = { ...lockfileData };

    for (const step of migrationPath) {
      result = this.executeMigrationStep(result, step.from, step.to);
    }

    return result;
  }

  getMigrationPath(from, to) {
    const paths = [];

    if (from < to) {
      for (let v = from; v < to; v++) {
        paths.push({ from: v, to: v + 1 });
      }
    } else {
      for (let v = from; v > to; v--) {
        paths.push({ from: v, to: v - 1 });
      }
    }

    return paths;
  }

  executeMigrationStep(data, fromVersion, toVersion) {
    if (fromVersion === 1 && toVersion === 2) {
      return this.migrateV1ToV2(data);
    }
    if (fromVersion === 2 && toVersion === 3) {
      return this.migrateV2ToV3(data);
    }
    if (fromVersion === 2 && toVersion === 1) {
      return this.migrateV2ToV1(data);
    }
    if (fromVersion === 3 && toVersion === 2) {
      return this.migrateV3ToV2(data);
    }

    throw new MigrationError(
      `No migration path from version ${fromVersion} to ${toVersion}`,
      'NO_MIGRATION_PATH'
    );
  }

  migrateV1ToV2(data) {
    const result = {
      name: data.name,
      version: data.version,
      lockfileVersion: 2,
      requires: true,
      packages: {},
      dependencies: data.dependencies || {}
    };

    result.packages[''] = {
      name: data.name,
      version: data.version,
      license: data.license,
      dependencies: this.extractRootDependencies(data.dependencies || {}),
      devDependencies: this.extractRootDevDependencies(data.dependencies || {})
    };

    this.buildPackagesMapFromDependencies(data.dependencies || {}, result.packages);

    return result;
  }

  migrateV2ToV3(data) {
    const result = {
      name: data.name,
      version: data.version,
      lockfileVersion: 3,
      requires: true,
      packages: data.packages || {}
    };

    return result;
  }

  migrateV2ToV1(data) {
    const result = {
      name: data.name,
      version: data.version,
      lockfileVersion: 1,
      requires: true,
      dependencies: data.dependencies || {}
    };

    if (!data.dependencies && data.packages) {
      result.dependencies = this.buildDependenciesTreeFromPackages(data.packages);
    }

    return result;
  }

  migrateV3ToV2(data) {
    const result = {
      name: data.name,
      version: data.version,
      lockfileVersion: 2,
      requires: true,
      packages: data.packages || {},
      dependencies: {}
    };

    if (data.packages) {
      result.dependencies = this.buildDependenciesTreeFromPackages(data.packages);
    }

    return result;
  }

  buildPackagesMapFromDependencies(dependencies, packagesMap, parentPath = '') {
    for (const [name, dep] of Object.entries(dependencies)) {
      const pkgPath = buildPackagePath(name, parentPath);

      const pkg = {
        version: dep.version,
        resolved: dep.resolved,
        integrity: dep.integrity
      };

      if (dep.dev) pkg.dev = true;
      if (dep.optional) pkg.optional = true;
      if (dep.requires) pkg.dependencies = { ...dep.requires };

      packagesMap[pkgPath] = pkg;

      if (dep.dependencies) {
        this.buildPackagesMapFromDependencies(dep.dependencies, packagesMap, pkgPath);
      }
    }
  }

  buildDependenciesTreeFromPackages(packages) {
    const tree = {};
    const packagesByName = new Map();

    for (const [path, pkg] of Object.entries(packages)) {
      if (path === '') continue;

      const pathInfo = parsePackagePath(path);

      if (pathInfo.depth === 1) {
        const depNode = this.packageToDepNode(pkg);
        tree[pathInfo.name] = depNode;
        packagesByName.set(pathInfo.name, depNode);
      }
    }

    for (const [path, pkg] of Object.entries(packages)) {
      if (path === '') continue;

      const pathInfo = parsePackagePath(path);

      if (pathInfo.depth > 1) {
        const parts = path.split('/node_modules/');
        const parentName = parts[parts.length - 2].split('/').pop();
        const parent = packagesByName.get(parentName);

        if (parent) {
          if (!parent.dependencies) parent.dependencies = {};
          parent.dependencies[pathInfo.name] = this.packageToDepNode(pkg);
        }
      }
    }

    return tree;
  }
}
