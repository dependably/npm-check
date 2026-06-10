# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.3.0] - 2026-06-10

### Added
- **Prune Command**: New `npfix prune` — removes orphaned packages from the lockfile, i.e. entries unreachable from the root package or any workspace by following dependency edges with npm's node_modules resolution rules (nested shadowing nearest-first, workspace `link:` targets, peer/optional deps included). Dry-run by default, `--write` with backup.
- **Unused Command**: New `npfix unused` — flags dependencies declared in package.json that the application's source never imports (heuristic scan of require/import/dynamic-import/re-export specifiers across .js/.ts/etc., skipping node_modules and build output). npm-script mentions and `@types/*` of used packages count as used. Report-only; `--include-dev` and `--json` flags.
- **Audit Rules**: Three new rules (8 total):
  - `lockfile-sync` (error): package.json and the lockfile agree — name/version match, every declared dep present in the root entry with the same range and installed in the packages map, no lockfile-only leftovers.
  - `no-orphan-packages` (warn): no unreachable lockfile entries; suggests `npfix prune`.
  - `unused-dependencies` (warn): every declared dependency is imported by the application; `includeDev`/`ignore` options.
- **API**: Exported `findOrphanedPackages`, `prunePackages`, `scanUsedPackages`, `findUnusedDependencies`, `specifierToPackageName`, and related error classes.

## [1.2.0] - 2026-06-10

### Added
- **Audit Command**: New `npfix audit` — an opinionated, configurable linter for package-lock best practices that exits non-zero on failure (for CI gating). Five rules: `lockfile-version`, `valid-structure`, `integrity-hygiene`, `secure-resolved`, `pinned-versions`, each settable to error/warn/off with per-rule options. Config discovered from `.npfixrc.json` / `npfix.config.json` with CLI overrides (`--rule`, `--max-warnings`, `--strict`, `--config`). Stylish and JSON report formats. Exit codes: 0 pass, 1 findings failure, 2 operational error.
- **Fix-Checksums Command**: New `npfix fix-checksums` — fills missing, placeholder, and sha1 integrity hashes with real `dist.integrity` values fetched from each package's registry (derived per-package from its `resolved` URL, so private registries work). Concurrent fetching with `--concurrency`/`--timeout`, opt-in `--local-fallback` (loudly flagged: directory hashes are not npm tarball hashes). Exits 1 if any hashes remain unresolved.
- **Pin Command**: New `npfix pin` — rewrites `^`/`~` ranges in package.json to the lockfile-resolved exact versions and syncs the lockfile root entry. Skips complex/git/file/alias ranges with reasons; `--include-peer` opt-in.
- **Upgrade Command**: New `npfix upgrade` — convenience alias for `migrate 3` with no-op detection when already at v3.
- **API**: Exported `fixChecksums`, `deriveRegistryBase`, `pinVersions`, `classifyRange`, `runAudit`, `formatAuditReport`, `auditRules`, `loadAuditConfig`, `mergeConfig`, `fetchPackumentIntegrity`, `forEachPackageEntry`, `hashPackageDirectory`, and related error classes.
- **Registry Client Hardening**: `fetchPackumentIntegrity` checks HTTP status, supports timeouts, custom registry bases, scoped-name encoding, and distinguishes 404 (resolves null) from network failure (rejects).

### Fixed
- **Binary File Hashing**: `generateIntegrityFromFile` now hashes raw bytes instead of utf8-decoded text, which corrupted hashes of binary files (e.g. tarballs).
- **Validator vs Real Lockfiles**: `validatePackageLock` no longer requires `name` on non-root packages-map entries, no longer requires `version` on `link: true` entries, and accepts version-range strings in packages-map dependency fields — matching what npm actually writes.

## [1.1.0] - 2026-02-17

### Fixed
- **Integrity Hash Upgrade**: Fixed `upgradeIntegrityHashes` to correctly upgrade SHA1 hashes to SHA512 (was incorrectly using SHA256)
- **Root Package Integrity**: Fixed fixer incorrectly adding integrity field to root package entry `packages['']`
- **CSV Header Detection**: Fixed `parseLicensesCsv` that was always skipping the first license entry; now detects headers via SPDX pattern
- **Workspace Package Licensing**: Fixed workspace packages (with `link: true` or outside `node_modules/`) being incorrectly rejected during license checks
- **Missing package.json Handling**: Fixed missing `package.json` in packages treated as license rejection instead of unknown (now unknown in non-strict mode)

### Added
- **Strict Mode Validation**: Implemented `strictMode` option in validator to treat warnings as validation errors
- **Resolved URL Validation**: Added validation for `resolved` field to warn on invalid URL schemes (must start with https://, http://, git+, git://, or file:)
- **Extended Package.json Validation**: `validateAgainstPackageJson` now checks `devDependencies` and `optionalDependencies` in addition to `dependencies`
- **SPDX Parentheses Support**: Added support for parenthesized SPDX expressions like `(MIT OR Apache-2.0)`
- **CLI Version Flag**: Added `--version` / `-v` flag to display version information
- **Clean Backups Command**: Added `clean-backups` CLI command with optional `--keep N` parameter to remove old backups
- **Public API Exports**: Exported backup functions and integrity utilities from main `src/index.js` for public API access
- **Comprehensive Test Expansion**:
  - Parser tests: added tests for missing files, invalid JSON, serialization overwrite protection, and progress callbacks
  - Migrator tests: added V3→V1 rejection, content-correctness validation, and workspace survival across migrations
  - Fixer tests: added normalizeTo option, throwOnError behavior, empty fixes validation, and root package exclusion
  - Checker tests: added headerless CSV support, workspace link skipping, missing package.json as unknown, and parenthesized SPDX matching
  - Validator tests: added strictMode behavior, resolved URL warnings, and devDep/optDep detection
- **Code Coverage Configuration**: Added `collectCoverageFrom` and `coverageThresholds` to Jest config; added `test:coverage` npm script

### Changed
- **CLI Help Text**: Updated `upgrade-hashes` command description from `sha1→sha256` to `sha1→sha512`
- **Documentation**: Moved streaming parser, parallel processing, and progress reporting from "Future" to "Implemented" features in `src/readme.md`

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
