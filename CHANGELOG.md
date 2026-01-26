# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- **CLI Enhancement**: Renamed CLI command from `cli` to `npfix` with `npfix` alias in npm bin field
- **CLI File Argument**: Made file argument optional, defaults to `./package-lock.json` in current directory
- **CLI Migrate Command**: Target version is now optional and defaults to 3 (latest)
- **CLI Usage**: Updated all CLI examples to reflect simplified command syntax (e.g., `npfix validate` instead of `cli validate package-lock.json`)

## [1.0.0] - 2026-01-26

### Added

#### Core Features
- **Format Library** (`src/format-library.js`): Comprehensive utilities for detecting lockfile versions (v1, v2, v3) and parsing/stringifying lockfiles
- **Validation Engine** (`src/validator.js`): Structural, data, and consistency validation with configurable options
- **Bidirectional Migrator** (`src/migrator.js`): Full support for v1↔v2↔v3 migration paths with automatic path chaining
- **Parser/IO Utilities** (`src/parser.js`): Safe reading and writing of lockfiles with error handling
- **Updater Core** (`src/updater.js`): Integrity hash upgrading (SHA1/SHA256 → SHA512) and package deduplication
- **Automated Fixer** (`src/fixer.js`): Smart fixing strategies with auto-migration, placeholder integrity filling, and deduplication
- **Backup System** (`src/backup.js`): Non-destructive file operations with timestamped backups
  - `createBackup()`: Create ISO-timestamped backups
  - `listBackups()`: List all available backups for a file
  - `restoreFromLatestBackup()`: Restore from the most recent backup
  - `cleanOldBackups()`: Remove backups older than specified days
- **Integrity Generation** (`src/integrity.js`): SHA512 hash generation and validation
  - `generateIntegrityFromData()`: Generate hash from data
  - `generateIntegrityFromFile()`: Generate hash from file path
  - `isValidIntegrity()`: Validate integrity format
  - `isPlaceholder()`: Detect placeholder hashes

#### CLI Interface
- **Enhanced CLI** (`bin/cli.js`): Commands for all core operations
  - `validate`: Validate lockfiles
  - `migrate`: Migrate between versions
  - `upgrade-hashes`: Upgrade integrity hashes
  - `dedupe`: Deduplicate packages
  - `fix`: Apply all automatic fixes
  - `backups`: List available backups
  - `restore`: Restore from latest backup
- **Safe Modifications**: `--write` flag creates automatic backups before file changes
- **Detailed Output**: Fix command shows list of applied fixes

#### Testing
- Comprehensive test suite with 58 tests across 7 test files
- Edge case coverage:
  - Workspace dependencies with proper isolation
  - Git dependencies with hash preservation
  - Optional and peer dependencies handling
  - Bundled package deduplication
  - Empty lockfiles and missing files
  - Custom resolved URLs preservation
  - Migration path chaining (v1→v2→v3)
  - Integrity validation and placeholder detection

#### Development & Quality
- **ESLint Configuration** (`.eslintrc.cjs`): Enforced code quality standards
- **Jest Configuration** (`jest.config.mjs`): ESM-compatible testing framework
- **Babel Configuration** (`.babelrc`): ES6+ transpilation
- **Pre-commit Hooks**: Automatic linting and fast test validation
- **Development Setup** (`setup.js`): Environment configuration script

#### Documentation
- **README.md**: Comprehensive documentation with CLI and API examples
- **Project Plan** (`project_plan.txt`): Implementation roadmap with completed and planned features

### Technical Details

#### Supported Lockfile Versions
- npm package-lock v1
- npm package-lock v2
- npm package-lock v3

#### Key Algorithms
- **Hash Upgrade**: SHA1 → SHA256 → SHA512
- **Deduplication**: Removes redundant package entries while preserving workspace dependencies
- **Migration Chaining**: Automatically routes migrations through intermediate versions
- **Integrity Validation**: Regex-based format validation with SHA512 standard

#### Non-Destructive Design
- All file modifications create timestamped backups in `.backups/` directory
- No automatic deletions without backup recovery options
- Safe defaults for all operations

### Project Structure
```
src/
  ├── backup.js          # File backup utilities
  ├── format-library.js  # Version detection and lockfile format handling
  ├── fixer.js           # Automated fixing strategies
  ├── index.js           # Main API exports
  ├── integrity.js       # SHA512 hashing and validation
  ├── migrator.js        # Version migration logic
  ├── parser.js          # File I/O utilities
  ├── updater.js         # Hash upgrading and deduplication
  └── validator.js       # Lockfile validation
bin/
  └── cli.js             # Command-line interface
tests/
  ├── backup.test.js
  ├── fixer.test.js
  ├── integrity.test.js
  ├── migrator.test.js
  ├── parser.test.js
  ├── updater.test.js
  └── validator.test.js
```

### API Reference

#### Main Functions
```javascript
// Parsing
parseLockfile(filePath) → Object

// Serialization
serializeLockfile(data) → string

// Validation
validatePackageLock(data, options) → Object

// Migration
migrateToVersion(data, targetVersion) → Object

// Fixing
fixPackageLock(data, options) → {fixedLockfile, fixes}

// Utilities
upgradeIntegrityHashes(data) → Object
deduplicatePackages(data, options) → Object
```

#### Backup Operations
```javascript
createBackup(filePath) → string | null
listBackups(fileName) → Array<{name, path, date}>
restoreFromLatestBackup(fileName) → boolean
cleanOldBackups(filePattern, daysOld) → number
```

#### Integrity Operations
```javascript
generateIntegrityFromData(data) → string
generateIntegrityFromFile(filePath) → string | null
isValidIntegrity(integrity) → boolean
isPlaceholder(integrity) → boolean
```

### Dependencies
- **Runtime**: Node.js 14+, no production dependencies
- **Development**:
  - Babel (@babel/core, @babel/preset-env, babel-jest)
  - ESLint (^8.0.0)
  - Jest (^29.0.0)

### Known Limitations
- Requires Node.js 14 or higher
- Lockfile backup directory (`.backups/`) must be writable
- Git dependencies are identified by `resolved` field format

### Future Enhancements (Planned)
- Full Updater features: targeted dependency updates, rollback capability, change diffs
- Backup & rollback system enhancements: compression, retention policies
- Interactive conflict-resolution flow: CLI-driven prompts or small TUI
- Performance improvements for large lockfiles: streaming, memory optimization
- Plugin system for custom validators and migration hooks
- GitHub Actions CI for automated testing and linting

---

For detailed usage examples and API documentation, see [README.md](README.md).
