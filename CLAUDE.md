# Package-Lock Fixer

A comprehensive toolkit for managing, validating, fixing, and migrating npm package-lock.json files across all lockfile versions.

## Overview

This project provides a robust solution for handling package-lock.json files that have become corrupted, inconsistent, or need migration between npm lockfile format versions. It addresses common issues developers face when dealing with lockfile problems in CI/CD pipelines, team collaboration, and npm version upgrades.

## Problem Statement

Package-lock.json files can become problematic in several ways:

- Corrupted structure after merge conflicts
- Inconsistent integrity hashes across duplicate packages
- Missing or invalid metadata (resolved URLs, integrity hashes)
- Format incompatibility when teams use different npm versions
- Bloated files with unnecessary duplicate entries
- Mismatch between package.json and package-lock.json

Manual fixes are error prone and time consuming. This tool automates detection, validation, repair, and migration of lockfiles.

## Project Plan
refer to project_plan.txt for project outline and todo items. Keep tproject_plan.txt up to date when items are completed and contribute to the file if more todo items are needed.

## Core Components

### 1. Format Library (`format-library.js`)

Defines comprehensive schemas and specifications for all three lockfile versions:

**Lockfile Version 1 (npm 5.x - 6.x)**
- Nested dependencies tree structure
- SHA1 integrity hashes
- No workspace support
- Legacy format, deprecated in npm 7+

**Lockfile Version 2 (npm 7.x+)**
- Dual format: both dependencies tree and packages map
- SHA512 integrity hashes
- Workspace support
- Backward compatible transition format

**Lockfile Version 3 (npm 7.x+)**
- Packages map only, flat structure
- SHA512 integrity hashes
- Workspace support
- Modern, recommended format

**Key Functions:**
- `detectLockfileVersion()` - Identifies lockfile format
- `getSchemaForVersion()` - Returns validation schema
- `parsePackagePath()` / `buildPackagePath()` - Path manipulation utilities
- `forEachPackageEntry()` - Iterates the packages map, classifying each entry (root, workspace, link, bundled, git, file)
- `resolvePackageName()` - Real package name for an entry (handles npm: aliases and scopes)

### 2. Validator (`validator.js`)

Comprehensive validation engine that checks:

**Structural Validation:**
- Required fields presence (name, version, lockfileVersion)
- Field type correctness
- Version-appropriate structure (packages vs dependencies)

**Data Validation:**
- Semantic versioning format
- Integrity hash format (SHA1/SHA512 patterns)
- Resolved URL format and accessibility
- Dependency version range syntax

**Consistency Validation:**
- Cross-reference between packages and dependencies tree
- Integrity hash consistency for duplicate packages
- package.json alignment (when provided)
- Workspace configuration validity

**Configuration Options:**
- `strictMode` - Fail on warnings
- `checkIntegrity` - Validate integrity hashes
- `checkResolved` - Validate resolved URLs
- `validateAgainstPackageJson` - Cross-check with package.json
- `allowMissingIntegrity` - Tolerate missing integrity for git deps

**Output:**
- Detailed error messages with paths
- Warning messages for non-critical issues
- Metadata about lockfile format and version
- Actionable fix suggestions

### 3. Migrator (`migrator.js`)

Handles format conversion between all lockfile versions:

**Migration Paths:**
- V1 → V2: Creates packages map from dependencies tree
- V2 → V3: Removes dependencies tree, keeps packages map
- V3 → V2: Reconstructs dependencies tree from packages map
- V2 → V1: Removes packages map, keeps dependencies tree
- Multi-step migrations (V1 → V3 via V2)

**Migration Features:**
- Bidirectional conversion support
- Metadata preservation during migration
- Dependency relationship reconstruction
- Root package extraction and creation

**Additional Utilities:**
- `upgradeIntegrityHashes()` - Convert SHA1 to SHA512
- `deduplicatePackages()` - Remove redundant package entries
- `normalizeToV2()` - Standardize to transition format

**Migration Safety:**
- Validates source format before migration
- Preserves all dependency relationships
- Maintains integrity hashes
- Optional strict mode for lossless migration

## Expected Workflow

### Basic Validation

```javascript
import { validatePackageLock } from './validator.js';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json'));
const result = validatePackageLock(lockfile, {
  strictMode: false,
  checkIntegrity: true
});

if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

### Migration to V3

```javascript
import { upgradeToV3 } from './migrator.js';

const oldLockfile = JSON.parse(fs.readFileSync('package-lock.json'));
const newLockfile = upgradeToV3(oldLockfile);

fs.writeFileSync('package-lock.json', JSON.stringify(newLockfile, null, 2));
```

### Validation Against package.json

```javascript
import { validateWithPackageJson } from './validator.js';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json'));
const packageJson = JSON.parse(fs.readFileSync('package.json'));

const result = validateWithPackageJson(lockfile, packageJson);
```

### 4. Checker (`checker.js`)

Verification engine for package integrity and licenses:

**Integrity Checking:**
- Verify package hashes in `package-lock.json` match actual packages in `node_modules`
- Detect corrupted or modified packages
- Skip packages without integrity hashes gracefully
- Report detailed hash mismatches

**License Validation:**
- Parse and validate SPDX license expressions (OR, AND operators)
- Check licenses against approved CSV list
- Distinguish between rejected, unknown, and approved licenses
- Support strict mode for license enforcement

**Key Functions:**
- `checkIntegrity()` - Verify package hashes
- `checkLicenses()` - Validate package licenses
- `checkAll()` - Run both checks
- `parseLicensesCsv()` - Parse approved licenses file

## Completed Components

### 5. Fixer (`fixer.js`)

Automated repair functionality:

- Auto-correct structural issues
- Regenerate missing integrity hashes
- Fix version mismatches
- Resolve duplicate package conflicts
- Repair broken dependency chains
- Update outdated resolved URLs

### 6. CLI Interface (`bin/cli.js`)

Command-line tool for easy usage:

```bash
npfix validate package-lock.json
npfix migrate 3 package-lock.json
npfix upgrade --write package-lock.json
npfix fix --write package-lock.json
npfix fix-checksums --write package-lock.json
npfix pin --write
npfix audit --strict
npfix dedupe --write package-lock.json
npfix check --check hash package-lock.json
npfix check --check license package-lock.json
npfix upgrade-hashes --write package-lock.json
```

### 7. Updater (`updater.js`)

Dependency update management:

- Upgrade integrity hashes from SHA1 to SHA512
- Deduplicate redundant package entries
- Batch updates with validation
- Change tracking and reporting

### 8. Checksum Fixer (`checksum-fixer.js`)

Fills missing, placeholder, and sha1 integrity hashes with real ones:

- Fetches authoritative `dist.integrity` from each package's registry
- Derives registry base per-package from `resolved` URLs (private registries work)
- Concurrent fetching with configurable pool and timeouts
- Opt-in local node_modules fallback, loudly flagged (directory hashes ≠ npm tarball hashes)
- Skips git/file-dir/link/workspace/bundled deps with reasons; rejects v1 lockfiles

**Key Functions:**
- `fixChecksums()` - Main entry point, returns `{lockfile, changes, unresolved, skipped, warnings, summary}`
- `deriveRegistryBase()` - Registry base from a resolved tarball URL

### 9. Pinner (`pinner.js`)

Removes `^`/`~` from package.json, locking versions down:

- Rewrites caret/tilde ranges to the lockfile-resolved exact versions
- Syncs the lockfile root entry (`packages['']`) so npm sees no drift
- Skips complex/git/file/workspace/alias ranges with reasons
- peerDependencies excluded by default (`includePeer` opt-in)

**Key Functions:**
- `pinVersions()` - Returns `{packageJson, lockfile, changes, skipped, warnings}`
- `classifyRange()` - Classifies a range: exact/caret/tilde/complex/git/file/link/workspace/alias/url

### 10. Audit Engine (`audit.js`, `audit-config.js`)

Opinionated, configurable lockfile linter for CI (non-zero exit on failure):

- Five rules: `lockfile-version`, `valid-structure`, `integrity-hygiene`, `secure-resolved`, `pinned-versions`
- Each rule is `{id, description, defaultSeverity, check(context)}` — extensible
- Severities error/warn/off with per-rule options; `maxWarnings` budget
- Config file discovery (`.npfixrc.json`, `npfix.config.json`) with CLI overrides
- Stylish (ESLint-like) and JSON report formats
- CLI exit codes: 0 pass, 1 findings failure, 2 operational error

**Key Functions:**
- `runAudit()` - Returns `{findings, summary, pass}`
- `formatAuditReport()` - Stylish or JSON rendering
- `loadAuditConfig()` / `mergeConfig()` - Config resolution and validation

## Planned Components

### Future: Advanced Features

- Interactive conflict resolution UI
- Performance optimizations for extremely large files (>100MB)
- Plugin system for custom validators
- Automated package update tool
- Git integration for lockfile diffing

## Use Cases

**CI/CD Pipeline Integration:**
- Validate lockfiles before deployment
- Enforce lockfile version standards across team
- Automated fixing of common issues
- Pre-commit validation hooks

**Team Collaboration:**
- Standardize lockfile format across team members
- Resolve merge conflict artifacts
- Migrate legacy projects to modern formats
- Ensure consistency in monorepo workspaces

**Dependency Management:**
- Audit lockfile health
- Clean up bloated lockfiles
- Update deprecated integrity hash formats
- Verify supply chain integrity

**npm Version Migration:**
- Upgrade projects from npm 6 to npm 7+
- Downgrade for legacy system compatibility
- Test compatibility across npm versions

## Technical Details

**Node.js Version:**
- Requires Node.js 18.0.0 or higher
- Uses native ES modules
- No external dependencies for core functionality

**File Format Support:**
- JSON parsing with error recovery
- Preserves formatting where possible
- UTF-8 encoding standard

**Performance Considerations:**
- Streaming for large lockfiles (planned)
- In-memory operations for typical sizes
- Efficient tree traversal algorithms
- Minimal memory footprint

**Error Handling:**
- Detailed error codes for programmatic handling
- Human-readable error messages
- Path information for precise issue location
- Suggested fixes when possible

## Design Principles

**Reliability:**
- Non-destructive operations by default
- Validation before modification
- Backup creation for file operations
- Rollback support for failed migrations

**Flexibility:**
- Configurable validation strictness
- Pluggable format detection
- Extensible schema definitions
- API-first design with CLI wrapper

**Transparency:**
- Detailed logging of all operations
- Explicit error reporting
- No silent fixes without user consent
- Audit trail for modifications

**Compatibility:**
- Support all npm lockfile versions
- Backward and forward migration
- Handles edge cases and legacy formats
- Works with workspace configurations

## Installation & Usage

```bash
npm install package-lock-fixer

# or for global CLI usage
npm install -g package-lock-fixer
```

**Programmatic Usage:**

```javascript
import {
  validatePackageLock,
  migrateToVersion,
  LOCKFILE_VERSIONS
} from 'package-lock-fixer';

const result = validatePackageLock(lockfileData);
const migrated = migrateToVersion(lockfileData, LOCKFILE_VERSIONS.V3);
```

## Development Status

**Completed:**
- Format library with complete schema definitions
- Full validation engine with configurable options
- Bidirectional migration between all versions
- Path parsing and manipulation utilities
- Automated fixer with repair strategies
- CLI interface with rich output
- Backup and rollback system
- Updater with hash upgrades and deduplication
- Checker with integrity verification and license validation
- Progress reporting with real-time feedback
- Parallel processing for performance
- Streaming parser for large files

**In Progress:**
- Documentation and examples
- Advanced license validation features

**Planned:**
- Interactive conflict resolution UI
- Performance optimizations for extremely large files (>100MB)
- Plugin system for custom validators
- Advanced package update tool
- Git integration for lockfile diffing

## Contributing

This project aims to be the definitive solution for package-lock.json management. Contributions welcome for additional validators, migration strategies, and edge case handling.

## License

MIT