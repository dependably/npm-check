# README.md
# Package Lockfile Fixer

A comprehensive tool for validating, migrating, and updating npm `package-lock.json` files across versions 1, 2, and 3.

## Features
- **Validation** – Detects structural, semantic, and integrity issues.
- **Migration** – Seamlessly convert between lockfile versions.
- **Updater** – Upgrade integrity hashes and deduplicate packages.
- **CLI** – Quick command‑line interface for everyday use.

## Installation
```bash
npm install -g package-lock-fixer
```

## Usage
```bash
# Validate a lockfile
npfix validate

# Migrate to latest version (v3)
npfix migrate

# Migrate to a specific version
npfix migrate 2

# Upgrade integrity hashes
npfix upgrade-hashes

# Deduplicate packages
npfix dedupe

# Run automated fixer
npfix fix --write

# Specify custom file path
npfix validate /path/to/package-lock.json
```

## API
```js
import {
  parsePackageLock,
  ````markdown
  # Package Lockfile Fixer

  A comprehensive tool for validating, migrating, fixing, and updating npm `package-lock.json` files across versions 1, 2, and 3.

  ## Features
  - **Validation** – Structural, semantic, and consistency checks (`src/validator.js`).
  - **Migration** – Convert between lockfile versions (`src/migrator.js`).
  - **Fixer** – Automated repair strategies for common issues (`src/fixer.js`).
  - **Updater** – Upgrade integrity hashes and deduplicate packages (`src/updater.js`).
  - **CLI** – Command-line interface: `validate`, `migrate`, `fix`, `upgrade-hashes`, `dedupe`.

  ## Installation
  ```bash
  npm install -g package-lock-fixer
  ```

  ## CLI Usage
The repository includes a lightweight CLI exposed as the `npfix` binary (entry: `bin/cli.js`). Example commands:

```bash
# Validate a lockfile (defaults to ./package-lock.json)
npfix validate

# Migrate to latest version (v3)
npfix migrate

# Migrate to a specific version
npfix migrate 2

# Run automated fixer (adds placeholders for missing integrity, dedupes packages)
npfix fix --write

# Upgrade integrity hashes
npfix upgrade-hashes --write

# Deduplicate packages
npfix dedupe --write

# Specify a custom file path
npfix validate ./path/to/package-lock.json
```

Notes:
- The file argument is optional and defaults to `./package-lock.json` in the current directory.
- The migrate command defaults to version 3 (latest) when no target version is specified.
- The CLI is implemented as an ESM script to match `type: "module"` in `package.json`.
- Aliases: `package-lock-fixer` and `npfix` both point to the same CLI.

  ## Fixer (automated)
  `src/fixer.js` provides `fixPackageLock(lockfile, options)` which applies safe, non-destructive fixes and returns `{ fixedLockfile, fixes }`.

  Example (programmatic):

  ```js
  import { parseLockfile } from './src/parser.js';
  import { fixPackageLock } from './src/fixer.js';

  const lockfile = parseLockfile('package-lock.json');
  const { fixedLockfile, fixes } = fixPackageLock(lockfile, {
    fillMissingIntegrity: true, // add placeholder integrity values when missing
    dedupe: true,               // remove duplicate package entries
    normalizeTo: 2              // optionally migrate to a target lockfile version
  });

  // Persist the fixed lockfile with parse/serialize helpers from `src/parser.js`
  ```

  ## Programmatic API
  Main exports are located in `src/` and include:

  - `parseLockfile(filePath)` — read and parse a lockfile (`src/parser.js`).
  - `validatePackageLock(lockfile, packageJson?, options?)` — validate a lockfile (`src/validator.js`).
  - `migrateToVersion(lockfile, targetVersion)` — migrate between lockfile formats (`src/migrator.js`).
  - `fixPackageLock(lockfile, options)` — automated fixer (`src/fixer.js`).
  - `upgradeIntegrityHashes(lockfile, options)` and `deduplicatePackages(lockfile, options)` — updater utilities (`src/updater.js`).

  ## Development & Tests
  Run the unit tests with:

  ```bash
  npm test
  ```

  There are tests for core modules in `tests/` (migrator, parser, updater, validator, fixer).

  ## Contributing
  Pull requests are welcome. Please run tests and linters before submitting.

  ## License
  MIT

  ````
