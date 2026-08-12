# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.9.0] - 2026-08-11

### Added
- **New `resolved-registry-pin` audit rule — "can everyone who has to build this repo actually reach the hosts in the lockfile?"** npm-check had no way to express *this lockfile must be installable by everyone who has to build it*. The existing host-aware rules (`secure-resolved`, `no-remote-deps`) both consult `allowedRegistryHosts` to answer a different question — *is this host a legitimate, trusted registry?* — and trust is orthogonal to portability: an org's own private mirror is trusted, yet unreachable from a public CI runner or an external contributor's machine. The gap is not academic. A plain `npm install` from a machine whose user-level `~/.npmrc` defaults to a private mirror silently rewrites the lockfile's `resolved` URLs to that host, and every trust-based rule passes the result clean. `.npmrc` cannot serve as the guard either — it is gitignored (it commonly carries auth tokens), so it is local-only and never reaches CI.
  - **Opt-in:** the rule defaults to `error` severity but ships with an empty `hosts` list, and empty `hosts` means off — a project that legitimately installs from a private registry is unaffected and no existing config changes behavior. Enable it with `"resolved-registry-pin": ["error", { "hosts": ["registry.npmjs.org"] }]`.
  - `hosts` is rule-local and deliberately **not** unioned from `common`, unlike `allowedRegistryHosts`: union is right for a trust allowlist (shared policy plus local additions) and wrong for a pin, since a list that can only widen cannot express one. Git/file/link/workspace entries are skipped — they resolve outside any registry by definition, and `no-git-deps`/`secure-resolved` own them — and the rule no-ops on pnpm lockfiles, which carry no `resolved` URLs at all.
- **The vendored `.dependably` conformance corpus is now replayed by the test suite.** npm-check authored most of the shared cases and was the only tool in the suite that never ran them, so the corpus could not catch npm-check drifting from the contract it defines. `tests/unit/conformance-dependably.test.js` materializes each case into a temp repo and drives `loadAuditConfig()` — the real entry point rather than the primitives underneath it, so a broken loader cannot pass a case. Cases npm-check cannot replay are waived by name with a reason, cases it genuinely fails are recorded as divergences that trip the suite once fixed, and a coverage assertion fails on any case that is neither, so a newly vendored case cannot land unrun.
  - The adapter binds the corpus's **symbolic vocabulary** (spec §12) rather than replaying cases verbatim: the seven placeholders are resolved from npm-check's real vocabulary (`SECTION_KEY`, the deprecated alias, the rule registry) instead of restated, `$rule1`/`$rule2` are derived as rule ids that do not already default to `error` (so a case pinning `error` cannot pass without the config actually being read), and the §12.5 capability tokens are answered from `APPLICABLE_SELECTORS`. An unanswerable token throws rather than reading as satisfied, and an unbound-placeholder check (§12.7) runs on every case, waived ones included.
  - Current accounting against the 29-case corpus: **25 replayed, 4 waived** (each authored in another tool's literal vocabulary), **0 known divergences, 0 capability skips**.

### Fixed
- **A sibling tool's rule id in `.dependably`'s `common` section no longer fails the load.** `common.rules` was merged into npm-check's rule map before the ids were validated against its own registry, so any sibling configuring one of its own rules there made the shared config unloadable with `UNKNOWN_RULE`. The spec makes an unknown rule id in `common` legal — it belongs to another tool — and an error only in the tool's own section, which is how npm-check already treated unknown ids in `exceptions`. Ids from `common` that npm-check does not know are now dropped; a typo in the `npm-check` section still errors as before. Found by replaying the shared conformance corpus, which had recorded it as a known divergence.
- **An unrecognized key inside `.dependably`'s `common` section no longer warns.** `common` is shared with the rest of the Dependably suite, so npm-check was emitting `UNKNOWN_KEY` for every sibling tool's legitimate key there — nucheck's registry keys, pdbcheck's `terms`, and so on — noise the reader cannot act on. The spec (§8) makes an unknown key a warning only inside the tool's *own* section and ignores it in `common`. npm-check already tolerated unknown *rule ids* in `common` for exactly that reason, so this also removes an internal inconsistency. A typo in the `npm-check` section still warns as before.
- **`update-notifier` in a project `.npmrc` no longer warns as an unknown key.** It is a real npm config (`npm config get update-notifier` returns `true` by default) but was absent from `valid-npmrc`'s known-key set, so any `.npmrc` disabling it drew a spurious `NPMRC_UNKNOWN_KEY`.

### Changed
- **The `.dependably` spec, its JSON Schema, and the conformance corpus now live in the [dependably-spec](https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec) repository.** They governed six tools while living in this one, so a contract change had to be filed against a peer implementation and drift between vendored copies was invisible. `docs/dependably-config-spec.md`, `docs/dependably-config-unification-plan.md`, and `schema/dependably-v1.json` are removed here; `conformance/dependably/` is now a vendored copy pinned to an upstream commit recorded in `conformance/VENDOR.md` (currently `55ba249c`), and changes to it belong upstream. No runtime behavior changes — nothing under `src/` ever read these files.
- **High-severity advisories cleared from the dev dependency tree.** `sonarqube-scanner` 3.5.0 → 5.0.0, which pins `adm-zip` 0.6.0 and clears GHSA-xcpc-8h2w-3j85 without forcing a major on a transitive dep; `js-yaml` overridden 4.2.0 → 4.3.1 (GHSA-52cp-r559-cp3m, GHSA-5p4m-2wfm-xmqj); `brace-expansion` split by major, since the two consumer lines want different ranges — a root override at 5.0.9 for the `^5.0.5` consumers and the existing nested overrides at 1.1.18 for the `^1.1.7` ones (GHSA-3jxr-9vmj-r5cp, GHSA-mh99-v99m-4gvg, GHSA-rgw5-rvv9-x895). The lockfile refresh also lifted `fast-uri`, `ip-address`, and `tar`. **No published-artifact impact:** every flagged package is dev-only — `files` ships `src/`, `bin/`, README and LICENSE, and the sole runtime dependency is `yaml`.
- **CI: the vendored conformance corpus is verified against an offline manifest** (`conformance/corpus.sha256`) rather than by cloning the spec repo, so the check needs no network and cannot be skipped by an unreachable upstream. The publish job's push and read-back credentials are also split, so the read-back cannot succeed on the publish token alone.

## [1.8.0] - 2026-07-14

### Changed
- **`pinned-versions` now defaults to `error` (was `warn`).** A warn-severity finding never fails `npm-check audit` (warnings alone pass by default), so unpinned `^`/`~` ranges in `package.json` were never actually gated by a default `audit` run or a pre-commit hook/CI job built on it — only `--strict`/`--fail-on count=0` caught them. Restore the previous behavior for a repo via `.dependably`'s `npm-check.rules.pinned-versions: "warn"` (or `"off"`), `.npm-checkrc.json`, or `--rule pinned-versions:warn`.

## [1.7.1] - 2026-07-03

### Added
- **Repo-root `.dependably` config.** npm-check now ships its own `.dependably` file (the shared, cross-tool config this project provides the reference implementation of — see the [config spec](https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec/-/blob/main/docs/dependably-config-spec.md)), declaring `dependably.northwardlabs.ca` as a trusted registry host under `common.allowedRegistryHosts`. This is a defensive/documentary addition for suite consistency with the other Dependably tools; this repo's own `package-lock.json` already resolves everything from `registry.npmjs.org`, so no active `secure-resolved`/`no-remote-deps` finding was being suppressed.

### Fixed
- **Console-output UX pass (moonlitlabs/npm-check#33).**
  - Progress redraw frames no longer flood piped/CI/`tee`'d logs: when stdout is not a TTY, the CLI's progress reporter degrades from an animated `\r` bar to periodic one-line milestones (0/25/50/75/100%) on stderr, instead of emitting one `\r` frame per percentage change (~35KB of redraw frames on a real run). New `formatCliProgressUpdate()` in `progress-reporter.js`.
  - The `report` command's "Integrity (registry)" summary no longer double-counts an unresolved (couldn't-check) entry as both "mismatched" and "unresolved" — `checkIntegrity()`'s fail-closed bookkeeping folds it into both `unresolved` and `failed`, which previously inflated the "mismatched" bit and orphaned the detail line from either count. The summary's "mismatched" bit and the detail section now derive from the same set; each detail line is prefixed `mismatched:` or `unresolved:`.
  - "Resolved URLs" and "Remote-URL deps" no longer report the same package twice for one root cause (an untrusted/unrecognized registry host trips both the `secure-resolved` and `no-remote-deps` audit rules independently). The report now cross-references the two sections and collapses "Remote-URL deps" duplicates into one grouped-by-host finding (`--verbose` restores the full per-package listing).
  - Each report detail line is now prefixed with its severity (`error`/`warn`, matching the standalone `audit` command's vocabulary), and the closing totals line adds a next-step hint when warnings alone didn't fail the run.
- **Console-output UX follow-up (moonlitlabs/npm-check#35).**
  - The `report` command's "Known vulnerabilities" summary and section-header count now agree on unit: the summary reads `N vulnerable packages (M advisories)` and the header reads `M advisories in N packages` — previously the summary counted packages while the header's `(M)` counted advisories with neither labeled, so the same run showed two different-meaning numbers.
  - Entries a registry-backed scan (integrity/vuln/deprecated) couldn't check at all — registry unreachable, endpoint unsupported, etc. — no longer get filed under whichever section's scan happened to run last (previously landing in "Deprecated packages" regardless of which check produced them). They're now collected in one new, shared "Unresolved (could not check)" section, each line tagged with the check that couldn't complete; a section like "Known vulnerabilities" can report a clean `ok` even while its registry call failed, with the failure surfaced (and still gating the exit code) via "Unresolved" instead.
  - The section summary table now has a fixed status column — `ok` / `N warnings` / `N errors` / `skipped` — with one consistent leading glyph per state (`✓`/`⚠`/`✖`/`·`), replacing each check's own invented phrasing (`valid`, `N/A (npm)`, `all TLS / trusted`, `skipped (no approved-licenses.csv)`, `none`, …) and the previously-unexplained `·`-prefixed rows. The check-specific detail is preserved in a trailing parenthetical after the status.

## [1.7.0] - 2026-07-02

### Added
- **`overrides` support across pin / audit / validate.** A floating `^`/`~` in the package.json `overrides` field was previously invisible — neither flagged nor pinned — silently defeating an otherwise fully-pinned manifest. Now:
  - `npm-check pin` rewrites caret/tilde ranges in npm `overrides` (nested `.`/child form) to their lockfile-resolved versions, pinning only when the name resolves to a single version tree-wide (a name present at multiple versions is skipped `ambiguous-resolution` rather than mis-pinned). `$`-references are left alone; `pnpm.overrides` is flagged but not auto-pinned (pin refuses pnpm lockfiles).
  - The `pinned-versions` audit rule (now npm + pnpm flavored) flags unpinned caret/tilde in both `overrides` and `pnpm.overrides`, by full path.
  - New shared `walkOverrides()` helper (`overrides.js`) descends the nested npm form and the flat pnpm form, stripping `@version` selectors and skipping `$`-references.
- **Wider package.json config-field validation** in `valid-package-json`: override-range syntax in `overrides`/`pnpm.overrides`; the range-carrying pnpm sub-fields (`packageExtensions` inner `dependencies`/`optionalDependencies`/`peerDependencies`, `peerDependencyRules.allowedVersions`, `allowedDeprecatedVersions` — validated but never flagged/pinned, since those ranges are loose by design); and `bundleDependencies`/`bundledDependencies` (array of valid names, warn when a bundled name isn't declared in dependencies). New codes: `PJ_INVALID_OVERRIDES`, `PJ_INVALID_OVERRIDE_RANGE`, `PJ_INVALID_RANGE`, `PJ_INVALID_PKG_EXTENSION`, `PJ_INVALID_BUNDLE_DEPS`, `PJ_INVALID_BUNDLE_DEP_NAME`, `PJ_BUNDLE_DEP_NOT_IN_DEPS`.

### Fixed
- **Self-audit hardening** — a broad pass across the toolkit closing 30+ correctness/robustness findings. Highlights: SSRI-aware integrity comparison that rejects a lockfile carrying a second, non-registry `sha512` token (tamper vector); all conversion paths in the migrator corrected and covered by round-trip tests; the fixer no longer mutates caller input or stamps placeholder integrity on git/bundled/link/workspace/file deps (incl. npm 6 hosted-git shorthand); registry transport hardened against hostile lockfiles (response size cap, wall-clock deadline, `http`/`https` scheme selection, scoped-name URL encoding, host allowlist) with abbreviated-packument fetches so large packuments still resolve; per-version advisory attribution so an advisory only fails the versions it actually affects; the suite-wide `--fail-on severity=` gate applied across all report sections (was vuln-only); id-less advisories no longer silently dropped; WorkerPool deadlock / listener-leak / clean-exit-hang fixed; pnpm v5/v6 leading-slash depPath parsing; and numerous validator/npmrc/package-json/checker/checksum-fixer edge-case fixes.

### Changed
- CI: all GitHub Actions `uses:` steps are pinned by commit SHA (supply-chain hardening); added an `exports` map and `publishConfig.access: "public"` to package.json.
- Internal refactors to clear static-analysis complexity warnings (extract-method only, no behavior change).

### Security
- Hardened the `vuln` semver range matcher's regex against super-linear (ReDoS) backtracking by switching to the canonical dot-separated-identifier grammar; unparseable/malformed ranges stay conservative (a warning, never a false-clean).

## [1.6.1] - 2026-06-22

### Added
- **Tag-driven GitHub Release with SLSA build provenance (L2).** Pushing a `v*` tag creates a GitHub Release, attaches the packed `.tgz`, and produces a signed `attest-build-provenance` attestation over that exact tarball; npm publish gains `--provenance` (OIDC → sigstore) when `NPM_TOKEN` is set.

### Changed
- CI runs on Node 24 runners (dropped EOL Node); fixed a Jest CI hang and runner-image deprecations.

## [1.6.0] - 2026-06-21

### Added
- **Shared `.dependably-check` config** — npm-check now reads a repo-root `.dependably-check` file (JSON, no extension) IN ADDITION to its existing `.npm-checkrc.json` / `npm-check.config.json`. Discovery walks up from the working directory to the repo root (stopping at a `.git` directory or the filesystem root). The relevant data for this tool is the union of `common.allowedRegistryHosts` and `npm.allowedRegistryHosts` (other tool sections such as `nuget`/`python` and unknown keys are ignored). New `findSharedConfig()`, `loadSharedConfig()`, and `extendAllowedHosts()` APIs and a `SHARED_CONFIG_FILENAME` constant.
- **Additive `allowedRegistryHosts`** — hosts from `.dependably-check` are ADDED to the `secure-resolved` rule's trusted-host allowlist rather than replacing it, so the built-in `registry.npmjs.org` (public npm) always stays trusted while private domains (e.g. `dependably.northwardlabs.ca`) become accepted. Config precedence is built-in defaults < `.dependably-check` (shared) < tool config (`.npm-checkrc.json` / `npm-check.config.json`) < CLI flags; an explicit `secure-resolved.allowedHosts` in the tool config still replaces the defaults (existing behavior), and the shared hosts then extend that result. Malformed `.dependably-check` JSON raises an `AuditConfigError` (exit code 2).

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
