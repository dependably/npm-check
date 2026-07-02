// src/vuln.js
// Known-vulnerability scan: checks each locked package against the npm registry's
// bulk advisory endpoint (POST {registry}/-/npm/v1/security/advisories/bulk).
//
// This complements the integrity check — integrity asks "is the lockfile what it
// claims to be?", this asks "do the versions it locks have published advisories?".
// It is lockfile-first (no node_modules), reuses the registry-base derivation and
// concurrency model. It deliberately does NOT shell out to `npm audit`.
//
// Fail-closed by default: when the scan CANNOT COMPLETE for an entry — the registry
// is unreachable (network/transport error) or doesn't implement the bulk advisory
// endpoint — that entry is `unresolved`, and an unresolved entry FAILS the run by
// default. We must never print "clean" for a package we could not actually scan.
// This is distinct from a package the registry successfully reports as having NO
// advisories, which is a normal `clean` result. Set `failOnUnresolved: false`
// (CLI `--allow-unresolved`) to opt back into lenient/offline-tolerant behavior.
import { createProgressReporter } from './progress-reporter.js';
import { forEachPackageEntry } from './format-library.js';
import { DEFAULT_REGISTRY, postJson } from './integrity.js';
import { buildEnvelope } from './schema.js';

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

// Fail-closed ranking: a severity we recognize maps to its ladder rank; a missing
// or off-vocabulary severity ranks ABOVE any threshold so it fails the run rather
// than being silently demoted to a warning (this module commits to fail-closed).
function severityRank(severity) {
  const key = typeof severity === 'string' ? severity.toLowerCase() : '';
  return key in SEVERITY_RANK ? SEVERITY_RANK[key] : Number.POSITIVE_INFINITY; // unknown → fail closed
}

// Preserve the advisory's raw severity for display; substitute a visible sentinel
// (never a fabricated 'low') when it is missing, so consumers see the real value.
function normalizeSeverity(severity) {
  return typeof severity === 'string' && severity.trim() ? severity.trim().toLowerCase() : 'unknown';
}

// --- Dependency-free exact-version range matching -----------------------------
// The locked version is always a concrete semver; advisory `vulnerable_versions`
// ranges are the plain comparator grammar the npm/GitHub advisory API emits
// (`<4.17.21`, `>=1.0.0 <1.2.3`, `>=1 <2 || >=3 <4`, `*`). We match the exact
// locked version against that range WITHOUT pulling in a `semver` dependency.
// Anything outside this comparator grammar (^, ~, x-ranges) is treated as
// "unparseable" → the caller stays conservative rather than guessing.
// Prerelease/build are dot-separated identifiers. Matching them as
// `identifier(?:\.identifier)*` — where the `.` separator is NOT in the
// identifier class — is linear and free of the backtracking ambiguity a single
// `[0-9A-Za-z.-]+` greedy class invites (and it's the correct semver grammar:
// identifiers can't be empty).
const IDENT = '[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*';
const SEMVER_RE = new RegExp(`^v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-(${IDENT}))?(?:\\+${IDENT})?$`);
const COMPARATOR_RE = new RegExp(`(<=|>=|<|>|=)?\\s*v?(\\d+)\\.(\\d+)\\.(\\d+)(?:-(${IDENT}))?(?:\\+${IDENT})?`, 'g');

function parseSemver(v) {
  if (typeof v !== 'string') return null;
  const m = SEMVER_RE.exec(v.trim());
  if (!m) return null;
  return { major: +m[1], minor: +m[2], patch: +m[3], prerelease: m[4] ? m[4].split('.') : [] };
}

function comparePreReleaseId(a, b) {
  const an = /^\d+$/.test(a);
  const bn = /^\d+$/.test(b);
  if (an && bn) return Number(a) - Number(b);
  if (an) return -1; // numeric identifiers have lower precedence than alphanumeric
  if (bn) return 1;
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  const ap = a.prerelease;
  const bp = b.prerelease;
  if (ap.length === 0 && bp.length === 0) return 0;
  if (ap.length === 0) return 1; // a release outranks a prerelease of the same core
  if (bp.length === 0) return -1;
  const len = Math.min(ap.length, bp.length);
  for (let i = 0; i < len; i++) {
    const cmp = comparePreReleaseId(ap[i], bp[i]);
    if (cmp !== 0) return cmp;
  }
  return ap.length - bp.length;
}

// Parse one AND-term (space-separated comparators). Returns the comparator list,
// or null when the term contains anything outside the supported comparator grammar.
function parseComparatorTerm(term) {
  const t = term.trim();
  if (t === '' || t === '*') return [{ any: true }];
  const matches = [...t.matchAll(COMPARATOR_RE)];
  if (matches.length === 0) return null;
  const comps = matches.map((m) => ({
    op: m[1] || '=',
    version: { major: +m[2], minor: +m[3], patch: +m[4], prerelease: m[5] ? m[5].split('.') : [] }
  }));
  // Reject the term if any non-comparator syntax (^, ~, x-range, ...) remains.
  const leftover = t.replace(COMPARATOR_RE, '').replace(/\s+/g, '');
  return leftover === '' ? comps : null;
}

// Parse a full range into OR-terms of AND-comparators, or null if unparseable.
function parseRange(range) {
  if (typeof range !== 'string') return null;
  const trimmed = range.trim();
  if (trimmed === '' || trimmed === '*') return [[{ any: true }]];
  const terms = [];
  for (const part of trimmed.split('||')) {
    const comps = parseComparatorTerm(part);
    if (comps === null) return null;
    terms.push(comps);
  }
  return terms;
}

function satisfiesComparator(v, comp) {
  if (comp.any) return true;
  const cmp = compareSemver(v, comp.version);
  switch (comp.op) {
    case '<': return cmp < 0;
    case '<=': return cmp <= 0;
    case '>': return cmp > 0;
    case '>=': return cmp >= 0;
    default: return cmp === 0; // '='
  }
}

// True/false when we can decide, null ("uncertain") when either the range or the
// version can't be parsed with this dependency-free matcher.
function satisfiesRange(versionStr, range) {
  const parsed = parseRange(range);
  if (parsed === null) return null;
  const v = parseSemver(versionStr);
  if (v === null) return null;
  for (const term of parsed) {
    if (term.every((c) => satisfiesComparator(v, c))) return true;
  }
  return false;
}

/**
 * Decide whether an advisory returned by the bulk endpoint actually applies to a
 * specific locked version. The endpoint keys advisories by NAME and filters
 * server-side to the set of versions we submitted, but does NOT say which of those
 * versions each advisory covers. So when a single version was submitted for a name
 * we trust the server verbatim; when MULTIPLE versions share a name we must match
 * each version against the advisory's `vulnerable_versions` range ourselves, or a
 * patched version sharing the name gets falsely flagged.
 *
 * Returns 'yes' (record by severity), 'no' (not this version — skip), or
 * 'uncertain' (multi-version group but the range/version isn't matchable — record
 * as a warning, never a run-failing error, to avoid a false CI failure).
 */
function advisoryAppliesTo(version, advisory, multiVersion) {
  if (!multiVersion) return 'yes'; // single submitted version: server filtering is authoritative
  const range = advisory.vulnerable_versions ?? advisory.vulnerableVersions ?? null;
  if (typeof range !== 'string' || range.trim() === '') return 'uncertain';
  const verdict = satisfiesRange(version, range);
  if (verdict === true) return 'yes';
  if (verdict === false) return 'no';
  return 'uncertain';
}

/**
 * Extract the patched/fixed version range from an advisory, when the registry
 * provides it. The npm/GitHub advisory shape carries this as `patched_versions`
 * (e.g. ">=4.17.21"); the sentinel "<0.0.0" means "no fix is available yet".
 * Returns null when absent — we never fabricate a fix that the data doesn't claim.
 */
function fixedVersionOf(advisory) {
  const raw = advisory.patched_versions ?? advisory.patchedVersions ?? advisory.fixedVersion ?? null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '<0.0.0') return null; // no fix published
  return trimmed;
}

/**
 * Extract the CVE identifier from an advisory, when present. The npm/GitHub
 * advisory shape carries it as `cves` (array), `cve`, or `cve_id`. Returns null
 * when absent — we never fabricate one.
 */
function cveOf(advisory) {
  const raw = (Array.isArray(advisory.cves) ? advisory.cves[0] : null)
    ?? advisory.cve ?? advisory.cve_id ?? null;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * Collect reference URLs from an advisory (its `references` list plus its own
 * `url`), de-duplicated. References may be plain strings or `{ url }` objects.
 */
function referencesOf(advisory) {
  const refs = [];
  if (Array.isArray(advisory.references)) {
    for (const r of advisory.references) {
      const url = typeof r === 'string' ? r : (r && r.url);
      if (url) refs.push(url);
    }
  }
  if (advisory.url) refs.push(advisory.url);
  return [...new Set(refs)];
}

/**
 * Walk the lockfile and collect the entries we can check via the bulk endpoint,
 * mirroring checker.js's skip logic. Mutates results.skipped for the rest.
 * Returns the candidate list ({ key, name, version, registryBase }).
 */
function collectCandidates(lockfileData, results, defaultRegistry) {
  const candidates = [];
  forEachPackageEntry(lockfileData, (info) => {
    const { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep } = info;
    if (isRoot) return results.skipped++;
    if (isWorkspaceSource) return results.skipped++;
    if (isLink) return results.skipped++;
    if (isBundled || isGitDep || isFileDep) return results.skipped++; // no registry advisory to check
    if (!entry.version) return results.skipped++;
    const registryBase = info.registryBase || defaultRegistry;
    candidates.push({ key, name, version: entry.version, registryBase });
  });
  return candidates;
}

/**
 * Group candidates by registry, then by name (the bulk endpoint keys by name),
 * and slice each registry's name list into POST units of at most `batchSize` names.
 * Each unit is { registryBase, names: [ [candidate, ...], ... ] }.
 */
function buildUnits(candidates, batchSize) {
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
  return units;
}

/**
 * Record every candidate in a unit as unresolved (registry unreachable, or the
 * endpoint isn't supported) — i.e. advisory data could not be obtained, so the
 * scan did not complete for these packages. Fails the run when failOnUnresolved
 * (the default), so a registry outage can never be mistaken for "no vulnerabilities".
 */
function recordUnresolvedUnit(unitCandidates, reason, results, failOnUnresolved) {
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
}

/**
 * Attribute the registry's advisory response to each submitted candidate.
 *
 * The endpoint keys advisories by NAME and filters server-side to the versions we
 * submitted, but doesn't say which submitted version each advisory covers. When a
 * name has a SINGLE locked version we trust that per-name attribution; when it has
 * MULTIPLE versions we match each version against the advisory's vulnerable range
 * so a patched sibling version isn't falsely flagged (issue #14). A per-name value
 * that isn't an array (a malformed 200) is treated as "no advisories" rather than
 * crashing the whole scan (issue #24).
 */
function recordResolvedUnit(unitCandidates, advisoriesByName, results, threshold) {
  // Count distinct submitted versions per name to know when to version-match.
  const versionsByName = new Map();
  for (const c of unitCandidates) {
    if (!versionsByName.has(c.name)) versionsByName.set(c.name, new Set());
    versionsByName.get(c.name).add(c.version);
  }

  for (const cand of unitCandidates) {
    const raw = advisoriesByName[cand.name];
    const advisories = Array.isArray(raw) ? raw : []; // malformed per-name value → no advisories
    const multiVersion = versionsByName.get(cand.name).size > 1;

    // Keep only advisories that actually apply to THIS version.
    const applicable = [];
    for (const advisory of advisories) {
      const verdict = advisoryAppliesTo(cand.version, advisory, multiVersion);
      if (verdict === 'no') continue;
      applicable.push({ advisory, uncertain: verdict === 'uncertain' });
    }

    if (applicable.length === 0) {
      results.clean++;
      results.details.push({ vulnerable: false, package: cand.name, version: cand.version, packagePath: cand.key });
      continue;
    }
    results.vulnerable++;
    for (const { advisory, uncertain } of applicable) recordVuln(cand, advisory, results, threshold, uncertain);
    results.details.push({
      vulnerable: true,
      package: cand.name,
      version: cand.version,
      packagePath: cand.key,
      advisories: applicable.map(({ advisory: a }) => ({
        id: a.id, title: a.title, severity: normalizeSeverity(a.severity),
        vulnerable_versions: a.vulnerable_versions, fixedVersion: fixedVersionOf(a), url: a.url
      }))
    });
  }
}

/**
 * Classify one advisory: at/above the threshold it's an error (fails the run),
 * below it a warning. A missing/unknown severity ranks above every threshold, so
 * it fails closed rather than being silently downgraded. `forceWarning` records
 * the finding as a warning regardless of severity — used when a multi-version
 * group can't be matched to a specific version, so an unmatchable advisory never
 * produces a run-failing false positive on a possibly-patched version (issue #14).
 */
function recordVuln(cand, advisory, results, threshold, forceWarning = false) {
  const finding = {
    package: cand.name,
    version: cand.version,
    packagePath: cand.key,
    advisoryId: advisory.id,
    title: advisory.title,
    severity: normalizeSeverity(advisory.severity), // raw value surfaced; 'unknown' when absent
    fixedVersion: fixedVersionOf(advisory), // null when the advisory publishes no fix
    cve: cveOf(advisory), // null when the advisory carries no CVE
    vulnerableRange: advisory.vulnerable_versions ?? null,
    references: referencesOf(advisory),
    url: advisory.url
  };
  if (!forceWarning && severityRank(finding.severity) >= threshold) {
    results.errors.push(finding);
    results.valid = false;
  } else {
    results.warnings.push(finding);
  }
  return finding;
}

/**
 * Build the bulk request body for a unit: { name: [unique versions] }.
 */
function buildUnitBody(unitNames) {
  const body = {};
  for (const group of unitNames) {
    const name = group[0].name;
    body[name] = [...new Set(group.map((c) => c.version))];
  }
  return body;
}

/**
 * Scan a single POST unit: fetch the bulk advisories for its registry and route
 * the result to the unresolved or resolved recorder. Updates results.scanned.
 */
async function scanUnit(unit, fetcher, timeoutMs, results, threshold, failOnUnresolved) {
  const unitCandidates = unit.names.flat();
  const body = buildUnitBody(unit.names);

  let advisoriesByName = null;
  let networkError = null;
  try {
    advisoriesByName = await fetcher(unit.registryBase, body, timeoutMs);
  } catch (e) {
    networkError = e;
  }

  const malformed = advisoriesByName !== null
    && (typeof advisoriesByName !== 'object' || Array.isArray(advisoriesByName));
  if (networkError || advisoriesByName === null || malformed) {
    let reason;
    if (networkError) {
      reason = `registry unreachable (${networkError.message})`;
    } else if (malformed) {
      reason = 'registry returned a malformed advisory response';
    } else {
      reason = 'registry does not support the bulk advisory endpoint';
    }
    recordUnresolvedUnit(unitCandidates, reason, results, failOnUnresolved);
  } else {
    recordResolvedUnit(unitCandidates, advisoriesByName, results, threshold);
  }

  results.scanned += unitCandidates.length;
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
  // Strip trailing slashes without a regex (linear scan, no backtracking).
  let base = registryBase;
  while (base.endsWith('/')) base = base.slice(0, -1);
  const url = `${base}/-/npm/v1/security/advisories/bulk`;
  return postJson(url, bodyObject, timeoutMs);
}

/**
 * Scan locked packages for known vulnerabilities via the registry bulk advisory endpoint.
 *
 * Outcomes per entry:
 *   - vulnerable: registry returned ≥1 advisory for that name@version
 *   - clean:      submitted, no advisories (obtained data, nothing found)
 *   - unresolved: registry unreachable or endpoint not supported — advisory data
 *                 could not be obtained (FAILS the run by default; fail-closed)
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
 * @param {boolean} options.failOnUnresolved - Fail the run when advisory data can't be
 *   obtained (registry unreachable / endpoint unsupported). Default true (fail closed);
 *   set false to tolerate an incomplete scan.
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
    failOnUnresolved = true, // fail closed: a scan that couldn't complete must not pass as "clean"
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

  // A non-positive / non-integer batchSize makes the name-slicing loop never
  // advance (infinite loop). Reject it up front, mirroring the minSeverity guard.
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new VulnError(
      `Invalid batchSize "${batchSize}"; must be a positive integer`,
      'INVALID_BATCH_SIZE'
    );
  }

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
  const candidates = collectCandidates(lockfileData, results, defaultRegistry);

  // Offline: nothing left to do — count remaining candidates as skipped.
  if (offline) {
    results.skipped += candidates.length;
    return results;
  }

  const fetcher = fetchAdvisories || fetchBulkAdvisories;

  // Group candidates by registry/name into POST units of at most `batchSize` names.
  const units = buildUnits(candidates, batchSize);

  const reporter = onProgress ? createProgressReporter(units.length, {
    onProgress,
    stage: 'Scanning for known vulnerabilities'
  }) : null;
  let completed = 0;

  await mapWithConcurrency(units, concurrency, async (unit) => {
    await scanUnit(unit, fetcher, timeoutMs, results, threshold, failOnUnresolved);
    completed++;
    if (reporter) reporter.update(completed);
  });

  if (reporter) reporter.finish();

  return results;
}

/**
 * Map one advisory finding (from results.errors/warnings) into the suite's shared
 * Finding shape. The advisory's TRUE severity is already the ladder vocabulary
 * (info|low|moderate|high|critical), so it becomes the top-level `severity`
 * verbatim; the advisory payload rides under `extra` per the vuln-tool contract.
 */
function toSchemaFinding(f) {
  return {
    severity: (f.severity || 'low').toLowerCase(),
    ruleId: f.advisoryId != null ? String(f.advisoryId) : 'NPM-ADVISORY',
    category: 'vulnerability',
    message: f.title,
    location: null, // a package advisory is not file-scoped
    remediation: f.fixedVersion ? `upgrade to ${f.fixedVersion}` : null,
    extra: {
      package: f.package,
      installedVersion: f.version,
      fixedVersion: f.fixedVersion ?? null,
      advisoryId: f.advisoryId ?? null,
      cve: f.cve ?? null,
      vulnerableRange: f.vulnerableRange ?? null,
      references: referencesOf(f)
    }
  };
}

/**
 * Wrap a checkVulnerabilities() result in the shared finding-schema envelope.
 * `findings` is the COMPLETE list of advisory findings (errors with an advisoryId
 * plus warnings); scan-completeness state (unresolved/skipped/clean, which drives
 * the fail-closed gate) is preserved under `extra.scan` so nothing is lost.
 *
 * @param {object} result   - a checkVulnerabilities() result
 * @param {object} meta
 * @param {string} meta.target   - the lockfile path scanned, as given
 * @param {number} meta.exitCode - the real process exit code (0/1/2)
 * @returns {object} the shared envelope
 */
export function vulnEnvelope(result, { target, exitCode }) {
  // errors holds BOTH advisory findings and unresolved items; the latter carry a
  // `reason` (and no advisory payload). Discriminate on `reason` — not on
  // `advisoryId` — so an advisory that merely lacks an `id` still reaches the
  // envelope (it falls back to the 'NPM-ADVISORY' ruleId) instead of vanishing
  // while the run still exits non-zero (issue #24). Mirrors deprecationEnvelope.
  const advisories = [
    ...result.errors.filter((e) => !e.reason),
    ...result.warnings
  ];
  const findings = advisories.map(toSchemaFinding);
  return buildEnvelope({
    target,
    scanned: result.scanned,
    findings,
    exitCode,
    extra: {
      scan: {
        vulnerable: result.vulnerable,
        clean: result.clean,
        unresolved: result.unresolved,
        skipped: result.skipped,
        valid: result.valid,
        unresolvedItems: result.unresolvedItems
      }
    }
  });
}
