# npm-check

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

### 2. Validator (`validator.js`, `package-json-validator.js`, `npmrc-validator.js`)

npm-check validates all three files that govern an install. The lockfile validator
(`validator.js`) is the comprehensive engine below; `package-json-validator.js`
(`validatePackageJson`) and `npmrc-validator.js` (`parseNpmrc` + `validateNpmrc`) cover the
manifest and the project `.npmrc` with the same `{ valid, errors, warnings, info }` contract,
and are surfaced via the `valid-package-json` / `valid-npmrc` audit rules and the `validate`
CLI command (see the Audit Engine section).

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
- Verify each locked `integrity` against the authoritative `dist.integrity` published by the registry (registry base derived per-package from `resolved`, so private registries work) — detects a tampered/drifted lockfile, and unlike a directory hash this actually matches npm's tarball integrity
- No `node_modules` required; concurrent fetching with configurable pool/timeout
- Skips entries that can't be verified this way (root/workspace/link/git/file/bundled, missing integrity, legacy sha1)
- Registry-unreachable / no-registry-hash entries are reported as `unresolved` and do not fail the run by default (`failOnUnresolved` to fail closed)

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

Automated, **non-destructive** structural repair:

- Fills missing/placeholder integrity hashes
- Auto-migrates a v1 dependencies tree to v2 (or to a requested `normalizeTo` version)
- **Root sync** — when given `package.json`, syncs the lockfile's stale top-level + `packages['']` name/version (the "Structure & format" errors after a rename / version bump). The `fix` CLI auto-loads the sibling package.json for this.
- **Dedupe is preserve-only.** A v2/v3 `packages` map is keyed by install *path*; every entry is a required node (the name is encoded in the path, so most entries have no `.name` field). Collapsing entries that share a name/version drops required install locations and yields an un-installable lockfile — npm's real "dedupe" is tree hoisting, which needs full re-resolution. So `deduplicatePackages`/`fix` **never remove path entries** (use `prune` to drop genuinely orphaned ones). *(Historical bug: the old name#version dedupe silently dropped every nameless entry, gutting real lockfiles down to the root — fixed and covered by regression tests.)*

### 6. CLI Interface (`bin/cli.js`)

Command-line tool for easy usage:

```bash
npm-check                                # full report (all checks) on ./package-lock.json
npm-check report web/package-lock.json   # explicit target
npm-check --offline                      # skip the registry integrity check
npm-check --format json                  # machine-readable report
npm-check validate package-lock.json     # validates lockfile + sibling package.json + .npmrc
npm-check migrate 3 package-lock.json
npm-check upgrade --write package-lock.json
npm-check fix --write package-lock.json
npm-check fix-checksums --write package-lock.json
npm-check pin --write
npm-check prune --write package-lock.json
npm-check unused
npm-check unused --format json           # machine-readable (boolean --json is retired)
npm-check audit --fail-on count=0        # CI gate: any warning fails
npm-check vuln --fail-on severity=critical
npm-check deprecated --fail-on count=0   # fail on any deprecation
npm-check remediate --write              # bump deprecated/vulnerable direct deps, then npm install
npm-check dedupe --write package-lock.json
npm-check check --check hash package-lock.json
npm-check check --check license package-lock.json
npm-check upgrade-hashes --write package-lock.json
```

### 6a. Unified Report (`report.js`)

The default command (bare `npm-check`, or `npm-check report [file]`). Runs **every** check in one pass — the audit rules (lockfile + package.json + .npmrc validation) + registry integrity verification + license validation — and renders one grouped, sectioned report (section summary table, then per-section detail, then a totals line). `--format json` for CI/tooling.

- Sections: Structure & format, package.json, .npmrc (config), Integrity (registry), Known vulnerabilities, Resolved URLs, Licenses, Install scripts, Pinned versions, Orphaned packages, Unused dependencies
- Network/filesystem checks degrade gracefully: integrity → `--offline`/`--no-integrity` to skip; licenses auto-skip when there's no `node_modules` or no approved-licenses CSV
- Exit 0 unless an error-severity finding exists (or the `--fail-on count=`/`severity=` gate trips). The CI gate is the suite-wide repeatable `--fail-on <key>=<value>`: `count=<N>` (warning-count budget; `count=0` == old `--strict`) and `severity=<level>`. The legacy `--strict` / `--max-warnings` / `--min-severity` / `--fail-on-deprecated` flags are thin **deprecated aliases** (still functional, emit a stderr notice). `-v` is **not** a version alias — version is `--version` (long-only).
- **Key Functions:** `runReport()` returns `{filePath, sections, summary}`; `formatReport()` renders pretty or JSON

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

- Rules: `lockfile-version`, `valid-structure`, `valid-package-json`, `integrity-hygiene`, `secure-resolved`, `install-scripts`, `no-git-deps`, `no-remote-deps`, `pinned-versions`, `lockfile-sync`, `no-orphan-packages`, `unused-dependencies`, `no-fund` (flags packages emitting npm funding solicitations unless a project `.npmrc` sets `fund=false`), `valid-npmrc`, `valid-pnpm-workspace`, `valid-pnpm-field`
- **Flavor gating:** each rule carries a `flavors` list (default `['npm']`); `runAudit` derives the lockfile flavor (`detectLockfileFlavor`) and skips rules that don't apply — the npm-lockfile-shape rules no-op on a `pnpm-lock.yaml`, and the pnpm-only rules (`valid-pnpm-workspace`, `valid-pnpm-field`) no-op on npm. The flavor-agnostic config rules (`valid-package-json`, `valid-npmrc`) run for both (and `valid-npmrc` gets the flavor threaded through so it can flag pnpm-ignored keys). See the pnpm support section.
- **Config-file validation** (`valid-package-json`, `valid-npmrc`): npm-check validates all three files that govern an install, not just the lockfile. `valid-package-json` (default `error`) delegates to `validatePackageJson()` — name/version validity, dependency-range syntax across all four sections, scripts/bin/main/exports/workspaces types, license presence (warn), and the `pnpm` field's types (`overrides`/`packageExtensions`/build allowlists/…). `valid-npmrc` (default `warn`) reads the project-level `.npmrc` next to the lockfile and delegates to `validateNpmrc()` — ini syntax, plus security checks where **plaintext auth tokens, `strict-ssl=false`, and disabled `rejectUnauthorized` are always hard errors** regardless of configured severity (insecure `http://` registries and unknown keys are warnings). Both surface as the report's "package.json" / ".npmrc (config)" sections and via the standalone `validate` command.
- **npm v12 readiness** (the three breaking opt-ins): `install-scripts` reconciles with package.json `allowScripts` (pinned `name@version` or name-only) and flags pending/denied scripts; `no-git-deps` and `no-remote-deps` flag deps that will need `--allow-git` / `--allow-remote`. The report's Install scripts section shows `total · allowed · blocked` when the project is `allowScripts`-aware.
- Each rule is `{id, description, defaultSeverity, check(context)}` — extensible
- Severities error/warn/off with per-rule options; `maxWarnings` budget
- Config resolution (suite convention): the shared `.dependably-check` — discovered by walking up to the repo root, or pointed at by `--config <file>` — is the PRIMARY source (npm-check reads its `common` then `npm` sections for `rules`/`maxWarnings`, via `extractSharedAuditSettings`); a tool-local `.npm-checkrc.json` / `npm-check.config.json` in cwd is a FALLBACK that overrides the shared settings; CLI flags override files
- Stylish (ESLint-like) and JSON report formats
- CLI exit codes: 0 pass, 1 findings failure, 2 operational error

**Key Functions:**
- `runAudit()` - Returns `{findings, summary, pass}`
- `formatAuditReport()` - Stylish or JSON rendering
- `loadAuditConfig()` / `mergeConfig()` - Config resolution and validation

### 11. Pruner (`pruner.js`)

Removes orphaned packages — lockfile entries unreachable from the dependency graph:

- Reachability walk from the root package and workspaces using npm's node_modules resolution (nearest-first shadowing)
- Follows dependencies/optionalDependencies/peerDependencies everywhere, devDependencies at roots, and workspace `link:` targets
- v1 unsupported (migrate first); v2 legacy tree left untouched with a warning

**Key Functions:**
- `findOrphanedPackages()` - Returns `{reachable, orphans}`
- `prunePackages()` - Returns `{lockfile, removed, warnings}`

### 12. Usage Scanner (`usage-scanner.js`)

Flags declared dependencies the application never imports (candidates for removal):

- Scans source files for require/import/dynamic-import/re-export specifiers
- npm-script mentions count as used (CLI tools); `@types/foo` used when `foo` is
- Heuristic, report-only — never auto-removes

**Key Functions:**
- `scanUsedPackages()` - Returns `{used: Set, scannedFiles}`
- `findUnusedDependencies()` - Returns `{unused, used, scannedFiles, sectionsChecked}`

### 13. Vuln Scanner (`vuln.js`)

Scans locked packages for known vulnerabilities (complements the integrity check — integrity asks "is the lockfile what it claims to be?", this asks "do the locked versions have published advisories?"):

- Queries the npm registry **bulk advisory endpoint** (`POST {registry}/-/npm/v1/security/advisories/bulk`) directly from the lockfile — no `node_modules`, no `npm audit` subprocess
- Reuses `deriveRegistryBase()` (per-package registry, so private registries work), the concurrent fetch pool, and a `postJson` helper added to `integrity.js`
- Groups requests by registry and batches names per POST (`batchSize`, default 250)
- `minSeverity` threshold (info/low/moderate/high/critical; default high): advisories at/above fail the run as errors, below as warnings
- Skips entries that can't be checked this way (root/workspace/link/git/file/bundled, missing version)
- Registry-unreachable / endpoint-unsupported entries are reported `unresolved` and do not fail by default (`failOnUnresolved` to fail closed); `offline` skips entirely
- Trusts the endpoint's server-side per-version filtering (no `semver` dependency); may slightly over-report when one name is locked at multiple versions
- Surfaced as both the report's "Known vulnerabilities" section and the standalone `vuln` CLI command

**Key Functions:**
- `checkVulnerabilities()` - Returns `{valid, scanned, vulnerable, clean, unresolved, skipped, errors, warnings, unresolvedItems, details}`

### 14. Deprecation Scanner (`deprecation.js`)

Surfaces the same `npm warn deprecated <pkg>@<ver>: <message>` notices npm prints during `npm ci`/`npm install`, read straight from the lockfile (complements the vuln scan — vuln asks "is there a published advisory?", this asks "did the maintainer mark this version deprecated?"):

- Reads each locked version's manifest `deprecated` field from the registry (`GET {registry}/{name}/{version}`) — no `node_modules`, no install
- Reuses `deriveRegistryBase()` (per-package registry, so private registries work) and the concurrent fetch pool via a `fetchPackumentManifest()` helper added to `integrity.js`
- Dedupes identical `name@version@registry` so each unique version is fetched once and attributed to every lockfile path that shares it
- Soft signal: deprecated entries are **warnings by default** (npm itself never fails an install on deprecation); `failOnDeprecated` promotes them to errors for CI
- Skips entries that can't be checked this way (root/workspace/link/git/file/bundled, missing version)
- Registry-unreachable / version-not-found entries are reported `unresolved` and do not fail by default (`failOnUnresolved` to fail closed); `offline` skips entirely
- Surfaced as both the report's "Deprecated packages" section and the standalone `deprecated` CLI command

**Key Functions:**
- `checkDeprecations()` - Returns `{valid, scanned, deprecated, clean, unresolved, skipped, errors, warnings, unresolvedItems, details}`

### 15. Remediator (`remediate.js`)

Turns the deprecated/vulnerable *findings* into *action* — the write counterpart to the detection scanners:

- Reuses `checkDeprecations()` + `checkVulnerabilities()` to flag package names (deprecated, or an advisory at/above `minSeverity`), then **bumps the flagged DIRECT dependencies** in package.json to the registry's `dist-tags.latest`, preserving the range operator (exact stays exact, `^`/`~` preserved), and syncs the lockfile root entry
- **Scope is deliberate:** npm-check is lockfile-first and does not re-resolve the graph — that's `npm install`'s job. So it edits package.json ranges + the lockfile root only; the caller runs `npm install` afterward to materialize the tree. Transitive findings (a flagged package that isn't a direct dep) are reported as **guidance** (bump the parent or add an npm `override`), not auto-written
- Skips complex/git/file/url/alias ranges with a reason; warns when a dep is already at latest yet still flagged (`latest-still-affected`) or the registry is unreachable
- Uses `fetchLatestVersion()`/`fetchPackument()` helpers added to `integrity.js`
- Surfaced as the standalone `remediate` CLI command (`--write` to apply, `--fail-on severity=<level>`, `--no-deprecated`)

**Key Functions:**
- `remediateDependencies(lockfile, packageJson, options)` - Returns `{packageJson, lockfile, bumped, guidance, skipped, warnings, changed}`

### 16. pnpm support (`pnpm-format.js`, `pnpm-workspace-validator.js`)

npm-check reads **pnpm projects** for the read-only checks + config validation. pnpm's model differs from npm's: `pnpm-lock.yaml` is YAML (`lockfileVersion` is a string like `'9.0'`), keyed by `name@version` with `resolution.integrity` and **no `resolved` URL** (the registry is implied by config), and most settings have moved off `.npmrc` into `pnpm-workspace.yaml` / the package.json `pnpm` field.

The whole toolkit couples to the lockfile shape through **two seams**, both made flavor-aware:
- **Iteration** — `forEachPackageEntry()` dispatches on `detectLockfileFlavor()` (string `lockfileVersion` / `importers` / `snapshots` → pnpm) to the npm walker or `forEachPnpmPackageEntry()`. Both emit the same callback shape plus a precomputed `registryBase` and normalized `node`, so the integrity / vuln / deprecation checkers iterate npm and pnpm uniformly.
- **Registry** — pnpm has no `resolved` URL, so `resolvePnpmRegistryBase()` derives the per-package registry from the sibling `.npmrc` (scoped `@scope:registry` → `registry` → default). The parser stamps a **non-enumerable** `lockfile.__npmCheckMeta` (`{ flavor, lockfileVersion, registry, scopedRegistries }`) so this config rides along without leaking into JSON output.

**Parsing:** `pnpm-lock.yaml` (any `*.yaml`/`*.yml` lockfile) is parsed via the **lazy `yaml` dependency** (`createRequire`, loaded only on the pnpm path — the npm path stays zero-dep). pnpm depPaths strip peer suffixes (`foo@1.0.0(react@18.0.0)` → `foo@1.0.0`).

**What works for pnpm:** the registry-backed read-only checks (`report` / integrity / `vuln` / `deprecated`) and config validation. The report runs only the applicable sections — integrity/vuln/deprecated + the config sections (package.json, .npmrc, **pnpm (workspace + manifest)**); the npm-lockfile-shape sections render `N/A (pnpm)` (and `pnpm-config` is `N/A (npm)` on an npm lockfile).

**Config validation (Phase 2):** `validateNpmrc(content, { flavor: 'pnpm' })` flags non-auth keys pnpm silently ignores (`NPMRC_PNPM_IGNORED`, warn) while keeping the security codes as hard errors; `validatePackageJson` type-checks the `pnpm` field; `validatePnpmWorkspace()` (in `pnpm-workspace-validator.js`) validates `pnpm-workspace.yaml`. Surfaced via the `valid-pnpm-workspace` / `valid-pnpm-field` audit rules and the flavor-aware `validate` command.

**Out of scope:** the write/transform commands (`migrate`, `fix`, `fix-checksums`, `upgrade`, `dedupe`, `prune`, `pin`) **refuse pnpm** — `pnpm-lock.yaml` is machine-generated; regenerate with `pnpm install`. License verification for pnpm (needs a `.pnpm` store walk), remediate/pinner for pnpm, and usage-scanning from `importers` are future (Phase 3).

**Key Functions:** `detectLockfileFlavor()`, `forEachPnpmPackageEntry()`, `resolvePnpmRegistryBase()`, `parsePnpmDepPath()` (pnpm-format.js); `validatePnpmWorkspace()` / `parsePnpmWorkspace()` (pnpm-workspace-validator.js)

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
- Zero external dependencies for the npm core path; pnpm support pulls one audited YAML parser
  (`yaml`), loaded lazily (createRequire) only when a `pnpm-lock.yaml` is actually parsed — npm-only
  usage never loads it

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
npm install npm-check

# or for global CLI usage
npm install -g npm-check
```

**Programmatic Usage:**

```javascript
import {
  validatePackageLock,
  migrateToVersion,
  LOCKFILE_VERSIONS
} from 'npm-check';

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