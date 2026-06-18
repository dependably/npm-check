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

  try {
    switch (command) {
      case 'report': {
        // `report` takes its file from argv[1] only when invoked explicitly.
        const fileArg = argv[0] === 'report' ? argv[1] : undefined;
        const filePath = getFilePath(fileArg);
        if (!fs.existsSync(filePath)) {
          console.error(`❌ No lockfile found at ${filePath}`);
          console.error('   Run `npm-check report <path>` or `npm-check --help`.');
          process.exit(2);
        }

        let report;
        try {
          // Audit config: discovered/--config file + --rule/--strict/--max-warnings overrides.
          let configPath = null;
          const configIndex = argv.indexOf('--config');
          if (configIndex !== -1 && argv[configIndex + 1]) configPath = argv[configIndex + 1];
          const config = loadAuditConfig(process.cwd(), configPath);

          argv.forEach((arg, i) => {
            if (arg === '--rule' && argv[i + 1]) {
              const [ruleId, severity] = argv[i + 1].split(':');
              const merged = mergeConfig({ rules: { [ruleId]: severity } });
              if (merged.rules[ruleId]) {
                config.rules[ruleId] = { severity: merged.rules[ruleId].severity, options: { ...config.rules[ruleId].options } };
              }
            }
          });

          const strict = argv.includes('--strict');
          let maxWarnings = strict ? 0 : config.maxWarnings;
          const maxWarningsIndex = argv.indexOf('--max-warnings');
          if (maxWarningsIndex !== -1 && argv[maxWarningsIndex + 1]) {
            const parsed = parseInt(argv[maxWarningsIndex + 1], 10);
            if (isNaN(parsed)) { console.error('❌ Invalid --max-warnings value. Must be a number'); process.exit(2); }
            maxWarnings = parsed;
          }

          let format = 'pretty';
          const formatIndex = argv.indexOf('--format');
          if (formatIndex !== -1 && argv[formatIndex + 1]) {
            format = argv[formatIndex + 1];
            if (!['pretty', 'json'].includes(format)) { console.error('❌ Invalid --format value. Use: pretty or json'); process.exit(2); }
          }

          // Network/integrity + license toggles.
          const integrity = !argv.includes('--offline') && !argv.includes('--no-integrity');
          const license = !argv.includes('--no-license');
          const vuln = !argv.includes('--offline') && !argv.includes('--no-vuln');
          const deprecated = !argv.includes('--offline') && !argv.includes('--no-deprecated');
          const failOnUnresolved = argv.includes('--fail-on-unresolved');
          const failOnDeprecated = argv.includes('--fail-on-deprecated');

          const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
          let minSeverity = 'high';
          const minSeverityIndex = argv.indexOf('--min-severity');
          if (minSeverityIndex !== -1 && argv[minSeverityIndex + 1]) {
            minSeverity = argv[minSeverityIndex + 1];
            if (!SEVERITIES.includes(minSeverity)) { console.error(`❌ Invalid --min-severity value. Use: ${SEVERITIES.join(', ')}`); process.exit(2); }
          }

          let concurrency = 8;
          const concurrencyIndex = argv.indexOf('--concurrency');
          if (concurrencyIndex !== -1 && argv[concurrencyIndex + 1]) {
            const parsed = parseInt(argv[concurrencyIndex + 1], 10);
            if (isNaN(parsed) || parsed < 1) { console.error('❌ Invalid --concurrency value. Must be a positive number'); process.exit(2); }
            concurrency = parsed;
          }
          let timeoutMs = 10000;
          const timeoutIndex = argv.indexOf('--timeout');
          if (timeoutIndex !== -1 && argv[timeoutIndex + 1]) {
            const parsed = parseInt(argv[timeoutIndex + 1], 10);
            if (isNaN(parsed) || parsed < 1) { console.error('❌ Invalid --timeout value. Must be a positive number'); process.exit(2); }
            timeoutMs = parsed;
          }
          let defaultRegistry;
          const registryIndex = argv.indexOf('--registry');
          if (registryIndex !== -1 && argv[registryIndex + 1]) defaultRegistry = argv[registryIndex + 1];

          let licensesCsv;
          const csvIndex = argv.indexOf('--licenses-csv');
          if (csvIndex !== -1 && argv[csvIndex + 1]) licensesCsv = argv[csvIndex + 1];

          const dir = path.dirname(filePath);
          const lockfile = parseLockfile(filePath);
          let packageJson = null;
          const packageJsonPath = path.join(dir, 'package.json');
          if (fs.existsSync(packageJsonPath)) packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));

          if ((integrity || vuln || deprecated) && format === 'pretty') console.log('🔎 Running all checks (querying the registry)…');

          let lastProgress = null;
          const onProgress = format === 'pretty' ? (progress) => {
            if (!lastProgress || progress.percentage !== lastProgress.percentage) {
              process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
              lastProgress = progress;
            }
          } : null;

          report = await runReport(
            { lockfile, packageJson, filePath: path.relative(process.cwd(), filePath) || filePath, dir },
            {
              auditConfig: config, integrity, license, vuln, deprecated, failOnDeprecated, minSeverity, strict, maxWarnings,
              concurrency, timeoutMs, failOnUnresolved, onProgress,
              ...(defaultRegistry ? { defaultRegistry } : {}),
              ...(licensesCsv ? { licensesCsv } : {})
            }
          );

          if (onProgress) process.stdout.write('\r' + ' '.repeat(80) + '\r');
          console.log(format === 'pretty' ? '\n' + formatReport(report, { format }) : formatReport(report, { format }));
        } catch (error) {
          console.error(`\n❌ Report error: ${error.message}`);
          process.exit(2);
        }

        process.exit(report.summary.pass ? 0 : 1);
        break;
      }

      case 'validate': {
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

        const out = {
          'package-lock.json': lockResult,
          'package.json': pkgResult || 'not found (skipped)',
          '.npmrc': npmrcResult || 'not found (skipped)'
        };

        console.log('\n📋 Validation Result:');
        console.log(JSON.stringify(out, null, 2));

        const valid = lockResult.valid && (!pkgResult || pkgResult.valid) && (!npmrcResult || npmrcResult.valid);
        process.exit(valid ? 0 : 1);
        break;
      }

      case 'migrate': {
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
        break;
      }

      case 'upgrade': {
        const filePath = getFilePath(argv[1]);
        ensureFileExists(filePath);
        const hasWrite = argv.includes('--write');

        const lockfile = parseLockfile(filePath);
        const sourceVersion = detectLockfileVersion(lockfile);

        if (sourceVersion === 3) {
          console.log('\n✅ Already at version 3, nothing to do');
          break;
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
        break;
      }

      case 'fix-checksums': {
        const filePath = getFilePath(argv[1]);
        ensureFileExists(filePath);
        const hasWrite = argv.includes('--write');
        const localFallback = argv.includes('--local-fallback');

        let concurrency = 8;
        const concurrencyIndex = argv.indexOf('--concurrency');
        if (concurrencyIndex !== -1 && argv[concurrencyIndex + 1]) {
          const parsed = parseInt(argv[concurrencyIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) {
            console.error('❌ Invalid --concurrency value. Must be a positive number');
            process.exit(1);
          }
          concurrency = parsed;
        }

        let timeoutMs = 10000;
        const timeoutIndex = argv.indexOf('--timeout');
        if (timeoutIndex !== -1 && argv[timeoutIndex + 1]) {
          const parsed = parseInt(argv[timeoutIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) {
            console.error('❌ Invalid --timeout value. Must be a positive number');
            process.exit(1);
          }
          timeoutMs = parsed;
        }

        let defaultRegistry;
        const registryIndex = argv.indexOf('--registry');
        if (registryIndex !== -1 && argv[registryIndex + 1]) {
          defaultRegistry = argv[registryIndex + 1];
        }

        const lockfile = parseLockfile(filePath);

        let lastProgress = null;
        const onProgress = (progress) => {
          if (!lastProgress || progress.percentage !== lastProgress.percentage) {
            process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
            lastProgress = progress;
          }
        };

        console.log('🔐 Fixing integrity checksums...');
        const lockfileDir = path.dirname(filePath);
        const result = await fixChecksums(lockfile, {
          onProgress,
          concurrency,
          timeoutMs,
          localFallback,
          baseDir: lockfileDir,
          nodeModulesPath: path.join(lockfileDir, 'node_modules'),
          ...(defaultRegistry ? { defaultRegistry } : {})
        });

        process.stdout.write('\r' + ' '.repeat(80) + '\r');
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

        result.warnings.forEach((warning) => {
          console.log(`\n⚠️  ${warning}`);
        });

        if (hasWrite && result.changes.length > 0) {
          createBackup(filePath);
          fs.writeFileSync(filePath, JSON.stringify(result.lockfile, null, 2) + '\n', 'utf8');
          console.log(`\n📝 Changes written to ${filePath}`);
        } else if (result.changes.length > 0) {
          console.log('\n⚠️  Use --write flag to save changes');
        }

        process.exit(result.unresolved.length > 0 ? 1 : 0);
        break;
      }

      case 'pin': {
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
        break;
      }

      case 'prune': {
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
            console.log(`     • ${orphan.key}${orphan.version ? ` (${orphan.name}@${orphan.version})` : ''}`);
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
        break;
      }

      case 'unused': {
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
        break;
      }

      case 'audit': {
        const filePath = getFilePath(argv[1]);

        let report;
        try {
          if (!fs.existsSync(filePath)) {
            throw new Error(`File not found: ${filePath}`);
          }

          // Resolve config: file (discovered or --config) + CLI overrides
          let configPath = null;
          const configIndex = argv.indexOf('--config');
          if (configIndex !== -1 && argv[configIndex + 1]) {
            configPath = argv[configIndex + 1];
          }
          const config = loadAuditConfig(process.cwd(), configPath);

          // --rule <id>:<severity> overrides (repeatable)
          const ruleOverrides = {};
          argv.forEach((arg, i) => {
            if (arg === '--rule' && argv[i + 1]) {
              const [ruleId, severity] = argv[i + 1].split(':');
              ruleOverrides[ruleId] = severity;
            }
          });
          if (Object.keys(ruleOverrides).length > 0) {
            const merged = mergeConfig({
              maxWarnings: config.maxWarnings,
              rules: ruleOverrides
            });
            for (const ruleId of Object.keys(ruleOverrides)) {
              config.rules[ruleId] = {
                severity: merged.rules[ruleId].severity,
                options: { ...config.rules[ruleId].options }
              };
            }
          }

          if (argv.includes('--strict')) {
            config.maxWarnings = 0;
          }
          const maxWarningsIndex = argv.indexOf('--max-warnings');
          if (maxWarningsIndex !== -1 && argv[maxWarningsIndex + 1]) {
            const parsed = parseInt(argv[maxWarningsIndex + 1], 10);
            if (isNaN(parsed)) {
              console.error('❌ Invalid --max-warnings value. Must be a number');
              process.exit(2);
            }
            config.maxWarnings = parsed;
          }

          let format = 'stylish';
          const formatIndex = argv.indexOf('--format');
          if (formatIndex !== -1 && argv[formatIndex + 1]) {
            format = argv[formatIndex + 1];
            if (!['stylish', 'json'].includes(format)) {
              console.error('❌ Invalid --format value. Use: stylish or json');
              process.exit(2);
            }
          }

          const lockfile = parseLockfile(filePath);

          // package.json is optional; the pinned-versions rule degrades gracefully
          let packageJson = null;
          const packageJsonPath = path.join(path.dirname(filePath), 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
          }

          report = runAudit({ lockfile, packageJson, filePath: path.relative(process.cwd(), filePath) || filePath }, config);
          console.log('\n' + formatAuditReport(report, { format }));
        } catch (error) {
          console.error(`\n❌ Audit error: ${error.message}`);
          process.exit(2);
        }

        process.exit(report.pass ? 0 : 1);
        break;
      }

      case 'upgrade-hashes': {
        const filePath = getFilePath(argv[1]);
        ensureFileExists(filePath);
        const hasWrite = argv.includes('--write');

        const lockfile = parseLockfile(filePath);

        // Setup progress reporting
        let lastProgress = null;
        const onProgress = (progress) => {
          // Only update if percentage changed to avoid flicker
          if (!lastProgress || progress.percentage !== lastProgress.percentage) {
            process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
            lastProgress = progress;
          }
        };

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
        break;
      }

      case 'dedupe': {
        const filePath = getFilePath(argv[1]);
        ensureFileExists(filePath);
        const hasWrite = argv.includes('--write');

        const lockfile = parseLockfile(filePath);
        const beforeCount = lockfile.packages ? Object.keys(lockfile.packages).length : 0;

        // Setup progress reporting
        let lastProgress = null;
        const onProgress = (progress) => {
          // Only update if percentage changed to avoid flicker
          if (!lastProgress || progress.percentage !== lastProgress.percentage) {
            process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
            lastProgress = progress;
          }
        };

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
        break;
      }

      case 'fix': {
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
        break;
      }

      case 'backups': {
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
        break;
      }

      case 'restore': {
        const filePath = getFilePath(argv[1]);
        ensureFileExists(filePath);

        restoreFromLatestBackup(filePath);
        console.log(`\n✅ File restored successfully`);
        break;
      }

      case 'clean-backups': {
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
        break;
      }

      case 'check': {
        const filePath = getFilePath(argv[1]);
        ensureFileExists(filePath);

        // Parse flags
        let checkType = 'all';  // Default to all checks
        let licensesCsv = './approved-licenses.csv';
        let strict = argv.includes('--strict');

        // Parse --check flag
        const checkIndex = argv.indexOf('--check');
        if (checkIndex !== -1 && argv[checkIndex + 1]) {
          checkType = argv[checkIndex + 1];
          if (!['hash', 'license', 'all'].includes(checkType)) {
            console.error('❌ Invalid check type. Use: hash, license, or all');
            process.exit(1);
          }
        }

        // Parse --licenses-csv flag
        const csvIndex = argv.indexOf('--licenses-csv');
        if (csvIndex !== -1 && argv[csvIndex + 1]) {
          licensesCsv = argv[csvIndex + 1];
        }

        // Registry-verification flags (hash check)
        let concurrency = 8;
        const concurrencyIndex = argv.indexOf('--concurrency');
        if (concurrencyIndex !== -1 && argv[concurrencyIndex + 1]) {
          const parsed = parseInt(argv[concurrencyIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) {
            console.error('❌ Invalid --concurrency value. Must be a positive number');
            process.exit(1);
          }
          concurrency = parsed;
        }

        let timeoutMs = 10000;
        const timeoutIndex = argv.indexOf('--timeout');
        if (timeoutIndex !== -1 && argv[timeoutIndex + 1]) {
          const parsed = parseInt(argv[timeoutIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) {
            console.error('❌ Invalid --timeout value. Must be a positive number');
            process.exit(1);
          }
          timeoutMs = parsed;
        }

        let defaultRegistry;
        const registryIndex = argv.indexOf('--registry');
        if (registryIndex !== -1 && argv[registryIndex + 1]) {
          defaultRegistry = argv[registryIndex + 1];
        }

        const failOnUnresolved = argv.includes('--fail-on-unresolved');

        // Parse lockfile
        const lockfile = parseLockfile(filePath);

        // Setup progress reporting
        let lastProgress = null;
        const onProgress = (progress) => {
          if (!lastProgress || progress.percentage !== lastProgress.percentage) {
            process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
            lastProgress = progress;
          }
        };

        const options = {
          onProgress,
          strict,
          csvPath: licensesCsv
        };

        let allValid = true;

        try {
          // Run hash check (verifies locked integrity against the registry)
          if (checkType === 'hash' || checkType === 'all') {
            console.log('🔐 Verifying integrity against the registry...');
            const hashResult = await checkIntegrity(lockfile, {
              ...options,
              concurrency,
              timeoutMs,
              failOnUnresolved,
              ...(defaultRegistry ? { defaultRegistry } : {})
            });

            process.stdout.write('\r' + ' '.repeat(80) + '\r');
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

            allValid = allValid && hashResult.valid;
          }

          // Run license check
          if (checkType === 'license' || checkType === 'all') {
            console.log('\n📜 Checking licenses...');
            const licenseResult = await checkLicenses(lockfile, options);

            process.stdout.write('\r' + ' '.repeat(80) + '\r');
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

            allValid = allValid && licenseResult.valid;
          }

          console.log(allValid ? '\n✅ All checks passed' : '\n❌ Some checks failed');
          process.exit(allValid ? 0 : 1);

        } catch (error) {
          handleError(error, `${command} command failed`);
        }
        break;
      }

      case 'vuln': {
        const filePath = getFilePath(argv[1]);
        if (!fs.existsSync(filePath)) {
          console.error(`❌ No lockfile found at ${filePath}`);
          console.error('   Run `npm-check vuln <path>` or `npm-check --help`.');
          process.exit(2);
        }

        let format = 'pretty';
        const formatIndex = argv.indexOf('--format');
        if (formatIndex !== -1 && argv[formatIndex + 1]) {
          format = argv[formatIndex + 1];
          if (!['pretty', 'json'].includes(format)) { console.error('❌ Invalid --format value. Use: pretty or json'); process.exit(2); }
        }

        const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
        let minSeverity = 'high';
        const minSeverityIndex = argv.indexOf('--min-severity');
        if (minSeverityIndex !== -1 && argv[minSeverityIndex + 1]) {
          minSeverity = argv[minSeverityIndex + 1];
          if (!SEVERITIES.includes(minSeverity)) { console.error(`❌ Invalid --min-severity value. Use: ${SEVERITIES.join(', ')}`); process.exit(2); }
        }

        const offline = argv.includes('--offline');
        const failOnUnresolved = argv.includes('--fail-on-unresolved');

        let concurrency = 8;
        const concurrencyIndex = argv.indexOf('--concurrency');
        if (concurrencyIndex !== -1 && argv[concurrencyIndex + 1]) {
          const parsed = parseInt(argv[concurrencyIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) { console.error('❌ Invalid --concurrency value. Must be a positive number'); process.exit(2); }
          concurrency = parsed;
        }
        let timeoutMs = 10000;
        const timeoutIndex = argv.indexOf('--timeout');
        if (timeoutIndex !== -1 && argv[timeoutIndex + 1]) {
          const parsed = parseInt(argv[timeoutIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) { console.error('❌ Invalid --timeout value. Must be a positive number'); process.exit(2); }
          timeoutMs = parsed;
        }
        let defaultRegistry;
        const registryIndex = argv.indexOf('--registry');
        if (registryIndex !== -1 && argv[registryIndex + 1]) defaultRegistry = argv[registryIndex + 1];

        const lockfile = parseLockfile(filePath);

        let lastProgress = null;
        const onProgress = format === 'pretty' ? (progress) => {
          if (!lastProgress || progress.percentage !== lastProgress.percentage) {
            process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
            lastProgress = progress;
          }
        } : null;

        try {
          if (format === 'pretty' && !offline) console.log('🛡️  Scanning locked packages for known vulnerabilities…');
          const result = await checkVulnerabilities(lockfile, {
            concurrency, timeoutMs, minSeverity, offline, failOnUnresolved, onProgress,
            ...(defaultRegistry ? { defaultRegistry } : {})
          });

          if (onProgress) process.stdout.write('\r' + ' '.repeat(80) + '\r');

          if (format === 'json') {
            console.log(JSON.stringify(result, null, 2));
          } else {
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

          process.exit(result.valid ? 0 : 1);
        } catch (error) {
          handleError(error, `${command} command failed`);
        }
        break;
      }

      case 'deprecated': {
        const filePath = getFilePath(argv[1]);
        if (!fs.existsSync(filePath)) {
          console.error(`❌ No lockfile found at ${filePath}`);
          console.error('   Run `npm-check deprecated <path>` or `npm-check --help`.');
          process.exit(2);
        }

        let format = 'pretty';
        const formatIndex = argv.indexOf('--format');
        if (formatIndex !== -1 && argv[formatIndex + 1]) {
          format = argv[formatIndex + 1];
          if (!['pretty', 'json'].includes(format)) { console.error('❌ Invalid --format value. Use: pretty or json'); process.exit(2); }
        }

        const offline = argv.includes('--offline');
        const failOnDeprecated = argv.includes('--fail-on-deprecated');
        const failOnUnresolved = argv.includes('--fail-on-unresolved');

        let concurrency = 8;
        const concurrencyIndex = argv.indexOf('--concurrency');
        if (concurrencyIndex !== -1 && argv[concurrencyIndex + 1]) {
          const parsed = parseInt(argv[concurrencyIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) { console.error('❌ Invalid --concurrency value. Must be a positive number'); process.exit(2); }
          concurrency = parsed;
        }
        let timeoutMs = 10000;
        const timeoutIndex = argv.indexOf('--timeout');
        if (timeoutIndex !== -1 && argv[timeoutIndex + 1]) {
          const parsed = parseInt(argv[timeoutIndex + 1], 10);
          if (isNaN(parsed) || parsed < 1) { console.error('❌ Invalid --timeout value. Must be a positive number'); process.exit(2); }
          timeoutMs = parsed;
        }
        let defaultRegistry;
        const registryIndex = argv.indexOf('--registry');
        if (registryIndex !== -1 && argv[registryIndex + 1]) defaultRegistry = argv[registryIndex + 1];

        const lockfile = parseLockfile(filePath);

        let lastProgress = null;
        const onProgress = format === 'pretty' ? (progress) => {
          if (!lastProgress || progress.percentage !== lastProgress.percentage) {
            process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
            lastProgress = progress;
          }
        } : null;

        try {
          if (format === 'pretty' && !offline) console.log('📉 Scanning locked packages for deprecation notices…');
          const result = await checkDeprecations(lockfile, {
            concurrency, timeoutMs, offline, failOnDeprecated, failOnUnresolved, onProgress,
            ...(defaultRegistry ? { defaultRegistry } : {})
          });

          if (onProgress) process.stdout.write('\r' + ' '.repeat(80) + '\r');

          if (format === 'json') {
            console.log(JSON.stringify(result, null, 2));
          } else {
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

          process.exit(result.valid ? 0 : 1);
        } catch (error) {
          handleError(error, `${command} command failed`);
        }
        break;
      }

      case 'remediate': {
        // Operates on a directory containing both package.json and the lockfile.
        let dir = process.cwd();
        if (argv[1] && !argv[1].startsWith('-')) dir = path.resolve(argv[1]);
        const hasWrite = argv.includes('--write');

        const packageJsonPath = path.join(dir, 'package.json');
        const lockfilePath = path.join(dir, 'package-lock.json');
        ensureFileExists(packageJsonPath);
        ensureFileExists(lockfilePath);

        let format = 'pretty';
        const formatIndex = argv.indexOf('--format');
        if (formatIndex !== -1 && argv[formatIndex + 1]) {
          format = argv[formatIndex + 1];
          if (!['pretty', 'json'].includes(format)) { console.error('❌ Invalid --format value. Use: pretty or json'); process.exit(2); }
        }

        const SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical'];
        let minSeverity = 'high';
        const minSeverityIndex = argv.indexOf('--min-severity');
        if (minSeverityIndex !== -1 && argv[minSeverityIndex + 1]) {
          minSeverity = argv[minSeverityIndex + 1];
          if (!SEVERITIES.includes(minSeverity)) { console.error(`❌ Invalid --min-severity value. Use: ${SEVERITIES.join(', ')}`); process.exit(2); }
        }
        const includeDeprecated = !argv.includes('--no-deprecated');

        let defaultRegistry;
        const registryIndex = argv.indexOf('--registry');
        if (registryIndex !== -1 && argv[registryIndex + 1]) defaultRegistry = argv[registryIndex + 1];

        const packageJsonRaw = fs.readFileSync(packageJsonPath, 'utf8');
        const packageJson = JSON.parse(packageJsonRaw);
        const lockfile = parseLockfile(lockfilePath);

        let lastProgress = null;
        const onProgress = format === 'pretty' ? (progress) => {
          if (!lastProgress || progress.percentage !== lastProgress.percentage) {
            process.stdout.write(`\r${createProgressBar(progress)} ${progress.stage}`);
            lastProgress = progress;
          }
        } : null;

        try {
          if (format === 'pretty') console.log('🩹 Scanning for remediable direct dependencies…');
          const result = await remediateDependencies(lockfile, packageJson, {
            minSeverity, includeDeprecated, onProgress,
            ...(defaultRegistry ? { defaultRegistry } : {})
          });
          if (onProgress) process.stdout.write('\r' + ' '.repeat(80) + '\r');

          if (format === 'json') {
            console.log(JSON.stringify(result, null, 2));
            process.exit(0);
          }

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

          if (hasWrite && result.changed) {
            const indent = detectIndent(packageJsonRaw);
            createBackup(packageJsonPath);
            createBackup(lockfilePath);
            fs.writeFileSync(packageJsonPath, JSON.stringify(result.packageJson, null, indent) + '\n', 'utf8');
            fs.writeFileSync(lockfilePath, JSON.stringify(result.lockfile, null, 2) + '\n', 'utf8');
            console.log(`\n📝 Changes written to ${packageJsonPath} and ${lockfilePath}`);
            console.log('   ▶ Run `npm install` to re-resolve the dependency tree, then re-run `npm-check`.');
          } else if (result.changed) {
            console.log('\n⚠️  Use --write to apply these bumps (then run `npm install`)');
          }
          process.exit(0);
        } catch (error) {
          handleError(error, `${command} command failed`);
        }
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } catch (error) {
    handleError(error, `${command} command failed`);
  }
}

main().catch(error => {
  handleError(error, 'Fatal error');
});
