# `.dependably` — Unified Configuration for the Dependably Suite

**Design spec + cross-repo implementation plan**
Tools: `npm-check` (checker-npm), `nucheck` (checker-nuget), `pycheck` (checker-python), `cslint` (cslint), `codemetrics` (dotnet-codemetrics).
Status: PLAN (v1). Date: 2026-07-03.

---

## 0. Summary of firm decisions

| # | Decision |
|---|----------|
| 1 | Canonical file name is **`.dependably`** (JSON, no extension), at repo root. `.dependably-check` remains a **deprecated alias for 2 minor releases** of each tool; `.dependably` wins if both exist in the same directory; reading the old name emits one stderr deprecation line. |
| 2 | Section keys are the **tool names**: `common`, `npm-check`, `nucheck`, `pycheck`, `cslint`, `codemetrics`. Legacy keys `npm`, `nuget`, `python` are read as aliases (canonical wins) for the same 2-release window. |
| 3 | One merge rule everywhere: **scalars — tool overrides common; maps (`rules`) — merged per key, tool's entry replaces wholesale; the standard list keys (`exclude`, `allowedRegistryHosts`, `allowedLocalFeeds`, `exceptions`) — UNION** (concat + dedupe; hosts and package names case-insensitively, globs ordinal). |
| 4 | Everything gate-shaped becomes a **`rules` map** (ESLint-style, npm-check's existing grammar: `"ruleId": "error"\|"warn"\|"off"` or `["severity", {options}]`). codemetrics thresholds and cslint toggles are modeled as rules (§B.4). |
| 5 | The CI gate is a standard **`failOn: {severity, count}`** key, mirroring the suite-wide `--fail-on` CLI vocabulary. npm-check's `maxWarnings` becomes a deprecated alias of `failOn.count`. |
| 6 | **`exceptions`** is the standardized suppression grammar (§C): an array of objects `{rule, package?, path?, symbol?, id?, reason, expires?}` — rule id + at least one selector + mandatory `reason`. Suppressed findings never gate but are still counted and reported. Unused or expired exceptions produce warnings. |
| 7 | Validation stance (§D): malformed file / bad value for a known key / unknown rule id **in the tool's own section** → typed error (exit 2 class). Unknown **top-level sections** → ignored (forward compat). Unknown keys inside `common` or the own-tool section → **warning**. Unknown rule ids inside `common` → ignored (they may belong to a sibling tool). |
| 8 | Optional `$schema` (published JSON Schema URL) and `version` (integer, currently `1`; missing ⇒ 1; greater than supported ⇒ typed error). |
| 9 | No flag day. The change is **incrementally adoptable per repo** — aliases make old files readable by new tools; the migration section (§E.7) covers old tools + new files. |
| 10 | C# implementation is extracted once into a small **`Dependably.Config`** NuGet package consumed by nucheck, cslint, codemetrics (they currently carry three near-identical copies of `Discover`/`Parse`). |

---

## A. File rename: `.dependably-check` → `.dependably`

### A.1 Discovery algorithm (unchanged shape, two names)

Walk up from the target/cwd directory. **At each directory level**, check in order:

1. `.dependably` — if present, use it. If `.dependably-check` also exists **in the same directory**, warn: `warning: both .dependably and .dependably-check found in <dir>; using .dependably (.dependably-check is ignored — delete it)`.
2. `.dependably-check` — if present, use it and warn once: `warning: .dependably-check is deprecated; rename it to .dependably`.
3. Stop after checking a directory that contains a `.git` entry (repo boundary, honored-then-stop — current behavior in all 5 tools), or at the filesystem root.

`--config <path>` still skips discovery, errors if the file is missing, and accepts **any** filename (both shapes are auto-detected as today in npm-check's `isSharedShape`).

### A.2 Back-compat window and precedence — recommendation

- **Keep the alias for 2 minor releases** of each tool (or ~6 months, whichever is longer), then drop reading `.dependably-check` in the next major.
- **`.dependably` wins** when both exist at the same level. Rationale: a repo mid-migration commits the new file; the stale old file must not silently override it.
- Do **not** merge the two files. One file is authoritative; merging two sources is an unauditable failure mode.
- The deprecation warning goes to **stderr** and never affects exit codes or `--format json` payloads.

### A.3 Why rename at all (and why this is cheap)

The `-check` suffix described the first two consumers; the suite now includes linters and metrics tools that don't "check dependencies". `.dependably` is the brand, shorter, and matches the section-key convention (`common` + tool names). Because every tool already funnels discovery through one constant (`SHARED_CONFIG_FILENAME` / `FileName` / `CONFIG_FILENAME`), the rename is a constant → ordered-list change plus one warning branch, per repo.

---

## B. Unified schema

### B.1 Top-level structure

```json
{
  "$schema": "https://dependably.dev/schema/dependably-v1.json",
  "version": 1,
  "common":      { },
  "npm-check":   { },
  "nucheck":     { },
  "pycheck":     { },
  "cslint":      { },
  "codemetrics": { }
}
```

- Every tool reads exactly two sections: `common` (base) and its own key (override/extend). All other top-level keys are ignored (this is what already makes the shared file additive-friendly — keep it).
- **Section-key decision: tool names, not ecosystem names.** Current keys are a mix (`npm`, `nuget`, `python`, `codemetrics`, `cslint`). Tool names win because (a) `cslint` and `codemetrics` have no ecosystem name, so ecosystem naming can never be uniform; (b) a section maps 1:1 to the binary that reads it, which is what a user greps for; (c) a future second Python tool doesn't collide.
  - Canonical keys: **`npm-check`**, **`nucheck`**, **`pycheck`**, **`cslint`**, **`codemetrics`**.
  - Alias map during the window: `npm` → `npm-check`, `nuget` → `nucheck`, `python` → `pycheck`. If both alias and canonical exist, canonical wins and the alias is ignored with a warning. `cslint`/`codemetrics` are already canonical — no change.

### B.2 Standard section vocabulary

These keys are legal in `common` **and** in every tool section, with identical semantics:

| Key | Type | Meaning | Merge (common↔tool) |
|-----|------|---------|--------------------|
| `rules` | object: ruleId → `"error"\|"warn"\|"off"` or `["sev", {opts}]` | per-rule severity + options | per rule-id; tool entry **replaces wholesale** (severity + options) |
| `exceptions` | array of exception objects (§C) | targeted finding suppression | **union** |
| `exclude` | string[] (globs) | paths the tool skips entirely | **union** (ordinal dedupe) |
| `failOn` | `{ "severity": <string>, "count": <int> }` | CI gate = the file form of `--fail-on` | per key; tool overrides |
| `allowedRegistryHosts` | string[] | trusted registry hostnames | **union** (case-insensitive dedupe, normalized lowercase) |
| `allowedLocalFeeds` | string[] | trusted repo-local feeds (nucheck; legal but inert elsewhere — it lives in the vocabulary so `common` can carry it) | **union** (case-insensitive) |

Tool sections may add tool-specific keys (e.g. nothing today beyond deprecated aliases); those are documented per tool and validated by that tool only.

**Two severity vocabularies, deliberately kept:**
- **Rule severity** (what a rule reports as): `error | warn | off` — npm-check's existing grammar, now suite-wide.
- **Finding-severity ladder** (what `failOn.severity` gates on): `critical > high > moderate > low > info`, plus the aliases `error`→`high` and `warning`/`warn`→`moderate` that nucheck's `Severity.Normalize` already applies. This is the ladder every tool's `--fail-on severity=` already accepts — the file key just persists the flag.

**`failOn` semantics (standardized):**
- `failOn.severity` — trip the gate when any unsuppressed finding is at-or-above this ladder level. Replaces cslint's `strict: true` (≡ `failOn: {"severity": "warning"}`) and codemetrics' `failOn.severity` (unchanged meaning, same key).
- `failOn.count` — a budget: trip when unsuppressed warning-class findings exceed N. Replaces npm-check's `maxWarnings` (`maxWarnings: 0` ≡ `failOn: {"count": 0}`; the old `-1` sentinel = key absent). nucheck's `--fail-on count=` (vulnerability count) keeps its current tool meaning; the file key feeds the same code path as the flag.
- CLI `--fail-on` always overrides the file's `failOn` (flags > files, unchanged suite convention).

### B.3 The single merge rule (and what changes)

> **Scalars override. Maps merge per key (tool wins per key, and the winning entry replaces wholesale — no deep option merging across sections). The standard list keys union.**

Rationale: allowlists/excludes/exceptions are *grants* — `common` states org-wide policy, a tool section adds to it; silently dropping a common grant because the tool section also has the key is the surprising outcome. Rule entries and gates are *policy decisions* — last-writer-wins per rule id is what ESLint users expect, and deep-merging options across common/tool would make it impossible to *reset* an option.

(Defaults↔user merging inside one tool is unchanged: npm-check keeps merging user rule options over that rule's built-in defaults, as `mergeConfig` does today. The rule above governs only common↔tool.)

Behavior changes vs. today:

| Tool | Today | New | Impact |
|------|-------|-----|--------|
| npm-check | `{...common, ...npm}` — a `rules` object in the `npm` section **replaces common's entire `rules` object** (see `extractSharedAuditSettings`) | per-rule-id merge | A repo with rules in both sections may see common rules re-activate. Rare (the shared file is young); call out in CHANGELOG with example. |
| npm-check | `allowedRegistryHosts` additive onto rule options | unchanged | none |
| nucheck / pycheck | union arrays | unchanged | none |
| codemetrics | `failOn` per-metric override, `exclude` union | thresholds move into `rules` (aliased, §B.4); `failOn.severity`/`exclude` unchanged | alias window |
| cslint | `strict`/`scan` tool-then-common scalar, `exclude` union | scalars per-key tool-wins (identical outcome); `strict`/`scan` become aliases (§B.4) | alias window |
| pycheck | lowercases hosts on read | spec: hosts are compared case-insensitively suite-wide; normalization to lowercase is the canonical form | nucheck/npm-check adopt lowercase normalization (today: nucheck case-insensitive dedupe but preserves case; npm-check case-sensitive `Set`). Fixes a latent npm-check dedupe gap. |

### B.4 Every tool speaks `rules`

Each tool publishes a **stable rule-id registry** (a table in its README + exported constant). The ids already exist in four of five tools; codemetrics and cslint get theirs mapped from thresholds/toggles:

| Tool | Rule ids (registry) |
|------|--------------------|
| npm-check | the 16 existing audit rules (`lockfile-version`, `secure-resolved`, `install-scripts`, …) — **unchanged** |
| nucheck | new ids over existing checks: `vulnerable-package` (advisory findings), `untrusted-source` (SourceFinding), `untrusted-local-feed`, `unused-packages` (UnusedPackageFinding), `unverifiable-advisory` |
| pycheck | its existing `ValidationError.code` values (requirements/pyproject/pip.conf validators) act as rule ids; plus `untrusted-registry` for the host-trust check |
| cslint | existing diagnostic ids: `OP004` (magic numbers), `OP005` (bool flags), `OP006` (cancellation), and the rest of its diagnostic set |
| codemetrics | one rule per metric: `cyclomatic`, `cognitive`, `mi`, `nesting`, `lcom4`, `coupling` |

**codemetrics: thresholds as rule options.** A metric threshold is exactly "rule with options":

```json
"codemetrics": {
  "rules": {
    "cyclomatic": ["error", { "max": 25 }],
    "cognitive":  ["error", { "max": 30 }],
    "mi":         ["error", { "min": 20 }],
    "nesting":    ["warn",  { "max": 5 }],
    "lcom4":      "off",
    "coupling":   ["error", { "max": 20 }]
  },
  "failOn": { "severity": "high" }
}
```

`mi` fails **below**, so its option is `min`; the others use `max` (fail above). This is strictly more expressive than today's `failOn` metrics: a metric can now be a non-gating `warn` or `off`, which the current model cannot say. Legacy alias: `failOn.cyclomatic: 25` maps to `rules: {"cyclomatic": ["error", {"max": 25}]}` during the window.

**cslint: toggles as rule severities.**

```json
"cslint": {
  "rules": { "OP004": "off", "OP005": "warn", "OP006": "error" },
  "failOn": { "severity": "warning" }
}
```

Aliases during the window: `scan.magicNumbers: false` → `OP004: "off"` (likewise OP005/OP006); `strict: true` → `failOn: {"severity": "warning"}`. If both alias and canonical are present, canonical wins + warning.

**nucheck/pycheck** gain `rules` for severity control of their policy checks (e.g. demote `unused-packages` to `off` instead of ignore-listing everything), while keeping their allowlist keys. `ignoreUnusedPackages: ["X"]` becomes an alias for the exception `{"rule": "unused-packages", "package": "X"}` (§C.5).

---

## C. The standardized exception format (centerpiece)

### C.1 Design

One key, `exceptions`, legal in `common` and every tool section. Each entry suppresses **specific findings** — the run no longer fails on them, without excluding whole files and without turning a rule off globally.

```json
{
  "rule":    "install-scripts",                 
  "package": "esbuild",                         
  "path":    "src/Legacy/**",                   
  "symbol":  "OrderService.ProcessAsync",       
  "id":      "GHSA-2cwj-8chv-9pp9",             
  "reason":  "vendored build tool; reviewed by mh 2026-06-12",
  "expires": "2026-12-31"
}
```

| Field | Req | Type | Matches |
|-------|-----|------|---------|
| `rule` | **yes** | string | the finding's rule id from the tool's registry (§B.4). No wildcard — turning a rule off globally is `rules: {id: "off"}`, not an exception. |
| `package` | at least one selector required | string | package/dependency name, case-insensitive. Optional `@<version>` suffix pins to an exact locked version (`"log4net@2.0.8"`) — recommended for vuln exceptions so an upgrade re-arms the check. |
| `path` | ↑ | string (glob) | the finding's file path, relative to the config file's directory. Same glob dialect each tool already uses for `exclude`. |
| `symbol` | ↑ | string | code location: `Type` or `Type.Member` (codemetrics diagnoses, cslint diagnostics). Ignored by tools without symbol-scoped findings — but only in `common`; in a tool's own section an inapplicable selector is a validation error (§D). |
| `id` | ↑ | string | a specific finding identifier: advisory id (GHSA/CVE/OSV) for vuln findings, or a validator finding code instance where the tool exposes one. |
| `reason` | **yes** | string, non-empty | audit trail. Missing/empty ⇒ typed error `EXCEPTION_MISSING_REASON`. Mandatory by design: an exception without a reason is how suppressions rot. |
| `expires` | no | string, `YYYY-MM-DD` | after this date the exception is **inert** and the tool warns `exception expired: <summary>`. Malformed date ⇒ typed error. |

**Matching semantics (identical in all 5 tools):**
1. All selectors present on an exception must match the finding (**AND** within an entry; multiple entries are OR).
2. A matched finding is **suppressed**: it does not gate (`failOn`, exit code, `maxWarnings` budget) and is reported in a one-line summary — `12 findings (3 suppressed by .dependably)` — with a `--show-suppressed` / JSON `suppressed: []` detail view. Suppressed ≠ deleted: JSON output carries them with `"suppressed": true` so dashboards don't lose signal.
3. An exception that matched **nothing** in the run produces a warning (`unused exception: …`) so dead entries get pruned. (Warning, not error: monorepo partial runs legitimately miss some.)
4. Expired exceptions are skipped for matching, then reported as expired (warning). They do not gate by themselves.
5. Exceptions from `common` and the tool section are unioned; duplicates (identical field sets) deduped.

**Deliberate exclusion — no hash fingerprints.** A fingerprint of file+line+content rots on every rebase and can't be authored by hand. `rule + package/path/symbol/id` is stable across rebases, reviewable in a diff, and covers every finding type the 5 tools emit. If a future tool needs finer identity, `id` is the extension point.

### C.2 The same grammar across all five tools — concrete JSON

```json
"npm-check": {
  "exceptions": [
    { "rule": "install-scripts", "package": "esbuild",
      "reason": "postinstall downloads platform binary; reviewed", "expires": "2027-01-01" },
    { "rule": "unused-dependencies", "package": "tslib",
      "reason": "injected by tsc importHelpers, never imported directly" }
  ]
},
"nucheck": {
  "exceptions": [
    { "rule": "vulnerable-package", "package": "log4net@2.0.8", "id": "GHSA-2cwj-8chv-9pp9",
      "reason": "sink not reachable; upgrade blocked on FooCorp SDK", "expires": "2026-09-30" },
    { "rule": "unused-packages", "package": "Microsoft.SourceLink.GitHub",
      "reason": "build-time only, no runtime namespace" }
  ]
},
"pycheck": {
  "exceptions": [
    { "rule": "REQ_UNPINNED", "package": "torch",
      "reason": "CUDA wheel pin varies per machine; pinned in constraints.txt" }
  ]
},
"cslint": {
  "exceptions": [
    { "rule": "OP004", "path": "src/Protocol/**",
      "reason": "wire-format constants; naming them adds noise" }
  ]
},
"codemetrics": {
  "exceptions": [
    { "rule": "cyclomatic", "path": "src/Parser/Parser.cs", "symbol": "Parser.ParseExpression",
      "reason": "grandfathered; refactor tracked in #142", "expires": "2027-06-30" }
  ]
}
```

The codemetrics entry is the exact capability the user is missing today (only whole-file `exclude` exists): one method's metric violation is grandfathered, with a reason and a deadline, and every *other* violation in that file still fails the run.

### C.3 Reconciliation with tool-native mechanisms

| Tool | Native mechanism | Verdict |
|------|-----------------|---------|
| npm-check per-rule `ignore`/`allow` options | same intent, no reason/expiry, per-rule syntax | **Superseded (soft).** Both honored; `ignore`/`allow` documented as deprecated in favor of `exceptions`; docs and `--fix`-style migration hint. Do NOT remove — rule options like `allowedHosts`, `sections` are *policy*, not exceptions, and stay. |
| nucheck `ignoreUnusedPackages` | exception without metadata | **Alias.** Read for 2 releases, internally rewritten to `{"rule": "unused-packages", "package": …}` exceptions; deprecation warning. |
| `allowedRegistryHosts` / `allowedLocalFeeds` (nucheck/pycheck/npm-check) | trust *configuration*, not finding suppression | **Kept as-is.** These define policy inputs, not exceptions to policy. |
| codemetrics | none (whole-file `exclude` only) | **Filled by `exceptions`.** `exclude` stays for genuinely generated code. |
| cslint `.editorconfig` (`dotnet_diagnostic.<id>.severity`) + `#pragma` | per-file/inline, IDE-visible | **Coexist.** `.editorconfig` remains the IDE-parity mechanism; `.dependably` exceptions are the audited, expiring, cross-tool mechanism. Precedence: suppression is the union — silenced by either stays silenced. cslint reports which source suppressed (`suppressedBy: "editorconfig" | "dependably"`) so the audit trail stays honest. |

### C.4 Interaction with `rules` and `exclude`

Escalation ladder, coarse → fine, all in one file:
1. `exclude` — the tool never looks at the path (generated code).
2. `rules: {id: "off"}` — the rule never runs.
3. `rules: {id: "warn"}` + `failOn` — the rule reports but doesn't gate.
4. `exceptions` — the rule runs and gates everywhere **except** these named findings.

Docs present exceptions as the default answer to "the tool fails on one thing"; the other three are for broader intent.

---

## D. Validation policy

Adopt npm-check's typed-error strictness suite-wide, scoped so the shared file stays additive:

| Condition | Outcome |
|-----------|---------|
| File unreadable / malformed JSON / top-level not an object | **typed error**, operational exit (exit 2 class). Codes: `CONFIG_READ`, `CONFIG_PARSE`, `CONFIG_SHAPE`. (Matches all 5 today.) |
| `version` present and > highest supported | **typed error** `CONFIG_VERSION` ("this file needs a newer <tool>"). Missing ⇒ treated as 1. |
| Unknown **top-level** section | **ignored** silently (forward compat: other tools, future tools). |
| Unknown key **inside `common` or the tool's own section** | **warning** (stderr, non-gating): `unknown key "commmon.exclde" in .dependably — ignoring`. Upgrades today's silent-ignore (typo black hole) without breaking additive growth: new *standard* keys land in the spec + all tools together. |
| Unknown **rule id / exception `rule`** in the tool's **own section** | **typed error** `UNKNOWN_RULE` (npm-check's current stance, now suite-wide). A typo'd rule id silently disabling policy is the worst failure mode. |
| Unknown rule id / exception `rule` in **`common`** | **ignored** — `common.rules`/`common.exceptions` may carry sibling tools' ids (e.g. a common exception for a path glob used by both cslint and codemetrics). |
| Known key, wrong type or invalid value (bad severity, non-integer count, non-string in array, bad `expires`, exception with no selector, exception missing `reason`, inapplicable selector in own section) | **typed error**: `INVALID_SEVERITY`, `INVALID_RULE_OPTIONS`, `INVALID_FAIL_ON`, `EXCEPTION_MISSING_REASON`, `EXCEPTION_NO_SELECTOR`, `EXCEPTION_BAD_EXPIRES`, `EXCEPTION_BAD_SELECTOR`. (Extends codemetrics' "known key + bad value = loud" contract to all tools.) |
| Deprecated name/key/section in use | **warning** once per run, never gating. |

**`$schema` / JSON Schema.** Publish `dependably-v1.json` (draft 2020-12) covering the top-level shape, standard vocabulary, exception grammar, and per-tool rule-id enums. It powers editor completion/validation; tools do **not** need a schema-validation dependency — their hand-rolled checks above are the runtime contract. `$schema` and `version` are always-legal top-level keys.

---

## E. Implementation plan

### E.1 Shared design artifacts (land first, one MR in checker-npm or a small `dependably-spec` repo)

1. **SPEC.md** — this document distilled: file name + discovery, section keys + aliases, merge rule, standard vocabulary, exception grammar + matching semantics, validation table, error codes, deprecation windows.
2. **`dependably-v1.json`** JSON Schema, published at the `$schema` URL and vendored into each repo.
3. **Conformance fixtures** — a directory of `.dependably` files + expected resolved-config/suppression outcomes (JSON), vendored into each repo's test suite. This is what keeps three languages honest: same fixtures, three harnesses. Fixture cases: rename precedence (both files), alias sections, per-rule merge, list union + case rules, each exception selector, expired/unused exceptions, every typed-error case.

### E.2 npm-check (`/Users/michael/Projects/checker-npm`) — reference implementation, lands second

- `src/audit-config.js`:
  - `SHARED_CONFIG_FILENAME` → ordered list `['.dependably', '.dependably-check']`; `findSharedConfig` implements §A.1 per-level precedence + deprecation warnings.
  - `extractSharedAuditSettings`: read `npm-check` section with `npm` alias; replace the object-spread with the §B.3 merge (per-rule-id; union `exceptions`/`exclude`/hosts); accept `failOn` (map `count`→`maxWarnings` internally), `version`, `$schema`.
  - `mergeConfig`: keep `UNKNOWN_RULE` for own-section rules; skip unknown ids sourced from `common`; add unknown-key warnings + new typed errors.
- New `src/exceptions.js` — parse/validate exception entries; `matchException(finding, exceptions)`; expiry + usage tracking. Written as the reference for the C#/Python ports.
- `src/audit.js` (`runAudit`) — thread exceptions through rule findings; mark `suppressed: true`; exclude suppressed from `pass`/severity/`maxWarnings` math; emit unused/expired-exception warnings as findings of a new internal channel.
- `src/report.js` — suppressed counts in section summaries + totals line; `suppressed` array in JSON format.
- `bin/cli.js` — `--show-suppressed`; deprecation notices; docs strings.
- Legacy `.npm-checkrc.json`/`npm-check.config.json` fallback: **unchanged behavior** (cwd fallback overriding shared settings), but documented as deprecated; removal in next major.
- Tests: `tests/unit/audit-config.test.js` (rename/alias/merge/typed errors), `tests/unit/audit.test.js` (suppression math), new `tests/unit/exceptions.test.js`, `tests/integration/cli-vocab.test.js` (flags, deprecation stderr), conformance fixtures harness.
- Docs: CLAUDE.md audit-engine section, README.

### E.3 `Dependably.Config` C# package — lands third

Extract the triplicated `Discover`/`Parse` (currently `DependablyCheckConfig.cs`, `CsLintConfig.cs`, `CodeMetricsConfig.cs`) into one package:
- `DependablyFile.Discover(startDir)` (§A.1), `DependablyFile.Load(explicitPath, startDir)`.
- `ToolSection.Resolve(root, "nucheck", aliases)` implementing the §B.3 merge, standard-key readers (`Rules`, `Exceptions`, `Exclude`, `FailOn`, `AllowedRegistryHosts`, `AllowedLocalFeeds`), typed exceptions mirroring the JS codes, unknown-key warnings via a callback.
- `ExceptionMatcher` (port of `exceptions.js`, same fixtures).
- Ship on the existing private/dependably NuGet feed; each C# tool keeps only its rule registry + finding→matcher adapter. (If a package is unwanted, second-best is a shared-source `Dependably.Config.cs` copied by CI — but the package is the recommendation; three drifting copies is how today's inconsistencies happened.)

### E.4 nucheck (`/Users/michael/Projects/checker-nuget`)

- Replace `src/Dependably.NuCheck/Config/DependablyCheckConfig.cs` internals with `Dependably.Config`; keep the public surface (`AllowedRegistryHosts`, `AllowedLocalFeeds`) and add `Rules`, `Exceptions`.
- `ignoreUnusedPackages` → alias rewriting to `unused-packages` exceptions (deprecation warning).
- Introduce the rule registry (`vulnerable-package`, `untrusted-source`, `untrusted-local-feed`, `unused-packages`, `unverifiable-advisory`).
- `Services/AuditService.cs` — apply `ExceptionMatcher` to advisories (`package[@version]` + `id` selectors) before `AuditResult`; carry suppressed advisories for display. `SourceTrustService.cs` / `UnusedPackageService.cs` — exception-aware. `AuditResult.GateTrips`/`MaxFindingRank` — count only unsuppressed findings; `failOn` file key feeds the same gate as `--fail-on`.
- Tests: `DependablyCheckConfigTests.cs`, `CliOptionsTests.cs`, new matcher tests + conformance fixtures. Docs: README, CHANGELOG.

### E.5 cslint (`/Users/michael/Projects/cslint`) and codemetrics (`/Users/michael/Projects/dotnet-codemetrics`)

- cslint: `src/CsLintConfig.cs` → `Dependably.Config`; map `rules` (OPxxx severities) with `scan`/`strict` aliases; `src/LintEngine.cs` applies exceptions (rule + path glob + symbol) alongside `.editorconfig` suppression, recording `suppressedBy`; `src/Cli.cs` gate = unsuppressed findings vs `failOn`. Tests: `ConfigAndLoaderTests.cs`, `OpinionatedRuleTests.cs`, `CliTests.cs`, fixtures under `tests/fixtures/`.
- codemetrics: `src/CodeMetrics/CodeMetricsConfig.cs` → `Dependably.Config`; metric rules with `max`/`min` options, `failOn.<metric>` aliases; diagnosis pipeline gains file+`symbol` exception matching (it already attributes diagnoses to type/member — the matcher keys off that); `src/CodeMetrics/Cli.cs` gate math over unsuppressed diagnoses. Tests: `CodeMetricsConfigTests.cs`, `AppTests.cs`. Docs: ARCHITECTURE.md.

### E.6 pycheck (`/Users/michael/Projects/checker-python`)

- `src/validators/config.py` — grow from hosts-only into the full model: rename + discovery (§A.1), `pycheck`/`python` sections, standard vocabulary, exception parsing, typed errors via `ImportCheckerError` subclasses carrying `code` (mirror the JS codes).
- `src/validators/runner.py` — filter `ValidationResult.errors/warnings` through the matcher (rule = finding `code`, `package` selector for requirement-level findings, `path` = the validated file); suppressed findings move to a `suppressed` list on the result; gate math over the remainder.
- Tests: `tests/unit/test_config_loader.py`, `test_cli.py`, `tests/integration/test_validate_e2e.py`, fixtures under `tests/fixtures/config/`. Docs: readme.md.

### E.7 Sequencing, atomicity, migration

**Not atomic — deliberately.** Order: (1) spec + schema + fixtures → (2) npm-check (reference) → (3) `Dependably.Config` → (4) nucheck, cslint, codemetrics (parallel, independent MRs) → (5) pycheck → (6) after the window, a removal wave (drop `.dependably-check`, alias sections, `ignoreUnusedPackages`, `scan`/`strict`, `failOn` metrics, `maxWarnings`, `.npm-checkrc.json`) in each tool's next major.

Safe interleaving because:
- **New tool + old file**: reads `.dependably-check` and every legacy key via aliases. Zero-change upgrade.
- **Old tool + new file**: the dangerous quadrant — an un-upgraded tool doesn't find `.dependably` and **silently runs on defaults (gates may loosen)**. Mitigations: (a) migration doc says *rename only after every Dependably tool in the repo's CI is upgraded*; until then keep the old name (new tools read it fine); (b) new tools warn when only `.dependably-check` exists, so the nudge appears exactly when renaming is safe; (c) never advise keeping both files long-term.
- New standard keys in the file before a given tool upgrades: harmless today by construction — every current parser ignores unknown keys in its sections (verified: npm-check's `extractSharedAuditSettings` picks only `rules`/`maxWarnings`; the C# parsers `TryGetProperty` known keys; pycheck reads only `allowedRegistryHosts`). So a repo can adopt `exceptions` in the file as each tool learns it, tool by tool.

### E.8 Risks

| Risk | Mitigation |
|------|-----------|
| npm-check per-rule merge changes effective config for repos with `rules` in both `common` and tool sections | CHANGELOG callout + example; the change is toward least surprise |
| Old tools silently default on renamed file | §E.7 quadrant plan; rename last |
| npm-check strict validation vs new keys | new keys ship in the same release as the readers; own-section unknown *keys* are warnings, only unknown *rule ids* are errors |
| Legacy `.npm-checkrc.json` fallback conflicts with new semantics | unchanged this cycle, deprecated, removed next major |
| Case-sensitivity drift (pycheck lowercases; cslint ordinal; npm-check case-sensitive Set) | spec §B.3 fixes it: hosts/packages case-insensitive (lowercase canonical), globs ordinal; conformance fixtures pin it |
| Three C# copies drift again | `Dependably.Config` package; conformance fixtures in every repo |
| Exceptions become a dumping ground | mandatory `reason`, `expires` support, unused-exception warnings, suppressed-but-still-reported output |
| glob dialect differences across languages | spec pins the dialect to each tool's existing `exclude` dialect for v1 and documents the common safe subset (`**`, `*`, `?`); fixture cases only use the subset |

---

## F. North-star example `.dependably`

A monorepo with a JS web app, a Python service, and .NET services; one private registry; a handful of audited, expiring exceptions. (JSON forbids comments — annotations follow the block.)

```json
{
  "$schema": "https://dependably.dev/schema/dependably-v1.json",
  "version": 1,

  "common": {
    "allowedRegistryHosts": ["packages.dependably.dev"],
    "exclude": ["**/Generated/**", "**/*.g.cs", "web/vendor/**"],
    "failOn": { "severity": "high" }
  },

  "npm-check": {
    "rules": {
      "lockfile-version": ["error", { "minVersion": 3 }],
      "install-scripts": "error",
      "no-git-deps": "error",
      "unused-dependencies": ["warn", { "includeDev": true }]
    },
    "failOn": { "severity": "high", "count": 10 },
    "exceptions": [
      { "rule": "install-scripts", "package": "esbuild",
        "reason": "postinstall fetches platform binary; reviewed by mh 2026-06-12",
        "expires": "2027-01-01" },
      { "rule": "unused-dependencies", "package": "tslib",
        "reason": "injected by tsc importHelpers; never imported directly" }
    ]
  },

  "nucheck": {
    "allowedLocalFeeds": ["./feeds"],
    "rules": { "unused-packages": "warn" },
    "exceptions": [
      { "rule": "vulnerable-package", "package": "log4net@2.0.8", "id": "GHSA-2cwj-8chv-9pp9",
        "reason": "vulnerable sink unreachable; upgrade blocked on FooCorp SDK 4.x",
        "expires": "2026-09-30" },
      { "rule": "unused-packages", "package": "Microsoft.SourceLink.GitHub",
        "reason": "build-time only; no runtime namespace" }
    ]
  },

  "pycheck": {
    "exceptions": [
      { "rule": "REQ_UNPINNED", "package": "torch",
        "reason": "CUDA wheel pin varies per builder; exact pin lives in constraints.txt" }
    ]
  },

  "cslint": {
    "rules": { "OP005": "off" },
    "failOn": { "severity": "warning" },
    "exceptions": [
      { "rule": "OP004", "path": "services/protocol/**",
        "reason": "wire-format constants; naming each adds noise, reviewed 2026-05" }
    ]
  },

  "codemetrics": {
    "rules": {
      "cyclomatic": ["error", { "max": 25 }],
      "cognitive":  ["error", { "max": 30 }],
      "mi":         ["warn",  { "min": 20 }],
      "nesting":    ["error", { "max": 5 }]
    },
    "exceptions": [
      { "rule": "cyclomatic", "path": "services/parser/Parser.cs", "symbol": "Parser.ParseExpression",
        "reason": "grandfathered at 31; refactor tracked in #142", "expires": "2027-06-30" }
    ]
  }
}
```

Annotations:
- **`common`** — the private registry host is trusted by npm-check (`secure-resolved`/`no-remote-deps` allowlists, additive), nucheck (source trust), and pycheck (index trust) from one line, exactly the cross-tool win the shared file was built for. `exclude` unions into every tool. `failOn.severity: "high"` is the org-wide gate; two tool sections override it.
- **`npm-check`** — rules use the existing grammar unchanged; `failOn.count: 10` is the old `maxWarnings: 10`; the esbuild exception replaces what previously needed `install-scripts: ["warn", {allow: ["esbuild"]}]`, now with a reason and an expiry.
- **`nucheck`** — the log4net entry is the canonical vuln exception: pinned to the exact version *and* the specific advisory, so either an upgrade or a new advisory re-arms the gate. The SourceLink entry is the old `ignoreUnusedPackages` with an audit trail.
- **`cslint`** — `OP005: "off"` is the old `scan.boolFlags: false`; `failOn.severity: "warning"` is the old `strict: true`; the OP004 exception is scoped to a path, not the whole repo.
- **`codemetrics`** — thresholds are rules (with `mi` demoted to non-gating `warn`), and the `Parser.ParseExpression` entry grandfathers one method's complexity with a deadline — impossible in the current whole-file-`exclude`-only model, and the direct answer to "the tool always fails for this project".
