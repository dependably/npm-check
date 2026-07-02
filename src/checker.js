/**
 * Checker module for verifying package integrity hashes and licenses
 * Provides comprehensive validation of installed packages against lockfile
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createProgressReporter } from './progress-reporter.js';
import { forEachPackageEntry, detectLockfileFlavor } from './format-library.js';
import { fetchPackumentIntegrity, DEFAULT_REGISTRY } from './integrity.js';

/**
 * Custom error class for checker operations
 */
export class CheckError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'CheckError';
    this.code = code;
    this.context = context;
  }
}

/**
 * Hash a package directory to verify integrity
 * Matches npm's tarball hashing approach
 * @param {string} pkgDir - Path to package directory
 * @returns {Promise<string>} Integrity hash in sha512-<base64> format
 */
export async function hashPackageDirectory(pkgDir) {
  try {
    // Collect all files in the package (excluding node_modules, etc)
    const filesToHash = await collectPackageFiles(pkgDir);

    // Sort files for consistent hashing
    filesToHash.sort();

    // Create hash
    const hash = crypto.createHash('sha512');

    for (const file of filesToHash) {
      const fullPath = path.join(pkgDir, file);
      try {
        const content = fs.readFileSync(fullPath);
        // Include filename and content in hash for consistency
        hash.update(file);
        hash.update(content);
      } catch {
        // Skip files that can't be read
        continue;
      }
    }

    const digest = hash.digest('base64');
    return `sha512-${digest}`;
  } catch (e) {
    throw new CheckError(
      `Failed to hash package directory: ${e.message}`,
      'HASH_FAILURE',
      { pkgDir }
    );
  }
}

/**
 * Collect all files in a package directory for hashing
 * Excludes node_modules, tests, and build artifacts
 * @param {string} pkgDir - Package directory path
 * @returns {Promise<string[]>} Array of relative file paths
 */
export async function collectPackageFiles(pkgDir) {
  const files = [];
  const excludeDirs = new Set(['node_modules', '.git', 'test', 'tests', '__tests__', '.github', '.nyc_output', 'coverage', 'dist', 'build']);
  const excludeFiles = new Set(['.DS_Store', '.gitignore', '.npmignore', 'thumbs.db']);

  function walkDir(dir, baseDir = '') {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });

      for (const entry of entries) {
        const relativePath = baseDir ? path.join(baseDir, entry.name) : entry.name;

        if (entry.isDirectory()) {
          if (!excludeDirs.has(entry.name)) {
            walkDir(path.join(dir, entry.name), relativePath);
          }
        } else if (entry.isFile()) {
          if (!excludeFiles.has(entry.name)) {
            files.push(relativePath);
          }
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  walkDir(pkgDir);
  return files;
}

/**
 * Map items through an async fn with a concurrency cap, preserving input order.
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
 * Evaluate an SPDX license expression against an approved set.
 * Implements proper SPDX operator precedence: AND binds tighter than OR.
 * Handles nested parentheses via recursive descent.
 *
 * Grammar:
 *   expr    := andExpr (' OR ' andExpr)*
 *   andExpr := atom (' AND ' atom)*
 *   atom    := '(' expr ')' | licenseId
 *
 * Fails closed (returns false) on empty identifiers, parse errors, or any
 * trailing unconsumed input.
 *
 * @param {string} licenseExpr - SPDX license expression
 * @param {Set<string>} approvedSet - Set of approved license identifiers
 * @returns {boolean} True if the expression is approved
 */
function isLicenseApproved(licenseExpr, approvedSet) {
  if (typeof licenseExpr !== 'string' || !licenseExpr.trim()) return false;

  const src = licenseExpr.trim();
  let pos = 0;

  function parseExpr() {
    let result = parseAndExpr();
    while (pos < src.length && src.startsWith(' OR ', pos)) {
      pos += 4; // consume ' OR '
      const right = parseAndExpr(); // always consume to advance pos
      result = result || right;
    }
    return result;
  }

  function parseAndExpr() {
    let result = parseAtom();
    while (pos < src.length && src.startsWith(' AND ', pos)) {
      pos += 5; // consume ' AND '
      const right = parseAtom(); // always consume to advance pos
      result = result && right;
    }
    return result;
  }

  function parseAtom() {
    if (pos < src.length && src[pos] === '(') {
      pos++; // consume '('
      const result = parseExpr();
      if (pos < src.length && src[pos] === ')') pos++; // consume ')'
      return result;
    }
    // Consume a license identifier; terminates at ' OR ', ' AND ', ')', or end
    const start = pos;
    while (
      pos < src.length &&
      src[pos] !== ')' &&
      !src.startsWith(' OR ', pos) &&
      !src.startsWith(' AND ', pos)
    ) {
      pos++;
    }
    const id = src.slice(start, pos).trim();
    return id.length > 0 && approvedSet.has(id);
  }

  try {
    const result = parseExpr();
    // Fail closed unless the ENTIRE expression was consumed. Trailing tokens
    // (e.g. 'MIT ) AND GPL-3.0-only') mean a malformed expression whose
    // unevaluated remainder might contain a rejected license — a compliance
    // gate must not approve it.
    return pos === src.length ? result : false;
  } catch {
    return false; // fail closed on any parse error
  }
}

/**
 * Normalize a license field value from a package.json to a plain string.
 * Handles the legacy object form ({ type: "MIT" }) and the legacy "licenses"
 * array ([{ type: "MIT" }, { type: "ISC" }]) that older packages used before
 * the SPDX string form became the standard.
 *
 * @param {*} licenseField - Value of the "license" field (may be string, object, or absent)
 * @param {*} licensesArray - Value of the legacy "licenses" array field (may be array or absent)
 * @returns {string|null} SPDX string, or null if unresolvable
 */
function normalizeLicenseField(licenseField, licensesArray) {
  // Normal case: already a string
  if (typeof licenseField === 'string') return licenseField;

  // Legacy object form: { type: "MIT", url: "..." }
  if (licenseField !== null && typeof licenseField === 'object' && !Array.isArray(licenseField)) {
    return typeof licenseField.type === 'string' ? licenseField.type : null;
  }

  // Legacy "licenses" array: [{ type: "MIT" }, { type: "ISC" }]
  if (Array.isArray(licensesArray) && licensesArray.length > 0) {
    const types = licensesArray
      .map(l => (l !== null && typeof l === 'object' ? l.type : l))
      .filter(t => typeof t === 'string');
    if (types.length > 0) return types.join(' OR ');
  }

  return null;
}

/**
 * Verify license for a single package
 * @param {string} packagePath - Package path from lockfile
 * @param {Set<string>} approvedLicenses - Set of approved license identifiers
 * @param {string} nodeModulesPath - Path to node_modules directory
 * @param {boolean} strict - Treat unknown licenses as errors
 * @param {object} pkgData - Package data from lockfile (optional)
 * @returns {Promise<object>} Verification result
 */
async function verifyPackageLicense(packagePath, approvedLicenses, nodeModulesPath, strict, pkgData) {
  // Skip root package
  if (packagePath === '') {
    return { valid: true, skipped: true, package: 'root' };
  }

  // Skip workspace packages (those not in node_modules or with link: true)
  if (pkgData && (pkgData.link === true || (!packagePath.startsWith('node_modules/')))) {
    return { valid: true, skipped: true, package: packagePath, reason: 'workspace-link' };
  }

  const pkgName = packagePath.replace(/^node_modules\//, '');
  const pkgJsonPath = path.join(nodeModulesPath, pkgName, 'package.json');

  // Resolve the license preferring the installed package.json, but falling back
  // to the lockfile's own `license` field when the package isn't on disk (a
  // partial node_modules) or omits it. This keeps the license check lockfile-
  // first — consistent with the integrity/vuln/deprecated checks, which all
  // work without a full install — instead of reporting UNKNOWN for every
  // uninstalled entry whose license the lockfile already records.
  let license;
  const pkgJsonExists = fs.existsSync(pkgJsonPath);
  if (pkgJsonExists) {
    try {
      // Normalize handles the string, object ({ type }), and legacy "licenses"
      // array forms without crashing on non-string values.
      const parsed = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
      license = normalizeLicenseField(parsed.license, parsed.licenses);
    } catch (e) {
      return { valid: false, error: e.message, package: pkgName };
    }
  }
  if (!license && pkgData && (pkgData.license || pkgData.licenses)) {
    license = normalizeLicenseField(pkgData.license, pkgData.licenses);
  }

  if (!license) {
    return {
      valid: !strict,
      package: pkgName,
      license: 'UNKNOWN',
      approved: false,
      reason: pkgJsonExists ? 'no-license' : 'package-json-not-found'
    };
  }

  const isApproved = isLicenseApproved(license, approvedLicenses);
  return {
    valid: isApproved,
    package: pkgName,
    license,
    approved: isApproved
  };
}

/**
 * Parse approved licenses CSV file
 * Format: license,category,notes
 * @param {string} csvPath - Path to CSV file
 * @returns {Promise<Set<string>>} Set of approved license identifiers
 */
export async function parseLicensesCsv(csvPath) {
  if (!fs.existsSync(csvPath)) {
    throw new CheckError(
      `Approved licenses file not found: ${csvPath}`,
      'LICENSES_CSV_NOT_FOUND',
      { csvPath }
    );
  }

  try {
    const content = fs.readFileSync(csvPath, 'utf8');
    const lines = content.split('\n')
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));

    // Detect if first line is a header by checking for common header names or pattern
    const HEADER_PATTERN = /^(license|spdx|identifier|name)/i;
    let dataLines = lines;
    if (lines.length > 0) {
      const firstLine = lines[0];
      const firstToken = firstLine.split(',')[0].trim();
      // It's a header if the first token matches common header names, or if line has multiple commas and contains "license"
      const isHeader = HEADER_PATTERN.test(firstToken) || (firstLine.includes(',') && firstLine.includes('license'));
      if (isHeader) {
        dataLines = lines.slice(1);
      }
    }

    const approvedSet = new Set();

    for (const line of dataLines) {
      const parts = line.split(',');
      const license = parts[0].trim();
      if (license) {
        approvedSet.add(license);
      }
    }

    return approvedSet;
  } catch (e) {
    throw new CheckError(
      `Failed to parse licenses CSV: ${e.message}`,
      'CSV_PARSE_ERROR',
      { csvPath }
    );
  }
}

/**
 * Extract the sha512 component from an SSRI integrity string.
 * An SSRI string may carry multiple space-separated hashes (multi-hash), e.g.
 * 'sha512-ABC== sha256-DEF='. The registry always publishes a single sha512 token,
 * so this is the canonical basis for comparison.
 *
 * NOTE: this helper is local to checker.js. A validator.js agent (#21) owns the
 * authoritative SSRI accept/reject logic in integrity.js; this is a deliberately
 * small duplicate kept in-module to avoid touching files out of scope for this fix.
 *
 * @param {*} integrity - Integrity field value (may be non-string)
 * @returns {string|null} The sha512-prefixed token, or null if absent
 */
function extractSha512Component(integrity) {
  if (typeof integrity !== 'string') return null;
  for (const token of integrity.split(/\s+/)) {
    if (token.startsWith('sha512-')) return token;
  }
  return null;
}

/**
 * Extract ALL sha512 tokens from an SSRI integrity string. npm/ssri accepts a
 * tarball matching ANY digest of the strongest algorithm present, so a lockfile
 * carrying more than one sha512 token ('sha512-GOOD sha512-EVIL') would let npm
 * accept a tarball hashing to EITHER. Tamper detection must therefore verify
 * every sha512 token against the single hash the registry publishes.
 * @param {*} integrity - Integrity field value (may be non-string)
 * @returns {string[]} All sha512-prefixed tokens (possibly empty)
 */
function extractAllSha512Components(integrity) {
  if (typeof integrity !== 'string') return [];
  return integrity.split(/\s+/).filter(token => token.startsWith('sha512-'));
}

/**
 * Decide whether a package entry can be verified against the registry.
 * Returns true for verifiable entries; non-verifiable entries are counted as
 * skipped (root/workspace/link/git/file/bundled, missing integrity/version, or
 * no sha512 component to compare to the registry's sha512).
 * @param {object} info - Entry classification from forEachPackageEntry
 * @returns {boolean} True if the entry should be verified
 */
function isVerifiableEntry(info) {
  const { entry, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep } = info;
  if (isRoot || isWorkspaceSource || isLink) return false;
  if (!entry.integrity) return false; // nothing locked to verify (integrity-hygiene flags this)
  if (isBundled || isGitDep || isFileDep) return false; // no registry tarball integrity
  // Skip when there is no sha512 component: sha1-only and sha256-only hashes cannot be
  // compared to the registry's sha512 (would be a guaranteed false 'tampered' alarm).
  // Multi-hash strings that include sha512 ('sha512-X sha256-Y') pass through and are
  // verified by extracting their sha512 component in recordIntegrityResult.
  if (!extractSha512Component(entry.integrity)) return false;
  // a version is required to query the registry
  return Boolean(entry.version);
}

/**
 * Collect the entries that are verifiable against the registry, tallying every
 * non-verifiable entry into results.skipped.
 * @param {object} lockfileData - Parsed lockfile data
 * @param {object} results - Results accumulator (skipped is incremented)
 * @returns {Array<object>} Candidate entries ({ key, entry, name })
 */
function collectIntegrityCandidates(lockfileData, results) {
  const candidates = [];
  forEachPackageEntry(lockfileData, (info) => {
    if (!isVerifiableEntry(info)) {
      results.skipped++;
      return;
    }
    candidates.push({ key: info.key, entry: info.entry, name: info.name, registryBase: info.registryBase });
  });
  return candidates;
}

/**
 * Resolve the host from a registry base for allowlist enforcement.
 * @param {string} registryBase - Registry base URL
 * @returns {string|null} Host, or null if unparseable
 */
function resolveRegistryHost(registryBase) {
  try {
    return new URL(registryBase).host;
  } catch {
    return null; // unparseable → treat as untrusted
  }
}

/**
 * Record an integrity failure (mismatch or untrusted host) into the results.
 * @param {object} results - Results accumulator
 * @param {object} item - Failure detail (already includes valid: false)
 */
function recordIntegrityFailure(results, item) {
  results.failed++;
  results.valid = false;
  results.errors.push(item);
  results.details.push(item);
}

/**
 * Record an unresolved entry (registry unreachable or no sha512 published) — i.e.
 * the authoritative hash could not be obtained, so integrity could not be verified.
 * Fails the run when failOnUnresolved (the default), so a registry outage can never
 * be mistaken for "integrity verified".
 * @param {object} results - Results accumulator
 * @param {object} item - Unresolved detail ({ package, version, packagePath, reason })
 * @param {boolean} failOnUnresolved - Promote unresolved entries to failures
 */
function recordIntegrityUnresolved(results, item, failOnUnresolved) {
  results.unresolved++;
  results.unresolvedItems.push(item);
  results.details.push({ valid: !failOnUnresolved, unresolved: true, ...item });
  if (failOnUnresolved) {
    results.failed++;
    results.valid = false;
    results.errors.push(item);
  }
}

/**
 * Classify a fetched registry hash for a candidate and record the outcome.
 * @param {object} results - Results accumulator
 * @param {object} candidate - { key, entry, name }
 * @param {string|null} registryHash - Hash fetched from the registry
 * @param {Error|null} networkError - Error thrown by the fetcher, if any
 * @param {boolean} failOnUnresolved - Promote unresolved entries to failures
 */
function recordIntegrityResult(results, candidate, registryHash, networkError, failOnUnresolved) {
  const { key, entry, name } = candidate;
  const base = { package: name, version: entry.version, packagePath: key };

  if (networkError) {
    recordIntegrityUnresolved(results, { ...base, reason: `registry unreachable (${networkError.message})` }, failOnUnresolved);
  } else if (!registryHash) {
    recordIntegrityUnresolved(results, { ...base, reason: `registry has no sha512 integrity for ${name}@${entry.version}` }, failOnUnresolved);
  } else {
    // SSRI-aware compare: the lockfile may carry a multi-hash string
    // ('sha512-A sha256-B') but the registry always publishes a single sha512
    // token, so a sha256/sha1 sibling must not trigger a false 'tampered'.
    // Crucially, EVERY sha512 token must equal the registry's: npm accepts a
    // tarball matching any sha512 present, so a second, non-registry sha512
    // ('sha512-GOOD sha512-EVIL') is a tamper vector and must fail.
    const lockedSha512s = extractAllSha512Components(entry.integrity);
    const registrySha512 = extractSha512Component(registryHash) ?? registryHash;
    const allMatch = lockedSha512s.length > 0 && lockedSha512s.every(t => t === registrySha512);
    if (allMatch) {
      results.passed++;
      results.details.push({ valid: true, package: name, packagePath: key, expected: registrySha512, actual: lockedSha512s.join(' ') });
    } else {
      recordIntegrityFailure(results, { valid: false, package: name, packagePath: key, expected: registrySha512, actual: lockedSha512s.join(' ') || entry.integrity });
    }
  }
}

/**
 * Verify a single candidate entry against the registry and record the outcome.
 * Enforces the host allowlist (an untrusted resolved host is failed outright),
 * then fetches the registry hash and classifies the result.
 * @param {object} candidate - { key, entry, name }
 * @param {object} ctx - Shared context (results, fetcher, defaultRegistry, hostAllowlist, failOnUnresolved)
 * @returns {Promise<void>}
 */
async function verifyIntegrityCandidate(candidate, ctx) {
  const { key, entry, name } = candidate;
  const { results, fetcher, defaultRegistry, hostAllowlist, failOnUnresolved } = ctx;
  const registryBase = candidate.registryBase || defaultRegistry;

  // Trust-anchor enforcement: never verify a hash against a host the operator
  // hasn't trusted — a tampered lockfile would just point `resolved` at its own server.
  if (hostAllowlist) {
    const host = resolveRegistryHost(registryBase);
    if (!host || !hostAllowlist.has(host)) {
      recordIntegrityFailure(results, { valid: false, package: name, version: entry.version, packagePath: key, reason: `untrusted registry host "${host || registryBase}" (not in allowedHosts) — refusing to trust its integrity hash` });
      return;
    }
  }

  let registryHash = null;
  let networkError = null;
  try {
    registryHash = await fetcher(name, entry.version, registryBase);
  } catch (e) {
    networkError = e;
  }

  recordIntegrityResult(results, candidate, registryHash, networkError, failOnUnresolved);
}

/**
 * Verify lockfile integrity hashes against the authoritative registry.
 *
 * For each registry-resolved package entry, the locked `integrity` is compared
 * to the `dist.integrity` published by the registry (the registry base is
 * derived per-package from the entry's `resolved` URL, so private registries
 * work). This detects a tampered or drifted lockfile WITHOUT needing
 * node_modules — and, unlike a directory hash, it actually matches npm's
 * tarball integrity.
 *
 * Outcomes per entry:
 *   - passed:     locked hash matches the registry hash
 *   - failed:     locked hash differs from the registry hash (the real tamper signal)
 *   - skipped:    not verifiable this way (root/workspace/link/git/file/bundled,
 *                 missing integrity, or a legacy sha1 hash)
 *   - unresolved: registry unreachable or has no sha512 for that version
 *
 * `valid` is false on mismatches (failed > 0) AND, by default, on unresolved
 * entries — verification that could not complete must not pass as "verified"
 * (fail closed). Pass `failOnUnresolved: false` to tolerate a flaky registry and
 * keep unresolved entries non-fatal.
 *
 * @param {object} lockfileData - Parsed lockfile data (v2/v3)
 * @param {object} options
 * @param {number} options.concurrency - Parallel registry requests (default: 8)
 * @param {number} options.timeoutMs - Per-request timeout (default: 10000)
 * @param {string} options.defaultRegistry - Registry for entries without a derivable base
 * @param {boolean} options.failOnUnresolved - Fail the run when the registry hash can't
 *   be obtained. Default true (fail closed); set false to keep unresolved non-fatal.
 * @param {Function} options.fetchIntegrity - Injectable (name, version, registryBase) => Promise<string|null>
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<object>} Results object with summary and details
 */
export async function checkIntegrity(lockfileData, options = {}) {
  const {
    concurrency = 8,
    timeoutMs = 10000,
    defaultRegistry = DEFAULT_REGISTRY,
    failOnUnresolved = true, // fail closed: verification that couldn't complete must not pass as "verified"
    // Operator-pinned trusted registry hosts. The authoritative hash is fetched
    // from the host named in the lockfile's own `resolved` URL — so a tampered
    // lockfile could point at an attacker host that returns a matching hash. When
    // this allowlist is set, an entry resolving from a non-listed host is FAILED
    // (not verified against it), closing that self-referential-trust gap.
    allowedHosts = null,
    fetchIntegrity = null,
    onProgress = null
  } = options;
  const hostAllowlist = Array.isArray(allowedHosts) && allowedHosts.length ? new Set(allowedHosts) : null;

  if (lockfileData && lockfileData.lockfileVersion === 1) {
    throw new CheckError(
      'v1 lockfiles have no integrity to verify; run `npm-check migrate 3` first',
      'UNSUPPORTED_VERSION'
    );
  }

  const fetcher = fetchIntegrity ||
    ((name, ver, registryBase) => fetchPackumentIntegrity(name, ver, { registryBase, timeoutMs }));

  const results = {
    valid: true,
    checked: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    unresolved: 0,
    errors: [],
    unresolvedItems: [],
    details: []
  };

  const candidates = collectIntegrityCandidates(lockfileData, results);

  const total = candidates.length;
  const reporter = onProgress ? createProgressReporter(total, {
    onProgress,
    stage: 'Verifying integrity against registry'
  }) : null;

  let completed = 0;
  const markCompleted = () => {
    completed++;
    results.checked = completed;
    if (reporter) reporter.update(completed);
  };

  const ctx = { results, fetcher, defaultRegistry, hostAllowlist, failOnUnresolved };
  await mapWithConcurrency(candidates, concurrency, async (candidate) => {
    await verifyIntegrityCandidate(candidate, ctx);
    markCompleted();
  });

  if (reporter) reporter.finish();

  return results;
}

/**
 * Classify a single package's license verification result into the running
 * tallies (approved/rejected/unknown) and the error/warning lists.
 * @param {object} results - Results accumulator
 * @param {object} result - Per-package result from verifyPackageLicense
 * @param {boolean} strict - Treat unknown licenses as errors
 */
function classifyLicenseResult(results, result, strict) {
  results.details.push(result);
  results.checked++;

  if (result.skipped) {
    return; // root/workspace-link packages aren't counted
  }

  if (result.license === 'UNKNOWN' || result.reason === 'no-license') {
    // Handle unknown/missing licenses
    results.unknown++;
    if (strict) {
      results.valid = false;
      results.errors.push(result);
    } else {
      results.warnings.push(result);
    }
    return;
  }

  if (result.valid) {
    results.approved++;
    return;
  }

  results.rejected++;
  results.valid = false;
  results.errors.push(result);
}

/**
 * Check licenses for all packages in lockfile against approved list
 * @param {object} lockfileData - Parsed lockfile data
 * @param {object} options - Options
 * @param {string} options.csvPath - Path to approved licenses CSV
 * @param {string} options.nodeModulesPath - Path to node_modules
 * @param {boolean} options.strict - Treat unknown licenses as errors
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<object>} Results object with summary and details
 */
export async function checkLicenses(lockfileData, options = {}) {
  const {
    csvPath = './approved-licenses.csv',
    nodeModulesPath = './node_modules',
    strict = false,
    onProgress = null
  } = options;

  // pnpm's flat `.pnpm` virtual store means license-by-node_modules path walking
  // doesn't map directly — not supported yet (planned as a store-aware walk).
  if (detectLockfileFlavor(lockfileData) === 'pnpm') {
    throw new CheckError(
      'license verification is not supported for pnpm-lock.yaml yet',
      'PNPM_UNSUPPORTED'
    );
  }

  // v1 lockfiles have no `packages` map — iterating `{}` would silently verify
  // nothing and return valid:true (a false-clean pass). Mirror checkIntegrity.
  if (lockfileData && lockfileData.lockfileVersion === 1) {
    throw new CheckError(
      'v1 lockfiles have no packages map to check licenses against; run `npm-check migrate 3` first',
      'UNSUPPORTED_VERSION'
    );
  }

  // Check if node_modules exists
  if (!fs.existsSync(nodeModulesPath)) {
    throw new CheckError(
      `node_modules directory not found: ${nodeModulesPath}`,
      'NO_NODE_MODULES',
      { nodeModulesPath }
    );
  }

  // Parse approved licenses CSV
  const approvedLicenses = await parseLicensesCsv(csvPath);

  const packages = lockfileData.packages || {};
  const entries = Object.entries(packages);
  const total = entries.length;

  const results = {
    valid: true,
    checked: 0,
    approved: 0,
    rejected: 0,
    unknown: 0,
    errors: [],
    warnings: [],
    details: []
  };

  // Create progress reporter
  const reporter = onProgress ? createProgressReporter(total, {
    onProgress,
    stage: 'Checking licenses'
  }) : null;

  for (const [pkgPath, pkgData] of entries) {
    const result = await verifyPackageLicense(pkgPath, approvedLicenses, nodeModulesPath, strict, pkgData);

    classifyLicenseResult(results, result, strict);

    if (reporter) {
      reporter.update(results.checked);
    }
  }

  if (reporter) {
    reporter.finish();
  }

  return results;
}

/**
 * Run both integrity and license checks
 * @param {object} lockfileData - Parsed lockfile data
 * @param {object} options - Options (merged for both checks)
 * @returns {Promise<object>} Combined results
 */
export async function checkAll(lockfileData, options = {}) {
  const hashResults = await checkIntegrity(lockfileData, options);
  const licenseResults = await checkLicenses(lockfileData, options);

  return {
    valid: hashResults.valid && licenseResults.valid,
    integrity: hashResults,
    licenses: licenseResults
  };
}
