// src/format-library.js
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
 * Iterate the v2/v3 packages map, classifying each entry.
 * The callback receives:
 *   { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep }
 * @param {object} lockfile - Lockfile with a packages map
 * @param {function} callback - Called for each entry
 */
export function forEachPackageEntry(lockfile, callback) {
  const packages = lockfile.packages || {};
  for (const [key, entry] of Object.entries(packages)) {
    const resolved = (entry && entry.resolved) || '';
    callback({
      key,
      entry,
      name: resolvePackageName(key, entry),
      isRoot: key === '',
      isWorkspaceSource: key !== '' && !key.includes('node_modules/'),
      isLink: Boolean(entry && entry.link),
      isBundled: Boolean(entry && entry.inBundle),
      isGitDep: resolved.startsWith('git+') || resolved.startsWith('git://'),
      isFileDep: resolved.startsWith('file:')
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
