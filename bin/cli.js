#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { parseLockfile } from '../src/parser.js';
import { validatePackageLock } from '../src/validator.js';
import { migrateToVersion } from '../src/migrator.js';
import { upgradeIntegrityHashes, deduplicatePackages } from '../src/updater.js';
import { fixPackageLock } from '../src/fixer.js';
import { createBackup, listBackups, restoreFromLatestBackup, cleanOldBackups } from '../src/backup.js';

const argv = process.argv.slice(2);

function printHelp() {
  console.log(`
Package Lockfile Tool

Usage:
  cli.js <command> [options]

Commands:
  validate <file>            Validate a package-lock.json file
  migrate <file> <target>    Migrate to target lockfile version (1, 2, or 3)
  upgrade-hashes <file>      Upgrade integrity hashes from sha1 to sha256
  dedupe <file>              Deduplicate packages in the lockfile
  fix <file> [--write]       Run automated fixer (optionally write changes)
  backups <file>             List all backups for a file
  restore <file>             Restore file from latest backup

Options:
  --write                    Write changes to file (creates backup first)
  -h, --help                 Show this help

Examples:
  cli.js validate package-lock.json
  cli.js migrate package-lock.json 3
  cli.js fix package-lock.json --write
  cli.js backups package-lock.json
  cli.js restore package-lock.json
`);
}

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printHelp();
  process.exit(0);
}

const command = argv[0];
const filePath = argv[1];

if (!filePath) {
  console.error('Error: No file specified.');
  process.exit(1);
}

const absolutePath = path.resolve(filePath);
if (!fs.existsSync(absolutePath)) {
  console.error(`Error: File not found: ${absolutePath}`);
  process.exit(1);
}

let lockfile;
try {
  lockfile = parseLockfile(absolutePath);
} catch (e) {
  console.error('Error parsing lockfile:', e.message);
  process.exit(1);
}

switch (command) {
  case 'validate': {
    const result = validatePackageLock(lockfile);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.valid ? 0 : 1);
    break;
  }
  case 'migrate': {
    const target = parseInt(argv[2], 10);
    if (![1, 2, 3].includes(target)) {
      console.error('Error: Target version must be 1, 2, or 3.');
      process.exit(1);
    }
    const migrated = migrateToVersion(lockfile, target);
    if (argv[3] === '--write') {
      createBackup(absolutePath);
      try {
        fs.writeFileSync(absolutePath, JSON.stringify(migrated, null, 2) + '\n', 'utf8');
        console.log(`✓ Migrated and written to ${absolutePath}`);
      } catch (e) {
        console.error(`Error writing file: ${e.message}`);
        process.exit(1);
      }
    } else {
      console.log(JSON.stringify(migrated, null, 2));
    }
    break;
  }
  case 'upgrade-hashes': {
    const upgraded = upgradeIntegrityHashes(lockfile);
    if (argv[2] === '--write') {
      createBackup(absolutePath);
      try {
        fs.writeFileSync(absolutePath, JSON.stringify(upgraded, null, 2) + '\n', 'utf8');
        console.log(`✓ Upgraded hashes and written to ${absolutePath}`);
      } catch (e) {
        console.error(`Error writing file: ${e.message}`);
        process.exit(1);
      }
    } else {
      console.log(JSON.stringify(upgraded, null, 2));
    }
    break;
  }
  case 'fix': {
    const writeMode = argv[2] === '--write';
    const result = fixPackageLock(lockfile, { fillMissingIntegrity: true, dedupe: true });

    console.log(`\nFix Results:`);
    result.fixes.forEach(fix => console.log(`  • ${fix}`));

    if (writeMode) {
      const backupPath = createBackup(absolutePath);
      console.log(`\nBackup created: ${backupPath}`);

      try {
        fs.writeFileSync(absolutePath, JSON.stringify(result.fixedLockfile, null, 2) + '\n', 'utf8');
        console.log(`✓ Fixed lockfile written to ${absolutePath}`);
        cleanOldBackups(path.basename(absolutePath), 5);
      } catch (e) {
        console.error(`Error writing file: ${e.message}`);
        process.exit(1);
      }
    } else {
      console.log('\nUse --write flag to write changes to the file');
    }
    break;
  }
  case 'dedupe': {
    const deduped = deduplicatePackages(lockfile);
    if (argv[2] === '--write') {
      createBackup(absolutePath);
      try {
        fs.writeFileSync(absolutePath, JSON.stringify(deduped, null, 2) + '\n', 'utf8');
        console.log(`✓ Deduplicated and written to ${absolutePath}`);
      } catch (e) {
        console.error(`Error writing file: ${e.message}`);
        process.exit(1);
      }
    } else {
      console.log(JSON.stringify(deduped, null, 2));
    }
    break;
  }
  case 'backups': {
    const backups = listBackups(path.basename(absolutePath));
    if (backups.length === 0) {
      console.log(`No backups found for ${path.basename(absolutePath)}`);
    } else {
      console.log(`\nBackups for ${path.basename(absolutePath)}:`);
      backups.forEach((backup, index) => {
        const date = new Date(backup.created).toISOString();
        console.log(`  ${index + 1}. ${backup.name} (${date})`);
      });
    }
    break;
  }
  case 'restore': {
    if (restoreFromLatestBackup(absolutePath)) {
      console.log(`✓ File restored successfully`);
    } else {
      console.error(`Failed to restore file`);
      process.exit(1);
    }
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
