// src/pnpm-format.js
// pnpm-lock.yaml support. pnpm's lockfile is a different shape from npm's:
//   - YAML, not JSON (`lockfileVersion` is a string like '9.0')
//   - `importers:` declares each workspace's direct deps (the root is the '.' importer)
//   - `packages:` is keyed by `name@version` (not by install path) and carries the
//     `resolution.integrity` we verify against the registry
//   - registry packages store NO `resolved` tarball URL — the registry is implied by
//     config (.npmrc), so we resolve the per-package registry base from that instead
//     of parsing it out of a URL the way the npm path does.
//
// This module gives the rest of the toolkit a uniform view: forEachPnpmPackageEntry
// emits the SAME callback shape as format-library's npm walker (so the integrity /
// vuln / deprecation checkers iterate it unchanged), plus a precomputed `registryBase`
// and a normalized `node`.
import { DEFAULT_REGISTRY } from './integrity.js';

// Strip trailing slashes without a regex (linear scan, no backtracking).
function stripTrailingSlash(url) {
  let base = url;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return base;
}

/**
 * Resolve the registry base for a pnpm package from the project's registry config.
 * Scoped names honour a matching `@scope:registry`; everything else uses the default
 * `registry`, falling back to the public npm registry. Preserves private-registry
 * support without a `resolved` URL to parse.
 * @param {string|null} name - Real package name (may be scoped)
 * @param {object} registryConfig - { registry, scopedRegistries }
 * @returns {string} Registry base URL
 */
export function resolvePnpmRegistryBase(name, registryConfig = {}) {
  const { registry = DEFAULT_REGISTRY, scopedRegistries = {} } = registryConfig;
  if (name && name.startsWith('@')) {
    const slash = name.indexOf('/');
    const scope = slash === -1 ? name : name.slice(0, slash);
    if (scopedRegistries[scope]) return stripTrailingSlash(scopedRegistries[scope]);
  }
  return stripTrailingSlash(registry || DEFAULT_REGISTRY);
}

/**
 * Split a pnpm depPath into { name, version }. Handles every pnpm key form the
 * flavor layer routes here:
 *   - v9 (`lockfileVersion '9.0'`):   `lodash@4.17.21`, `@scope/pkg@1.0.0`
 *   - v6 (`'6.0'`, pnpm 8):           `/lodash@4.17.21`, `/@scope/pkg@1.0.0`
 *   - v5 (`'5.x'`, pnpm 6-7):         `/lodash/4.17.21`, `/@scope/pkg/1.0.0`
 * plus peer suffixes: paren style `foo@1.0.0(react@18.0.0)` (v6/v9) and the older
 * v5 underscore style `react-dom/16.13.1_react@16.13.1`.
 *
 * The paren peer suffix is stripped FIRST so the inner `@` of a peer (`react@18`)
 * can't be mistaken for the version separator. A leading `/` (v5/v6 key form) is then
 * stripped, and the name↔version separator is located past any `@scope/` prefix:
 * whichever of `@` (v6/v9) or `/` (v5) comes first delimits the version. Local deps
 * surface as `name@file:../x` / `name@link:../x`.
 * @param {string} depPath - Key from the pnpm `packages` map
 * @returns {{ name: string, version: string|null }}
 */
export function parsePnpmDepPath(depPath) {
  // 1. Strip a paren-style peer suffix (`(react@18.0.0)`, v6/v9).
  const parenIdx = depPath.indexOf('(');
  let bare = parenIdx === -1 ? depPath : depPath.slice(0, parenIdx);

  // 2. Strip the leading slash of the v5/v6 key forms (v9 keys have none).
  if (bare.startsWith('/')) bare = bare.slice(1);

  // 3. Locate the name↔version separator past any `@scope/` prefix. The name is
  //    either `pkg` or `@scope/pkg`, so begin the search after the scope's slash.
  let searchStart = 0;
  if (bare.startsWith('@')) {
    const scopeSlash = bare.indexOf('/');
    if (scopeSlash !== -1) searchStart = scopeSlash + 1;
  }
  const atSep = bare.indexOf('@', searchStart);
  const slashSep = bare.indexOf('/', searchStart);

  // Slash separator wins only when it exists and precedes any `@` — the v5
  // `/name/version` form. Its version may carry an underscore peer suffix
  // (`16.13.1_react@16.13.1`), trimmed here (semver versions never contain `_`,
  // so this is safe for the slash form).
  if (slashSep !== -1 && (atSep === -1 || slashSep < atSep)) {
    let version = bare.slice(slashSep + 1);
    const underscore = version.indexOf('_');
    if (underscore !== -1) version = version.slice(0, underscore);
    return { name: bare.slice(0, slashSep), version: version || null };
  }
  // Otherwise `@` separates name from version (v6/v9). `file:`/`link:` versions —
  // which contain slashes after the `@` — land here and are preserved verbatim.
  if (atSep > 0) {
    return { name: bare.slice(0, atSep), version: bare.slice(atSep + 1) || null };
  }
  return { name: bare, version: null }; // name with no version / no separator
}

/**
 * Classify a pnpm `packages` entry into the boolean flags the checkers already
 * understand. Only a plain registry package (integrity, semver version, no
 * tarball/git/local marker) is left verifiable; everything else is flagged so the
 * existing skip logic in the checkers passes over it.
 * @param {string} version - Version portion of the depPath
 * @param {object} entry - The pnpm package entry (with `resolution`)
 * @returns {{ kind: string, flags: object }}
 */
function classifyPnpmPackage(version, entry) {
  const resolution = (entry && entry.resolution) || {};
  const flags = { isLink: false, isBundled: false, isGitDep: false, isFileDep: false };

  if (typeof version === 'string' && version.startsWith('link:')) {
    flags.isLink = true;
    return { kind: 'link', flags };
  }
  if (typeof version === 'string' && (version.startsWith('file:') || resolution.directory)) {
    flags.isFileDep = true;
    return { kind: 'file', flags };
  }
  if (resolution.type === 'git' || resolution.repo || (typeof version === 'string' && version.startsWith('git'))) {
    flags.isGitDep = true;
    return { kind: 'git', flags };
  }
  if (resolution.tarball) {
    // Remote URL-tarball dep — may or may not carry its own `integrity`. pnpm records
    // BOTH `tarball` and `integrity` for these (a plain registry entry has integrity
    // and NO tarball). The `version` parsed from the key is the tarball URL, not a
    // registry version, so no registry advisory/manifest applies — treat like a
    // file/url dep so the checkers skip it, regardless of integrity.
    flags.isFileDep = true;
    return { kind: 'tarball', flags };
  }
  if (resolution.integrity) {
    return { kind: 'registry', flags };
  }
  // Unknown / unverifiable shape — flag as file so it is skipped, not mis-checked.
  flags.isFileDep = true;
  return { kind: 'file', flags };
}

/**
 * Iterate a parsed pnpm-lock.yaml, emitting one info object per importer (root /
 * workspace) and per `packages` entry. The shape mirrors format-library's npm
 * walker — { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled,
 * isGitDep, isFileDep } — plus `registryBase` and a normalized `node`, so the
 * downstream checkers iterate npm and pnpm uniformly.
 *
 * The registry config is read from `lockfile.__npmCheckMeta` (stamped by the
 * parser from the sibling .npmrc); absent meta falls back to public-registry
 * defaults.
 * @param {object} lockfile - Parsed pnpm lockfile
 * @param {function} callback - Called with each entry's info
 */
// Per-package registry config, read from `lockfile.__npmCheckMeta` (stamped by the
// parser from the sibling .npmrc); absent meta falls back to public-registry defaults.
function pnpmRegistryConfig(lockfile) {
  const meta = lockfile && lockfile.__npmCheckMeta;
  return {
    registry: (meta && meta.registry) || DEFAULT_REGISTRY,
    scopedRegistries: (meta && meta.scopedRegistries) || {}
  };
}

// Emit one importer (the root project '.' or a workspace package). These have no
// integrity to verify; emitting them keeps counts/iteration aligned with the npm
// root+workspace entries (the checkers skip both).
function emitPnpmImporter(importerKey, callback) {
  const isRoot = importerKey === '.';
  const node = { name: null, version: null, integrity: null, registryBase: null, kind: isRoot ? 'root' : 'workspace', path: importerKey };
  callback({
    key: importerKey,
    entry: {},
    name: null,
    isRoot,
    isWorkspaceSource: !isRoot,
    isLink: false,
    isBundled: false,
    isGitDep: false,
    isFileDep: false,
    registryBase: null,
    node
  });
}

// Emit one resolved `packages` entry (keyed by `name@version`).
function emitPnpmPackage(depPath, entry, registryConfig, callback) {
  const { name, version } = parsePnpmDepPath(depPath);
  const { kind, flags } = classifyPnpmPackage(version, entry);
  const resolution = (entry && entry.resolution) || {};
  const integrity = resolution.integrity || null;
  const registryBase = kind === 'registry' ? resolvePnpmRegistryBase(name, registryConfig) : null;

  // Synthesize an npm-shaped `entry` so the existing checkers read it unchanged:
  // version + integrity are the fields they consult; `resolved` is null for pnpm
  // registry deps (the registry comes from `registryBase`, not a URL).
  const synthEntry = {
    version: version || undefined,
    integrity: integrity || undefined,
    resolved: resolution.tarball || undefined,
    deprecated: entry && entry.deprecated
  };

  callback({
    key: depPath,
    entry: synthEntry,
    name,
    isRoot: false,
    isWorkspaceSource: false,
    isLink: flags.isLink,
    isBundled: flags.isBundled,
    isGitDep: flags.isGitDep,
    isFileDep: flags.isFileDep,
    registryBase,
    node: { name, version: version || null, integrity, registryBase, kind, path: depPath }
  });
}

export function forEachPnpmPackageEntry(lockfile, callback) {
  const registryConfig = pnpmRegistryConfig(lockfile);

  // 1. Importers: the root project ('.') and each workspace package.
  const importers = (lockfile && lockfile.importers) || {};
  for (const importerKey of Object.keys(importers)) {
    emitPnpmImporter(importerKey, callback);
  }

  // 2. Packages: the resolved dependency set, keyed by `name@version`.
  const packages = (lockfile && lockfile.packages) || {};
  for (const [depPath, entry] of Object.entries(packages)) {
    emitPnpmPackage(depPath, entry, registryConfig, callback);
  }
}
