// src/checksum-fixer.js
import fs from 'fs';
import path from 'path';
import { detectLockfileVersion, LOCKFILE_VERSIONS, forEachPackageEntry } from './format-library.js';
import {
  fetchPackumentIntegrity,
  generateIntegrityFromFile,
  isPlaceholder,
  deriveRegistryBase,
  DEFAULT_REGISTRY
} from './integrity.js';
import { hashPackageDirectory } from './checker.js';

// Re-exported for back-compat; the canonical definition now lives in integrity.js
export { deriveRegistryBase } from './integrity.js';

export class ChecksumFixError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'ChecksumFixError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Map items through an async fn with a concurrency cap.
 * Results keep input order; rejections propagate.
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

const NEEDS_FIX_REASONS = {
  missing: (integrity) => !integrity,
  placeholder: (integrity) => isPlaceholder(integrity),
  sha1: (integrity) => typeof integrity === 'string' && integrity.startsWith('sha1-')
};

function needsFix(integrity) {
  if (NEEDS_FIX_REASONS.missing(integrity)) return 'missing';
  if (NEEDS_FIX_REASONS.placeholder(integrity)) return 'placeholder';
  if (NEEDS_FIX_REASONS.sha1(integrity)) return 'sha1';
  return null;
}

/**
 * Build a change record for a resolved hash. Centralizes the common shape so
 * each source (registry, local-file, local-directory) reads identically.
 */
function makeChange(key, entry, name, hash, source) {
  return { packagePath: key, name, version: entry.version, from: entry.integrity || null, to: hash, source };
}

/**
 * Classify a single lockfile entry into either a skip reason or a fix
 * candidate. Returns the work item without recording it, so the caller owns
 * the skipped/candidate buckets. file: tarballs become file-tarball
 * candidates; file: directories are skipped.
 */
function classifyEntry(info, baseDir) {
  const { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep } = info;

  if (isRoot) return { skip: 'root' };
  if (isWorkspaceSource) return { skip: 'workspace' };
  if (isLink) return { skip: 'link' };

  const reason = needsFix(entry.integrity);
  if (!reason) return { skip: 'valid' };

  if (isBundled) return { skip: 'bundled' };
  if (isGitDep) return { skip: 'git' };

  if (isFileDep) {
    // file: specs are relative to the lockfile's directory, not the cwd
    const filePath = path.resolve(baseDir, entry.resolved.slice('file:'.length).replace(/^\/\//, ''));
    if (/\.(tgz|tar\.gz|tar)$/i.test(filePath)) {
      return { candidate: { key, entry, name, fixReason: reason, source: 'file-tarball', filePath } };
    }
    return { skip: 'file-dir' };
  }

  return { candidate: { key, entry, name, fixReason: reason, source: 'registry' } };
}

/**
 * Walk every package entry, sorting them into skips and fix candidates.
 */
function collectCandidates(lockfile, baseDir) {
  const candidates = [];
  const skipped = [];
  let total = 0;

  forEachPackageEntry(lockfile, (info) => {
    total++;
    const outcome = classifyEntry(info, baseDir);
    if (outcome.skip) {
      skipped.push({ packagePath: info.key, reason: outcome.skip });
    } else {
      candidates.push(outcome.candidate);
    }
  });

  return { candidates, skipped, total };
}

/**
 * Resolve a hash for a file-tarball candidate from the local tarball, pushing
 * either a change or an unresolved record.
 */
function resolveFileTarball(candidate, buckets) {
  const { key, entry, name } = candidate;
  const hash = generateIntegrityFromFile(candidate.filePath);
  if (hash) {
    buckets.changes.push(makeChange(key, entry, name, hash, 'local-file'));
  } else {
    buckets.unresolved.push({ packagePath: key, reason: `local tarball not readable: ${candidate.filePath}` });
  }
}

/**
 * Hash a registry candidate's local node_modules copy as a fallback. Records a
 * local-directory change on success and returns true; returns false (leaving
 * the entry unresolved) on any failure.
 *
 * Fix #17: derive the on-disk path from the lockfile key (the install path
 * relative to the project root) rather than slicing at the last node_modules/
 * segment. The old approach mapped nested packages (node_modules/a/node_modules/b)
 * to the wrong hoisted location (node_modules/b). It also silently recorded a
 * constant sha512-of-nothing when the directory was absent, because
 * hashPackageDirectory swallows ENOENT rather than throwing. This function now
 * enforces two invariants before delegating to the hasher:
 *   1. Containment — the resolved path must stay inside baseDir (blocks traversal
 *      keys like node_modules/../../secret).
 *   2. Existence — the directory must be present on disk; absent → unresolved.
 */
async function tryLocalFallback(candidate, baseDir, buckets) {
  const { key, entry, name } = candidate;

  // The lockfile key is the install path relative to the project root, so
  // joining directly with baseDir gives the correct on-disk location for both
  // top-level (node_modules/foo) and nested (node_modules/a/node_modules/b)
  // packages without any segment-slicing.
  const resolvedBase = path.resolve(baseDir);
  const pkgDir = path.resolve(path.join(baseDir, key));

  // Containment check: reject any key that resolves outside the project root.
  if (!pkgDir.startsWith(resolvedBase + path.sep)) {
    return false;
  }

  // Existence check: hashPackageDirectory digests zero bytes and returns a
  // constant sha512-of-nothing for a missing directory rather than throwing —
  // without this guard that garbage constant would be silently recorded.
  if (!fs.existsSync(pkgDir)) {
    return false;
  }

  try {
    const localHash = await hashPackageDirectory(pkgDir);
    buckets.changes.push(makeChange(key, entry, name, localHash, 'local-directory'));
    return true;
  } catch {
    return false;
  }
}

/**
 * Record why a registry candidate could not be resolved, distinguishing a
 * network failure, a versionless entry, and a registry with no sha512 hash.
 */
function recordUnresolved(candidate, networkError, localFallback, buckets) {
  const { key, entry, name, fixReason } = candidate;
  if (networkError) {
    buckets.unresolved.push({ packagePath: key, reason: `registry unreachable (${networkError.message})${localFallback ? '' : '; consider --local-fallback'}` });
  } else if (!entry.version) {
    buckets.unresolved.push({ packagePath: key, reason: `cannot fix ${fixReason} integrity: entry has no version` });
  } else {
    buckets.unresolved.push({ packagePath: key, reason: `registry has no sha512 integrity for ${name}@${entry.version}` });
  }
}

/**
 * Resolve a hash for a registry candidate: try the registry, then the optional
 * local fallback, then record an unresolved reason.
 */
async function resolveRegistryCandidate(candidate, settings, buckets) {
  const { key, entry, name } = candidate;
  const { fetcher, defaultRegistry, localFallback, baseDir } = settings;

  const registryBase = deriveRegistryBase(entry.resolved, name) || defaultRegistry;
  let hash = null;
  let networkError = null;
  try {
    hash = entry.version ? await fetcher(name, entry.version, registryBase) : null;
  } catch (e) {
    networkError = e;
  }

  if (hash) {
    buckets.changes.push(makeChange(key, entry, name, hash, 'registry'));
    return;
  }

  if (localFallback && await tryLocalFallback(candidate, baseDir, buckets)) {
    return;
  }

  recordUnresolved(candidate, networkError, localFallback, buckets);
}

/**
 * Navigate to the node in the legacy v2 dependencies tree that corresponds to
 * a packages-map key, returning the leaf object or null when the path is
 * absent.
 *
 * "node_modules/foo"                  → dependencies["foo"]
 * "node_modules/a/node_modules/b"     → dependencies["a"]["dependencies"]["b"]
 * "node_modules/@scope/pkg"           → dependencies["@scope/pkg"]
 */
function getDepsNode(dependencies, pkgKey) {
  // Only handle keys rooted at "node_modules/…"; workspace-level keys are skipped.
  if (!pkgKey.startsWith('node_modules/')) return null;
  // Slice off the leading "node_modules/" then split the remainder by the
  // nested-package delimiter to obtain the name chain.
  // "node_modules/foo"            → rest="foo"            → names=["foo"]
  // "node_modules/a/node_modules/b" → rest="a/node_modules/b" → names=["a","b"]
  const names = pkgKey.slice('node_modules/'.length).split('/node_modules/');
  let current = dependencies;
  for (let i = 0; i < names.length - 1; i++) {
    current = current[names[i]]?.dependencies;
    if (!current) return null;
  }
  return current[names[names.length - 1]] ?? null;
}

/**
 * Apply the collected integrity changes to a shallow copy of the lockfile.
 *
 * Fix #19: v2 lockfiles carry both a packages map and a legacy dependencies
 * tree. The old code only updated packages, leaving the dependencies tree with
 * stale hashes — the exact inconsistency the validator flags as an error.
 * When lockfile.dependencies is present, each change is now mirrored into the
 * corresponding node of the legacy tree so both sections stay consistent.
 */
function applyChanges(lockfile, changes) {
  const updated = {
    ...lockfile,
    packages: { ...lockfile.packages }
  };

  // Deep-copy the legacy dependencies tree once so we can mutate the copy
  // without touching the input lockfile.
  const updatedDeps = lockfile.dependencies
    ? JSON.parse(JSON.stringify(lockfile.dependencies))
    : null;

  for (const change of changes) {
    updated.packages[change.packagePath] = {
      ...updated.packages[change.packagePath],
      integrity: change.to
    };

    // Mirror into the v2 legacy dependencies tree when present.
    if (updatedDeps) {
      const node = getDepsNode(updatedDeps, change.packagePath);
      if (node) {
        node.integrity = change.to;
      }
    }
  }

  if (updatedDeps) {
    updated.dependencies = updatedDeps;
  }

  return updated;
}

/**
 * Fill missing, placeholder, or weak (sha1) integrity hashes with real ones.
 * Fetches the authoritative dist.integrity from the package's registry
 * (derived per-package from its resolved URL); optionally falls back to
 * hashing the local node_modules copy — those hashes are flagged because
 * they are NOT npm tarball hashes and npm ci will not verify them.
 *
 * @param {object} lockfile - Parsed lockfile (v2/v3)
 * @param {object} options
 * @returns {Promise<{lockfile, changes, unresolved, skipped, warnings, summary}>}
 */
export async function fixChecksums(lockfile, options = {}) {
  const {
    onProgress = null,
    concurrency = 8,
    timeoutMs = 10000,
    localFallback = false,
    nodeModulesPath = './node_modules', // accepted for API compat; path is now derived from baseDir + key
    defaultRegistry = DEFAULT_REGISTRY,
    fetchIntegrity = null,
    baseDir = '.'
  } = options;

  if (detectLockfileVersion(lockfile) === LOCKFILE_VERSIONS.V1) {
    throw new ChecksumFixError(
      'v1 lockfiles are not supported; run `npm-check migrate 3` first',
      'UNSUPPORTED_VERSION'
    );
  }

  const fetcher = fetchIntegrity ||
    ((name, ver, registryBase) => fetchPackumentIntegrity(name, ver, { registryBase, timeoutMs }));

  const { candidates, skipped, total } = collectCandidates(lockfile, baseDir);

  const buckets = { changes: [], unresolved: [], warnings: [] };
  let completed = 0;

  const reportProgress = (stage) => {
    if (onProgress) {
      onProgress({
        current: completed,
        total: candidates.length,
        percentage: candidates.length === 0 ? 100 : Math.round((completed / candidates.length) * 100),
        stage
      });
    }
  };

  reportProgress('Fetching integrity hashes');

  const settings = { fetcher, defaultRegistry, localFallback, baseDir };
  await mapWithConcurrency(candidates, concurrency, async (candidate) => {
    try {
      if (candidate.source === 'file-tarball') {
        resolveFileTarball(candidate, buckets);
      } else {
        await resolveRegistryCandidate(candidate, settings, buckets);
      }
    } finally {
      completed++;
      reportProgress('Fetching integrity hashes');
    }
  });

  const { changes, unresolved, warnings } = buckets;

  const localDirCount = changes.filter((c) => c.source === 'local-directory').length;
  if (localDirCount > 0) {
    warnings.push(
      `${localDirCount} hash(es) were computed from node_modules directories; these are NOT npm ` +
      'tarball hashes and `npm ci` will fail integrity verification against the registry. ' +
      'Use only for air-gapped/internal verification.'
    );
  }

  // Suppress the unused variable warning — nodeModulesPath is kept in the destructuring
  // for backward-compatible API surface but is no longer used internally (see fix #17).
  void nodeModulesPath;

  return {
    lockfile: applyChanges(lockfile, changes),
    changes,
    unresolved,
    skipped,
    warnings,
    summary: {
      total,
      candidates: candidates.length,
      fixedFromRegistry: changes.filter((c) => c.source === 'registry').length,
      fixedFromLocal: changes.filter((c) => c.source === 'local-directory' || c.source === 'local-file').length,
      unresolved: unresolved.length,
      skipped: skipped.length
    }
  };
}
