# Package Lock Fixer

## Overview
This repository bundles three npm‑centric libraries that help developers work with `package-lock.json` files:

1. **`package-lock-validator`** – Validates the structure, top‑level fields, integrity hashes, resolved URLs, and consistency of a lockfile against the three npm lockfile formats.
2. **`package-lock-migrator`** – Provides bidirectional migration between lockfile versions 1, 2, and 3, deduplication, integrity‑hash upgrades, and metadata preservation.
3. **`package-lock-format-library`** – Exposes constants, JSON schemas, and helper utilities for parsing and building package paths.

All three packages share a common API surface defined in `formats.js`.

## Architecture
The repo is split into three publish‑able modules that can be installed independently:

- `package-lock-validator` exposes `PackageLockValidator`, `validatePackageLock`, and `validateWithPackageJson`.
- `package-lock-migrator` exposes `PackageLockMigrator`, `migrateToVersion`, `upgradeToV3`, `downgradeToV1`, and `normalizeToV2`.
- `package-lock-format-library` provides constants and helper functions (`detectLockfileVersion`, `getSchemaForVersion`, `parsePackagePath`, etc.).

The top‑level `lockfix` CLI (defined in `bin/cli.js`) stitches them together to offer commands like `lockfix validate`, `lockfix migrate`, and `lockfix upgrade`.

## Installation
```bash
npm install -g ./package-lock-fixer
# or
npm i ./package-lock-fixer
```

## CLI Usage
```
# Validate a lockfile
lockfix validate <path-to-lockfile> [--strict]

# Migrate to a target npm version
lockfix migrate <path-to-lockfile> <target-version> [--dedupe] [--upgrade-integrity]

# Run all tests in the validator
node --test package-lock-validator/test.js
```

## Testing
All unit tests are located in the `tests/` directory and can be executed with:
```
npm test
```
The test harness uses Node.js native test runner (`node --test`).

## Contributing
We welcome contributions! Please follow these guidelines:
1. Fork the repository.
2. Create a feature branch.
3. Write unit tests for your changes.
4. Submit a pull request.

## License
MIT © 2024
