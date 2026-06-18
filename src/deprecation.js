// src/deprecation.js
// Deprecated-package scan: checks each locked package version against the npm
// registry's per-version manifest `deprecated` field — the same signal npm
// surfaces as "npm warn deprecated <pkg>@<ver>: <message>" during `npm ci`.
//
// Like the integrity and vuln checks it is lockfile-first (no node_modules) and
// reuses the registry-base derivation + concurrency model. Deprecation is a soft
// signal (npm itself only warns; it never fails the install), so findings are
// warnings by default; pass `failOnDeprecated` to fail the run in CI. Identical
// name@version@registry entries are fetched once and the result is attributed to
// every lockfile path that shares them.
import { createProgressReporter } from './progress-reporter.js';
import { forEachPackageEntry } from './format-library.js';
import { deriveRegistryBase, DEFAULT_REGISTRY, fetchPackumentManifest } from './integrity.js';

/**
 * Custom error class for deprecation-scan operations
 */
export class DeprecationError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'DeprecationError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Map items through an async fn with a concurrency cap, preserving input order.
 * (Mirrors the private helper in checker.js/vuln.js — kept local to keep modules decoupled.)
 */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length || 1)) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Normalize a manifest's `deprecated` field to a message string or null.
 * npm marks a version deprecated with a non-empty string; an empty string means
 * "un-deprecated", and a bare `true` (rare) carries no message of its own.
 */
function deprecationMessage(raw) {
  if (typeof raw === 'string' && raw.trim() !== '') return raw;
  if (raw === true) return 'deprecated';
  return null;
}

/**
 * Scan locked packages for deprecation notices via the registry version manifest.
 *
 * Outcomes per entry:
 *   - deprecated: registry manifest carries a `deprecated` message
 *   - clean:      manifest fetched, not deprecated
 *   - unresolved: registry unreachable or version not found (non-fatal by default)
 *   - skipped:    not checkable this way (root/workspace/link/git/file/bundled, missing version)
 *
 * Deprecated entries are warnings by default; pass `failOnDeprecated` to make them errors.
 *
 * @param {object} lockfileData - Parsed lockfile data (v2/v3)
 * @param {object} options
 * @param {number} options.concurrency - Parallel registry GETs (default: 8)
 * @param {number} options.timeoutMs - Per-request timeout (default: 10000)
 * @param {string} options.defaultRegistry - Registry for entries without a derivable base
 * @param {boolean} options.offline - Skip all network; report everything as skipped
 * @param {boolean} options.failOnDeprecated - Treat deprecated entries as failures (default: false)
 * @param {boolean} options.failOnUnresolved - Treat unresolved entries as failures
 * @param {Function} options.fetchManifest - Injectable (name, version, registryBase) => Promise<object|null>
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<object>} Results object with summary and details
 */
export async function checkDeprecations(lockfileData, options = {}) {
  const {
    concurrency = 8,
    timeoutMs = 10000,
    defaultRegistry = DEFAULT_REGISTRY,
    offline = false,
    failOnDeprecated = false,
    failOnUnresolved = false,
    fetchManifest = null,
    onProgress = null
  } = options;

  if (lockfileData && lockfileData.lockfileVersion === 1) {
    throw new DeprecationError(
      'v1 lockfiles are not supported; run `npm-check migrate 3` first',
      'UNSUPPORTED_VERSION'
    );
  }

  const results = {
    valid: true,
    scanned: 0,
    deprecated: 0,
    clean: 0,
    unresolved: 0,
    skipped: 0,
    errors: [],
    warnings: [],
    unresolvedItems: [],
    details: []
  };

  // Collect verifiable candidates (mirror checker.js / vuln.js skip logic).
  const candidates = [];
  forEachPackageEntry(lockfileData, (info) => {
    const { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep } = info;
    if (isRoot) return results.skipped++;
    if (isWorkspaceSource) return results.skipped++;
    if (isLink) return results.skipped++;
    if (isBundled || isGitDep || isFileDep) return results.skipped++; // no registry manifest to check
    if (!entry.version) return results.skipped++;
    const registryBase = deriveRegistryBase(entry.resolved, name) || defaultRegistry;
    candidates.push({ key, name, version: entry.version, registryBase });
  });

  // Offline: nothing left to do — count remaining candidates as skipped.
  if (offline) {
    results.skipped += candidates.length;
    return results;
  }

  const fetcher = fetchManifest ||
    ((name, version, registryBase) => fetchPackumentManifest(name, version, { registryBase, timeoutMs }));

  // Dedupe identical name@version@registry so each unique version is fetched once;
  // the single manifest result is attributed to every lockfile entry that shares it.
  const groups = new Map();
  for (const c of candidates) {
    const dedupeKey = `${c.registryBase}\n${c.name}\n${c.version}`;
    if (!groups.has(dedupeKey)) {
      groups.set(dedupeKey, { name: c.name, version: c.version, registryBase: c.registryBase, entries: [] });
    }
    groups.get(dedupeKey).entries.push(c);
  }
  const units = [...groups.values()];

  const reporter = onProgress ? createProgressReporter(units.length, {
    onProgress,
    stage: 'Scanning for deprecated packages'
  }) : null;
  let completed = 0;

  await mapWithConcurrency(units, concurrency, async (unit) => {
    let manifest = null;
    let networkError = null;
    try {
      manifest = await fetcher(unit.name, unit.version, unit.registryBase);
    } catch (e) {
      networkError = e;
    }

    if (networkError || manifest === null) {
      const reason = networkError
        ? `registry unreachable (${networkError.message})`
        : `registry has no manifest for ${unit.name}@${unit.version}`;
      for (const cand of unit.entries) {
        const item = { package: unit.name, version: unit.version, packagePath: cand.key, reason };
        results.unresolved++;
        results.unresolvedItems.push(item);
        results.details.push({ unresolved: true, ...item });
        if (failOnUnresolved) {
          results.valid = false;
          results.errors.push(item);
        }
      }
    } else {
      const message = deprecationMessage(manifest.deprecated);
      if (message) {
        for (const cand of unit.entries) {
          results.deprecated++;
          const finding = { package: unit.name, version: unit.version, packagePath: cand.key, message };
          if (failOnDeprecated) {
            results.errors.push(finding);
            results.valid = false;
          } else {
            results.warnings.push(finding);
          }
          results.details.push({ deprecated: true, ...finding });
        }
      } else {
        for (const cand of unit.entries) {
          results.clean++;
          results.details.push({ deprecated: false, package: unit.name, version: unit.version, packagePath: cand.key });
        }
      }
    }

    results.scanned += unit.entries.length;
    completed++;
    if (reporter) reporter.update(completed);
  });

  if (reporter) reporter.finish();

  return results;
}
