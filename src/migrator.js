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

  const migrated = runMigrationPath(lockfile, currentVersion, targetVersion);
  migrated.lockfileVersion = targetVersion;
  return migrated;
}

// Dispatch to the concrete migration for a (current -> target) pair. Every pair
// documented in CLAUDE.md is handled here (both upgrades and downgrades); the
// multi-version hops (V1<->V3) are composed from the single-step migrations.
function runMigrationPath(lockfile, currentVersion, targetVersion) {
  const { V1, V2, V3 } = LOCKFILE_VERSIONS;
  const key = `${currentVersion}->${targetVersion}`;
  switch (key) {
    case `${V1}->${V2}`: return migrateV1toV2(lockfile);
    case `${V2}->${V3}`: return migrateV2toV3(lockfile);
    case `${V3}->${V2}`: return migrateV3toV2(lockfile);
    case `${V1}->${V3}`: return migrateV2toV3(migrateV1toV2(lockfile));
    case `${V2}->${V1}`: return migrateV2toV1(lockfile);
    case `${V3}->${V1}`: return migrateV2toV1(migrateV3toV2(lockfile));
    default:
      throw new MigrationError(`Unsupported migration path from ${currentVersion} to ${targetVersion}`);
  }
}

// --- Path helpers -----------------------------------------------------------

// Parse a packages-map install path into its node_modules name segments.
// "node_modules/a"                       -> ['a']
// "node_modules/@scope/a"                -> ['@scope/a']
// "node_modules/a/node_modules/b"        -> ['a', 'b']
// "node_modules/a/node_modules/@scope/b" -> ['a', '@scope/b']
// Returns null for workspace source paths (e.g. "packages/app") which are not
// node_modules installs and have no place in the legacy dependencies tree.
function parseInstallPath(key) {
  const prefix = 'node_modules/';
  if (!key.startsWith(prefix)) return null;
  return key.slice(prefix.length).split('/node_modules/');
}

// Merge a package entry's runtime/optional/peer dependency ranges into the
// legacy tree's `requires` map (name -> range string). Returns null when empty.
function buildRequires(pkg) {
  const requires = {};
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const deps = pkg[section];
    if (deps && typeof deps === 'object') {
      for (const [name, range] of Object.entries(deps)) {
        if (typeof range === 'string') requires[name] = range;
      }
    }
  }
  return Object.keys(requires).length > 0 ? requires : null;
}

// Convert a v2/v3 packages-map entry into a legacy (v1/v2) dependencies-tree
// node: a resolution object {version, resolved, integrity, requires, ...}.
// `existing` preserves any nested `dependencies` already built from children
// that were seen before their parent.
function packageEntryToLegacyNode(pkg, existing) {
  const node = { version: typeof pkg.version === 'string' ? pkg.version : '' };
  if (pkg.resolved) node.resolved = pkg.resolved;
  if (pkg.integrity) node.integrity = pkg.integrity;
  if (pkg.dev) node.dev = true;
  if (pkg.optional) node.optional = true;
  const requires = buildRequires(pkg);
  if (requires) node.requires = requires;
  if (existing && existing.dependencies) node.dependencies = existing.dependencies;
  return node;
}

// Reconstruct the nested legacy dependencies tree from a v2/v3 packages map.
// Order-independent: parents seen after their children keep the children that
// were already placed under them.
function buildDependenciesTreeFromPackages(packages) {
  const root = {};
  for (const [key, pkg] of Object.entries(packages)) {
    if (key === '' || !pkg || typeof pkg !== 'object') continue;
    const segments = parseInstallPath(key);
    if (!segments || segments.length === 0) continue; // workspace source dir, not an install

    let tree = root;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      if (!tree[seg]) tree[seg] = { version: '' };
      if (!tree[seg].dependencies) tree[seg].dependencies = {};
      tree = tree[seg].dependencies;
    }
    const name = segments[segments.length - 1];
    tree[name] = packageEntryToLegacyNode(pkg, tree[name]);
  }
  return root;
}

// Convert a v1 dependencies-tree node into a v2 packages-map entry (drops the
// nested `dependencies` — those become their own path-keyed entries — and turns
// `requires` back into a `dependencies` range map).
function v1NodeToPackageEntry(node) {
  const entry = {};
  if (node.version !== undefined) entry.version = node.version;
  if (node.resolved) entry.resolved = node.resolved;
  if (node.integrity) entry.integrity = node.integrity;
  if (node.dev) entry.dev = true;
  if (node.optional) entry.optional = true;
  if (node.requires && typeof node.requires === 'object') {
    entry.dependencies = { ...node.requires };
  }
  return entry;
}

// Walk a v1 nested dependencies tree, emitting one packages-map entry per node
// keyed by its full node_modules install path.
function walkV1Tree(tree, pathPrefix, packages) {
  for (const [name, node] of Object.entries(tree)) {
    if (!node || typeof node !== 'object') continue;
    const key = `${pathPrefix}/${name}`;
    packages[key] = v1NodeToPackageEntry(node);
    if (node.dependencies && typeof node.dependencies === 'object') {
      walkV1Tree(node.dependencies, `${key}/node_modules`, packages);
    }
  }
}

// Build the v2 packages map from a v1 lockfile's dependencies tree: a root
// entry ('') with direct-dependency range strings, plus a path-keyed entry for
// every node in the tree carrying its resolution data.
function buildPackagesFromV1Tree(lockfile) {
  const packages = {};
  const tree = lockfile.dependencies || {};

  const root = { name: lockfile.name, version: lockfile.version };
  for (const [name, node] of Object.entries(tree)) {
    if (!node || typeof node !== 'object' || typeof node.version !== 'string') continue;
    const section = node.dev ? 'devDependencies' : 'dependencies';
    root[section] = root[section] || {};
    root[section][name] = node.version;
  }
  packages[''] = root;

  walkV1Tree(tree, 'node_modules', packages);
  return packages;
}

// --- Single-step migrations -------------------------------------------------

// V1 -> V2: keep the v1 dependencies tree verbatim (it IS a valid v2 legacy
// tree) and add the packages map derived from it. Nothing is lost.
function migrateV1toV2(lockfile) {
  const packages = buildPackagesFromV1Tree(lockfile);
  return { ...lockfile, packages, requires: true };
}

// V2 -> V3: keep the packages map (including the root '' entry) verbatim; drop
// the legacy dependencies tree and top-level `requires` that v3 must not carry.
function migrateV2toV3(lockfile) {
  const { dependencies, requires, ...rest } = lockfile;
  void dependencies;
  void requires;
  return { ...rest, packages: { ...(lockfile.packages || {}) } };
}

// V3 -> V2: keep the packages map verbatim; reconstruct the legacy dependencies
// tree as resolution objects so npm 6 gets its locked versions back.
function migrateV3toV2(lockfile) {
  const packages = { ...(lockfile.packages || {}) };
  const dependencies = buildDependenciesTreeFromPackages(packages);
  return { ...lockfile, packages, dependencies, requires: true };
}

// V2 -> V1: drop the packages map (and `requires`), keep the legacy dependencies
// tree. When a v2 file lacks that tree, reconstruct it from the packages map.
function migrateV2toV1(lockfile) {
  let dependencies = lockfile.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Object.keys(dependencies).length === 0) {
    dependencies = buildDependenciesTreeFromPackages(lockfile.packages || {});
  }
  const { packages, requires, ...rest } = lockfile;
  void packages;
  void requires;
  return { ...rest, dependencies };
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
