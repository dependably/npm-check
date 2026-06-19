#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { parseLockfile } from '../src/parser.js';
import { validatePackageLock } from '../src/validator.js';
import { validatePackageJson } from '../src/package-json-validator.js';
import { validateNpmrc } from '../src/npmrc-validator.js';
import { migrateToVersion } from '../src/migrator.js';
import { upgradeIntegrityHashes, deduplicatePackages } from '../src/updater.js';
import { fixPackageLock } from '../src/fixer.js';
import { createBackup, listBackups, restoreFromLatestBackup, cleanOldBackups, BackupError } from '../src/backup.js';
import { createProgressBar } from '../src/progress-reporter.js';
import { checkIntegrity, checkLicenses } from '../src/checker.js';
import { checkVulnerabilities } from '../src/vuln.js';
import { checkDeprecations } from '../src/deprecation.js';
import { remediateDependencies } from '../src/remediate.js';
import { detectLockfileVersion } from '../src/format-library.js';
import { fixChecksums } from '../src/checksum-fixer.js';
import { pinVersions, detectIndent } from '../src/pinner.js';
import { runAudit, formatAuditReport } from '../src/audit.js';
import { loadAuditConfig, mergeConfig } from '../src/audit-config.js';
import { runReport, formatReport } from '../src/report.js';
import { prunePackages } from '../src/pruner.js';
import { findUnusedDependencies } from '../src/usage-scanner.js';

const argv = process.argv.slice(2);

function printHelp() {
  console.log(`
npm-check — npm lockfile toolkit

Usage:
  npm-check [command] [file] [options]

  With no command, npm-check runs the full report (all checks) on ./package-lock.json.

Commands:
  report [file]              Run ALL checks and print one grouped report (default)
  validate [file]            Validate package-lock.json, package.json, and .npmrc
  migrate [file] [target]    Migrate to target version (1, 2, or 3; default: 3)
  upgrade [file]             Upgrade lockfile to version 3 (alias for migrate 3)
  upgrade-hashes [file]      Upgrade integrity hashes sha1→sha512
  fix-checksums [file]       Fill missing/placeholder/sha1 hashes from the registry
  pin [dir]                  Pin ^/~ ranges in package.json to lockfile versions
  prune [file]               Remove orphaned packages unreachable from the dependency graph
  unused [dir]               Flag declared dependencies the application never imports
  audit [file]               Lint lockfile for best practices (non-zero exit on failure)
  vuln [file]                Scan locked packages for known vulnerabilities (registry advisories)
  deprecated [file]          Scan locked packages for deprecation notices (the npm ci warnings)
  remediate [dir]            Bump direct deps that are deprecated/vulnerable to latest (then npm install)
  dedupe [file]              Deduplicate packages in lockfile
  fix [file] [--write]       Run automated fixer with optional write
  check [file]               Verify integrity hashes and licenses
  backups [file]             List all backups for a file
  restore [file]             Restore from latest backup
  clean-backups [file]       Clean old backup files with optional --keep N

Report Options:
  --offline                  Skip all network checks (integrity + vuln + deprecated); offline rules only
  --no-integrity             Skip the integrity check
  --no-vuln                  Skip the known-vulnerability scan
  --no-deprecated            Skip the deprecation scan
  --no-license               Skip the license check
  --min-severity <level>     Vuln severity that fails the run (info|low|moderate|high|critical; default: high)
  --format pretty|json       Output format (default: pretty)
  --strict                   Treat warnings as failures
  --max-warnings N           Fail if warnings exceed N (-1 = unlimited)
  --fail-on-unresolved       Fail when integrity can't be verified (registry down/missing)
  --fail-on-deprecated       Fail when a locked package is deprecated (default: warn)
  --concurrency / --timeout / --registry / --licenses-csv   (as in Check Options)

Check Options:
  --check hash               Verify locked integrity hashes against the registry
  --check license            Only verify licenses against approved list
  --check all                Run both checks (default)
  --licenses-csv <path>      Path to approved licenses CSV
  --strict                   Treat warnings as errors
  --concurrency N            Parallel registry requests for hash check (default: 8)
  --timeout MS               Per-request timeout in milliseconds (default: 10000)
  --registry <url>           Registry for entries without a derivable base
  --fail-on-unresolved       Fail when an entry can't be verified (registry down/missing)

Vuln Options:
  --min-severity <level>     Severity that fails the run (info|low|moderate|high|critical; default: high)
  --format pretty|json       Output format (default: pretty)
  --offline                  Skip the scan (report everything as skipped)
  --fail-on-unresolved       Fail when a package can't be checked (registry down/unsupported)
  --concurrency N            Parallel registry requests (default: 8)
  --timeout MS               Per-request timeout in milliseconds (default: 10000)
  --registry <url>           Registry for entries without a derivable base

Deprecated Options:
  --format pretty|json       Output format (default: pretty)
  --offline                  Skip the scan (report everything as skipped)
  --fail-on-deprecated       Fail the run when a locked package is deprecated (default: warn)
  --fail-on-unresolved       Fail when a package can't be checked (registry down/missing)
  --concurrency N            Parallel registry requests (default: 8)
  --timeout MS               Per-request timeout in milliseconds (default: 10000)
  --registry <url>           Registry for entries without a derivable base

Fix-Checksums Options:
  --concurrency N            Parallel registry requests (default: 8)
  --timeout MS               Per-request timeout in milliseconds (default: 10000)
  --registry <url>           Default registry for entries without a resolved URL
  --local-fallback           Hash node_modules copies when the registry fails
                             (flagged: these are NOT npm tarball hashes)

Remediate Options:
  --write                    Apply the bumps to package.json + lockfile root (backs up first)
  --min-severity <level>     Advisory level that counts a dep as vulnerable (default: high)
  --no-deprecated            Don't treat deprecated direct deps as remediation targets
  --format pretty|json       Output format (default: pretty)
  --registry <url>           Registry for entries without a derivable base
  (only DIRECT deps are bumped; transitive findings are reported as guidance.
   Run 'npm install' afterward to re-resolve the tree.)

Pin Options:
  --include-peer             Also pin peerDependencies (off by default)

Unused Options:
  --include-dev              Also check devDependencies (off by default)
  --json                     Machine-readable output

Audit Options:
  --config <path>            Audit config file (default: discover .npm-checkrc.json
                             or npm-check.config.json in the current directory)
  --rule <id>:<severity>     Override a rule severity (error|warn|off); repeatable
  --max-warnings N           Fail when warnings exceed N (default: unlimited)
  --strict                   Shorthand for --max-warnings 0
  --format stylish|json      Report format (default: stylish)

General Options:
  --write                    Write changes to file (creates backup)
  -h, --help                 Show this help
  -v, --version              Show version

Exit Codes:
  0  success / audit passed
  1  failure / audit found problems
  2  audit operational error (bad config, unknown rule, unreadable file)

Examples:
  npm-check validate
  npm-check upgrade --write                    # Lockfile v2 → v3
  npm-check fix-checksums --write              # Real integrity hashes from registry
  npm-check pin --write                        # Lock down ^/~ versions
  npm-check prune --write                      # Remove orphaned lockfile entries
  npm-check unused                             # Flag never-imported dependencies
  npm-check audit                              # Lint with default rules
  npm-check audit --strict --format json
  npm-check audit --rule pinned-versions:error
  npm-check vuln                               # Scan for known vulnerabilities
  npm-check vuln --min-severity critical --format json
  npm-check deprecated                         # Scan for deprecated packages (npm ci warnings)
  npm-check deprecated --fail-on-deprecated    # Fail CI when any locked package is deprecated
  npm-check check --check hash                 # Only verify integrity
  npm-check restore
  npm-check clean-backups --keep 5

Default file: ./package-lock.json
`);
}

function getVersion() {
  try {
    const packageJsonPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
  } catch {
    return 'unknown';
  }
}

function getFilePath(arg1) {
  // Determine if arg1 is a file path or needs to use default
  if (!arg1 || arg1.startsWith('-')) {
    return path.resolve('package-lock.json');
  }

  // Check if arg1 looks like a numeric target version or other command arg
  if (arg1.match(/^\d+$/)) {
    return path.resolve('package-lock.json');
  }

  // arg1 is a file path
  return path.resolve(arg1);
}

function ensureFileExists(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`Error: File not found: ${filePath}`);
    process.exit(1);
  }
}

function handleError(error, context = '') {
  console.error(`\n❌ ${context || 'Error'}:`);
  if (error instanceof BackupError) {
    console.error(`   Backup Error: ${error.message}`);
  } else if (error.fixes) {
    console.error(`   ${error.message}`);
    if (error.fixes.length > 0) {
      console.error('   Partial fixes attempted:');
      error.fixes.forEach(fix => console.error(`     • ${fix}`));
    }
  } else {
    console.error(`   ${error.message}`);
  }
  process.exit(1);
}

// Build a progress callback that redraws the bar only when the percentage
// changes, to avoid flicker. Each caller keeps its own `lastProgress` state.
function makeProgressReporter() {
  let lastProgress = null;
  return (progress) => {
    if (!lastProgress || progress.percentage !== lastProgress.percentage) {
      process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
      lastProgress = progress;
    }
  };
}

// Read the value that follows a flag in argv, or undefined when absent.
function flagValue(name) {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : undefined;
}

// Parse a flag's value as a positive integer, exiting with `code` on a bad value.
// Returns `fallback` when the flag is absent.
function parsePositiveIntFlag(name, fallback, label, code = 1) {
  const raw = flagValue(name);
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed) || parsed < 1) {
    console.error(`❌ Invalid ${label} value. Must be a positive number`);
    process.exit(code);
  }
  return parsed;
}

// Validate a --format flag against the allowed values, exiting with `code` on a bad value.
function parseFormatFlag(allowed, fallback, code = 2) {
  const raw = flagValue('--format');
  if (raw === undefined) return fallback;
  if (!allowed.includes(raw)) {
    console.error(`❌ Invalid --format value. Use: ${allowed.join(' or ')}`);
    process.exit(code);
  }
  return raw;
}

const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];

// Validate a --min-severity flag against the severity ladder, exiting on a bad value.
function parseMinSeverityFlag(fallback = 'high', code = 2) {
  const raw = flagValue('--min-severity');
  if (raw === undefined) return fallback;
  if (!SEVERITIES.includes(raw)) {
    console.error(`❌ Invalid --min-severity value. Use: ${SEVERITIES.join(', ')}`);
    process.exit(code);
  }
  return raw;
}

// The registry-verification flags shared by the network-backed commands.
function parseNetworkFlags(code = 1) {
  return {
    concurrency: parsePositiveIntFlag('--concurrency', 8, '--concurrency', code),
    timeoutMs: parsePositiveIntFlag('--timeout', 10000, '--timeout', code),
    defaultRegistry: flagValue('--registry')
  };
}

// Spread the optional registry override only when one was supplied.
function registryOption(defaultRegistry) {
  return defaultRegistry ? { defaultRegistry } : {};
}

// Clear the in-progress progress bar line.
function clearProgressLine() {
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
}

// Resolve the directory argument for dir-oriented commands (pin/unused/remediate).
function getDirArg() {
  return argv[1] && !argv[1].startsWith('-') ? path.resolve(argv[1]) : process.cwd();
}

// Write `data` as pretty JSON to a file, creating a backup first.
function writeJsonFile(targetPath, data, indent = 2) {
  createBackup(targetPath);
  fs.writeFileSync(targetPath, JSON.stringify(data, null, indent) + '\n', 'utf8');
}

// Guard for the report/vuln/deprecated commands: a missing lockfile is exit 2.
function requireLockfileOrExit2(filePath, command) {
  if (!fs.existsSync(filePath)) {
    console.error(`❌ No lockfile found at ${filePath}`);
    console.error(`   Run \`npm-check ${command} <path>\` or \`npm-check --help\`.`);
    process.exit(2);
  }
}

// Apply repeatable --rule <id>:<severity> overrides onto an audit config.
function applyRuleOverrides(config) {
  const ruleOverrides = {};
  argv.forEach((arg, i) => {
    if (arg === '--rule' && argv[i + 1]) {
      const [ruleId, severity] = argv[i + 1].split(':');
      ruleOverrides[ruleId] = severity;
    }
  });
  if (Object.keys(ruleOverrides).length === 0) return;
  const merged = mergeConfig({ maxWarnings: config.maxWarnings, rules: ruleOverrides });
  for (const ruleId of Object.keys(ruleOverrides)) {
    if (!merged.rules[ruleId]) continue;
    config.rules[ruleId] = {
      severity: merged.rules[ruleId].severity,
      options: { ...config.rules[ruleId].options }
    };
  }
}

// Resolve the --max-warnings flag onto an audit config (--strict forces 0).
function applyMaxWarnings(config) {
  if (argv.includes('--strict')) config.maxWarnings = 0;
  const raw = flagValue('--max-warnings');
  if (raw === undefined) return;
  const parsed = parseInt(raw, 10);
  if (isNaN(parsed)) {
    console.error('❌ Invalid --max-warnings value. Must be a number');
    process.exit(2);
  }
  config.maxWarnings = parsed;
}

// Load the package.json sibling to a lockfile, or null when absent/unparseable.
function loadSiblingPackageJson(filePath, { tolerant = false } = {}) {
  const pkgPath = path.join(path.dirname(filePath), 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  if (!tolerant) return JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  try { return JSON.parse(fs.readFileSync(pkgPath, 'utf8')); } catch { return null; }
}

// Resolve every report option from argv (audit config, format, toggles, network).
function parseReportOptions() {
  const config = loadAuditConfig(process.cwd(), flagValue('--config') || null);
  applyRuleOverrides(config);

  const strict = argv.includes('--strict');
  applyMaxWarnings(config);
  const maxWarnings = strict ? 0 : config.maxWarnings;

  return {
    config,
    strict,
    maxWarnings,
    format: parseFormatFlag(['pretty', 'json'], 'pretty'),
    // Network/integrity + license toggles.
    integrity: !argv.includes('--offline') && !argv.includes('--no-integrity'),
    license: !argv.includes('--no-license'),
    vuln: !argv.includes('--offline') && !argv.includes('--no-vuln'),
    deprecated: !argv.includes('--offline') && !argv.includes('--no-deprecated'),
    failOnUnresolved: argv.includes('--fail-on-unresolved'),
    failOnDeprecated: argv.includes('--fail-on-deprecated'),
    minSeverity: parseMinSeverityFlag(),
    concurrency: parsePositiveIntFlag('--concurrency', 8, '--concurrency', 2),
    timeoutMs: parsePositiveIntFlag('--timeout', 10000, '--timeout', 2),
    defaultRegistry: flagValue('--registry'),
    licensesCsv: flagValue('--licenses-csv')
  };
}

async function runReportCommand() {
  // `report` takes its file from argv[1] only when invoked explicitly.
  const filePath = getFilePath(argv[0] === 'report' ? argv[1] : undefined);
  requireLockfileOrExit2(filePath, 'report');

  let report;
  try {
    const opts = parseReportOptions();
    const dir = path.dirname(filePath);
    const lockfile = parseLockfile(filePath);
    const packageJson = loadSiblingPackageJson(filePath);

    if ((opts.integrity || opts.vuln || opts.deprecated) && opts.format === 'pretty') {
      console.log('🔎 Running all checks (querying the registry)…');
    }
    const onProgress = opts.format === 'pretty' ? makeProgressReporter() : null;

    report = await runReport(
      { lockfile, packageJson, filePath: path.relative(process.cwd(), filePath) || filePath, dir },
      {
        auditConfig: opts.config, integrity: opts.integrity, license: opts.license, vuln: opts.vuln,
        deprecated: opts.deprecated, failOnDeprecated: opts.failOnDeprecated, minSeverity: opts.minSeverity,
        strict: opts.strict, maxWarnings: opts.maxWarnings, concurrency: opts.concurrency,
        timeoutMs: opts.timeoutMs, failOnUnresolved: opts.failOnUnresolved, onProgress,
        ...registryOption(opts.defaultRegistry),
        ...(opts.licensesCsv ? { licensesCsv: opts.licensesCsv } : {})
      }
    );

    if (onProgress) clearProgressLine();
    const rendered = formatReport(report, { format: opts.format });
    console.log(opts.format === 'pretty' ? '\n' + rendered : rendered);
  } catch (error) {
    console.error(`\n❌ Report error: ${error.message}`);
    process.exit(2);
  }

  process.exit(report.summary.pass ? 0 : 1);
}

function runValidateCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);
  const dir = path.dirname(filePath);

  const lockfile = parseLockfile(filePath);
  const lockResult = validatePackageLock(lockfile);

  const pkgPath = path.join(dir, 'package.json');
  let pkgResult = null;
  if (fs.existsSync(pkgPath)) {
    try {
      pkgResult = validatePackageJson(JSON.parse(fs.readFileSync(pkgPath, 'utf8')));
    } catch (e) {
      // A malformed manifest is itself a validation failure to report —
      // not a reason to abort the whole command (the lockfile result still matters).
      pkgResult = { valid: false, errors: [{ code: 'PJ_PARSE_ERROR', message: `package.json is not valid JSON: ${e.message}` }], warnings: [] };
    }
  }

  const npmrcPath = path.join(dir, '.npmrc');
  const npmrcResult = fs.existsSync(npmrcPath)
    ? validateNpmrc(fs.readFileSync(npmrcPath, 'utf8'))
    : null;

  // Errors are Error subclass instances, whose `message` is non-enumerable
  // and so vanishes under JSON.stringify — normalize to {code, message} so
  // the JSON output is actually readable.
  const normalizeResult = (r) => r && typeof r === 'object' && Array.isArray(r.errors)
    ? { ...r, errors: r.errors.map((e) => ({ code: e.code, message: e.message })) }
    : r;

  const out = {
    'package-lock.json': normalizeResult(lockResult),
    'package.json': normalizeResult(pkgResult) || 'not found (skipped)',
    '.npmrc': normalizeResult(npmrcResult) || 'not found (skipped)'
  };

  console.log('\n📋 Validation Result:');
  console.log(JSON.stringify(out, null, 2));

  const valid = lockResult.valid && (!pkgResult || pkgResult.valid) && (!npmrcResult || npmrcResult.valid);
  process.exit(valid ? 0 : 1);
}

function runMigrateCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);

  // Get target version (default: 3)
  let target = 3;
  if (argv[1] && argv[1].match(/^\d+$/) && !argv[1].startsWith('/')) {
    target = parseInt(argv[1], 10);
  } else if (argv[2] && argv[2].match(/^\d+$/)) {
    target = parseInt(argv[2], 10);
  }

  const hasWrite = argv.includes('--write');

  const lockfile = parseLockfile(filePath);
  const migrated = migrateToVersion(lockfile, target);

  console.log(`\n✅ Migrated lockfile to version ${target}`);

  if (hasWrite) {
    createBackup(filePath);
    fs.writeFileSync(filePath, JSON.stringify(migrated, null, 2) + '\n', 'utf8');
    console.log(`📝 Changes written to ${filePath}`);
  } else {
    console.log('\n⚠️  Use --write flag to save changes');
    console.log(JSON.stringify(migrated, null, 2));
  }
}

function runUpgradeCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);
  const hasWrite = argv.includes('--write');

  const lockfile = parseLockfile(filePath);
  const sourceVersion = detectLockfileVersion(lockfile);

  if (sourceVersion === 3) {
    console.log('\n✅ Already at version 3, nothing to do');
    return;
  }

  const migrated = migrateToVersion(lockfile, 3);
  console.log(`\n✅ Migrated lockfile v${sourceVersion} → v3`);

  if (hasWrite) {
    createBackup(filePath);
    fs.writeFileSync(filePath, JSON.stringify(migrated, null, 2) + '\n', 'utf8');
    console.log(`📝 Changes written to ${filePath}`);
  } else {
    console.log('\n⚠️  Use --write flag to save changes');
  }
}

// Print the fix-checksums result summary, changes, unresolved entries and warnings.
function printChecksumResult(result, hasWrite) {
  clearProgressLine();
  console.log('\n✅ Checksum fix complete');
  console.log(`   Candidates:          ${result.summary.candidates}`);
  console.log(`   Fixed from registry: ${result.summary.fixedFromRegistry}`);
  console.log(`   Fixed locally:       ${result.summary.fixedFromLocal}${result.summary.fixedFromLocal > 0 ? ' ⚠️  (flagged)' : ''}`);
  console.log(`   Unresolved:          ${result.summary.unresolved}`);
  console.log(`   Skipped:             ${result.summary.skipped}`);

  if (result.changes.length > 0 && !hasWrite) {
    console.log('\n   Changes:');
    result.changes.forEach((change) => {
      console.log(`     • ${change.packagePath}: ${change.from || '(missing)'} → ${change.to.slice(0, 40)}... [${change.source}]`);
    });
  }
  if (result.unresolved.length > 0) {
    console.log('\n   Unresolved packages:');
    result.unresolved.forEach((item) => {
      console.log(`     • ${item.packagePath}: ${item.reason}`);
    });
  }
  result.warnings.forEach((warning) => console.log(`\n⚠️  ${warning}`));
}

async function runFixChecksumsCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);
  const hasWrite = argv.includes('--write');
  const localFallback = argv.includes('--local-fallback');
  const { concurrency, timeoutMs, defaultRegistry } = parseNetworkFlags();

  const lockfile = parseLockfile(filePath);
  const onProgress = makeProgressReporter();

  console.log('🔐 Fixing integrity checksums...');
  const lockfileDir = path.dirname(filePath);
  const result = await fixChecksums(lockfile, {
    onProgress, concurrency, timeoutMs, localFallback,
    baseDir: lockfileDir,
    nodeModulesPath: path.join(lockfileDir, 'node_modules'),
    ...registryOption(defaultRegistry)
  });

  printChecksumResult(result, hasWrite);

  if (hasWrite && result.changes.length > 0) {
    writeJsonFile(filePath, result.lockfile);
    console.log(`\n📝 Changes written to ${filePath}`);
  } else if (result.changes.length > 0) {
    console.log('\n⚠️  Use --write flag to save changes');
  }

  process.exit(result.unresolved.length > 0 ? 1 : 0);
}

function runPinCommand() {
  // pin operates on a directory containing both package.json and the lockfile
  let dir = process.cwd();
  if (argv[1] && !argv[1].startsWith('-')) {
    dir = path.resolve(argv[1]);
  }
  const hasWrite = argv.includes('--write');
  const includePeer = argv.includes('--include-peer');

  const packageJsonPath = path.join(dir, 'package.json');
  const lockfilePath = path.join(dir, 'package-lock.json');
  ensureFileExists(packageJsonPath);
  ensureFileExists(lockfilePath);

  const packageJsonRaw = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(packageJsonRaw);
  const lockfile = parseLockfile(lockfilePath);

  const result = pinVersions(packageJson, lockfile, { includePeer });

  console.log('\n📌 Pin Results:');
  if (result.changes.length === 0) {
    console.log('   Nothing to pin — all ranges already exact (or skipped)');
  } else {
    result.changes.forEach((change) => {
      console.log(`   • ${change.section}/${change.name}  ${change.from} → ${change.to}`);
    });
  }

  if (result.skipped.length > 0) {
    console.log('\n   Skipped:');
    result.skipped.forEach((skip) => {
      console.log(`     • ${skip.section}/${skip.name} (${skip.range}): ${skip.reason}`);
    });
  }

  result.warnings.forEach((warning) => {
    console.log(`\n⚠️  ${warning}`);
  });

  if (hasWrite && result.changes.length > 0) {
    const indent = detectIndent(packageJsonRaw);
    createBackup(packageJsonPath);
    createBackup(lockfilePath);
    fs.writeFileSync(packageJsonPath, JSON.stringify(result.packageJson, null, indent) + '\n', 'utf8');
    fs.writeFileSync(lockfilePath, JSON.stringify(result.lockfile, null, 2) + '\n', 'utf8');
    console.log(`\n📝 Changes written to ${packageJsonPath} and ${lockfilePath}`);
  } else if (result.changes.length > 0) {
    console.log('\n⚠️  Use --write flag to save changes');
  }
}

function runPruneCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);
  const hasWrite = argv.includes('--write');

  const lockfile = parseLockfile(filePath);
  const result = prunePackages(lockfile);

  console.log('\n🧹 Prune Results:');
  if (result.removed.length === 0) {
    console.log('   No orphaned packages found — lockfile is fully connected');
  } else {
    console.log(`   Removed ${result.removed.length} orphaned package(s):`);
    result.removed.forEach((orphan) => {
      const detail = orphan.version ? ` (${orphan.name}@${orphan.version})` : '';
      console.log(`     • ${orphan.key}${detail}`);
    });
  }

  result.warnings.forEach((warning) => {
    console.log(`\n⚠️  ${warning}`);
  });

  if (hasWrite && result.removed.length > 0) {
    createBackup(filePath);
    fs.writeFileSync(filePath, JSON.stringify(result.lockfile, null, 2) + '\n', 'utf8');
    console.log(`\n📝 Changes written to ${filePath}`);
  } else if (result.removed.length > 0) {
    console.log('\n⚠️  Use --write flag to save changes');
  }
}

function runUnusedCommand() {
  let dir = process.cwd();
  if (argv[1] && !argv[1].startsWith('-')) {
    dir = path.resolve(argv[1]);
  }
  const includeDev = argv.includes('--include-dev');
  const asJson = argv.includes('--json');

  const packageJsonPath = path.join(dir, 'package.json');
  ensureFileExists(packageJsonPath);

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  const result = findUnusedDependencies(packageJson, dir, { includeDev });

  if (asJson) {
    console.log(JSON.stringify({
      scannedFiles: result.scannedFiles,
      sectionsChecked: result.sectionsChecked,
      unused: result.unused
    }, null, 2));
  } else {
    console.log(`\n🔎 Scanned ${result.scannedFiles} source file(s) (${result.sectionsChecked.join(', ')})`);
    if (result.unused.length === 0) {
      console.log('   All declared dependencies are imported by the application');
    } else {
      console.log(`   ${result.unused.length} package(s) flagged for removal (never imported):`);
      result.unused.forEach((dep) => {
        console.log(`     • ${dep.name} (${dep.section}: ${dep.version})`);
      });
      console.log('\n   Heuristic results — packages loaded via config files or CLI-only');
      console.log('   tools can be false positives. Verify before removing, e.g.:');
      result.unused.forEach((dep) => {
        console.log(`     npm uninstall ${dep.name}`);
      });
    }
  }
}

function runAuditCommand() {
  const filePath = getFilePath(argv[1]);

  let report;
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Resolve config: file (discovered or --config) + CLI overrides
    const config = loadAuditConfig(process.cwd(), flagValue('--config') || null);
    applyRuleOverrides(config);
    applyMaxWarnings(config);
    const format = parseFormatFlag(['stylish', 'json'], 'stylish');

    const lockfile = parseLockfile(filePath);
    // package.json is optional; the pinned-versions rule degrades gracefully
    const packageJson = loadSiblingPackageJson(filePath);

    report = runAudit({ lockfile, packageJson, filePath: path.relative(process.cwd(), filePath) || filePath }, config);
    console.log('\n' + formatAuditReport(report, { format }));
  } catch (error) {
    console.error(`\n❌ Audit error: ${error.message}`);
    process.exit(2);
  }

  process.exit(report.pass ? 0 : 1);
}

function runUpgradeHashesCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);
  const hasWrite = argv.includes('--write');

  const lockfile = parseLockfile(filePath);

  // Setup progress reporting
  const onProgress = makeProgressReporter();

  const upgraded = upgradeIntegrityHashes(lockfile, { onProgress });

  // Clear progress line and show completion
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  console.log('\n✅ Upgraded integrity hashes');

  if (hasWrite) {
    createBackup(filePath);
    fs.writeFileSync(filePath, JSON.stringify(upgraded, null, 2) + '\n', 'utf8');
    console.log(`📝 Changes written to ${filePath}`);
  } else {
    console.log('\n⚠️  Use --write flag to save changes');
    console.log(JSON.stringify(upgraded, null, 2));
  }
}

function runDedupeCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);
  const hasWrite = argv.includes('--write');

  const lockfile = parseLockfile(filePath);
  const beforeCount = lockfile.packages ? Object.keys(lockfile.packages).length : 0;

  // Setup progress reporting
  const onProgress = makeProgressReporter();

  const deduped = deduplicatePackages(lockfile, { onProgress });
  const afterCount = deduped.packages ? Object.keys(deduped.packages).length : 0;

  // Clear progress line and show completion
  process.stdout.write('\r' + ' '.repeat(80) + '\r');
  console.log(`\n✅ Deduplication complete`);
  console.log(`   Packages: ${beforeCount} → ${afterCount} (removed ${beforeCount - afterCount})`);
  if (afterCount === beforeCount && beforeCount > 0) {
    console.log('   (a v2/v3 packages map is keyed by install path — every entry is required,');
    console.log('    so there is nothing to collapse. Use `npm-check prune` to remove orphaned entries.)');
  }

  if (hasWrite) {
    createBackup(filePath);
    fs.writeFileSync(filePath, JSON.stringify(deduped, null, 2) + '\n', 'utf8');
    console.log(`📝 Changes written to ${filePath}`);
  } else {
    console.log('\n⚠️  Use --write flag to save changes');
    console.log(JSON.stringify(deduped, null, 2));
  }
}

function runFixCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);
  const hasWrite = argv.includes('--write');

  const lockfile = parseLockfile(filePath);
  // Load the sibling package.json (if present) so the fixer can sync the
  // lockfile's stale root name/version — the "Structure & format" errors.
  let pkgJson = null;
  const pkgJsonPath = path.join(path.dirname(filePath), 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try { pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')); } catch { /* ignore malformed package.json */ }
  }
  const { fixedLockfile, fixes } = fixPackageLock(lockfile, { packageJson: pkgJson });

  console.log('\n✅ Fixer Results:');
  if (fixes.length === 0) {
    console.log('   • Nothing to fix — lockfile structure is already consistent');
  } else {
    fixes.forEach(fix => console.log(`   • ${fix}`));
  }

  if (hasWrite) {
    createBackup(filePath);
    fs.writeFileSync(filePath, JSON.stringify(fixedLockfile, null, 2) + '\n', 'utf8');
    console.log(`📝 Changes written to ${filePath}`);
  } else {
    console.log('\n⚠️  Use --write flag to save changes');
    console.log(JSON.stringify(fixedLockfile, null, 2));
  }
}

function runBackupsCommand() {
  const filePath = getFilePath(argv[1]);
  const fileName = path.basename(filePath);

  const backups = listBackups(fileName);

  if (backups.length === 0) {
    console.log(`\n📦 No backups found for ${fileName}`);
  } else {
    console.log(`\n📦 Backups for ${fileName}:`);
    backups.forEach((backup, i) => {
      console.log(`   ${i + 1}. ${backup.name} (${backup.created.toLocaleString()})`);
    });
  }
}

function runRestoreCommand() {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);

  restoreFromLatestBackup(filePath);
  console.log(`\n✅ File restored successfully`);
}

function runCleanBackupsCommand() {
  const filePath = getFilePath(argv[1]);
  const fileName = path.basename(filePath);

  // Parse --keep flag
  let keepCount = 5;
  const keepIndex = argv.indexOf('--keep');
  if (keepIndex !== -1 && argv[keepIndex + 1]) {
    const parsed = parseInt(argv[keepIndex + 1], 10);
    if (!isNaN(parsed) && parsed > 0) {
      keepCount = parsed;
    } else {
      console.error('❌ Invalid --keep value. Must be a positive number');
      process.exit(1);
    }
  }

  const deleted = cleanOldBackups(fileName, keepCount);
  if (deleted === 0) {
    console.log(`\n📦 No old backups to clean (keeping ${keepCount})`);
  } else {
    console.log(`\n✅ Cleaned ${deleted} old backup(s), keeping ${keepCount}`);
  }
}

// Validate the --check flag, exiting on a bad value.
function parseCheckType() {
  const raw = flagValue('--check');
  if (raw === undefined) return 'all';
  if (!['hash', 'license', 'all'].includes(raw)) {
    console.error('❌ Invalid check type. Use: hash, license, or all');
    process.exit(1);
  }
  return raw;
}

// Print the integrity (hash) check result: counts, mismatches, unresolved entries.
function printHashResult(hashResult, failOnUnresolved) {
  clearProgressLine();
  console.log(`   Checked: ${hashResult.checked}`);
  console.log(`   ✅ Passed: ${hashResult.passed}`);
  console.log(`   ❌ Failed: ${hashResult.failed}`);
  console.log(`   ⏭️  Skipped: ${hashResult.skipped}`);
  console.log(`   ❔ Unresolved: ${hashResult.unresolved}`);

  const mismatches = hashResult.errors.filter(e => e.expected && e.actual);
  if (mismatches.length > 0) {
    console.log('\n   Hash mismatches (lockfile differs from registry):');
    mismatches.forEach(err => {
      console.log(`     • ${err.package}`);
      console.log(`       Registry: ${err.expected.slice(0, 50)}...`);
      console.log(`       Lockfile: ${err.actual.slice(0, 50)}...`);
    });
  }
  if (hashResult.unresolvedItems.length > 0) {
    console.log('\n   Unresolved (could not verify against the registry):');
    hashResult.unresolvedItems.forEach(item => {
      console.log(`     • ${item.package}@${item.version}: ${item.reason}`);
    });
    if (!failOnUnresolved) {
      console.log('   (unresolved entries do not fail the check; pass --fail-on-unresolved to fail closed)');
    }
  }
}

// Print the license check result: counts, unapproved licenses, warnings.
function printLicenseResult(licenseResult, strict) {
  clearProgressLine();
  console.log(`   Checked: ${licenseResult.checked}`);
  console.log(`   ✅ Approved: ${licenseResult.approved}`);
  console.log(`   ❌ Rejected: ${licenseResult.rejected}`);
  console.log(`   ⚠️  Unknown: ${licenseResult.unknown}`);

  if (licenseResult.errors.length > 0) {
    console.log('\n   Unapproved/Unknown licenses:');
    licenseResult.errors.forEach(err => {
      console.log(`     • ${err.package}: ${err.license || 'UNKNOWN'}`);
    });
  }
  if (licenseResult.warnings.length > 0 && !strict) {
    console.log('\n   Warnings (unknown licenses):');
    licenseResult.warnings.forEach(warn => {
      console.log(`     • ${warn.package}: ${warn.license || 'UNKNOWN'}`);
    });
  }
}

async function runCheckCommand(command) {
  const filePath = getFilePath(argv[1]);
  ensureFileExists(filePath);

  const checkType = parseCheckType();
  const strict = argv.includes('--strict');
  const licensesCsv = flagValue('--licenses-csv') || './approved-licenses.csv';
  const failOnUnresolved = argv.includes('--fail-on-unresolved');
  // Registry-verification flags (hash check)
  const { concurrency, timeoutMs, defaultRegistry } = parseNetworkFlags();

  const lockfile = parseLockfile(filePath);
  const onProgress = makeProgressReporter();
  const options = { onProgress, strict, csvPath: licensesCsv };

  let allValid = true;
  try {
    // Run hash check (verifies locked integrity against the registry)
    if (checkType === 'hash' || checkType === 'all') {
      console.log('🔐 Verifying integrity against the registry...');
      const hashResult = await checkIntegrity(lockfile, {
        ...options, concurrency, timeoutMs, failOnUnresolved, ...registryOption(defaultRegistry)
      });
      printHashResult(hashResult, failOnUnresolved);
      allValid = allValid && hashResult.valid;
    }

    // Run license check
    if (checkType === 'license' || checkType === 'all') {
      console.log('\n📜 Checking licenses...');
      const licenseResult = await checkLicenses(lockfile, options);
      printLicenseResult(licenseResult, strict);
      allValid = allValid && licenseResult.valid;
    }

    console.log(allValid ? '\n✅ All checks passed' : '\n❌ Some checks failed');
    process.exit(allValid ? 0 : 1);
  } catch (error) {
    handleError(error, `${command} command failed`);
  }
}

// Print the vuln-scan result in pretty form: counts, advisories, unresolved entries.
function printVulnResult(result, minSeverity, failOnUnresolved) {
  console.log(`   Scanned: ${result.scanned}`);
  console.log(`   🛑 Vulnerable: ${result.vulnerable}`);
  console.log(`   ⏭️  Skipped: ${result.skipped}`);
  console.log(`   ❔ Unresolved: ${result.unresolved}`);

  if (result.errors.length > 0) {
    console.log(`\n   Vulnerabilities at/above ${minSeverity} (fail the run):`);
    result.errors.forEach(e => {
      if (!e.advisoryId) return;
      console.log(`     • ${e.package}@${e.version}: ${e.title} (${e.severity})`);
      if (e.url) console.log(`       ${e.url}`);
    });
  }
  if (result.warnings.length > 0) {
    console.log(`\n   Advisories below ${minSeverity} (warnings):`);
    result.warnings.forEach(w => {
      console.log(`     • ${w.package}@${w.version}: ${w.title} (${w.severity})`);
    });
  }
  if (result.unresolvedItems.length > 0) {
    console.log('\n   Unresolved (could not check against the registry):');
    result.unresolvedItems.forEach(item => {
      console.log(`     • ${item.package}@${item.version}: ${item.reason}`);
    });
    if (!failOnUnresolved) {
      console.log('   (unresolved entries do not fail the scan; pass --fail-on-unresolved to fail closed)');
    }
  }
  console.log(result.valid ? '\n✅ No known vulnerabilities at/above the threshold' : '\n❌ Known vulnerabilities found');
}

async function runVulnCommand(command) {
  const filePath = getFilePath(argv[1]);
  requireLockfileOrExit2(filePath, 'vuln');

  const format = parseFormatFlag(['pretty', 'json'], 'pretty');
  const minSeverity = parseMinSeverityFlag();
  const offline = argv.includes('--offline');
  const failOnUnresolved = argv.includes('--fail-on-unresolved');
  const { concurrency, timeoutMs, defaultRegistry } = parseNetworkFlags(2);

  const lockfile = parseLockfile(filePath);
  const onProgress = format === 'pretty' ? makeProgressReporter() : null;

  try {
    if (format === 'pretty' && !offline) console.log('🛡️  Scanning locked packages for known vulnerabilities…');
    const result = await checkVulnerabilities(lockfile, {
      concurrency, timeoutMs, minSeverity, offline, failOnUnresolved, onProgress,
      ...registryOption(defaultRegistry)
    });

    if (onProgress) clearProgressLine();

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printVulnResult(result, minSeverity, failOnUnresolved);
    }

    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    handleError(error, `${command} command failed`);
  }
}

// Print the deprecation-scan result in pretty form: counts, notices, unresolved, verdict.
function printDeprecatedResult(result, failOnUnresolved) {
  console.log(`   Scanned: ${result.scanned}`);
  console.log(`   📉 Deprecated: ${result.deprecated}`);
  console.log(`   ⏭️  Skipped: ${result.skipped}`);
  console.log(`   ❔ Unresolved: ${result.unresolved}`);

  if (result.errors.some(e => e.message)) {
    console.log('\n   Deprecated (fail the run):');
    result.errors.forEach(e => {
      if (!e.message) return;
      console.log(`     • ${e.package}@${e.version}: ${e.message}`);
    });
  }
  if (result.warnings.length > 0) {
    console.log('\n   Deprecated (warnings):');
    result.warnings.forEach(w => {
      console.log(`     • ${w.package}@${w.version}: ${w.message}`);
    });
  }
  if (result.unresolvedItems.length > 0) {
    console.log('\n   Unresolved (could not check against the registry):');
    result.unresolvedItems.forEach(item => {
      console.log(`     • ${item.package}@${item.version}: ${item.reason}`);
    });
    if (!failOnUnresolved) {
      console.log('   (unresolved entries do not fail the scan; pass --fail-on-unresolved to fail closed)');
    }
  }
  if (result.deprecated === 0) {
    console.log('\n✅ No deprecated packages found');
  } else if (result.valid) {
    console.log('\n⚠️  Deprecated packages found (warnings; pass --fail-on-deprecated to fail the run)');
  } else {
    console.log('\n❌ Deprecated packages found');
  }
}

async function runDeprecatedCommand(command) {
  const filePath = getFilePath(argv[1]);
  requireLockfileOrExit2(filePath, 'deprecated');

  const format = parseFormatFlag(['pretty', 'json'], 'pretty');
  const offline = argv.includes('--offline');
  const failOnDeprecated = argv.includes('--fail-on-deprecated');
  const failOnUnresolved = argv.includes('--fail-on-unresolved');
  const { concurrency, timeoutMs, defaultRegistry } = parseNetworkFlags(2);

  const lockfile = parseLockfile(filePath);
  const onProgress = format === 'pretty' ? makeProgressReporter() : null;

  try {
    if (format === 'pretty' && !offline) console.log('📉 Scanning locked packages for deprecation notices…');
    const result = await checkDeprecations(lockfile, {
      concurrency, timeoutMs, offline, failOnDeprecated, failOnUnresolved, onProgress,
      ...registryOption(defaultRegistry)
    });

    if (onProgress) clearProgressLine();

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printDeprecatedResult(result, failOnUnresolved);
    }

    process.exit(result.valid ? 0 : 1);
  } catch (error) {
    handleError(error, `${command} command failed`);
  }
}

// Print the remediation result in pretty form: bumps, guidance, skips, warnings.
function printRemediateResult(result) {
  console.log('\n🩹 Remediation Results:');
  if (result.bumped.length === 0) {
    console.log('   • No direct dependencies to bump');
  } else {
    result.bumped.forEach((b) => {
      console.log(`   • ${b.section}/${b.package}  ${b.from} → ${b.to}  (${b.reasons.join(', ')})`);
    });
  }

  if (result.guidance.length > 0) {
    console.log('\n   Transitive / manual (not a direct dep — bump the parent or add an npm override):');
    result.guidance.forEach((g) => {
      const note = g.kind === 'latest-still-affected' ? `${g.reasons.join(', ')}; latest still affected` : g.reasons.join(', ');
      console.log(`     • ${g.package}: ${note}`);
    });
  }
  if (result.skipped.length > 0) {
    console.log('\n   Skipped:');
    result.skipped.forEach((s) => console.log(`     • ${s.section}/${s.package} (${s.range}): ${s.reason}`));
  }
  result.warnings.forEach((w) => console.log(`\n⚠️  ${w.package}: ${w.reason}`));
}

async function runRemediateCommand(command) {
  // Operates on a directory containing both package.json and the lockfile.
  const dir = getDirArg();
  const hasWrite = argv.includes('--write');

  const packageJsonPath = path.join(dir, 'package.json');
  const lockfilePath = path.join(dir, 'package-lock.json');
  ensureFileExists(packageJsonPath);
  ensureFileExists(lockfilePath);

  const format = parseFormatFlag(['pretty', 'json'], 'pretty');
  const minSeverity = parseMinSeverityFlag();
  const includeDeprecated = !argv.includes('--no-deprecated');
  const defaultRegistry = flagValue('--registry');

  const packageJsonRaw = fs.readFileSync(packageJsonPath, 'utf8');
  const packageJson = JSON.parse(packageJsonRaw);
  const lockfile = parseLockfile(lockfilePath);

  const onProgress = format === 'pretty' ? makeProgressReporter() : null;

  try {
    if (format === 'pretty') console.log('🩹 Scanning for remediable direct dependencies…');
    const result = await remediateDependencies(lockfile, packageJson, {
      minSeverity, includeDeprecated, onProgress,
      ...registryOption(defaultRegistry)
    });
    if (onProgress) clearProgressLine();

    if (format === 'json') {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }

    printRemediateResult(result);

    if (hasWrite && result.changed) {
      const indent = detectIndent(packageJsonRaw);
      writeJsonFile(packageJsonPath, result.packageJson, indent);
      writeJsonFile(lockfilePath, result.lockfile);
      console.log(`\n📝 Changes written to ${packageJsonPath} and ${lockfilePath}`);
      console.log('   ▶ Run `npm install` to re-resolve the dependency tree, then re-run `npm-check`.');
    } else if (result.changed) {
      console.log('\n⚠️  Use --write to apply these bumps (then run `npm install`)');
    }
    process.exit(0);
  } catch (error) {
    handleError(error, `${command} command failed`);
  }
}

// Dispatch table: command name → handler. Handlers that report their own
// errors with the originating command name take it as an argument.
const COMMAND_HANDLERS = {
  report: () => runReportCommand(),
  validate: () => runValidateCommand(),
  migrate: () => runMigrateCommand(),
  upgrade: () => runUpgradeCommand(),
  'fix-checksums': () => runFixChecksumsCommand(),
  pin: () => runPinCommand(),
  prune: () => runPruneCommand(),
  unused: () => runUnusedCommand(),
  audit: () => runAuditCommand(),
  'upgrade-hashes': () => runUpgradeHashesCommand(),
  dedupe: () => runDedupeCommand(),
  fix: () => runFixCommand(),
  backups: () => runBackupsCommand(),
  restore: () => runRestoreCommand(),
  'clean-backups': () => runCleanBackupsCommand(),
  check: (command) => runCheckCommand(command),
  vuln: (command) => runVulnCommand(command),
  deprecated: (command) => runDeprecatedCommand(command),
  remediate: (command) => runRemediateCommand(command)
};

async function main() {
  if (argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(`npm-check version ${getVersion()}`);
    return;
  }

  // Bare `npm-check` (no command, or only flags) runs the full report.
  const command = (!argv[0] || argv[0].startsWith('-')) ? 'report' : argv[0];

  const handler = COMMAND_HANDLERS[command];
  if (!handler) {
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
    return;
  }

  try {
    await handler(command);
  } catch (error) {
    handleError(error, `${command} command failed`);
  }
}

main().catch(error => {
  handleError(error, 'Fatal error');
});
