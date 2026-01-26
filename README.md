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
cli validate package-lock.json

# Migrate to v3
cli migrate package-lock.json 3

# Upgrade integrity hashes
cli upgrade-hashes package-lock.json

# Deduplicate packages
cli dedupe package-lock.json
```

## API
```js
import {
  parsePackageLock,
  validatePackageLock,
  migrateToVersion,
  upgradeIntegrityHashes,
  deduplicatePackages
} from 'package-lock-fixer';
```

## Contributing
Pull requests are welcome! Please run the test suite before submitting.

## License
MIT
