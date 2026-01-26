// src/migrator.js
import { detectLockfileVersion, hasPackagesMap, hasDependenciesTree, LOCKFILE_VERSIONS } from './format-library.js';

export class MigrationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MigrationError';
  }
}

export function migrateToVersion(lockfile, targetVersion) {
  const currentVersion = detectLockfileVersion(lockfile);
  if (targetVersion === currentVersion) return lockfile;

  if (![LOCKFILE_VERSIONS.V1, LOCKFILE_VERSIONS.V2, LOCKFILE_VERSIONS.V3].includes(targetVersion)) {
    throw new MigrationError(`Unsupported target version: ${targetVersion}`);
  }

  let migrated = { ...lockfile };

  if (currentVersion === LOCKFILE_VERSIONS.V1 && targetVersion === LOCKFILE_VERSIONS.V2) {
    migrated = migrateV1toV2(migrated);
  } else if (currentVersion === LOCKFILE_VERSIONS.V2 && targetVersion === LOCKFILE_VERSIONS.V3) {
    migrated = migrateV2toV3(migrated);
  } else if (currentVersion === LOCKFILE_VERSIONS.V3 && targetVersion === LOCKFILE_VERSIONS.V2) {
    migrated = migrateV3toV2(migrated);
  } else if (currentVersion === LOCKFILE_VERSIONS.V1 && targetVersion === LOCKFILE_VERSIONS.V3) {
    migrated = migrateV1toV3(migrated);
  } else {
    throw new MigrationError(`Unsupported migration path from ${currentVersion} to ${targetVersion}`);
  }

  migrated.lockfileVersion = targetVersion;
  return migrated;
}

function migrateV1toV2(lockfile) {
  const packages = {};
  const rootPkg = {
    name: lockfile.name,
    version: lockfile.version,
    dependencies: lockfile.dependencies
  };
  packages[''] = rootPkg;
  return { ...lockfile, packages, requires: true };
}

function migrateV2toV3(lockfile) {
  const dependencies = {};
  for (const [path, pkg] of Object.entries(lockfile.packages)) {
    if (path === '') continue;
    const depName = pkg.name;
    dependencies[depName] = {
      version: pkg.version,
      resolved: pkg.resolved,
      integrity: pkg.integrity
    };
  }
  // Only include top-level `dependencies` when we actually collected entries
  if (Object.keys(dependencies).length === 0) {
    // remove dependencies property if empty
    const { dependencies: _unused, ...rest } = lockfile;
    return { ...rest };
  }
  return { ...lockfile, dependencies };
}

function migrateV3toV2(lockfile) {
  const packages = {};
  // Pull dependencies from top-level or from packages[''] (v3 format may nest them)
  const topDependencies = lockfile.dependencies || (lockfile.packages && lockfile.packages[''] && lockfile.packages[''].dependencies) || {};
  packages[''] = {
    name: lockfile.name,
    version: lockfile.version,
    dependencies: topDependencies
  };
  for (const [name, dep] of Object.entries(topDependencies)) {
    packages[`node_modules/${name}`] = {
      name,
      version: dep.version,
      resolved: dep.resolved,
      integrity: dep.integrity
    };
  }
  // Include top-level dependencies as well in the resulting v2 lockfile
  return { ...lockfile, packages, dependencies: topDependencies, requires: true };
}

function migrateV1toV3(lockfile) {
  const migrated = migrateV1toV2(lockfile);
  return migrateV2toV3(migrated);
}

export class PackageLockMigrator {
  constructor(options = {}) {
    this.preserveMetadata = options.preserveMetadata || false;
  }

  migrate(lockfile, targetVersion) {
    const migrated = migrateToVersion(lockfile, targetVersion);
    if (this.preserveMetadata) {
      const metadata = {
        name: lockfile.name,
        version: lockfile.version
      };
      return { ...migrated, ...metadata };
    }
    return migrated;
  }
}
