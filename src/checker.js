/**
 * Checker module for verifying package integrity hashes and licenses
 * Provides comprehensive validation of installed packages against lockfile
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createProgressReporter } from './progress-reporter.js';
import { forEachPackageEntry } from './format-library.js';
import { fetchPackumentIntegrity, deriveRegistryBase, DEFAULT_REGISTRY } from './integrity.js';

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
async function collectPackageFiles(pkgDir) {
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
 * Check if a license (with SPDX expressions) is approved
 * Handles SPDX operators: OR (at least one) and AND (all required)
 * @param {string} licenseExpr - SPDX license expression
 * @param {Set<string>} approvedSet - Set of approved license identifiers
 * @returns {boolean} True if license is approved
 */
function isLicenseApproved(licenseExpr, approvedSet) {
  if (!licenseExpr || !licenseExpr.trim()) {
    return false;
  }

  // Strip outer parentheses if present
  let expr = licenseExpr.trim();
  if (expr.startsWith('(') && expr.endsWith(')')) {
    expr = expr.slice(1, -1).trim();
  }

  // Handle SPDX OR expressions (at least one must be approved)
  if (expr.includes(' OR ')) {
    return expr.split(' OR ')
      .map(lic => lic.trim())
      .some(lic => approvedSet.has(lic));
  }

  // Handle SPDX AND expressions (all must be approved)
  if (expr.includes(' AND ')) {
    return expr.split(' AND ')
      .map(lic => lic.trim())
      .every(lic => approvedSet.has(lic));
  }

  // Simple license identifier
  return approvedSet.has(expr);
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

  // Check if package.json exists
  if (!fs.existsSync(pkgJsonPath)) {
    return {
      valid: !strict,
      license: 'UNKNOWN',
      approved: false,
      package: pkgName,
      reason: 'package-json-not-found'
    };
  }

  try {
    // Read license field from package.json
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8'));
    const license = pkgJson.license;

    if (!license) {
      return {
        valid: !strict,
        package: pkgName,
        license: 'UNKNOWN',
        approved: false,
        reason: 'no-license'
      };
    }

    // Check against approved list
    const isApproved = isLicenseApproved(license, approvedLicenses);

    return {
      valid: isApproved,
      package: pkgName,
      license,
      approved: isApproved
    };
  } catch (e) {
    return {
      valid: false,
      error: e.message,
      package: pkgName
    };
  }
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
 * `valid` is false only when there are mismatches (failed > 0). Unresolved
 * entries are surfaced loudly but do not fail the run, so a flaky registry
 * doesn't break CI; pass `failOnUnresolved: true` to fail closed instead.
 *
 * @param {object} lockfileData - Parsed lockfile data (v2/v3)
 * @param {object} options
 * @param {number} options.concurrency - Parallel registry requests (default: 8)
 * @param {number} options.timeoutMs - Per-request timeout (default: 10000)
 * @param {string} options.defaultRegistry - Registry for entries without a derivable base
 * @param {boolean} options.failOnUnresolved - Treat unresolved entries as failures
 * @param {Function} options.fetchIntegrity - Injectable (name, version, registryBase) => Promise<string|null>
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<object>} Results object with summary and details
 */
export async function checkIntegrity(lockfileData, options = {}) {
  const {
    concurrency = 8,
    timeoutMs = 10000,
    defaultRegistry = DEFAULT_REGISTRY,
    failOnUnresolved = false,
    fetchIntegrity = null,
    onProgress = null
  } = options;

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

  const candidates = [];

  forEachPackageEntry(lockfileData, (info) => {
    const { key, entry, name, isRoot, isWorkspaceSource, isLink, isBundled, isGitDep, isFileDep } = info;
    if (isRoot) return results.skipped++;
    if (isWorkspaceSource) return results.skipped++;
    if (isLink) return results.skipped++;
    if (!entry.integrity) return results.skipped++; // nothing locked to verify (integrity-hygiene flags this)
    if (isBundled || isGitDep || isFileDep) return results.skipped++; // no registry tarball integrity
    if (typeof entry.integrity === 'string' && entry.integrity.startsWith('sha1-')) {
      // legacy sha1 can't be compared to the registry's sha512 — upgrade first
      results.skipped++;
      return;
    }
    if (!entry.version) return results.skipped++;
    candidates.push({ key, entry, name });
  });

  const total = candidates.length;
  const reporter = onProgress ? createProgressReporter(total, {
    onProgress,
    stage: 'Verifying integrity against registry'
  }) : null;

  let completed = 0;

  await mapWithConcurrency(candidates, concurrency, async ({ key, entry, name }) => {
    const registryBase = deriveRegistryBase(entry.resolved, name) || defaultRegistry;
    let registryHash = null;
    let networkError = null;
    try {
      registryHash = await fetcher(name, entry.version, registryBase);
    } catch (e) {
      networkError = e;
    }

    if (networkError) {
      const item = { package: name, version: entry.version, packagePath: key, reason: `registry unreachable (${networkError.message})` };
      results.unresolved++;
      results.unresolvedItems.push(item);
      results.details.push({ valid: failOnUnresolved ? false : true, unresolved: true, ...item });
      if (failOnUnresolved) { results.failed++; results.valid = false; results.errors.push(item); }
    } else if (!registryHash) {
      const item = { package: name, version: entry.version, packagePath: key, reason: `registry has no sha512 integrity for ${name}@${entry.version}` };
      results.unresolved++;
      results.unresolvedItems.push(item);
      results.details.push({ valid: failOnUnresolved ? false : true, unresolved: true, ...item });
      if (failOnUnresolved) { results.failed++; results.valid = false; results.errors.push(item); }
    } else if (registryHash === entry.integrity) {
      results.passed++;
      results.details.push({ valid: true, package: name, packagePath: key, expected: registryHash, actual: entry.integrity });
    } else {
      const item = { valid: false, package: name, packagePath: key, expected: registryHash, actual: entry.integrity };
      results.failed++;
      results.valid = false;
      results.errors.push(item);
      results.details.push(item);
    }

    completed++;
    results.checked = completed;
    if (reporter) reporter.update(completed);
  });

  if (reporter) reporter.finish();

  return results;
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

    if (result.skipped) {
      // Skip root package
    } else if (result.license === 'UNKNOWN' || result.reason === 'no-license') {
      // Handle unknown/missing licenses
      results.unknown++;
      if (strict) {
        results.valid = false;
        results.errors.push(result);
      } else {
        results.warnings.push(result);
      }
    } else if (result.valid) {
      results.approved++;
    } else {
      results.rejected++;
      results.valid = false;
      results.errors.push(result);
    }

    results.details.push(result);
    results.checked++;

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
