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
- `detectLockfileFlavor()` - npm vs pnpm
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
- `deduplicatePackages()` - Preserve-only for the v2/v3 packages map (never drops path-keyed entries); reports what real hoisting would need. See the Fixer note below.
- `findDuplicatePackages()` / `countUniquePackages()` - Identify duplicate name@versions and count unique packages

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
const result = validatePackageLock(lockfile);

if (!result.valid) {
  console.error('Validation errors:', result.errors);
}
```

### Migration to V3

```javascript
import { migrateToVersion, LOCKFILE_VERSIONS } from './index.js';

const oldLockfile = JSON.parse(fs.readFileSync('package-lock.json'));
const newLockfile = migrateToVersion(oldLockfile, LOCKFILE_VERSIONS.V3);

fs.writeFileSync('package-lock.json', JSON.stringify(newLockfile, null, 2));
```

### Validation Against package.json

```javascript
import { validatePackageLock } from './validator.js';

const lockfile = JSON.parse(fs.readFileSync('package-lock.json'));
const packageJson = JSON.parse(fs.readFileSync('package.json'));

const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });
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
- Reads each package's license from its installed `package.json`, falling back to the lockfile entry's own `license` field when the package isn't on disk (a partial `node_modules`) — so the check stays lockfile-first (like integrity/vuln/deprecated) instead of reporting `UNKNOWN` for every uninstalled entry the lockfile already describes

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

- Sections: Structure & format, package.json, .npmrc (config), Integrity (registry), Known vulnerabilities, Deprecated packages, Unresolved (could not check), Resolved URLs, Licenses, Install scripts, Pinned versions, Orphaned packages, Unused dependencies
- Network/filesystem checks degrade gracefully: integrity → `--offline`/`--no-integrity` to skip; licenses auto-skip when there's no `node_modules` or no approved-licenses CSV
- Exit 0 unless an error-severity finding exists (or the `--fail-on count=`/`severity=` gate trips). The CI gate is the suite-wide repeatable `--fail-on <key>=<value>`: `count=<N>` (warning-count budget; `count=0` == old `--strict`) and `severity=<level>`. The legacy `--strict` / `--max-warnings` / `--min-severity` / `--fail-on-deprecated` flags are thin **deprecated aliases** (still functional, emit a stderr notice). `-v` is **not** a version alias — version is `--version` (long-only).
- **Integrity summary/detail reconciliation:** `checkIntegrity()` fails closed by folding an unresolved entry into both `unresolvedItems` and `errors`/`failed`, so the raw `failed` count can't be used directly as "genuine mismatches" without double-counting a package as both "mismatched" and "unresolved". `integrityMismatches()` (report.js) filters `errors` against a `Set` of `unresolvedItems` (same object references) to recover the true mismatch count; the summary's "mismatched" bit and each `mismatched:`/`unresolved:`-prefixed detail line both derive from it, so the detail count always equals the summary's non-verified sum.
- **Resolved URLs / Remote-URL deps dedup:** `secure-resolved` and `no-remote-deps` are independently valid audit rules that both flag a package resolved from an untrusted/unrecognized host — for a private registry mirror, every package resolved from it trips both, reporting one root cause twice. `dedupeRemoteFindings()` cross-references the two sections by packagePath and collapses "Remote-URL deps" duplicates into one grouped-by-host finding; `--verbose` (`verbose: true`) opts back into the full per-package listing.
- **Progress output:** registry-backed stages report via `onProgress`; the CLI's `makeProgressReporter()` (bin/cli.js, backed by `formatCliProgressUpdate()` in progress-reporter.js) writes to stderr — an animated `\r` bar on a real TTY, periodic one-line milestones (0/25/50/75/100%) when stdout is not a TTY, so a piped/CI run's log isn't flooded with redraw frames.
- **Unresolved (could not check) — moonlitlabs/npm-check#35:** entries the integrity/vuln/deprecation scans couldn't check at all (registry unreachable, endpoint unsupported, …) are a *scan-completeness* signal distinct from what each scan actually *found*, so they no longer live inside "Integrity (registry)" / "Known vulnerabilities" / "Deprecated packages" (previously landing in whichever section happened to own the last-run scan). `collectUnresolvedFindings()` buckets them into one shared section instead, each tagged `check: 'integrity'|'vuln'|'deprecated'` (+ the schema `category` that section would have had), with a summary that breaks the total down by check. A section like "Known vulnerabilities" or "Integrity (registry)" can therefore report `pass`/`ok` even while the registry was unreachable — the failure still rolls up into `report.summary`/exit code via the Unresolved section's own severity (errors by default, `failOnUnresolved:false` downgrades to warnings).
- **Same-unit summary/header + fixed status vocabulary — moonlitlabs/npm-check#35:** the vuln section's summary and detail-header count now agree on unit (`N vulnerable packages (M advisories)` / `M advisories in N packages` — a package can carry more than one advisory, so the two used to read as different numbers with no unit label). Every section's status-table row also uses one fixed vocabulary — `ok` / `N warnings` / `N errors` / `skipped` (`statusLabel()`) — with one glyph per state (`✓`/`⚠`/`✖`/`·`, `STATUS_ICON`) instead of each check inventing its own phrasing; the check-specific detail (`valid`, `all TLS / trusted`, `--offline`, …) still follows in a trailing parenthetical.
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
- Also pins the npm **`overrides`** field (nested form, via `walkOverrides()` in `overrides.js`) — a floating `^` in `overrides` otherwise silently defeats an otherwise-pinned manifest. `$`-references and non-caret/tilde forms are left alone; `overrides` isn't mirrored into `packages['']`, so no root-sync there. `pnpm.overrides` is **not** auto-pinned (pin refuses pnpm lockfiles), only flagged by the audit rule.

**Key Functions:**
- `pinVersions()` - Returns `{packageJson, lockfile, changes, skipped, warnings}`
- `classifyRange()` - Classifies a range: exact/caret/tilde/complex/git/file/link/workspace/alias/url
- `walkOverrides()` (`overrides.js`) - Shared generator yielding each range leaf of an npm `overrides`/`pnpm.overrides` object (descends the nested `.`/child form, skips `$`-references); reused by the pinner, the `pinned-versions` audit rule, and the package.json validator

### 10. Audit Engine (`audit.js`, `audit-config.js`)

Opinionated, configurable lockfile linter for CI (non-zero exit on failure):

- Rules: `lockfile-version`, `valid-structure`, `valid-package-json`, `integrity-hygiene`, `secure-resolved`, `install-scripts`, `no-git-deps`, `no-remote-deps`, `pinned-versions`, `lockfile-sync`, `no-orphan-packages`, `unused-dependencies`, `resolved-registry-pin`, `min-release-age`, `no-fund` (flags packages emitting npm funding solicitations unless a project `.npmrc` sets `fund=false`), `valid-npmrc`, `valid-pnpm-workspace`, `valid-pnpm-field`
- **Flavor gating:** each rule carries a `flavors` list (default `['npm']`); `runAudit` derives the lockfile flavor (`detectLockfileFlavor`) and skips rules that don't apply — the npm-lockfile-shape rules no-op on a `pnpm-lock.yaml`, and the pnpm-only rules (`valid-pnpm-workspace`, `valid-pnpm-field`) no-op on npm. The flavor-agnostic config rules (`valid-package-json`, `valid-npmrc`) run for both (and `valid-npmrc` gets the flavor threaded through so it can flag pnpm-ignored keys). See the pnpm support section.
- **Config-file validation** (`valid-package-json`, `valid-npmrc`): npm-check validates all three files that govern an install, not just the lockfile. `valid-package-json` (default `error`) delegates to `validatePackageJson()` — name/version validity, dependency-range syntax across all four sections, **override-range syntax in both `overrides` and `pnpm.overrides`** (nested form, `$`-refs skipped), **the range-carrying pnpm sub-fields** (`packageExtensions` inner `dependencies`/`peerDependencies`, `peerDependencyRules.allowedVersions`, `allowedDeprecatedVersions` — validated but never flagged/pinned, since these ranges are loose by design), **`bundleDependencies`/`bundledDependencies`** (array of valid names, warn when a bundled name isn't declared in dependencies), scripts/bin/main/exports/workspaces types, license presence (warn), and the `pnpm` field's types (`overrides`/`packageExtensions`/build allowlists/…). `valid-npmrc` (default `warn`) reads the project-level `.npmrc` next to the lockfile and delegates to `validateNpmrc()` — ini syntax, plus security checks where **plaintext auth tokens, `strict-ssl=false`, and disabled `rejectUnauthorized` are always hard errors** regardless of configured severity (insecure `http://` registries and unknown keys are warnings). Both surface as the report's "package.json" / ".npmrc (config)" sections and via the standalone `validate` command.
- **Trust vs. portability** (`secure-resolved`/`no-remote-deps` vs. `resolved-registry-pin`): these answer
  two orthogonal questions and must not be conflated. `allowedRegistryHosts` (shared config) answers
  *"is this host a legitimate, trusted registry?"* — an org's own private mirror is trusted, so
  allowlisting it is correct. `resolved-registry-pin` answers *"can everyone who has to build this repo
  actually reach the hosts in the lockfile?"* — a trusted private mirror still makes the lockfile
  un-installable on a public CI runner or for an external contributor. The distinction is not academic:
  a plain `npm install` by a contributor whose user-level `.npmrc` defaults to a private registry
  silently rewrites the lockfile's `resolved` URLs to that host, and every trust-based rule passes it.
  Note the two use different merge semantics on purpose — `allowedRegistryHosts` is a **union** list key
  (shared policy + local additions, only ever widening, right for trust) while the pin's `hosts` is
  rule-local and never unioned from `common` (a pin that could only widen would not be a pin). The rule
  is **opt-in**: empty `hosts` == off, so projects that genuinely install from a private registry are
  unaffected. `.npmrc` cannot serve as the guard here — it is gitignored (it commonly holds auth
  tokens), so it is local-only and never reaches CI.

- **Release-age cooldown** (`min-release-age`): a supply-chain check on *committed policy*, not on the
  lockfile. A compromised maintainer's malicious release is usually detected and unpublished within
  hours, so refusing versions younger than N days means you never resolve one. The two package
  managers disagree on **both key name and unit** — npm reads `min-release-age` from `.npmrc` in
  **days** (≥ 11.10); pnpm reads `minimumReleaseAge` from `pnpm-workspace.yaml` in **minutes**
  (≥ 10.16, and pnpm reads only auth/registry settings from `.npmrc`, so its cooldown is never
  there). The rule normalizes to days before comparing, so `minimumReleaseAge: 3` is correctly
  reported as three *minutes*. Default `warn` / `minDays: 3`, deliberately stricter than the
  ecosystem's 1-day norm. **Presence-only was rejected**: `min-release-age=0` is set and worthless,
  so the rule always compares a threshold and never emits a bare "it's configured". A blanket
  `minimumReleaseAgeExclude` of `*` is flagged separately, since it voids the policy. Firing when
  *no* cooldown is committed is intended — a cooldown living only in a dev's `~/.npmrc` never
  reaches CI, so that project really is uncovered.

- **npm v12 readiness** (the three breaking opt-ins): `install-scripts` reconciles with package.json `allowScripts` (pinned `name@version` or name-only) and flags pending/denied scripts; `no-git-deps` and `no-remote-deps` flag deps that will need `--allow-git` / `--allow-remote`. The report's Install scripts section shows `total · allowed · blocked` when the project is `allowScripts`-aware.
- Each rule is `{id, description, defaultSeverity, check(context)}` — extensible
- Severities error/warn/off with per-rule options; `maxWarnings` budget
- Config resolution (suite convention): the shared **`.dependably`** (canonical; `.dependably-check` is a deprecated alias, canonical preferred at each walk-up level) — discovered by walking up to the repo root, or pointed at by `--config <file>` — is the PRIMARY source. npm-check reads its `common` then **`npm-check`** section (`npm` is a deprecated section alias), applying the unified merge rule (rules merge per id, list keys `exclude`/`exceptions`/`allowedRegistryHosts` union, scalars/`failOn` override). `failOn: {count}` maps to `maxWarnings`, `failOn: {severity}` to `failOnSeverity`; `version`/non-object root are validated (`CONFIG_VERSION`/`CONFIG_SHAPE`). A tool-local `.npm-checkrc.json` / `npm-check.config.json` in cwd is a FALLBACK that overrides the shared settings; CLI flags override files. The normative spec and its JSON Schema live in the [dependably-spec](https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec) repository, which governs all six tools; this repo vendors the conformance corpus under `conformance/dependably/` (provenance in `conformance/VENDOR.md`) and does not own the contract.
- **Exceptions** (`src/exceptions.js`, the reference module the C#/Python ports mirror): a section's `exceptions` array suppresses specific findings — `{rule, package?|path?|symbol?|id?, reason, expires?}` (rule + ≥1 selector + mandatory reason; selectors AND within an entry). npm-check findings match on `package`/`id` (`path`/`symbol` are inapplicable — an error in the own section, tolerated in `common`). `runAudit` returns suppressed findings on `report.suppressed` (excluded from gating, counted in `summary.suppressed`) and unused/expired entries on `report.exceptionsMeta`; `--show-suppressed` lists them and deprecation/unused/expired notices print to stderr.
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
- Attributes each advisory only to the locked versions it actually affects: a single-version name group trusts the endpoint's server-side filtering verbatim (zero regression), while a multi-version group matches each locked version against the advisory's `vulnerable_versions` via a small dependency-free comparator matcher (no `semver` dependency). Ranges the matcher can't parse in a multi-version group are demoted to warnings rather than failing the run
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

### 17. Import facts (`src/facts/`)

The npm **language-facts** layer: what a JavaScript/TypeScript/Svelte tree imports, published as data for another tool (`npm-check imports`, and the `@dependably/npm-check/facts` subpath export). It moved here verbatim from sbom-reach's `packages/analyzer-npm` (commit `44e9252`) under one ownership rule: **the check tool owns language facts** — per-file imports, bindings and referenced names (`scan.js`), Node-style resolution (`resolve.js`), the walk through `node_modules` (`modulegraph.js`), lockfile graphs (`lockfile-graph.js`), workspace discovery (`workspace.js`) — and **sbom-reach keeps the verdicts** (`reachable` / `not-observed` / `unknown`, symbol intersection, confidence). Nothing under `src/facts/` may use that vocabulary: there is no severity, no verdict and no purl in the document, and `tests/unit/facts-document.test.js` pins that by grepping the output. The precedent is pycheck's `--imports` document: report not gate, a `documentType` discriminator, `unanalyzable[]` load-bearing, additive fields only.

- **Layout:** `collect.js` (`collectImportFacts` — one call: workspace → every first-party file scanned with each site resolved to the installed copy it loads → the module graph → ONE lockfile discovery → `unanalyzable`), `document.js` (`factsDocument` — Maps/Sets to sorted arrays, absolute paths to target-relative POSIX paths, module-graph keys keep their `\0` separator with the path half relativized), `types.d.ts` (hand-written; the JS references it via `@typedef {import('./types.d.ts').X}` and CI type-checks it with `npm run typecheck` / `tsconfig.facts.json` — keep every exported runtime symbol declared there, it IS the public surface), `ts.js` (the compiler, loaded lazily via `createRequire`), `errors.js` (`FactsError`), `index.js` (the barrel). `bench/scan-bench.mjs` is the perf harness; never wire it into CI.
- **`typescript` is an optional peer, and the lockfile commands never load it.** `bin/cli.js` imports `src/facts/index.js` lazily inside `runImportsCommand`; the main barrel `src/index.js` does not re-export facts. A missing peer is `FactsError('TYPESCRIPT_MISSING')`, thrown by `collectImportFacts` before it touches the tree, and exit `2` at the CLI. `fast-glob` and `ignore` are real runtime dependencies (workspace discovery) but are likewise only loaded on this path. `lockfile-graph.js` imports `yaml` STATICALLY, unlike `parser.js`'s lazy `createRequire` — a consumer that bundles this subpath (sbom-reach, with esbuild) would otherwise be left with an unbundled runtime `require`. Do not merge `lockfile-graph.js` into `parser.js`/`format-library.js`: they answer different questions and couple to the lockfile differently.
- **`buildFactsEnvelope` in `schema.js` is a sibling of `buildEnvelope`, not a variant of it.** Same identity fields, plus `documentType: "imports"`, and NO `findings` — an import site has no severity, and putting it in `findings` would let `--fail-on` gate CI on ordinary imports. The findings envelope is unchanged and still has no `documentType`; `tests/unit/schema-facts-envelope.test.js` pins both. `imports` exits `0` on every successful scan and never `1`.
- **Invariants that travel with the code** (each was a real bug in the consumer, and each has a test):
  - **Over-report USE, never under-report it.** `referenced` counts any occurrence of a binding — call, argument, spread, re-export, shorthand property — and a shadowing local is deliberately NOT excluded; two sites destructuring the same local name from different packages are both credited. The consumer's "was the vulnerable symbol used" question is only safe in the loud direction.
  - **`opaque` is fail-safe.** A default/namespace binding that escapes the one-level property-access resolution — assigned, passed, spread, exported, returned, computed access, or **called/constructed/tagged/rendered directly** (`axios(...)`, `new X()`, `<X/>`) — "could use anything". A consumer must never read an opaque site as evidence that some symbol was NOT used. Calling the identifier itself is intentionally opaque, not "safe, no binding" (adversarial-review finding: `axios(...)` executes the module identity, which no member-name intersection can reason about).
  - **`unanalyzable` is load-bearing and ALWAYS present.** A first-party file that could not be read (`file` — the consumer used to `continue` silently), a `.svelte` file whose `<script>` extraction reported a problem (`file-partial`; its sites are still present, what the entry says is that their absence for some package is not a clean negative), a `node_modules` file the walk skipped (`node-modules-file`), and a budget stop (`walk`) are each listed with a reason and counted in `summary`. Absence of evidence is only a negative if the search actually ran. The `.svelte` extraction's own backstops (`parseErrors`: TS parse diagnostics plus a `<script`/`</script>` tag found outside every span the extraction accounted for) exist for the same reason; `scan.js`'s doc comments enumerate the two accepted silent-loss gaps and why they stay.
  - **The module graph reports what it could not follow, precisely.** `dynamic` / `incomplete` per reached package, `weakPackages`, `unresolvedByName` (an unresolved bare specifier says which package it wanted), `truncated` + `filesPastBudget`. A package's own internal relative imports are traversed but never listed as importers (recording them inflated evidence ~70× on a real tree). One `reached` entry per installed COPY (`name@version\0root`), indexed under both the package.json name and the directory name so an aliased install matches either spelling.
  - **Lockfile facts are read, never inferred.** `devDeclared` is tri-state from what the lockfile asserts (npm's per-entry flags are a computed whole-tree verdict; pnpm only names importer-direct packages), folded "runtime anywhere wins" across paths and across lockfiles; `scope: optional` is a claim of exclusivity that one non-optional sighting revokes; an unparseable lockfile is a diagnostic naming the file, and none at all is `NO_LOCKFILE`.
- **Testing:** `tests/unit/facts-*.test.js` (temp trees under `os.tmpdir()`, realpath'd — macOS `/var` is `/private/var`, and the resolver realpaths everything) and `tests/fixtures/facts/{npm-app,svelte-app}` (no `node_modules` — the resolver walks UP from a fixture the way Node does and finds THIS repo's `node_modules`, so fixture-based graph assertions are avoided; `moduleGraph: false` or a temp tree instead). Parity with the sbom-reach analyzer it replaces was measured on the sbom-reach repository itself: 431 files parsed / 73 copies reached / 12 unresolved, identical on both tools.

**Key Functions:** `collectImportFacts()`, `factsDocument()`, `scanSource()`, `ModuleResolver`, `walkModuleGraph()`, `discoverWorkspace()`, `discoverLockfileGraphs()`, `specifierToPackage()`; `buildFactsEnvelope()` (schema.js)

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
- Requires Node.js 22.0.0 or higher (npm >= 10)
- Uses native ES modules
- Zero external dependencies loaded on the npm lockfile path; pnpm support pulls one audited YAML
  parser (`yaml`), loaded lazily (createRequire) only when a `pnpm-lock.yaml` is actually parsed —
  npm-only usage never loads it. The import-facts path (`src/facts/`, the `imports` command) is the
  one place `fast-glob`, `ignore` and the optional `typescript` peer are loaded, and it is imported
  lazily by the CLI and never by the main barrel

**File Format Support:**
- JSON parsing with error recovery
- Preserves formatting where possible
- UTF-8 encoding standard

**Performance Considerations:**
- Streaming/chunked processing for large lockfiles (`streaming-parser.js`, `parallel-processor.js`)
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
npm install @dependably/npm-check

# or for global CLI usage
npm install -g @dependably/npm-check
```

**Programmatic Usage:**

```javascript
import {
  validatePackageLock,
  migrateToVersion,
  LOCKFILE_VERSIONS
} from '@dependably/npm-check';

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

Apache-2.0