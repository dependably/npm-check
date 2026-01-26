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
  npfix <command> [file] [options]

Commands:
  validate [file]            Validate a package-lock.json file (defaults to ./package-lock.json)
  migrate [file] [target]    Migrate to target lockfile version (1, 2, or 3; defaults to 3)
  upgrade-hashes [file]      Upgrade integrity hashes from sha1 to sha256
  dedupe [file]              Deduplicate packages in the lockfile
  fix [file] [--write]       Run automated fixer (optionally write changes)
  backups [file]             List all backups for a file
  restore [file]             Restore file from latest backup

Options:
  --write                    Write changes to file (creates backup first)
  -h, --help                 Show this help

Examples:
  npfix validate
  npfix migrate
  npfix migrate 2
  npfix fix --write
  npfix backups
  npfix restore
  npfix validate /path/to/package-lock.json
`);
}

if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
  printHelp();
  process.exit(0);
}

const command = argv[0];
let filePath = argv[1];

// Determine if argv[1] is a file or an option flag
// If argv[1] is missing or starts with --, use default
if (!filePath || filePath.startsWith('--')) {
  filePath = 'package-lock.json';
} else if (filePath.match(/^-/)) {
  // It's a flag, not a file; use default
  filePath = 'package-lock.json';
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
    // argv[1] might be a file, a target number, or --write flag (if no file specified)
    // argv[2] might be a target number or --write flag (if file was specified)
    let target;
    let writeIndex;

    if (argv[1] === filePath) {
      // File was explicitly provided: migrate <file> [target] [--write]
      target = argv[2] ? parseInt(argv[2], 10) : 3; // Default to 3
      writeIndex = 3;
    } else if (isNaN(parseInt(argv[1], 10))) {
      // argv[1] is not a number, so no target specified: migrate [--write]
      target = 3; // Default to 3
      writeIndex = 1;
    } else {
      // argv[1] is the target: migrate <target> [--write]
      target = parseInt(argv[1], 10);
      writeIndex = 2;
    }

    if (![1, 2, 3].includes(target)) {
      console.error('Error: Target version must be 1, 2, or 3.');
      process.exit(1);
    }
    const migrated = migrateToVersion(lockfile, target);
    if (argv[writeIndex] === '--write') {
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
    // argv[1] might be a file or --write flag (if no file specified)
    let writeIndex = 2;
    if (argv[1] === filePath) {
      // File was explicitly provided: upgrade-hashes <file> [--write]
      writeIndex = 2;
    } else {
      // No file, so argv[1] might be the flag: upgrade-hashes [--write]
      writeIndex = 1;
    }

    const upgraded = upgradeIntegrityHashes(lockfile);
    if (argv[writeIndex] === '--write') {
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
    // argv[1] might be a file or --write flag (if no file specified)
    let writeIndex = 2;
    if (argv[1] === filePath) {
      // File was explicitly provided: fix <file> [--write]
      writeIndex = 2;
    } else {
      // No file, so argv[1] might be the flag: fix [--write]
      writeIndex = 1;
    }

    const writeMode = argv[writeIndex] === '--write';
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
    // argv[1] might be a file or --write flag (if no file specified)
    let writeIndex = 2;
    if (argv[1] === filePath) {
      // File was explicitly provided: dedupe <file> [--write]
      writeIndex = 2;
    } else {
      // No file, so argv[1] might be the flag: dedupe [--write]
      writeIndex = 1;
    }

    const deduped = deduplicatePackages(lockfile);
    if (argv[writeIndex] === '--write') {
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
