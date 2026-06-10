/**
 * Checker module for verifying package integrity hashes and licenses
 * Provides comprehensive validation of installed packages against lockfile
 */

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createProgressReporter } from './progress-reporter.js';

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
      } catch (e) {
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
    } catch (e) {
      // Skip directories we can't read
    }
  }

  walkDir(pkgDir);
  return files;
}

/**
 * Verify integrity hash for a single package
 * @param {string} packagePath - Package path from lockfile (e.g., 'node_modules/lodash')
 * @param {object} packageData - Package data from lockfile
 * @param {string} nodeModulesPath - Path to node_modules directory
 * @returns {Promise<object>} Verification result
 */
async function verifyPackageIntegrity(packagePath, packageData, nodeModulesPath) {
  // Skip root package (empty path)
  if (packagePath === '') {
    return { valid: true, skipped: true, package: 'root' };
  }

  // Skip if no integrity in lockfile
  if (!packageData.integrity) {
    return { valid: true, skipped: true, package: packagePath, reason: 'no-integrity' };
  }

  // Extract package name from node_modules path
  // Handle scoped packages like @org/package
  let pkgName = packagePath.replace(/^node_modules\//, '');
  let pkgDir = path.join(nodeModulesPath, pkgName);

  // Check if package exists in node_modules
  if (!fs.existsSync(pkgDir)) {
    return {
      valid: false,
      error: 'Package not found in node_modules',
      package: pkgName,
      path: pkgDir
    };
  }

  // Hash the package directory
  try {
    const actualHash = await hashPackageDirectory(pkgDir);
    const expectedHash = packageData.integrity;
    const matches = actualHash === expectedHash;

    return {
      valid: matches,
      package: pkgName,
      expected: expectedHash,
      actual: actualHash
    };
  } catch (e) {
    return {
      valid: false,
      error: e.message,
      package: pkgName,
      path: pkgDir
    };
  }
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
 * Check integrity hashes for all packages in lockfile
 * @param {object} lockfileData - Parsed lockfile data
 * @param {object} options - Options
 * @param {string} options.nodeModulesPath - Path to node_modules (default: ./node_modules)
 * @param {Function} options.onProgress - Progress callback
 * @returns {Promise<object>} Results object with summary and details
 */
export async function checkIntegrity(lockfileData, options = {}) {
  const {
    nodeModulesPath = './node_modules',
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

  const packages = lockfileData.packages || {};
  const entries = Object.entries(packages);
  const total = entries.length;

  const results = {
    valid: true,
    checked: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    errors: [],
    details: []
  };

  // Create progress reporter
  const reporter = onProgress ? createProgressReporter(total, {
    onProgress,
    stage: 'Verifying integrity hashes'
  }) : null;

  for (const [pkgPath, pkgData] of entries) {
    const result = await verifyPackageIntegrity(pkgPath, pkgData, nodeModulesPath);

    if (result.skipped) {
      results.skipped++;
    } else if (result.valid) {
      results.passed++;
    } else {
      results.failed++;
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
