// src/format-library.js
import { deriveRegistryBase } from './integrity.js';
import { forEachPnpmPackageEntry } from './pnpm-format.js';

export const LOCKFILE_VERSIONS = {
  V1: 1,
  V2: 2,
  V3: 3
};

export function detectLockfileVersion(lockfile) {
  const version = lockfile.lockfileVersion;
  if (version === 1) return LOCKFILE_VERSIONS.V1;
  if (version === 2) return LOCKFILE_VERSIONS.V2;
  if (version === 3) return LOCKFILE_VERSIONS.V3;
  throw new Error(`Unsupported lockfile version: ${version}`);
}

/**
 * Identify which package manager produced a parsed lockfile.
 * pnpm-lock.yaml uses a STRING `lockfileVersion` ('9.0', '6.0', …) and carries
 * `importers`/`snapshots`; npm uses a NUMERIC `lockfileVersion` and a `packages`
 * map keyed by install path. The parser stamps `__npmCheckMeta.flavor`, which is
 * trusted first when present.
 * @param {object} lockfile - Parsed lockfile
 * @returns {'npm'|'pnpm'} Flavor
 */
export function detectLockfileFlavor(lockfile) {
  if (!lockfile || typeof lockfile !== 'object') return 'npm';
  if (lockfile.__npmCheckMeta && lockfile.__npmCheckMeta.flavor) return lockfile.__npmCheckMeta.flavor;
  if (typeof lockfile.lockfileVersion === 'string') return 'pnpm';
  if (lockfile.importers || lockfile.snapshots) return 'pnpm';
  return 'npm';
}

// Collapse the boolean classification flags into the normalized node `kind`.
function npmEntryKind(flags) {
  if (flags.isRoot) return 'root';
  if (flags.isWorkspaceSource) return 'workspace';
  if (flags.isLink) return 'link';
  if (flags.isGitDep) return 'git';
  if (flags.isFileDep) return 'file';
  if (flags.isBundled) return 'bundled';
  return 'registry';
}

export function hasPackagesMap(version) {
  return version === LOCKFILE_VERSIONS.V2 || version === LOCKFILE_VERSIONS.V3;
}

export function hasDependenciesTree(version) {
  return version === LOCKFILE_VERSIONS.V1;
}

/**
 * Resolve the real package name for a packages-map entry.
 * Uses entry.name when present (set for npm: aliases), otherwise the
 * last node_modules/ segment of the key (handles scoped packages).
 * @param {string} key - Key in the packages map
 * @param {object} entry - Package entry data
 * @returns {string|null} Package name or null for the root entry
 */
export function resolvePackageName(key, entry) {
  if (entry && entry.name) return entry.name;
  if (!key) return null;
  const marker = 'node_modules/';
  const idx = key.lastIndexOf(marker);
  if (idx === -1) return key;
  return key.slice(idx + marker.length);
}

/**
 * Iterate a lockfile's package entries, classifying each one. Dispatches by flavor:
 * the npm v2/v3 `packages` map (keyed by install path) or pnpm-lock's `packages` +
 * `importers`. Both flavors emit the SAME callback shape:
 *   { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep,
 *     isFileDep, registryBase, node }
 * `registryBase` is the per-package registry (npm: derived from the entry's
 * `resolved` URL, may be null; pnpm: resolved from config) so consumers read one
 * uniform field instead of re-deriving it. `node` is the normalized package node.
 * @param {object} lockfile - Parsed lockfile (npm v2/v3 or pnpm)
 * @param {function} callback - Called for each entry
 */
export function forEachPackageEntry(lockfile, callback) {
  if (detectLockfileFlavor(lockfile) === 'pnpm') {
    return forEachPnpmPackageEntry(lockfile, callback);
  }
  const packages = lockfile.packages || {};
  for (const [key, entry] of Object.entries(packages)) {
    const resolved = (entry && entry.resolved) || '';
    const name = resolvePackageName(key, entry);
    const flags = {
      isRoot: key === '',
      isWorkspaceSource: key !== '' && !key.includes('node_modules/'),
      isLink: Boolean(entry && entry.link),
      isBundled: Boolean(entry && entry.inBundle),
      isGitDep: resolved.startsWith('git+') || resolved.startsWith('git://'),
      isFileDep: resolved.startsWith('file:')
    };
    // Per-package registry from the resolved URL (null when not derivable — the
    // historical `deriveRegistryBase(...) || defaultRegistry` fallback lives in the
    // consumers, so behavior is byte-identical).
    const registryBase = deriveRegistryBase(resolved, name);
    callback({
      key,
      entry,
      name,
      ...flags,
      registryBase,
      node: {
        name,
        version: (entry && entry.version) || null,
        integrity: (entry && entry.integrity) || null,
        registryBase,
        kind: npmEntryKind(flags),
        path: key
      }
    });
  }
}

export function parseLockfile(content) {
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('Invalid JSON in lockfile', { cause: e });
  }
}

export function stringifyLockfile(lockfile) {
  return JSON.stringify(lockfile, null, 2);
}
