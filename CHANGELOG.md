# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.5.0] - 2026-06-19

### Added
- **Known-vulnerability scan** — new `npm-check vuln` command and "Known vulnerabilities" report section. Scans locked packages against the npm registry bulk advisory endpoint (`POST /-/npm/v1/security/advisories/bulk`) straight from the lockfile — no `node_modules`, no `npm audit` subprocess. Per-package registry derivation (private registries work), concurrent fetch pool, `--min-severity` threshold (default high), `--offline` / `--fail-on-unresolved`. New `checkVulnerabilities()` API and `postJson()` helper.
- **Deprecated-package scan** — new `npm-check deprecated` command and "Deprecated packages" report section. Surfaces the same `npm warn deprecated …` notices npm prints during `npm ci`, read from each locked version's registry manifest. Warning by default (`--fail-on-deprecated` for CI); dedupes identical `name@version@registry`. New `checkDeprecations()` API and `fetchPackumentManifest()` helper.
- **Remediator** — new `npm-check remediate` command. Bumps DIRECT deps that are deprecated or vulnerable (≥ `--min-severity`) to the registry `dist-tags.latest` (range operator preserved) and syncs the lockfile root; transitive findings reported as guidance. Lockfile-first (run `npm install` afterward). New `remediateDependencies()` API and `fetchPackument()` / `fetchLatestVersion()` helpers.
- **Config-file validation** — npm-check now validates all three files that govern an install. New `valid-package-json` (error) and `valid-npmrc` (warn) audit rules, "package.json" / ".npmrc (config)" report sections, and a `validate` command that checks lockfile + sibling package.json + project `.npmrc`. `validatePackageJson()` covers name/version validity, dependency-range syntax across all four sections, and field types; `validateNpmrc()` parses ini and forces plaintext auth tokens, `strict-ssl=false`, and disabled `rejectUnauthorized` to hard errors regardless of configured severity.
- **`no-fund` audit rule** (warn) — flags packages carrying `funding` metadata (npm's "N packages are looking for funding" notice). Self-clears when a project `.npmrc` sets `fund=false`.
- **npm v12 readiness** (for the [July 2026 breaking changes](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/) where install scripts, git deps, and remote-URL deps become opt-in):
  - `install-scripts` rule now reconciles with npm v12's package.json `allowScripts` map (pinned `name@version` or name-only entries; `true`/`false`). It flags scripts that are pending approval or explicitly denied — i.e. the ones npm v12 will silently not run — and treats approved ones as clean. The report's Install scripts section shows `N scripts · X allowed · Y blocked` when the project is `allowScripts`-aware.
  - New `no-git-deps` rule (warn): flags git dependencies (need `--allow-git` under npm v12).
  - New `no-remote-deps` rule (warn): flags remote-URL / non-registry tarball dependencies (need `--allow-remote` under npm v12).
  - Report gains **Git dependencies** and **Remote-URL deps** sections. Exported `classifyInstallScripts()`.
- **Unified `report` command** (now the default — bare `npm-check` runs it). Runs every check in one pass — the 9 audit rules + registry integrity verification + license validation — and prints one clean, grouped report: a section summary table (Structure, Integrity, Resolved URLs, Licenses, Install scripts, Pinned versions, Orphans, Unused), then per-section detail, then a totals line. `--format json` for CI. Network/filesystem checks degrade gracefully (`--offline`/`--no-integrity`; licenses auto-skip without `node_modules`/approved-list). New API: `runReport()` / `formatReport()`.

### Changed
- **Package scope renamed** from `@moonlitlabs/npm-check` to `@dependably/npm-check`, aligning the package name with its `dependably.northwardlabs.ca` registry. The CLI command (`npm-check`) is unchanged.
- **`check --check hash` now verifies against the registry** instead of hashing the installed `node_modules` directory. The old approach compared a directory hash to npm's tarball integrity — two incompatible things — producing false-positive mismatches for every package. It now compares each locked `integrity` to the authoritative `dist.integrity` from the registry (base derived per-package from `resolved`, so private registries work), needs no `node_modules`, and reports unreachable/missing entries as `unresolved` (non-failing by default; `--fail-on-unresolved` to fail closed). New flags: `--concurrency`, `--timeout`, `--registry`, `--fail-on-unresolved`. `deriveRegistryBase` moved to `integrity.js` (re-exported from `checksum-fixer.js` for back-compat).
- **Fixer root-sync** — `fixPackageLock(lockfile, { packageJson })` now syncs a stale lockfile top-level + `packages['']` name/version (the report's "Structure & format" errors after a rename / version bump); the `fix` CLI auto-loads the sibling package.json.

### Fixed
- **Destructive dedupe (data loss).** `deduplicatePackages` keyed a map by `name#version`, but real v2/v3 packages-map entries carry no `.name` field (the name lives in the install path) — so it silently dropped **every** dependency, gutting `fix`/`dedupe` output down to the root (e.g. 440 entries → 1). A path-keyed packages map has no safe key-collapse (that is npm hoisting / re-resolution), so the packages map is now preserved; only the legacy v1 dependencies tree is name-deduped. Covered by a regression test.

## [1.4.0] - 2026-06-17

### Changed
- **Rebrand to `npm-check`**: the package, the CLI command, and all docs are now `npm-check`. The previous `package-lock-fixer` and `npfix` binaries are replaced by a single `npm-check` bin. Audit config files are now `.npm-checkrc.json` / `npm-check.config.json` (was `.npfixrc.json` / `npfix.config.json`).

### Added
- **Audit Rule `install-scripts`** (warn, 9 total): flags any dependency whose lockfile entry declares a lifecycle install script (`hasInstallScript` — preinstall/install/postinstall), the most common npm malware vector. Detection is purely static (no execution, no `node_modules` needed). Configurable `allow` list to ratify trusted packages; remediate by allowlisting or installing with `--ignore-scripts`.

## [1.3.0] - 2026-06-10

### Added
- **Prune Command**: New `npm-check prune` — removes orphaned packages from the lockfile, i.e. entries unreachable from the root package or any workspace by following dependency edges with npm's node_modules resolution rules (nested shadowing nearest-first, workspace `link:` targets, peer/optional deps included). Dry-run by default, `--write` with backup.
- **Unused Command**: New `npm-check unused` — flags dependencies declared in package.json that the application's source never imports (heuristic scan of require/import/dynamic-import/re-export specifiers across .js/.ts/etc., skipping node_modules and build output). npm-script mentions and `@types/*` of used packages count as used. Report-only; `--include-dev` and `--json` flags.
- **Audit Rules**: Three new rules (8 total):
  - `lockfile-sync` (error): package.json and the lockfile agree — name/version match, every declared dep present in the root entry with the same range and installed in the packages map, no lockfile-only leftovers.
  - `no-orphan-packages` (warn): no unreachable lockfile entries; suggests `npm-check prune`.
  - `unused-dependencies` (warn): every declared dependency is imported by the application; `includeDev`/`ignore` options.
- **API**: Exported `findOrphanedPackages`, `prunePackages`, `scanUsedPackages`, `findUnusedDependencies`, `specifierToPackageName`, and related error classes.

## [1.2.0] - 2026-06-10

### Added
- **Audit Command**: New `npm-check audit` — an opinionated, configurable linter for package-lock best practices that exits non-zero on failure (for CI gating). Five rules: `lockfile-version`, `valid-structure`, `integrity-hygiene`, `secure-resolved`, `pinned-versions`, each settable to error/warn/off with per-rule options. Config discovered from `.npm-checkrc.json` / `npm-check.config.json` with CLI overrides (`--rule`, `--max-warnings`, `--strict`, `--config`). Stylish and JSON report formats. Exit codes: 0 pass, 1 findings failure, 2 operational error.
- **Fix-Checksums Command**: New `npm-check fix-checksums` — fills missing, placeholder, and sha1 integrity hashes with real `dist.integrity` values fetched from each package's registry (derived per-package from its `resolved` URL, so private registries work). Concurrent fetching with `--concurrency`/`--timeout`, opt-in `--local-fallback` (loudly flagged: directory hashes are not npm tarball hashes). Exits 1 if any hashes remain unresolved.
- **Pin Command**: New `npm-check pin` — rewrites `^`/`~` ranges in package.json to the lockfile-resolved exact versions and syncs the lockfile root entry. Skips complex/git/file/alias ranges with reasons; `--include-peer` opt-in.
- **Upgrade Command**: New `npm-check upgrade` — convenience alias for `migrate 3` with no-op detection when already at v3.
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
