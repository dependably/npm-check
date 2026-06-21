# Package Lockfile Fixer

A comprehensive tool for validating, migrating, fixing, and updating npm `package-lock.json` files across versions 1, 2, and 3.

## Features

- **Validation** – Detects structural, semantic, and integrity issues.
- **Migration** – Seamlessly convert between lockfile versions (v1 ↔ v2 ↔ v3).
- **Audit** – Opinionated, configurable linter for lockfile best practices; non-zero exit for CI gating.
- **Checksum Fixing** – Fill missing/placeholder/sha1 integrity hashes with real registry hashes.
- **Integrity Verification** – Verify locked integrity hashes against the registry's authoritative hashes (no `node_modules` needed); plus SPDX license checks.
- **Version Pinning** – Remove `^`/`~` from package.json ranges, locking to resolved versions.
- **Pruning** – Remove orphaned lockfile entries unreachable from the dependency graph.
- **Unused Detection** – Flag declared dependencies the application never imports.
- **Fixing** – Automated repair strategies for common issues.
- **Updater** – Upgrade integrity hashes and deduplicate packages.
- **Streaming** – Handle very large lockfiles without loading entire file into memory.
- **Parallel Processing** – Distribute operations across CPU cores for better performance.
- **Progress Tracking** – Real-time progress reporting with ETA for long operations.
- **CLI** – Command-line interface for everyday use.

## Installation

Published to the private registry. Point the `@dependably` scope at it, then install:

```bash
npm config set @dependably:registry https://dependably.northwardlabs.ca/
npm install -g @dependably/npm-check
```

The CLI is still invoked as `npm-check`.

## Quick Start

### CLI Usage

The repository includes a lightweight CLI exposed as the `npm-check` binary:

```bash
# Run ALL checks and print one grouped report (the default command)
npm-check                       # ./package-lock.json
npm-check report web/package-lock.json
npm-check --offline             # skip the registry integrity check
npm-check --format json         # machine-readable, for CI

# Validate a lockfile (defaults to ./package-lock.json)
npm-check validate

# Migrate to latest version (v3)
npm-check migrate

# Migrate to a specific version
npm-check migrate 2

# Upgrade lockfile v2 → v3 (alias for migrate 3; no-op if already v3)
npm-check upgrade --write

# Fill missing/placeholder/sha1 integrity hashes with real registry hashes
npm-check fix-checksums --write

# Pin ^/~ ranges in package.json to the lockfile-resolved versions
npm-check pin --write

# Lint the lockfile for best practices (exits non-zero on failure)
npm-check audit

# Remove orphaned packages unreachable from the dependency graph
npm-check prune --write

# Flag declared dependencies the application never imports
npm-check unused

# Run automated fixer (adds placeholders for missing integrity, dedupes packages)
npm-check fix --write

# Upgrade integrity hashes
npm-check upgrade-hashes --write

# Deduplicate packages
npm-check dedupe --write

# Check integrity hashes and licenses
npm-check check

# Verify locked integrity hashes against the registry (no node_modules needed)
npm-check check --check hash

# Fail the run when an entry can't be verified (registry down / missing)
npm-check check --check hash --fail-on-unresolved

# Check only licenses against approved list
npm-check check --check license

# Use custom approved licenses file
npm-check check --check license --licenses-csv ./my-approved.csv

# Strict mode (treats unknown licenses as errors)
npm-check check --check license --strict

# Scan locked packages for known vulnerabilities (npm advisory endpoint; no node_modules)
npm-check vuln
npm-check vuln --min-severity critical

# Surface npm's "deprecated" warnings straight from the lockfile
npm-check deprecated
npm-check deprecated --fail-on-deprecated

# Bump deprecated/vulnerable DIRECT deps to latest, then run npm install
npm-check remediate --write

# Specify a custom file path
npm-check validate ./path/to/package-lock.json

# List backups
npm-check backups

# Restore from latest backup
npm-check restore
```

**Notes:**
- The file argument is optional and defaults to `./package-lock.json` in the current directory.
- The migrate command defaults to version 3 (latest) when no target version is specified.
- The `--write` flag creates automatic backups before modifying files.
- The `check` command requires `node_modules` directory to exist for verification.
- Aliases: `npm-check` and `npm-check` both point to the same CLI.

### Check Command

The `check` command validates package integrity hashes and licenses:

**Integrity Check** – Verifies that packages in `node_modules` match the integrity hashes recorded in `package-lock.json`:

```bash
npm-check check --check hash
```

This is useful for detecting if packages have been modified or corrupted after installation.

**License Check** – Verifies that all packages in `node_modules` have licenses that are in your approved list:

```bash
# Create approved-licenses.csv in your project root
npm-check check --check license

# Or use a custom CSV file
npm-check check --check license --licenses-csv ./my-approved-licenses.csv
```

**Approved Licenses CSV Format:**

```csv
license,category,notes
MIT,permissive,
Apache-2.0,permissive,
BSD-3-Clause,permissive,
GPL-2.0,copyleft,Requires disclosure
```

The first column is the SPDX license identifier that must match exactly. Comments (lines starting with `#`) and empty lines are ignored.

**Exit Codes:**
- `0` – All checks passed
- `1` – At least one check failed

**Strict Mode:**

Use `--strict` to treat unknown licenses (missing license field) as errors instead of warnings:

```bash
npm-check check --check license --strict
```

### Audit Command

The `audit` command is an opinionated linter for `package-lock.json` best practices and supply-chain hygiene. It is designed for CI: it exits non-zero when the audit fails.

```bash
npm-check audit                          # Lint ./package-lock.json with default rules
npm-check audit --strict                 # Treat any warning as failure
npm-check audit --format json            # Machine-readable output
npm-check audit --rule pinned-versions:error --rule secure-resolved:off
npm-check audit --config ./my-audit.json
```

**Default Rules:**

| Rule | Default | What it checks |
|---|---|---|
| `lockfile-version` | error | `lockfileVersion` is at least 3 (configurable `minVersion`) |
| `valid-structure` | error | Lockfile passes structural validation |
| `integrity-hygiene` | error | No missing, placeholder, or sha1 integrity hashes (git/file/link/bundled deps exempt) |
| `secure-resolved` | error | No `http://` resolved URLs; registry hosts limited to an allowlist (default: `registry.npmjs.org`) |
| `install-scripts` | warn | No dependency declares a lifecycle install script (`hasInstallScript`) unless approved — via the rule's `allow` option **or** npm v12's package.json `allowScripts` map (pinned `name@version` or name-only). Flags pending/denied scripts that npm v12 won't run |
| `no-git-deps` | warn | No git dependencies — npm v12 won't install them without `--allow-git` |
| `no-remote-deps` | warn | No remote-URL (non-registry) tarball dependencies — npm v12 won't install them without `--allow-remote` |
| `pinned-versions` | warn | No `^`/`~` ranges in package.json dependency sections |
| `lockfile-sync` | error | package.json and the lockfile agree (name/version, every declared dep present with matching range, no lockfile-only leftovers) |
| `no-orphan-packages` | warn | No lockfile entries unreachable from the dependency graph (fix with `npm-check prune`) |
| `unused-dependencies` | warn | Every declared dependency is imported by the application source (heuristic; `includeDev`/`ignore` options) |

**Configuration File:**

The audit looks for `.npm-checkrc.json`, then `npm-check.config.json`, in the current directory (or pass `--config <path>`). CLI flags override file settings. Rule entries are `"error"`, `"warn"`, `"off"`, or `[severity, options]`:

```json
{
  "maxWarnings": -1,
  "rules": {
    "lockfile-version":  ["error", { "minVersion": 3 }],
    "valid-structure":   "error",
    "integrity-hygiene": ["error", { "allowSha1": false }],
    "secure-resolved":   ["error", {
      "allowedHosts": ["registry.npmjs.org", "npm.mycorp.example.com"],
      "allowHttp": false,
      "allowGit": true,
      "allowFile": true
    }],
    "pinned-versions":   ["warn", {
      "sections": ["dependencies", "devDependencies", "optionalDependencies"],
      "ignore": []
    }],
    "lockfile-sync":     "error",
    "no-orphan-packages": "warn",
    "unused-dependencies": ["warn", { "includeDev": false, "ignore": [] }]
  }
}
```

**Audit Exit Codes:**
- `0` – Audit passed
- `1` – Findings failure (errors present, or warnings exceed `maxWarnings`)
- `2` – Operational error (bad config, unknown rule, unreadable file)

### Fix-Checksums Command

Fills missing, placeholder (`sha512-PLACEHOLDER`), and weak (`sha1-`) integrity hashes with the authoritative `dist.integrity` from each package's registry. The registry is derived per-package from the entry's `resolved` URL, so scoped/private registries work without configuration.

```bash
npm-check fix-checksums                  # Dry-run: show what would change
npm-check fix-checksums --write          # Apply (creates backups)
npm-check fix-checksums --concurrency 16 --timeout 5000
npm-check fix-checksums --local-fallback # Hash node_modules copies when registry fails
```

Exits `1` if any candidate hashes remain unresolved (CI-gateable). Git, file-directory, linked, workspace, and bundled dependencies are skipped — they legitimately lack registry hashes. v1 lockfiles are not supported; run `npm-check migrate 3` first.

> ⚠️ **Local fallback caveat:** hashes produced by `--local-fallback` are computed from `node_modules` directories and are **not** npm tarball hashes — `npm ci` will fail integrity verification against the registry for those entries. Use only for air-gapped/internal verification; such changes are tagged `local-directory` in the output.

### Pin Command

Rewrites caret (`^`) and tilde (`~`) ranges in `package.json` to the exact versions already resolved in the lockfile, and keeps the lockfile's root entry (`packages[""]`) in sync so `npm install` sees no mismatch.

```bash
npm-check pin                            # Dry-run from the current directory
npm-check pin --write                    # Apply (backs up both files)
npm-check pin ./packages/app --write     # Operate on another directory
npm-check pin --include-peer             # Also pin peerDependencies (off by default)
```

Complex ranges (`>=`, `||`, `1.x`, `*`, dist-tags), git/file/workspace/alias specs, and dependencies missing from the lockfile are left untouched and reported with reasons.

### Prune Command

Removes orphaned packages from the lockfile — entries unreachable from the root package (or any workspace) by following dependency edges with npm's node_modules resolution rules. Orphans typically accumulate after bad merges or hand-edits.

```bash
npm-check prune                          # Dry-run: list orphaned entries
npm-check prune --write                  # Remove them (creates a backup)
```

Reachability follows `dependencies`, `optionalDependencies`, and `peerDependencies` of every installed package (plus `devDependencies` of the root and workspaces), resolves nested `node_modules` shadowing nearest-first, and follows workspace `link:` entries. v1 lockfiles are not supported; run `npm-check migrate 3` first. On v2 lockfiles the legacy `dependencies` tree is left untouched (npm regenerates it) with a recommendation to migrate to v3.

### Unused Command

Flags dependencies declared in `package.json` that the application never imports — candidates for removal.

```bash
npm-check unused                         # Scan the current directory
npm-check unused ./my-app --include-dev  # Also check devDependencies
npm-check unused --json                  # Machine-readable output
```

The scan walks source files (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte`, skipping `node_modules`, `dist`, etc.) for `require()`, `import`, dynamic `import()`, and re-export specifiers. Packages mentioned in npm scripts count as used (CLI tools), and `@types/foo` counts as used when `foo` is. Results are **heuristic and report-only** — packages loaded via config files or runtime magic can be false positives, so nothing is removed automatically.

## API

### Core Functions

```js
import {
  parseLockfile,
  serializeLockfile,
  validatePackageLock,
  migrateToVersion,
  fixPackageLock,
  upgradeIntegrityHashes,
  deduplicatePackages,
  checkIntegrity,
  checkLicenses,
  checkAll,
  parseLicensesCsv
} from '@dependably/npm-check';

// Parse and validate a lockfile
const lockfile = parseLockfile('package-lock.json');
const { valid, errors } = validatePackageLock(lockfile);

// Migrate between versions
const v3Lockfile = migrateToVersion(lockfile, 3);

// Apply automated fixes
const { fixedLockfile, fixes } = fixPackageLock(lockfile, {
  fillMissingIntegrity: true,
  dedupe: true
});

// Write back to file
serializeLockfile('package-lock.json', fixedLockfile, true);
```

### Checking Integrity and Licenses

```js
// Check integrity hashes
const { valid: hashesValid, passed, failed, errors } = await checkIntegrity(
  lockfile,
  {
    nodeModulesPath: './node_modules',
    onProgress: (progress) => console.log(progress.percentage + '%')
  }
);

// Check licenses
const approvedLicenses = await parseLicensesCsv('./approved-licenses.csv');
const { valid: licensesValid, approved, rejected, warnings } = await checkLicenses(
  lockfile,
  {
    nodeModulesPath: './node_modules',
    csvPath: './approved-licenses.csv',
    strict: false, // Unknown licenses are warnings, not errors
    onProgress: (progress) => console.log(progress.percentage + '%')
  }
);

// Or run both checks at once
const { valid, integrity, licenses } = await checkAll(lockfile, {
  nodeModulesPath: './node_modules',
  csvPath: './approved-licenses.csv',
  strict: false
});
```

**Integrity Check Options:**
- `nodeModulesPath` (string) – Path to node_modules directory (default: './node_modules')
- `onProgress` (function) – Progress callback called with `{ current, total, percentage, stage }`

**License Check Options:**
- `csvPath` (string) – Path to approved licenses CSV file (default: './approved-licenses.csv')
- `nodeModulesPath` (string) – Path to node_modules directory (default: './node_modules')
- `strict` (boolean) – Treat unknown licenses as errors instead of warnings (default: false)
- `onProgress` (function) – Progress callback

### Performance & Large Files

```js
import {
  shallowCopyLockfile,
  processBatchedPackages,
  getMemoryStats,
  chunkLockfile,
  mergeLockfileChunks,
  isLargeLockfile
} from '@dependably/npm-check';

const lockfile = parseLockfile('large-package-lock.json');

// Check if large file
if (isLargeLockfile(lockfile, 10)) {
  // Process in batches to avoid blocking
  await processBatchedPackages(lockfile.packages, (path, pkg) => {
    // Process each package
  }, 1000);

  // Or chunk for parallel processing
  const chunks = chunkLockfile(lockfile, 5000);
  const processed = chunks.map(chunk => fixPackageLock(chunk));
  const result = mergeLockfileChunks(processed);
}

// Monitor memory usage
const stats = getMemoryStats();
console.log(`Heap: ${stats.heapUsed}MB / ${stats.heapTotal}MB`);
```

### Streaming Large Lockfiles

```js
import { StreamingParser } from '@dependably/npm-check';

const parser = new StreamingParser({
  onPackage: (path, pkg) => {
    console.log(`Parsed package at ${path}`);
  },
  onProgress: (bytesRead, totalBytes) => {
    console.log(`Progress: ${bytesRead}/${totalBytes} bytes`);
  }
});

const lockfile = await parser.parseFile('huge-package-lock.json');
```

### Parallel Processing

```js
import { parallelUpgradeIntegrityHashes, parallelDeduplicatePackages } from '@dependably/npm-check';

const lockfile = parseLockfile('package-lock.json');

// Distribute hash upgrades across CPU cores
const upgraded = await parallelUpgradeIntegrityHashes(lockfile);

// Parallel deduplication
const deduplicated = await parallelDeduplicatePackages(upgraded);
```

### Progress Tracking

```js
import { createProgressReporter } from '@dependably/npm-check';

const progress = createProgressReporter(totalPackages, {
  showMemory: true,
  updateInterval: 100
});

progress.on('update', (info) => {
  console.log(`${info.percentage}% complete, ETA: ${info.estimated}ms`);
});

// Increment progress as you process packages
progress.update();
```

## Advanced Examples

### Complete Workflow

```js
import {
  parseLockfile,
  validatePackageLock,
  fixPackageLock,
  serializeLockfile
} from '@dependably/npm-check';

// 1. Parse
const lockfile = parseLockfile('package-lock.json');

// 2. Validate
const validation = validatePackageLock(lockfile);
if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}

// 3. Fix
const { fixedLockfile, fixes } = fixPackageLock(lockfile, {
  fillMissingIntegrity: true,
  dedupe: true,
  normalizeTo: 3  // Upgrade to v3
});

console.log('Fixes applied:', fixes);

// 4. Write
serializeLockfile('package-lock.json', fixedLockfile, true);
```

### Find and Analyze Issues

```js
import {
  validatePackageLock,
  findDuplicatePackages,
  countUniquePackages
} from '@dependably/npm-check';

const lockfile = parseLockfile('package-lock.json');

// Validation details
const { errors, warnings } = validatePackageLock(lockfile);
errors.forEach(err => console.error(`[${err.code}] ${err.message}`));

// Duplicate analysis
const duplicates = findDuplicatePackages(lockfile);
duplicates.forEach((versions, packageName) => {
  console.log(`${packageName}: ${versions.length} versions found`);
});

console.log(`Total unique packages: ${countUniquePackages(lockfile)}`);
```

## Development & Testing

### Unit Tests (Fast)

```bash
npm run test:unit
```

Runs fast unit tests with mocks. All tests complete in under 1 second.

### Integration Tests (Docker Required)

```bash
# Build Docker images (one-time setup)
npm run docker:build

# Run integration tests with Node 18 and npm 10
npm run docker:test:node18-npm10

# Test multiple Node versions
npm run docker:test:all
```

Integration tests validate that lockfile migration produces identical `node_modules` installations. See [TESTING.md](TESTING.md) for detailed testing guide.

### All Tests

```bash
npm run test:all
```

The project includes 130+ tests across 11 test suites covering:
- Format detection and validation
- All migration paths (v1 ↔ v2 ↔ v3)
- Updater operations with immutability
- Fixer workflows and error handling
- Backup and restore functionality
- Integrity hash generation
- Streaming parser operations
- Parallel processing operations
- Progress reporting
- npm ci migration validation (integration tests)

## Contributing

Pull requests are welcome. Please:
1. Run `npm test` to ensure all tests pass
2. Run `npm run lint` for code quality checks
3. Update tests for any new functionality

## License

Apache-2.0
