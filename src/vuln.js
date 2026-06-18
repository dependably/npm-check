// src/vuln.js
// Known-vulnerability scan: checks each locked package against the npm registry's
// bulk advisory endpoint (POST {registry}/-/npm/v1/security/advisories/bulk).
//
// This complements the integrity check — integrity asks "is the lockfile what it
// claims to be?", this asks "do the versions it locks have published advisories?".
// It is lockfile-first (no node_modules), reuses the registry-base derivation and
// concurrency model, and degrades gracefully when a registry doesn't implement the
// endpoint (every such entry is reported `unresolved`, which does not fail the run
// by default). It deliberately does NOT shell out to `npm audit`.
import { createProgressReporter } from './progress-reporter.js';
import { forEachPackageEntry } from './format-library.js';
import { deriveRegistryBase, DEFAULT_REGISTRY, postJson } from './integrity.js';

/**
 * Custom error class for vuln-scan operations
 */
export class VulnError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'VulnError';
    this.code = code;
    this.context = context;
  }
}

// Advisory severity ordering. Used to compare against the minSeverity threshold.
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function severityRank(severity) {
  const key = typeof severity === 'string' ? severity.toLowerCase() : '';
  return key in SEVERITY_RANK ? SEVERITY_RANK[key] : SEVERITY_RANK.low; // unknown → low
}

/**
 * Map items through an async fn with a concurrency cap, preserving input order.
 * (Mirrors the private helper in checker.js — kept local to keep the modules decoupled.)
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
 * Default transport: POST the bulk advisory request for one registry.
 * Resolves the advisories-by-name object ({} when nothing is vulnerable),
 * null when the endpoint 404s (registry doesn't support it), and rejects on
 * network errors / timeouts.
 */
function fetchBulkAdvisories(registryBase, bodyObject, timeoutMs) {
  const base = registryBase.replace(/\/+$/, '');
  const url = `${base}/-/npm/v1/security/advisories/bulk`;
  return postJson(url, bodyObject, timeoutMs);
}

/**
 * Scan locked packages for known vulnerabilities via the registry bulk advisory endpoint.
 *
 * Outcomes per entry:
 *   - vulnerable: registry returned ≥1 advisory for that name@version
 *   - clean:      submitted, no advisories
 *   - unresolved: registry unreachable or endpoint not supported (non-fatal by default)
 *   - skipped:    not checkable this way (root/workspace/link/git/file/bundled, missing version)
 *
 * Each advisory at or above `minSeverity` is an error (fails the run); below it, a warning.
 *
 * @param {object} lockfileData - Parsed lockfile data (v2/v3)
 * @param {object} options
 * @param {number} options.concurrency - Parallel registry POSTs (default: 8)
 * @param {number} options.timeoutMs - Per-request timeout (default: 10000)
 * @param {string} options.defaultRegistry - Registry for entries without a derivable base
 * @param {string} options.minSeverity - Threshold at/above which a finding fails the run (default: 'high')
 * @param {number} options.batchSize - Max package names per bulk POST (default: 250)
 * @param {boolean} options.offline - Skip all network; report everything as skipped
 * @param {boolean} options.failOnUnresolved - Treat unresolved entries as failures
 * @param {Function} options.fetchAdvisories - Injectable (registryBase, body, timeoutMs) => Promise<object|null>
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<object>} Results object with summary and details
 */
export async function checkVulnerabilities(lockfileData, options = {}) {
  const {
    concurrency = 8,
    timeoutMs = 10000,
    defaultRegistry = DEFAULT_REGISTRY,
    minSeverity = 'high',
    batchSize = 250,
    offline = false,
    failOnUnresolved = false,
    fetchAdvisories = null,
    onProgress = null
  } = options;

  if (!(minSeverity.toLowerCase() in SEVERITY_RANK)) {
    throw new VulnError(
      `Invalid minSeverity "${minSeverity}"; use one of: ${Object.keys(SEVERITY_RANK).join(', ')}`,
      'INVALID_SEVERITY'
    );
  }
  const threshold = severityRank(minSeverity);

  if (lockfileData && lockfileData.lockfileVersion === 1) {
    throw new VulnError(
      'v1 lockfiles are not supported; run `npm-check migrate 3` first',
      'UNSUPPORTED_VERSION'
    );
  }

  const results = {
    valid: true,
    scanned: 0,
    vulnerable: 0,
    clean: 0,
    unresolved: 0,
    skipped: 0,
    errors: [],
    warnings: [],
    unresolvedItems: [],
    details: []
  };

  // Collect verifiable candidates (mirror checker.js skip logic).
  const candidates = [];
  forEachPackageEntry(lockfileData, (info) => {
    const { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep } = info;
    if (isRoot) return results.skipped++;
    if (isWorkspaceSource) return results.skipped++;
    if (isLink) return results.skipped++;
    if (isBundled || isGitDep || isFileDep) return results.skipped++; // no registry advisory to check
    if (!entry.version) return results.skipped++;
    const registryBase = deriveRegistryBase(entry.resolved, name) || defaultRegistry;
    candidates.push({ key, name, version: entry.version, registryBase });
  });

  // Offline: nothing left to do — count remaining candidates as skipped.
  if (offline) {
    results.skipped += candidates.length;
    return results;
  }

  const fetcher = fetchAdvisories || fetchBulkAdvisories;

  // Group candidates by registry, then by name (the bulk endpoint keys by name).
  // Build POST units of at most `batchSize` names each.
  const byRegistry = new Map();
  for (const c of candidates) {
    if (!byRegistry.has(c.registryBase)) byRegistry.set(c.registryBase, new Map());
    const names = byRegistry.get(c.registryBase);
    if (!names.has(c.name)) names.set(c.name, []);
    names.get(c.name).push(c);
  }

  const units = [];
  for (const [registryBase, names] of byRegistry) {
    const nameList = [...names.keys()];
    for (let i = 0; i < nameList.length; i += batchSize) {
      const chunk = nameList.slice(i, i + batchSize);
      units.push({ registryBase, names: chunk.map((n) => names.get(n)) });
    }
  }

  const reporter = onProgress ? createProgressReporter(units.length, {
    onProgress,
    stage: 'Scanning for known vulnerabilities'
  }) : null;
  let completed = 0;

  const recordVuln = (cand, advisory) => {
    const finding = {
      package: cand.name,
      version: cand.version,
      packagePath: cand.key,
      advisoryId: advisory.id,
      title: advisory.title,
      severity: (advisory.severity || 'low').toLowerCase(),
      url: advisory.url
    };
    if (severityRank(finding.severity) >= threshold) {
      results.errors.push(finding);
      results.valid = false;
    } else {
      results.warnings.push(finding);
    }
    return finding;
  };

  await mapWithConcurrency(units, concurrency, async (unit) => {
    // Flat list of candidates this unit covers, plus the bulk body { name: [versions] }.
    const unitCandidates = unit.names.flat();
    const body = {};
    for (const group of unit.names) {
      const name = group[0].name;
      body[name] = [...new Set(group.map((c) => c.version))];
    }

    let advisoriesByName = null;
    let networkError = null;
    try {
      advisoriesByName = await fetcher(unit.registryBase, body, timeoutMs);
    } catch (e) {
      networkError = e;
    }

    if (networkError || advisoriesByName === null) {
      const reason = networkError
        ? `registry unreachable (${networkError.message})`
        : 'registry does not support the bulk advisory endpoint';
      for (const cand of unitCandidates) {
        const item = { package: cand.name, version: cand.version, packagePath: cand.key, reason };
        results.unresolved++;
        results.unresolvedItems.push(item);
        results.details.push({ unresolved: true, ...item });
        if (failOnUnresolved) {
          results.valid = false;
          results.errors.push(item);
        }
      }
    } else {
      // Attribute returned advisories to each submitted name@version for that name.
      // The endpoint already filters server-side to the versions we submitted, so we
      // trust per-name attribution without local semver range matching.
      for (const cand of unitCandidates) {
        const advisories = advisoriesByName[cand.name] || [];
        if (advisories.length === 0) {
          results.clean++;
          results.details.push({ vulnerable: false, package: cand.name, version: cand.version, packagePath: cand.key });
        } else {
          results.vulnerable++;
          for (const advisory of advisories) recordVuln(cand, advisory);
          results.details.push({
            vulnerable: true,
            package: cand.name,
            version: cand.version,
            packagePath: cand.key,
            advisories: advisories.map((a) => ({
              id: a.id, title: a.title, severity: (a.severity || 'low').toLowerCase(),
              vulnerable_versions: a.vulnerable_versions, url: a.url
            }))
          });
        }
      }
    }

    results.scanned += unitCandidates.length;
    completed++;
    if (reporter) reporter.update(completed);
  });

  if (reporter) reporter.finish();

  return results;
}
