# CLI reference

The `npm-check` binary. The file argument is optional and defaults to
`./package-lock.json`. Commands that modify files require `--write` (backups are
created automatically). `--format json` emits machine-readable output.

Subcommands group into three families (`npm-check --help` prints the same grouping):

- **Read & report** (inspect; never mutate the lockfile): `report` (default), `validate`, `vuln`, `deprecated`, `check`, `audit`, `unused`, `imports`
- **Fix & transform** (npm-only; mutate the lockfile with `--write`): `fix`, `fix-checksums`, `upgrade-hashes`, `migrate` (`upgrade` is an alias of `migrate 3`), `pin`, `prune`, `dedupe`, `remediate`
- **Backups**: `backups`, `restore`, `clean-backups`

```bash
# Run ALL checks and print one grouped report (the default command)
npm-check                       # ./package-lock.json
npm-check report web/package-lock.json
npm-check --offline             # skip the registry integrity check
npm-check --format json         # machine-readable, for CI
npm-check --verbose             # list every "Remote-URL deps" package individually instead of
                                 # the default grouped-by-host cross-reference against "Resolved URLs"

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

# Report the tree's import facts as a JSON document (data for another tool)
npm-check imports ./src > imports.json

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

## Progress output

Registry-backed commands (`check --check hash`, `vuln`, `deprecated`, `report`) write progress to **stderr**, never stdout — stdout stays report-only. On a real terminal this is an animated redraw-in-place bar; when stdout is not a TTY (piped, redirected, `tee`'d, CI logs) it degrades to periodic one-line milestones (0/25/50/75/100%) instead, so a piped/CI run's log isn't flooded with redraw frames.

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

**The `documentType` rule.** A findings document has **no** `documentType` key — schema `1.0` predates the split and the findings envelope above is unchanged. The one other document npm-check emits, the [import-facts document](#imports-command), carries `documentType: "imports"` and no `findings`. A consumer reads "absent" as findings and `"imports"` as facts; it never has to infer the payload from whichever key happens to be present.

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
npm-check audit --config ./.dependably
npm-check audit --show-suppressed         # List findings silenced by .dependably exceptions
```

**Default rules:**

| Rule | Default | What it checks |
|---|---|---|
| `lockfile-version` | error | `lockfileVersion` is at least 3 (configurable `minVersion`) |
| `valid-structure` | error | Lockfile passes structural validation |
| `integrity-hygiene` | error | No missing, placeholder, or sha1 integrity hashes (git/file/link/bundled deps exempt) |
| `secure-resolved` | error | No `http://` resolved URLs; registry hosts limited to an allowlist (default: `registry.npmjs.org`) |
| `resolved-registry-pin` | error | Every `resolved` URL points at one of the registry hosts the project pins to. **Opt-in: empty `hosts` means off.** Answers *portability* ("can everyone who builds this reach these hosts?"), not *trust* — a private mirror can be trusted and still unreachable from CI. Configure with `["error", { "hosts": ["registry.npmjs.org"] }]`; `hosts` is rule-local and is **not** unioned from `common` |
| `install-scripts` | warn | No dependency declares a lifecycle install script (`hasInstallScript`) unless approved — via the rule's `allow` option **or** npm v12's package.json `allowScripts` map. Flags pending/denied scripts that npm v12 won't run |
| `no-git-deps` | warn | No git dependencies — npm v12 won't install them without `--allow-git` |
| `no-remote-deps` | warn | No remote-URL (non-registry) tarball dependencies — npm v12 won't install them without `--allow-remote` |
| `pinned-versions` | error | No `^`/`~` ranges in package.json dependency sections or `overrides` |
| `min-release-age` | warn | A supply-chain cooldown is configured, so a version published moments ago is never installed. npm: `min-release-age` in `.npmrc` (**days**, npm ≥ 11.10); pnpm: `minimumReleaseAge` in `pnpm-workspace.yaml` (**minutes**, pnpm ≥ 10.16). Normalized to days internally; `minDays` defaults to **3**. Also flags a blanket `minimumReleaseAgeExclude` (`*`) that voids the policy |
| `lockfile-sync` | error | package.json and the lockfile agree (name/version, every declared dep present with matching range, no lockfile-only leftovers) |
| `no-orphan-packages` | warn | No lockfile entries unreachable from the dependency graph (fix with `npm-check prune`) |
| `unused-dependencies` | warn | Every declared dependency is imported by the application source (heuristic; `includeDev`/`ignore` options) |

Additional rules validate the manifest and config files (`valid-package-json`, `valid-npmrc`) and pnpm projects (`valid-pnpm-workspace`, `valid-pnpm-field`, `no-fund`).

**Configuration file:**

Config resolution follows the suite-wide convention: `--config <file>` (or, when omitted, a **`.dependably`** discovered by walking up to the repo root — `.dependably-check` is a deprecated alias, and `.dependably` wins when both exist) is the **primary** source — npm-check reads its `common` then **`npm-check`** section (`npm` is a deprecated section alias). Sections merge by the unified rule: `rules` merge per id, the list keys (`exclude`, `exceptions`, `allowedRegistryHosts`) union, and scalars/`failOn` override. A tool-local `.npm-checkrc.json` (then `npm-check.config.json`) in the current directory is a **fallback** that overrides the shared settings. CLI flags override file settings. Rule entries are `"error"`, `"warn"`, `"off"`, or `[severity, options]`:

```json
{
  "maxWarnings": -1,
  "rules": {
    "lockfile-version":  ["error", { "minVersion": 3 }],
    "integrity-hygiene": ["error", { "allowSha1": false }],
    "secure-resolved":   ["error", { "allowedHosts": ["registry.npmjs.org", "npm.mycorp.example.com"] }],
    "pinned-versions":   ["error", { "sections": ["dependencies", "devDependencies"], "ignore": [] }],
    "unused-dependencies": ["warn", { "includeDev": false, "ignore": [] }]
  }
}
```

**Exceptions and `failOn`** (unified `.dependably` format — see the [config spec](https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec/-/blob/main/docs/dependably-config-spec.md)): use the standard `failOn` gate and `exceptions` to suppress specific findings so the run doesn't fail wholesale, without turning a rule off or excluding a whole file:

```json
{
  "npm-check": {
    "failOn": { "count": 0 },
    "exceptions": [
      { "rule": "install-scripts", "package": "esbuild", "reason": "vendored build tool; reviewed", "expires": "2027-01-01" },
      { "rule": "unused-dependencies", "package": "tslib", "reason": "injected by tsc importHelpers" }
    ]
  }
}
```

Each exception needs a `rule`, at least one selector (npm-check matches `package` and `id`), and a non-empty `reason`; `expires` (`YYYY-MM-DD`) makes it inert afterward. Suppressed findings don't gate but are still counted (`--show-suppressed` lists them); unused/expired exceptions warn on stderr. `failOn: {count}` is the standard form of `maxWarnings`; `failOn: {severity}` gates on a finding-severity level.

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

## Imports command

`imports` exports what a JavaScript/TypeScript/Svelte tree imports, as data for another tool. It is a **report, not a check**: it defaults to `--format json`, a successful scan always exits `0`, and it never exits `1` — there is nothing in it to gate on. It is the scan [sbom-reach](https://github.com/dependably/sbom-reach) builds its npm reachability verdicts from; the verdicts themselves are not here.

```bash
npm-check imports                        # the current directory, as JSON
npm-check imports ./src > imports.json   # a tree; the document goes to stdout
npm-check imports ./src --format human   # the summary only
npm-check imports ./src --no-module-graph            # do not follow imports through node_modules
npm-check imports ./src --max-files 5000 --max-file-bytes 500000   # walk budgets (defaults 25000 / 1500000)
```

The command needs the optional **`typescript`** peer dependency (any 5.6+ release; it is the parser). When it is not installed the run exits `2` with `TYPESCRIPT_MISSING` and an install hint. A missing target directory and an invalid flag value are also `2`. No network access, ever.

**Language facts only.** The document names packages by the name and version on disk or in a lockfile, and nothing else: no purls, no verdicts, no severities. Mapping a resolved copy to an SBOM component, and deciding what "imported" means for a vulnerability, is the consumer's job.

### The document

For a tree with one file `src/index.js` reading `import { a } from 'lib-a'; a();`, where `lib-a` is installed and itself imports `leaf`:

```json
{
  "tool": "npm-check",
  "toolVersion": "1.10.1",
  "schemaVersion": "1.1",
  "documentType": "imports",
  "target": "./src",
  "summary": {
    "scanned": 1,
    "analyzed": 1,
    "unanalyzable": 0,
    "imports": 1,
    "moduleGraph": { "filesParsed": 2, "reached": 2, "unresolved": 0, "truncated": false },
    "exitCode": 0
  },
  "workspace": {
    "firstPartyNames": ["app"],
    "depScopes": [{ "name": "lib-a", "scope": "runtime" }],
    "aliasPrefixes": [],
    "aliasScope": [{ "dir": "vendor", "prefixes": ["@vendor"] }],
    "devDeclaredBy": [{ "name": "leaf", "manifests": ["tools/package.json"] }],
    "sourceFiles": 1,
    "diagnostics": []
  },
  "imports": [
    {
      "file": "src/index.js",
      "dynamicUnknown": 0,
      "parseErrors": [],
      "sites": [
        {
          "specifier": "lib-a",
          "package": "lib-a",
          "line": 1,
          "snippet": "import { a } from 'lib-a';",
          "kind": "import",
          "bindings": ["a"],
          "referenced": ["a"],
          "opaque": false,
          "installed": { "name": "lib-a", "dirName": "lib-a", "version": "1.0.0", "root": "node_modules/lib-a" }
        }
      ]
    }
  ],
  "moduleGraph": {
    "enabled": true,
    "filesParsed": 2,
    "filesSkippedForSize": 0,
    "unresolved": 0,
    "truncated": false,
    "nodeModulesMissing": false,
    "weakPackages": [],
    "reached": [
      {
        "key": "leaf@2.0.0\u0000node_modules/leaf",
        "name": "leaf", "dirName": "leaf", "version": "2.0.0", "root": "node_modules/leaf",
        "chain": ["lib-a@1.0.0\u0000node_modules/lib-a", "leaf@2.0.0\u0000node_modules/leaf"],
        "dynamic": false, "incomplete": false,
        "importers": [
          { "file": "node_modules/lib-a/index.js", "line": 1, "snippet": "import * as leaf from 'leaf';", "kind": "import",
            "bindings": ["go"], "referenced": ["go"], "opaque": false, "fromPackage": "lib-a@1.0.0\u0000node_modules/lib-a" }
        ]
      },
      { "key": "lib-a@1.0.0\u0000node_modules/lib-a", "...": "..." }
    ],
    "unresolvedByName": []
  },
  "lockfile": {
    "files": ["package-lock.json"],
    "packages": [{ "name": "leaf", "version": "2.0.0", "devDeclared": false }, { "name": "lib-a", "version": "1.0.0", "devDeclared": false }],
    "rootDependencies": ["lib-a@1.0.0"],
    "edges": [{ "from": "lib-a@1.0.0", "to": "leaf@2.0.0" }],
    "diagnostics": []
  },
  "unanalyzable": []
}
```

`imports` lists **every first-party file that was read**, sorted by path, each with its sites in source order — a file that parsed and imports nothing is still listed, with an empty `sites`, because "searched and imports nothing" and "never searched" are different facts. Every path is relative to `target`, with `/` separators, and the module-graph keys (`name@version` + `\u0000` + the package root) are relativized the same way, so the document is deterministic and comparable across machines.

`summary` counts what the document contains:

| Key | Meaning |
| --- | --- |
| `scanned` | First-party source files the workspace discovery found (`.ts`, `.tsx`, `.mts`, `.cts`, `.js`, `.jsx`, `.mjs`, `.cjs`, `.svelte`; `node_modules`, `.git`, dot-directories and anything the tree's own `.gitignore` ignores excluded — **not** `dist`/`build`/`out`/etc. by name; see below). |
| `analyzed` | Of those, files read and parsed — the length of `imports`. |
| `unanalyzable` | Entries in `unanalyzable`, of every kind. Non-zero means the search was incomplete. Unlike pycheck's, this is **not** `scanned − analyzed`: a `file-partial` entry is also analyzed, and a `node-modules-file` or `walk` entry is not a first-party file at all. |
| `imports` | Import sites summed over every first-party file. |
| `moduleGraph` | `filesParsed` node_modules files parsed, `reached` installed package copies reached from first-party code, `unresolved` imports the resolver could not follow, and whether the walk was `truncated` by its file budget. All zero when `--no-module-graph`. |
| `exitCode` | The process exit code, `0` for every successful scan. |

Each import site:

| Field | Meaning |
| --- | --- |
| `specifier` | As written. |
| `package` | The npm package the specifier names (lower-cased; `lodash/get` → `lodash`, `@scope/pkg/sub` → `@scope/pkg`), or `null` for a relative/absolute path, a builtin, a `#imports` key, a `data:`/`file:` URL, or a tsconfig/jsconfig `paths` alias. A workspace sibling is still named — deciding it is first-party wiring is the consumer's, via `workspace.firstPartyNames`. |
| `line` | 1-based. |
| `snippet` | The statement's text, whitespace-collapsed, capped at 200 characters. |
| `kind` | `import`, `require`, `dynamic-import`, `export-from`, or `type-only-import`. A type-only import never loads code at runtime and is never an edge of the module graph. |
| `bindings` | The names the site introduces: named-import / named-export-from **original** names (`import { a, b as c }` → `a`, `b` — never the local alias), `require()`/`import()` destructured names, and exactly one level of property access on a default/namespace import's local identifier (`_.template(x)` → `template`). Parse-level only: no type checker, no cross-file aliasing, nothing past one property level. Empty means "no binding names observed here" — never proof that nothing was used; see `opaque`. |
| `referenced` | The subset of `bindings` whose local identifier is actually referenced somewhere in the module body. Any occurrence counts (call, argument, spread, re-export, shorthand property) — this is "referenced", not "called" — and a shadowing local is deliberately **not** excluded. Over-reporting use is the safe direction. |
| `opaque` | `true` when the site's default/namespace binding (or a bare `export * from`) is used in a way a parse-level scan cannot resolve to specific property names: assigned to another variable, passed as an argument, spread, exported, returned, accessed with a computed key, **or called / constructed / tagged / rendered directly** (`axios(...)`, `new X()`, `` tag`...` ``, `<X/>`). An opaque site "could use anything": a consumer must never read it as evidence that some symbol was **not** used. |
| `installed` | The installed package copy the specifier resolved **into**, when it did: its `package.json` `name`, the node_modules `dirName` (differs for an aliased install such as `"string-width-cjs": "npm:string-width@^4"`), `version`, and `root`. Present when the resolver landed anywhere in a package — a fact, not a match; compare `name`/`dirName` against `package` before treating it as the installed copy of the package the site names. Absent for an alias, a builtin, a first-party target, or a package that is not installed. |

Each `imports` entry also carries `dynamicUnknown` — the number of `require()`/`import()` calls in that file whose argument is not a string literal (a package loaded that way cannot be named) — and `parseErrors`, non-empty only for a `.svelte` file whose `<script>` extraction reported a problem (its sites are still present; see `unanalyzable` below).

`workspace` is what the tree declares about itself: every `package.json`'s `name` (`firstPartyNames`), the dev/runtime scope each manifest gives its dependencies (`depScopes`, "runtime anywhere wins" across manifests), the tsconfig/jsconfig `paths` alias bases (`aliasPrefixes` — the whole-tree union, **reporting only**), the count of first-party source files, and `diagnostics` (an unparseable manifest or tsconfig, named and skipped). Two fields carry provenance a consumer decides with rather than just reports: `aliasScope` is the live per-file alias answer (`{dir, prefixes}[]`, one layer per tsconfig/jsconfig that declared `paths`, `dir` target-relative) — a `paths` map governs only the project that declares it, so deciding whether a specifier is aliased means finding the layer whose `dir` is that file's own directory or an ancestor of it, never consulting `aliasPrefixes` directly; `devDeclaredBy` (`{name, manifests}[]`) names, for every package no manifest declares runtime anywhere, which manifest path(s) called it a dev dependency — a consumer can then refuse a dev claim from a manifest that does not govern the importing file (see `governedByManifest` in the [API guide](./API.md)).

`moduleGraph` is the statically resolved module graph **through** `node_modules`: every first-party import resolved (Node-style — symlink-aware, so pnpm's `.pnpm` layout works; `exports`/`imports` maps with `import`-vs-`require` conditions; `main`, `module`, `index.*`; `.js`→`.ts` probing) to the installed file it loads, that file parsed with the same scanner, its imports resolved in turn, and so on. It is a *module* graph, not a call graph: an edge means "evaluating this module evaluates that one". One `reached` entry per installed **copy** (`key` = `name@version` + `\u0000` + root — two copies of one version can differ only by location), with the `importers` from outside that package (a package's own internal relative imports are traversed but never listed), the `chain` of keys along which it was first reached, and the honesty flags: `dynamic` (a file in the package has a non-literal `require()`/`import()` — it can load things the walk cannot see), `incomplete` (a file was not parsed, or a relative import inside the package went nowhere — its edges are not all known). `weakPackages` lists the `name@version` of everything flagged either way. `unresolvedByName` records every bare specifier the resolver could not follow, under the package name it asked for, with where and why (at most five sites per name) — an unresolved import is a place a runtime path could hide, and it says exactly which package it wanted. `nodeModulesMissing` is `true` when nothing resolved, something was unresolved, and there is no `node_modules` directory at all: the tree was never installed. `truncated` means the file budget stopped the walk (`--max-files`); packages past the frontier are unobserved, not absent.

`lockfile` is the dependency graph every `package-lock.json` and `pnpm-lock.yaml` under the tree records (outside `node_modules`; several lockfiles merge into one graph): the resolved `packages` (each with the `license` the lockfile carries, a tri-state `devDeclared` — `true` reachable only through devDependencies, `false` some path reaches it without a dev edge, absent when the lockfile says nothing — and `scope: "optional"` only when npm asserts exclusivity), the `rootDependencies` the project's own manifests depend on directly, the `edges` among the closure (hoisting-accurate for npm; peer-suffix-stripped for pnpm), the `files` that were read, and `diagnostics` (`unparseable … at <file>: <why>`, or `NO_LOCKFILE`).

### `unanalyzable`

Every path the scan could not read or would not follow appears in `unanalyzable` with a `kind` and a `reason`, and is counted in `summary`. The list is always present — empty when nothing was skipped. A scan that hits one still succeeds and reports everything else.

```json
"unanalyzable": [
  { "file": "src/locked.js",                        "kind": "file",              "reason": "unreadable: EACCES" },
  { "file": "src/Broken.svelte",                    "kind": "file-partial",      "reason": "line 3: Expression expected." },
  { "file": "node_modules/typescript/lib/typescript.js", "kind": "node-modules-file", "reason": "too large to parse: 9313231 bytes exceeds the 1500000-byte limit" },
  { "file": "node_modules",                         "kind": "walk",              "reason": "file budget 25000 reached; 312 resolved file(s) past that frontier were not parsed, so packages they load are unobserved, not absent" }
]
```

| Kind | Meaning |
| --- | --- |
| `file` | A first-party source file that could not be read. Its imports are unknown; it appears in neither `imports` nor the graph. |
| `file-partial` | A first-party `.svelte` file whose `<script>` extraction reported a problem — the extracted text failed to parse, or a `<script`/`</script>` tag was found outside every span the extraction accounted for. Its sites **are** in `imports`; what this entry says is that their absence for some package is not a clean negative. |
| `node-modules-file` | A `node_modules` file the walk resolved but did not parse (unreadable, or over `--max-file-bytes`). The package it belongs to is `incomplete`. |
| `walk` | The walk stopped on `--max-files`; everything past the frontier is unobserved. |

This is the part that matters most: absence of evidence is only a negative if the search actually ran. A file that could not be read used to be skipped silently by the consumer; now it is named.

**What a scan does not look at**, so you can reason about what was not searched: `node_modules`, `.git`, dot-directories, and anything the tree's own `.gitignore` ignores are excluded from the first-party scan by policy (a deliberate, documented choice, so they are *not* listed in `unanalyzable`); symbolic links are not followed during discovery; and only the nine source extensions above are picked up. **A directory name (`dist`, `build`, `out`, `coverage`, `vendor`, …) is never, by itself, evidence that its contents are generated** — only `.gitignore` decides that, applied with git's own precedence (every `.gitignore` in the tree, not just the root one, deepest match wins, including a nested `!re-include`). A project that gitignores `dist/` gets it excluded; one whose real source lives in `build/` and does not gitignore it gets `build/` scanned as first-party code. When that happens, `workspace.diagnostics` carries an `OUTPUT_DIR_SCANNED` note naming which such directory (from `OUTPUT_SHAPED_DIRS`: `build`, `coverage`, `dist`, `out`, `vendor`) was read — a note, not a warning, since it means the scan looked at *more* of the tree, not less; if one of those names also collides with an unrelated npm package, that package's finding is reported `unknown` rather than a false negative. Inside `node_modules` the walk follows resolved imports only — an installed package nothing imports is not visited, and is reported through `lockfile`, not `moduleGraph`.
