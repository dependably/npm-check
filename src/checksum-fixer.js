// src/checksum-fixer.js
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
    nodeModulesPath = './node_modules',
    defaultRegistry = DEFAULT_REGISTRY,
    fetchIntegrity = null,
    baseDir = '.'
  } = options;

  const version = detectLockfileVersion(lockfile);
  if (version === LOCKFILE_VERSIONS.V1) {
    throw new ChecksumFixError(
      'v1 lockfiles are not supported; run `npm-check migrate 3` first',
      'UNSUPPORTED_VERSION'
    );
  }

  const fetcher = fetchIntegrity ||
    ((name, ver, registryBase) => fetchPackumentIntegrity(name, ver, { registryBase, timeoutMs }));

  const candidates = [];
  const skipped = [];
  let total = 0;

  forEachPackageEntry(lockfile, (info) => {
    total++;
    const { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep } = info;

    if (isRoot) return skipped.push({ packagePath: key, reason: 'root' });
    if (isWorkspaceSource) return skipped.push({ packagePath: key, reason: 'workspace' });
    if (isLink) return skipped.push({ packagePath: key, reason: 'link' });

    const reason = needsFix(entry.integrity);
    if (!reason) return skipped.push({ packagePath: key, reason: 'valid' });

    if (isBundled) return skipped.push({ packagePath: key, reason: 'bundled' });
    if (isGitDep) return skipped.push({ packagePath: key, reason: 'git' });
    if (isFileDep) {
      // file: specs are relative to the lockfile's directory, not the cwd
      const filePath = path.resolve(baseDir, entry.resolved.slice('file:'.length).replace(/^\/\//, ''));
      if (/\.(tgz|tar\.gz|tar)$/i.test(filePath)) {
        candidates.push({ key, entry, name, fixReason: reason, source: 'file-tarball', filePath });
      } else {
        skipped.push({ packagePath: key, reason: 'file-dir' });
      }
      return;
    }

    candidates.push({ key, entry, name, fixReason: reason, source: 'registry' });
  });

  const changes = [];
  const unresolved = [];
  const warnings = [];
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

  await mapWithConcurrency(candidates, concurrency, async (candidate) => {
    const { key, entry, name, fixReason, source } = candidate;
    try {
      if (source === 'file-tarball') {
        const hash = generateIntegrityFromFile(candidate.filePath);
        if (hash) {
          changes.push({ packagePath: key, name, version: entry.version, from: entry.integrity || null, to: hash, source: 'local-file' });
        } else {
          unresolved.push({ packagePath: key, reason: `local tarball not readable: ${candidate.filePath}` });
        }
        return;
      }

      const registryBase = deriveRegistryBase(entry.resolved, name) || defaultRegistry;
      let hash = null;
      let networkError = null;
      try {
        hash = entry.version ? await fetcher(name, entry.version, registryBase) : null;
      } catch (e) {
        networkError = e;
      }

      if (hash) {
        changes.push({ packagePath: key, name, version: entry.version, from: entry.integrity || null, to: hash, source: 'registry' });
        return;
      }

      if (localFallback) {
        const pkgDir = path.join(nodeModulesPath, key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length));
        try {
          const localHash = await hashPackageDirectory(pkgDir);
          changes.push({ packagePath: key, name, version: entry.version, from: entry.integrity || null, to: localHash, source: 'local-directory' });
          return;
        } catch (e) {
          // fall through to unresolved
        }
      }

      if (networkError) {
        unresolved.push({ packagePath: key, reason: `registry unreachable (${networkError.message})${localFallback ? '' : '; consider --local-fallback'}` });
      } else if (!entry.version) {
        unresolved.push({ packagePath: key, reason: `cannot fix ${fixReason} integrity: entry has no version` });
      } else {
        unresolved.push({ packagePath: key, reason: `registry has no sha512 integrity for ${name}@${entry.version}` });
      }
    } finally {
      completed++;
      reportProgress('Fetching integrity hashes');
    }
  });

  const localDirCount = changes.filter((c) => c.source === 'local-directory').length;
  if (localDirCount > 0) {
    warnings.push(
      `${localDirCount} hash(es) were computed from node_modules directories; these are NOT npm ` +
      'tarball hashes and `npm ci` will fail integrity verification against the registry. ' +
      'Use only for air-gapped/internal verification.'
    );
  }

  // Apply changes immutably
  const updated = {
    ...lockfile,
    packages: { ...lockfile.packages }
  };
  for (const change of changes) {
    updated.packages[change.packagePath] = {
      ...updated.packages[change.packagePath],
      integrity: change.to
    };
  }

  return {
    lockfile: updated,
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
