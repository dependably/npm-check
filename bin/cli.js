#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { parseLockfile, serializeLockfile } from './parser.js';
import { validatePackageLock, validateWithPackageJson } from './index.js';
import { migrateToVersion, upgradeToV3 } from './index.js';

const args = process.argv.slice(2);

if (args.length === 0 || ['-h', '--help'].includes(args[0])) {
  console.log(`Usage: ${path.basename(process.argv[1])} <command> <file> [options]
Commands:
  validate <file>          Validate a package-lock.json
  migrate <file> <v>       Migrate lockfile to version v (1,2,3)
  upgrade-v3 <file>        Upgrade lockfile to v3 if not already
`);
  process.exit(0);
}

const command = args[0];
const file = args[1];
if (!file) {
  console.error('Error: lockfile path required');
  process.exit(1);
}

const lockfile = parseLockfile(file);

switch (command) {
  case 'validate': {
    const result = validatePackageLock(lockfile);
    if (result.valid) {
      console.log('✅ Lockfile is valid');
    } else {
      console.log('❌ Validation failed:');
      console.table(result.errors);
    }
    break;
  }
  case 'validate-with-packagejson': {
    const pkgJsonPath = path.join(process.cwd(), 'package.json');
    if (!fs.existsSync(pkgJsonPath)) {
      console.error('Error: package.json not found');
      process.exit(1);
    }
    const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
    const result = validateWithPackageJson(lockfile, pkgJson);
    if (result.valid) {
      console.log('✅ Lockfile and package.json are consistent');
    } else {
      console.log('❌ Validation failed:');
      console.table(result.errors);
    }
    break;
  }
  case 'migrate': {
    const target = parseInt(args[2], 10);
    if (![1,2,3].includes(target)) {
      console.error('Error: target version must be 1, 2, or 3');
      process.exit(1);
    }
    const migrated = migrateToVersion(lockfile, target, { preserveMetadata: true });
    serializeLockfile(file, migrated, true);
    console.log(`Lockfile migrated to v${target}`);
    break;
  }
  case 'upgrade-v3': {
    const upgraded = upgradeToV3(lockfile, { preserveMetadata: true });
    serializeLockfile(file, upgraded, true);
    console.log('Lockfile upgraded to v3');
    break;
  }
  default:
    console.error(`Unknown command: ${command}`);
    process.exit(1);
}
