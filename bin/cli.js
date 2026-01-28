#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { parseLockfile } from '../src/parser.js';
import { validatePackageLock } from '../src/validator.js';
import { migrateToVersion } from '../src/migrator.js';
import { upgradeIntegrityHashes, deduplicatePackages } from '../src/updater.js';
import { fixPackageLock } from '../src/fixer.js';
import { createBackup, listBackups, restoreFromLatestBackup, BackupError } from '../src/backup.js';
import { createProgressBar } from '../src/progress-reporter.js';
import { checkIntegrity, checkLicenses } from '../src/checker.js';

const argv = process.argv.slice(2);

function printHelp() {
  console.log(`
Package Lockfile Tool (npfix)

Usage:
  npfix <command> [file] [options]

Commands:
  validate [file]            Validate a package-lock.json file
  migrate [file] [target]    Migrate to target version (1, 2, or 3; default: 3)
  upgrade-hashes [file]      Upgrade integrity hashes sha1→sha256
  dedupe [file]              Deduplicate packages in lockfile
  fix [file] [--write]       Run automated fixer with optional write
  check [file]               Verify integrity hashes and licenses
  backups [file]             List all backups for a file
  restore [file]             Restore from latest backup

Check Options:
  --check hash               Only verify integrity checksums
  --check license            Only verify licenses against approved list
  --check all                Run both checks (default)
  --licenses-csv <path>      Path to approved licenses CSV
  --strict                   Treat warnings as errors

General Options:
  --write                    Write changes to file (creates backup)
  -h, --help                 Show this help

Examples:
  npfix validate
  npfix validate ./custom-lock.json
  npfix migrate 3 --write
  npfix fix --write
  npfix check                              # Run all checks
  npfix check --check hash                 # Only verify integrity
  npfix check --check license              # Only check licenses
  npfix check --licenses-csv ./my-list.csv # Use custom CSV
  npfix restore

Default file: ./package-lock.json
`);
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
