# CLI reference

The `npm-check` binary. The file argument is optional and defaults to
`./package-lock.json`. Commands that modify files require `--write` (backups are
created automatically). `--format json` emits machine-readable output.

Subcommands group into three families (`npm-check --help` prints the same grouping):

- **Read & report** (inspect; never mutate the lockfile): `report` (default), `validate`, `vuln`, `deprecated`, `check`, `audit`, `unused`
- **Fix & transform** (npm-only; mutate the lockfile with `--write`): `fix`, `fix-checksums`, `upgrade-hashes`, `migrate` (`upgrade` is an alias of `migrate 3`), `pin`, `prune`, `dedupe`, `remediate`
- **Backups**: `backups`, `restore`, `clean-backups`

```bash
# Run ALL checks and print one grouped report (the default command)
npm-check                       # ./package-lock.json
npm-check report web/package-lock.json
npm-check --offline             # skip the registry integrity check
npm-check --format json         # machine-readable, for CI

# Validate a lockfile (+ sibling package.json + .npmrc)
npm-check validate

# Migrate to latest version (v3), or a specific version
npm-check migrate
npm-check migrate 2
npm-check upgrade --write       # alias for migrate 3; no-op if already v3

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

# Automated fixer (placeholders for missing integrity, dedupe), and the pieces
npm-check fix --write
npm-check upgrade-hashes --write
npm-check dedupe --write

# Verify integrity hashes and licenses (--check hash / --check license for one)
npm-check check

# Scan locked packages for known vulnerabilities (npm advisory endpoint; no node_modules)
npm-check vuln
npm-check vuln --fail-on severity=critical

# Surface npm's "deprecated" warnings straight from the lockfile
npm-check deprecated
npm-check deprecated --fail-on count=0  # fail CI on any deprecation

# Bump deprecated/vulnerable DIRECT deps to latest, then run npm install
npm-check remediate --write

# Backups (--write creates them automatically)
npm-check backups
npm-check restore
```

**Notes:**

- The file argument is optional and defaults to `./package-lock.json`.
- `migrate` defaults to version 3 (latest) when no target is given.
- `--write` creates automatic backups before modifying files.

## Check command

The `check` command validates package integrity hashes and licenses:

- **Integrity check** (`--check hash`) – Verifies locked `integrity` hashes against the registry's authoritative hashes (no `node_modules` needed) — detects a tampered or drifted lockfile.
- **License check** (`--check license`) – Verifies every package's license against your approved list (`approved-licenses.csv` in the project root, or `--licenses-csv ./my-approved.csv`).

**Approved licenses CSV format:**

```csv
license,category,notes
MIT,permissive,
Apache-2.0,permissive,
BSD-3-Clause,permissive,
GPL-2.0,copyleft,Requires disclosure
```

The first column is the SPDX license identifier that must match exactly. Comments (lines starting with `#`) and empty lines are ignored.

Use `--strict` to treat unknown licenses (missing license field) as errors instead of warnings. Exit codes follow the [shared convention](#exit-codes).

## Fail-closed scanning (registry errors)

The registry-backed scans — `check --check hash` (integrity), `vuln`, `deprecated`, and the full `report` — **fail closed by default**: a package the scan *could not verify* (registry unreachable, endpoint unsupported) is reported as **unresolved** and the run exits non-zero, so a registry outage is never mistaken for a clean result. A package the registry successfully reports as clean still exits 0. Opting out:

- `--allow-unresolved` — unresolved entries become non-fatal; real findings still fail the run.
- `--offline` (`vuln`, `deprecated`, `report`) — skip the network entirely; everything is *skipped* and the run exits 0.

The programmatic API matches: `checkIntegrity`, `checkVulnerabilities`, and `checkDeprecations` default `failOnUnresolved: true`; pass `false` for lenient behavior.

## Machine-readable output (`--format json`)

`vuln`, `deprecated`, `remediate`, and `report` all emit the **Dependably suite's shared finding-schema envelope** (schema v1) under `--format json` — the same top-level shape every tool in the suite produces, so one consumer can parse any of them identically. In json mode stdout is exactly **one** JSON object (banners/progress go to stderr); the default human format is `--format human`.

```json
{
  "tool": "npm-check",
  "toolVersion": "1.7.0",
  "schemaVersion": "1.0",
  "target": "package-lock.json",
  "summary": {
    "scanned": 1,                 // packages examined
    "findings": 1,                // == findings.length, never truncated
    "bySeverity": { "critical": 0, "high": 1, "moderate": 0, "low": 0, "info": 0 },
    "exitCode": 1                 // == the real process exit code
  },
  "findings": [
    {
      "severity": "high",                       // the ladder: critical|high|moderate|low|info
      "ruleId": "GHSA-jf85-cpcp-j695",          // the advisory id (GHSA / npm id)
      "category": "vulnerability",
      "message": "Prototype Pollution in lodash",
      "location": null,                          // a package advisory is not file-scoped
      "remediation": "upgrade to >=4.17.12",
      "extra": {
        "package": "lodash",
        "installedVersion": "4.17.10",
        "fixedVersion": ">=4.17.12",
        "cve": "CVE-2019-10744",
        "vulnerableRange": "<4.17.12"
      }
    }
  ],
  "extra": { "scan": { "vulnerable": 1, "clean": 0, "unresolved": 0, "skipped": 1, "valid": false, "unresolvedItems": [] } }
}
```

Highlights of the envelope:

- Each finding's top-level `severity` is the ladder string (`info`|`low`|`moderate`|`high`|`critical`); advisory findings keep the **true** advisory severity verbatim, and the advisory payload (package, versions, advisory/CVE ids, vulnerable range, references) lives under `extra`. `fixedVersion` is populated only from data the advisory actually provides.
- `report --format json` flattens every section's findings into one list (report-tier `error`→`high`, `warn`→`low`; the original tier is kept under `extra.reportSeverity`, the section table and gate rollup under the top-level `extra`).
- `deprecated` findings map to `category: "deprecated"` with severity `low` (a soft warning, as npm treats it) or `high` when `--fail-on count=0` promotes them; `remediate` findings describe each planned bump, transitive guidance, or skip. Scan-completeness counts ride under `extra.scan`, so nothing the human output showed is lost.

## Exit codes

All subcommands follow one convention:

| Code | Meaning |
| --- | --- |
| `0` | Clean run (and `--help` / `--version`) |
| `1` | Findings — vulnerabilities at/above the threshold, audit problems, or a check that failed (a blocking result) |
| `2` | Usage or operational error — unknown command, unknown/invalid flag, missing or unreadable lockfile, unsupported input (e.g. a v1 lockfile to a v3-only command), or an internal failure |

A missing lockfile is `2` for **every** subcommand (it is a usage error, not a findings failure).

## Audit command

The `audit` command is an opinionated linter for `package-lock.json` best practices and supply-chain hygiene. It is designed for CI: it exits non-zero when the audit fails.

```bash
npm-check audit                          # Lint ./package-lock.json with default rules
npm-check audit --fail-on count=0        # Treat any warning as failure
npm-check audit --format json            # Machine-readable output
npm-check audit --rule pinned-versions:error --rule secure-resolved:off
npm-check audit --config ./.dependably-check
```

**Default rules:**

| Rule | Default | What it checks |
|---|---|---|
| `lockfile-version` | error | `lockfileVersion` is at least 3 (configurable `minVersion`) |
| `valid-structure` | error | Lockfile passes structural validation |
| `integrity-hygiene` | error | No missing, placeholder, or sha1 integrity hashes (git/file/link/bundled deps exempt) |
| `secure-resolved` | error | No `http://` resolved URLs; registry hosts limited to an allowlist (default: `registry.npmjs.org`) |
| `install-scripts` | warn | No dependency declares a lifecycle install script (`hasInstallScript`) unless approved — via the rule's `allow` option **or** npm v12's package.json `allowScripts` map. Flags pending/denied scripts that npm v12 won't run |
| `no-git-deps` | warn | No git dependencies — npm v12 won't install them without `--allow-git` |
| `no-remote-deps` | warn | No remote-URL (non-registry) tarball dependencies — npm v12 won't install them without `--allow-remote` |
| `pinned-versions` | warn | No `^`/`~` ranges in package.json dependency sections or `overrides` |
| `lockfile-sync` | error | package.json and the lockfile agree (name/version, every declared dep present with matching range, no lockfile-only leftovers) |
| `no-orphan-packages` | warn | No lockfile entries unreachable from the dependency graph (fix with `npm-check prune`) |
| `unused-dependencies` | warn | Every declared dependency is imported by the application source (heuristic; `includeDev`/`ignore` options) |

Additional rules validate the manifest and config files (`valid-package-json`, `valid-npmrc`) and pnpm projects (`valid-pnpm-workspace`, `valid-pnpm-field`, `no-fund`).

**Configuration file:**

Config resolution follows the suite-wide convention: `--config <file>` (or, when omitted, a `.dependably-check` discovered by walking up to the repo root) is the **primary** source — npm-check reads its `common` then `npm` sections for `rules`/`maxWarnings`. A tool-local `.npm-checkrc.json` (then `npm-check.config.json`) in the current directory is a **fallback** that overrides the shared settings. CLI flags override file settings. Rule entries are `"error"`, `"warn"`, `"off"`, or `[severity, options]`:

```json
{
  "maxWarnings": -1,
  "rules": {
    "lockfile-version":  ["error", { "minVersion": 3 }],
    "integrity-hygiene": ["error", { "allowSha1": false }],
    "secure-resolved":   ["error", { "allowedHosts": ["registry.npmjs.org", "npm.mycorp.example.com"] }],
    "pinned-versions":   ["warn", { "sections": ["dependencies", "devDependencies"], "ignore": [] }],
    "unused-dependencies": ["warn", { "includeDev": false, "ignore": [] }]
  }
}
```

Exit codes follow the [shared convention](#exit-codes) (`1` also covers warnings exceeding `maxWarnings` / `--fail-on count=`).

> The CI gate is the suite-wide `--fail-on <key>=<value>` (repeatable): `--fail-on count=<N>` fails when the warning count exceeds N (`count=0` fails on any warning), and `--fail-on severity=<level>` fails on findings at/above a severity. The older `--strict` / `--max-warnings` / `--min-severity` / `--fail-on-deprecated` flags are **deprecated aliases** that still work but emit a notice and will be removed.

## Fix-checksums command

Fills missing, placeholder (`sha512-PLACEHOLDER`), and weak (`sha1-`) integrity hashes with the authoritative `dist.integrity` from each package's registry. The registry is derived per-package from the entry's `resolved` URL, so scoped/private registries work without configuration.

```bash
npm-check fix-checksums                  # Dry-run: show what would change
npm-check fix-checksums --write          # Apply (creates backups)
npm-check fix-checksums --concurrency 16 --timeout 5000
npm-check fix-checksums --local-fallback # Hash node_modules copies when registry fails
```

Exits `1` if any candidate hashes remain unresolved (CI-gateable). Git, file-directory, linked, workspace, and bundled dependencies are skipped — they legitimately lack registry hashes. v1 lockfiles are not supported; run `npm-check migrate 3` first.

> **Local fallback caveat:** hashes produced by `--local-fallback` are computed from `node_modules` directories and are **not** npm tarball hashes — `npm ci` will fail integrity verification against the registry for those entries. Use only for air-gapped/internal verification; such changes are tagged `local-directory` in the output.

## Pin command

Rewrites caret (`^`) and tilde (`~`) ranges in `package.json` to the exact versions already resolved in the lockfile, and keeps the lockfile's root entry (`packages[""]`) in sync so `npm install` sees no mismatch. Covers the `overrides` field too.

```bash
npm-check pin                            # Dry-run from the current directory
npm-check pin --write                    # Apply (backs up both files)
npm-check pin ./packages/app --write     # Operate on another directory
npm-check pin --include-peer             # Also pin peerDependencies (off by default)
```

Complex ranges (`>=`, `||`, `1.x`, `*`, dist-tags), git/file/workspace/alias specs, and dependencies missing from the lockfile are left untouched and reported with reasons.

## Prune command

Removes orphaned packages from the lockfile — entries unreachable from the root package (or any workspace) by following dependency edges with npm's node_modules resolution rules. Orphans typically accumulate after bad merges or hand-edits.

```bash
npm-check prune                          # Dry-run: list orphaned entries
npm-check prune --write                  # Remove them (creates a backup)
```

Reachability follows `dependencies`, `optionalDependencies`, and `peerDependencies` of every installed package (plus `devDependencies` of the root and workspaces), resolves nested `node_modules` shadowing nearest-first, and follows workspace `link:` entries. v1 lockfiles are not supported; run `npm-check migrate 3` first. On v2 lockfiles the legacy `dependencies` tree is left untouched (npm regenerates it) with a recommendation to migrate to v3.

## Unused command

Flags dependencies declared in `package.json` that the application never imports — candidates for removal.

```bash
npm-check unused                         # Scan the current directory
npm-check unused ./my-app --include-dev  # Also check devDependencies
npm-check unused --format json           # Machine-readable output
```

The scan walks source files (`.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.tsx`, `.vue`, `.svelte`, skipping `node_modules`, `dist`, etc.) for `require()`, `import`, dynamic `import()`, and re-export specifiers. Packages mentioned in npm scripts count as used (CLI tools), and `@types/foo` counts as used when `foo` is. Results are **heuristic and report-only** — packages loaded via config files or runtime magic can be false positives, so nothing is removed automatically.
