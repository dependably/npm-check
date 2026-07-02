// src/pinner.js
import { detectLockfileVersion, LOCKFILE_VERSIONS } from './format-library.js';
import { walkOverrides } from './overrides.js';

export class PinnerError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'PinnerError';
    this.code = code;
    this.context = context;
  }
}

const EXACT_VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z-.+]+)?$/;
const CARET_RANGE = /^\^\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z-.+]+)?$/;
const TILDE_RANGE = /^~\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z-.+]+)?$/;

/**
 * Classify a package.json version range.
 * @param {string} range - The range string
 * @returns {string} 'exact' | 'caret' | 'tilde' | 'complex' | 'git' | 'file' | 'link' | 'workspace' | 'alias' | 'url'
 */
export function classifyRange(range) {
  if (typeof range !== 'string' || range.trim() === '') return 'complex';
  const r = range.trim();

  if (r.startsWith('npm:')) return 'alias';
  if (r.startsWith('workspace:')) return 'workspace';
  if (r.startsWith('file:')) return 'file';
  if (r.startsWith('link:')) return 'link';
  if (r.startsWith('git+') || r.startsWith('git://') || /^(github|gitlab|bitbucket):/.test(r)) return 'git';
  if (/^https?:\/\//.test(r)) return 'url';

  if (EXACT_VERSION.test(r)) return 'exact';
  if (CARET_RANGE.test(r)) return 'caret';
  if (TILDE_RANGE.test(r)) return 'tilde';

  // Everything else: >=, <=, ||, x-ranges, *, dist-tags, hyphen ranges,
  // and GitHub shorthand like user/repo (indistinguishable from tags safely → complex)
  return 'complex';
}

const DEFAULT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies'];

/**
 * Look up the version a package resolved to in the lockfile.
 * v2/v3 use the packages map keyed by install path; v1 uses the dependencies tree.
 * @param {object} lockfile - Parsed lockfile
 * @param {string} name - Package name
 * @param {boolean} hasPackages - Whether the lockfile has a packages map (v2/v3)
 * @returns {string|undefined} The resolved version, or undefined if absent
 */
function resolvedVersionFor(lockfile, name, hasPackages) {
  if (hasPackages) {
    const entry = lockfile.packages && lockfile.packages[`node_modules/${name}`];
    return entry && entry.version;
  }
  const entry = lockfile.dependencies && lockfile.dependencies[name];
  return entry && entry.version;
}

/**
 * Keep the lockfile root entry (packages['']) in sync after pinning (v2/v3 only).
 * Only rewrites a range that's already present in the matching root section.
 * @param {object} lockfile - The (cloned) lockfile being mutated
 * @param {string} section - The dependency section
 * @param {string} name - Package name
 * @param {string} resolvedVersion - The exact version to pin to
 */
function syncLockfileRoot(lockfile, section, name, resolvedVersion) {
  if (!lockfile.packages || !lockfile.packages['']) return;
  const rootSection = lockfile.packages[''][section];
  if (rootSection && Object.prototype.hasOwnProperty.call(rootSection, name)) {
    rootSection[name] = resolvedVersion;
  }
}

/**
 * Pin a single dependency's range to the lockfile-resolved version, recording
 * the result into changes/skipped and syncing the lockfile root on success.
 * @param {object} ctx - { sourceLockfile, newLockfile, hasPackages, changes, skipped }
 * @param {object} deps - The (cloned) package.json section being mutated
 * @param {string} section - The dependency section
 * @param {string} name - Package name
 * @param {string} range - The original range
 */
function pinDependency(ctx, deps, section, name, range) {
  const kind = classifyRange(range);

  if (kind === 'exact') return;
  if (kind !== 'caret' && kind !== 'tilde') {
    ctx.skipped.push({ section, name, range, reason: `${kind}-range` });
    return;
  }

  const resolvedVersion = resolvedVersionFor(ctx.sourceLockfile, name, ctx.hasPackages);
  if (!resolvedVersion) {
    ctx.skipped.push({ section, name, range, reason: 'not-in-lockfile' });
    return;
  }

  deps[name] = resolvedVersion;
  ctx.changes.push({ section, name, from: range, to: resolvedVersion });

  // Keep the lockfile root entry in sync (v2/v3)
  if (ctx.hasPackages) {
    syncLockfileRoot(ctx.newLockfile, section, name, resolvedVersion);
  }
}

/**
 * Collect every DISTINCT version a package name resolves to anywhere in the
 * lockfile. An override forces all instances and a nested selector targets a
 * shadowed install path (e.g. node_modules/a/node_modules/b), so the top-level
 * `node_modules/<name>` entry alone can be the wrong instance to pin to.
 * @param {object} lockfile - The source lockfile
 * @param {string} name - Package name (selector already stripped)
 * @param {boolean} hasPackages - v2/v3 (packages map) vs v1 (dependencies tree)
 * @returns {Set<string>} Distinct resolved versions
 */
function collectResolvedVersions(lockfile, name, hasPackages) {
  const versions = new Set();
  if (hasPackages) {
    const suffix = `node_modules/${name}`;
    for (const [key, entry] of Object.entries(lockfile.packages || {})) {
      if ((key === suffix || key.endsWith(`/${suffix}`)) && entry && entry.version) {
        versions.add(entry.version);
      }
    }
  } else {
    const walk = (tree) => {
      if (!tree || typeof tree !== 'object') return;
      for (const [depName, node] of Object.entries(tree)) {
        if (!node || typeof node !== 'object') continue;
        if (depName === name && node.version) versions.add(node.version);
        if (node.dependencies) walk(node.dependencies);
      }
    };
    walk(lockfile.dependencies);
  }
  return versions;
}

/**
 * Pin caret/tilde ranges inside the npm `overrides` field to their lockfile-
 * resolved versions. `overrides` is nested and never mirrored into packages[''],
 * so there is no lockfile-root sync — the caller runs `npm install` to reconcile.
 * `$`-references and non-caret/tilde forms are left alone (reported in skipped).
 * Pins only when the name resolves to a SINGLE version tree-wide; a name present
 * at multiple versions is skipped `ambiguous-resolution` rather than pinned to a
 * possibly-wrong instance.
 * @param {object} ctx - Shared context (see pinDependency)
 * @param {object} overrides - The (cloned) package.json `overrides` object
 */
function pinOverrides(ctx, overrides) {
  if (!overrides || typeof overrides !== 'object') return;
  for (const { path, name, range, container, key } of walkOverrides(overrides)) {
    const kind = classifyRange(range);
    if (kind === 'exact') continue;
    if (kind !== 'caret' && kind !== 'tilde') {
      ctx.skipped.push({ section: 'overrides', name: path, range, reason: `${kind}-range` });
      continue;
    }
    const versions = collectResolvedVersions(ctx.sourceLockfile, name, ctx.hasPackages);
    if (versions.size === 0) {
      ctx.skipped.push({ section: 'overrides', name: path, range, reason: 'not-in-lockfile' });
      continue;
    }
    if (versions.size > 1) {
      ctx.skipped.push({ section: 'overrides', name: path, range, reason: 'ambiguous-resolution' });
      continue;
    }
    const resolvedVersion = [...versions][0];
    container[key] = resolvedVersion;
    ctx.changes.push({ section: 'overrides', name: path, from: range, to: resolvedVersion });
  }
}

/**
 * Pin caret/tilde ranges in package.json to the exact versions resolved in
 * the lockfile, and keep the lockfile's root entry (packages['']) in sync.
 * All other range forms are left alone and reported in `skipped`.
 *
 * @param {object} packageJson - Parsed package.json
 * @param {object} lockfile - Parsed lockfile
 * @param {object} options - { sections, includePeer }
 * @returns {{packageJson, lockfile, changes, skipped, warnings}}
 */
export function pinVersions(packageJson, lockfile, options = {}) {
  const { sections = DEFAULT_SECTIONS, includePeer = false } = options;

  if (!packageJson || typeof packageJson !== 'object') {
    throw new PinnerError('package.json data is required', 'MISSING_PACKAGE_JSON');
  }
  if (!lockfile || typeof lockfile !== 'object') {
    throw new PinnerError('lockfile data is required', 'MISSING_LOCKFILE');
  }

  const hasPackages = detectLockfileVersion(lockfile) !== LOCKFILE_VERSIONS.V1;
  const activeSections = includePeer ? [...sections, 'peerDependencies'] : sections;

  const newPackageJson = JSON.parse(JSON.stringify(packageJson));
  const newLockfile = JSON.parse(JSON.stringify(lockfile));

  const changes = [];
  const skipped = [];
  const warnings = [];

  if (!hasPackages) {
    warnings.push('v1 lockfile has no packages map; pinned package.json only — consider `npm-check migrate 3`');
  }

  const ctx = { sourceLockfile: lockfile, newLockfile, hasPackages, changes, skipped };

  for (const section of activeSections) {
    const deps = newPackageJson[section];
    if (!deps || typeof deps !== 'object') continue;

    for (const [name, range] of Object.entries(deps)) {
      pinDependency(ctx, deps, section, name, range);
    }
  }

  // npm `overrides` (nested) — pnpm.overrides is deliberately left alone: `pin`
  // refuses pnpm lockfiles, and its selector keys don't map to a resolvable
  // package name here. The audit `pinned-versions` rule still flags both.
  pinOverrides(ctx, newPackageJson.overrides);

  if (skipped.some((s) => s.reason === 'not-in-lockfile')) {
    warnings.push('some dependencies are missing from the lockfile; run `npm install` to sync it');
  }

  return { packageJson: newPackageJson, lockfile: newLockfile, changes, skipped, warnings };
}

/**
 * Detect the indentation used in a JSON file's raw text (default two spaces).
 * @param {string} rawText - Original file content
 * @returns {string} Indentation string
 */
export function detectIndent(rawText) {
  const match = typeof rawText === 'string' ? rawText.match(/^([ \t]+)["{[]/m) : null;
  return match ? match[1] : '  ';
}
