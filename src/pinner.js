// src/pinner.js
import { detectLockfileVersion, LOCKFILE_VERSIONS } from './format-library.js';

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

  const version = detectLockfileVersion(lockfile);
  const hasPackages = version !== LOCKFILE_VERSIONS.V1;

  const activeSections = includePeer ? [...sections, 'peerDependencies'] : sections;

  const newPackageJson = JSON.parse(JSON.stringify(packageJson));
  const newLockfile = JSON.parse(JSON.stringify(lockfile));

  const changes = [];
  const skipped = [];
  const warnings = [];

  if (!hasPackages) {
    warnings.push('v1 lockfile has no packages map; pinned package.json only — consider `npm-check migrate 3`');
  }

  for (const section of activeSections) {
    const deps = newPackageJson[section];
    if (!deps || typeof deps !== 'object') continue;

    for (const [name, range] of Object.entries(deps)) {
      const kind = classifyRange(range);

      if (kind === 'exact') continue;
      if (kind !== 'caret' && kind !== 'tilde') {
        skipped.push({ section, name, range, reason: `${kind}-range` });
        continue;
      }

      const resolvedVersion = hasPackages
        ? lockfile.packages && lockfile.packages[`node_modules/${name}`] && lockfile.packages[`node_modules/${name}`].version
        : lockfile.dependencies && lockfile.dependencies[name] && lockfile.dependencies[name].version;

      if (!resolvedVersion) {
        skipped.push({ section, name, range, reason: 'not-in-lockfile' });
        continue;
      }

      deps[name] = resolvedVersion;
      changes.push({ section, name, from: range, to: resolvedVersion });

      // Keep the lockfile root entry in sync (v2/v3)
      if (hasPackages && newLockfile.packages && newLockfile.packages['']) {
        const rootSection = newLockfile.packages[''][section];
        if (rootSection && Object.prototype.hasOwnProperty.call(rootSection, name)) {
          rootSection[name] = resolvedVersion;
        }
      }
    }
  }

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
