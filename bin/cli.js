#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { parseLockfile } from '../src/parser.js';
import { validatePackageLock } from '../src/validator.js';
import { migrateToVersion } from '../src/migrator.js';
import { upgradeIntegrityHashes, deduplicatePackages } from '../src/updater.js';
import { fixPackageLock } from '../src/fixer.js';
import { createBackup, listBackups, restoreFromLatestBackup, cleanOldBackups, BackupError } from '../src/backup.js';
import { createProgressBar } from '../src/progress-reporter.js';
import { checkIntegrity, checkLicenses } from '../src/checker.js';
import { detectLockfileVersion } from '../src/format-library.js';
import { fixChecksums } from '../src/checksum-fixer.js';
import { pinVersions, detectIndent } from '../src/pinner.js';
import { runAudit, formatAuditReport } from '../src/audit.js';
import { loadAuditConfig, mergeConfig } from '../src/audit-config.js';

const argv = process.argv.slice(2);

function printHelp() {
  console.log(`
Package Lockfile Tool (npfix)

Usage:
  npfix <command> [file] [options]

Commands:
  validate [file]            Validate a package-lock.json file
  migrate [file] [target]    Migrate to target version (1, 2, or 3; default: 3)
  upgrade [file]             Upgrade lockfile to version 3 (alias for migrate 3)
  upgrade-hashes [file]      Upgrade integrity hashes sha1→sha512
  fix-checksums [file]       Fill missing/placeholder/sha1 hashes from the registry
  pin [dir]                  Pin ^/~ ranges in package.json to lockfile versions
  audit [file]               Lint lockfile for best practices (non-zero exit on failure)
  dedupe [file]              Deduplicate packages in lockfile
  fix [file] [--write]       Run automated fixer with optional write
  check [file]               Verify integrity hashes and licenses
  backups [file]             List all backups for a file
  restore [file]             Restore from latest backup
  clean-backups [file]       Clean old backup files with optional --keep N

Check Options:
  --check hash               Only verify integrity checksums
  --check license            Only verify licenses against approved list
  --check all                Run both checks (default)
  --licenses-csv <path>      Path to approved licenses CSV
  --strict                   Treat warnings as errors

Fix-Checksums Options:
  --concurrency N            Parallel registry requests (default: 8)
  --timeout MS               Per-request timeout in milliseconds (default: 10000)
  --registry <url>           Default registry for entries without a resolved URL
  --local-fallback           Hash node_modules copies when the registry fails
                             (flagged: these are NOT npm tarball hashes)

Pin Options:
  --include-peer             Also pin peerDependencies (off by default)

Audit Options:
  --config <path>            Audit config file (default: discover .npfixrc.json
                             or npfix.config.json in the current directory)
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
  npfix validate
  npfix upgrade --write                    # Lockfile v2 → v3
  npfix fix-checksums --write              # Real integrity hashes from registry
  npfix pin --write                        # Lock down ^/~ versions
  npfix audit                              # Lint with default rules
  npfix audit --strict --format json
  npfix audit --rule pinned-versions:error
  npfix check --check hash                 # Only verify integrity
  npfix restore
  npfix clean-backups --keep 5

Default file: ./package-lock.json
`);
}

function getVersion() {
  try {
    const packageJsonPath = path.join(path.dirname(new URL(import.meta.url).pathname), '../package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    return packageJson.version;
  } catch (e) {
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
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    printHelp();
    return;
  }

  if (argv.includes('-v') || argv.includes('--version')) {
    console.log(`npfix version ${getVersion()}`);
    return;
  }

  const command = argv[0];

  try {
    switch (command) {
      case 'validate': {
        const filePath = getFilePath(argv[1]);
        ensureFileExists(filePath);

        const lockfile = parseLockfile(filePath);
        const result = validatePackageLock(lockfile);

        console.log('\n📋 Validation Result:');
        console.log(JSON.stringify(result, null, 2));

        process.exit(result.valid ? 0 : 1);
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
        const { fixedLockfile, fixes } = fixPackageLock(lockfile);

        console.log('\n✅ Fixer Results:');
        fixes.forEach(fix => console.log(`   • ${fix}`));

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
          // Run hash check
          if (checkType === 'hash' || checkType === 'all') {
            console.log('🔐 Checking integrity hashes...');
            const hashResult = await checkIntegrity(lockfile, options);

            process.stdout.write('\r' + ' '.repeat(80) + '\r');
            console.log(`   Checked: ${hashResult.checked}`);
            console.log(`   ✅ Passed: ${hashResult.passed}`);
            console.log(`   ❌ Failed: ${hashResult.failed}`);
            console.log(`   ⏭️  Skipped: ${hashResult.skipped}`);

            if (hashResult.errors.length > 0) {
              console.log('\n   Failed packages:');
              hashResult.errors.forEach(err => {
                console.log(`     • ${err.package}`);
                if (err.expected && err.actual) {
                  console.log(`       Expected: ${err.expected.slice(0, 50)}...`);
                  console.log(`       Actual:   ${err.actual.slice(0, 50)}...`);
                } else if (err.error) {
                  console.log(`       Error: ${err.error}`);
                }
              });
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
