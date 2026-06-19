// src/migrator.js
import { detectLockfileVersion, LOCKFILE_VERSIONS } from './format-library.js';

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

function extractRootDependencies(rootPkg, dependencies) {
  // Flatten the root package's dependency tree into top-level entries
  if (!rootPkg.dependencies) return;
  for (const [depName, dep] of Object.entries(rootPkg.dependencies)) {
    dependencies[depName] = {
      version: dep.version || '',
      resolved: dep.resolved,
      integrity: dep.integrity
    };
  }
}

function migrateV2toV3(lockfile) {
  // V3 format keeps the packages structure but simplifies to top-level dependencies
  // However, we need to preserve all package metadata
  const dependencies = {};
  const packages = {};

  // Preserve all non-root packages as-is
  if (lockfile.packages) {
    for (const [pkgPath, pkg] of Object.entries(lockfile.packages)) {
      if (pkgPath === '') {
        // Root package - extract top-level dependencies
        extractRootDependencies(pkg, dependencies);
      } else {
        // Non-root packages - preserve them
        packages[pkgPath] = { ...pkg };
      }
    }
  }

  // Build result maintaining structure
  const result = { ...lockfile };
  
  // In v3, we can optionally keep packages or flatten to dependencies
  // For better preservation, keep both structures
  if (Object.keys(packages).length > 0) {
    result.packages = packages;
  }

  result.dependencies = dependencies;
  
  return result;
}

function migrateV3toV2(lockfile) {
  const packages = {};
  
  // Pull dependencies from top-level or from packages['']
  const topDependencies = lockfile.dependencies || 
    (lockfile.packages && lockfile.packages[''] && lockfile.packages[''].dependencies) || 
    {};
  
  // Root package entry
  packages[''] = {
    name: lockfile.name,
    version: lockfile.version,
    dependencies: topDependencies
  };
  
  // Preserve all existing packages from v3 format
  if (lockfile.packages) {
    for (const [pkgPath, pkg] of Object.entries(lockfile.packages)) {
      if (pkgPath !== '') {
        // Preserve non-root packages as-is
        packages[pkgPath] = { ...pkg };
      }
    }
  }
  
  // Ensure top-level dependencies are also in the result
  for (const [name, dep] of Object.entries(topDependencies)) {
    // Only add node_modules entry if not already present
    const nodeModulesPath = `node_modules/${name}`;
    if (!packages[nodeModulesPath]) {
      packages[nodeModulesPath] = {
        name,
        version: dep.version || '',
        resolved: dep.resolved,
        integrity: dep.integrity
      };
    }
  }
  
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
