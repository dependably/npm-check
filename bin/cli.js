#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { parseLockfile } = require('../src/parser.js');
const { validatePackageLock } = require('../src/validator.js');
const { migrateToVersion } = require('../src/migrator.js');
const { upgradeIntegrityHashes, deduplicatePackages } = require('../src/updater.js');
const { LOCKFILE_VERSIONS } = require('../src/format-library.js');

const argv = process.argv.slice(2);

function printHelp() {
  console.log(`
Package Lockfile Tool

Usage:
  cli.js <command> [options]

Commands:
  validate <file>          Validate a package-lock.json file
  migrate <file> <target>  Migrate to target lockfile version (1, 2, or 3)
  upgrade-hashes <file>    Upgrade integrity hashes from sha1 to sha256
  dedupe <file>            Deduplicate packages in the lockfile

Examples:
  cli.js validate package-lock.json
  cli.js migrate package-lock.json 3
  cli.js upgrade-hashes package-lock.json
  cli.js dedupe package-lock.json
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

const fileContent = fs.readFileSync(absolutePath, 'utf8');
let lockfile;
try {
  lockfile = parseLockfile(fileContent);
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
    console.log(JSON.stringify(migrated, null, 2));
    break;
  }
  case 'upgrade-hashes': {
    const upgraded = upgradeIntegrityHashes(lockfile);
    console.log(JSON.stringify(upgraded, null, 2));
    break;
  }
  case 'dedupe': {
    const deduped = deduplicatePackages(lockfile);
    console.log(JSON.stringify(deduped, null, 2));
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}
