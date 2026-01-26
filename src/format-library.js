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

export function parseLockfile(content) {
  try {
    return JSON.parse(content);
  } catch (e) {
    throw new Error('Invalid JSON in lockfile');
  }
}

export function stringifyLockfile(lockfile) {
  return JSON.stringify(lockfile, null, 2);
}
