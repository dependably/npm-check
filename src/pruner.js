// src/pruner.js
import { detectLockfileVersion, LOCKFILE_VERSIONS } from './format-library.js';

export class PrunerError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'PrunerError';
    this.code = code;
    this.context = context;
  }
}

const ROOT_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
// npm 7+ auto-installs peers, so they count toward reachability everywhere
const PACKAGE_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'];

/**
 * Resolve where npm would look up dependency `name` required from the package
 * at `key`, following node_modules resolution: the package's own node_modules,
 * then each ancestor's, ending at the top level.
 * @returns {string[]} Candidate keys, nearest first
 */
function resolutionCandidates(key, name) {
  const candidates = [];
  let host = key;
  for (;;) {
    candidates.push(host === '' ? `node_modules/${name}` : `${host}/node_modules/${name}`);
    if (host === '') break;
    const idx = host.lastIndexOf('/node_modules/');
    if (idx === -1) {
      // workspace dir (e.g. 'packages/foo') or top-level 'node_modules/x' → root next
      host = '';
    } else {
      host = host.slice(0, idx);
    }
  }
  return candidates;
}

/**
 * A root-like entry is the project itself ('') or a workspace source dir —
 * anything not installed under a node_modules/ path.
 */
function isRootLike(key) {
  return key === '' || !key.includes('node_modules/');
}

/**
 * Mark `target` reachable and enqueue it, but only the first time it is seen
 * and only when it exists in the packages map.
 */
function visit(target, packages, reachable, queue) {
  if (packages[target] === undefined || reachable.has(target)) return;
  reachable.add(target);
  queue.push(target);
}

/**
 * Follow the node_modules resolution chain for dependency `name` required from
 * `key`, marking the nearest existing match reachable (like node resolution).
 */
function visitDependency(key, name, packages, reachable, queue) {
  for (const candidate of resolutionCandidates(key, name)) {
    if (packages[candidate] !== undefined) {
      visit(candidate, packages, reachable, queue);
      break; // nearest hit wins, like node resolution
    }
  }
}

/**
 * Process one dequeued entry: follow its link target (if any) and every
 * dependency edge in the sections that apply to its position in the tree.
 */
function walkEntry(key, entry, packages, reachable, queue) {
  // Link entries point at their target (usually a workspace dir)
  if (entry.link && typeof entry.resolved === 'string') {
    visit(entry.resolved, packages, reachable, queue);
  }

  const sections = isRootLike(key) ? ROOT_SECTIONS : PACKAGE_SECTIONS;
  for (const section of sections) {
    const deps = entry[section];
    if (!deps || typeof deps !== 'object') continue;
    for (const name of Object.keys(deps)) {
      visitDependency(key, name, packages, reachable, queue);
    }
  }
}

/**
 * Derive the package name for an orphan entry: prefer its explicit `.name`,
 * otherwise the last node_modules/ path segment.
 */
function orphanName(key, entry) {
  if (entry && entry.name) return entry.name;
  return key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
}

/**
 * Compute which packages-map entries are reachable from the root package and
 * workspace entries by following dependency edges with npm's resolution rules.
 *
 * @param {object} lockfile - Parsed v2/v3 lockfile
 * @returns {{reachable: Set<string>, orphans: Array<{key, name, version}>}}
 */
export function findOrphanedPackages(lockfile) {
  if (detectLockfileVersion(lockfile) === LOCKFILE_VERSIONS.V1) {
    throw new PrunerError(
      'v1 lockfiles are not supported; run `npm-check migrate 3` first',
      'UNSUPPORTED_VERSION'
    );
  }

  const packages = lockfile.packages || {};
  const reachable = new Set();
  const queue = [];

  // Roots: the project itself plus workspace source entries
  for (const key of Object.keys(packages)) {
    if (isRootLike(key)) {
      reachable.add(key);
      queue.push(key);
    }
  }

  while (queue.length > 0) {
    const key = queue.shift();
    const entry = packages[key];
    if (entry) walkEntry(key, entry, packages, reachable, queue);
  }

  const orphans = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (!reachable.has(key)) {
      orphans.push({ key, name: orphanName(key, entry), version: entry ? entry.version : undefined });
    }
  }

  return { reachable, orphans };
}

/**
 * Remove orphaned (unreachable) entries from the packages map.
 * v2 lockfiles keep their legacy dependencies tree untouched (npm regenerates
 * it on install); a warning is emitted recommending migration to v3.
 *
 * @param {object} lockfile - Parsed v2/v3 lockfile
 * @returns {{lockfile, removed: Array<{key, name, version}>, warnings: string[]}}
 */
export function prunePackages(lockfile) {
  const { orphans } = findOrphanedPackages(lockfile);
  const warnings = [];

  if (orphans.length === 0) {
    return { lockfile, removed: [], warnings };
  }

  const removedKeys = new Set(orphans.map((o) => o.key));
  const packages = {};
  for (const [key, entry] of Object.entries(lockfile.packages)) {
    if (!removedKeys.has(key)) {
      packages[key] = entry;
    }
  }

  const pruned = { ...lockfile, packages };

  if (detectLockfileVersion(lockfile) === LOCKFILE_VERSIONS.V2 && lockfile.dependencies) {
    warnings.push(
      'v2 legacy dependencies tree was left untouched (npm regenerates it on install); ' +
      'consider `npm-check migrate 3` to drop it entirely'
    );
  }

  return { lockfile: pruned, removed: orphans, warnings };
}
