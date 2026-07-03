# `.dependably` Configuration — Specification v1

**Status:** Normative draft (v1)
**Applies to:** `npm-check`, `nucheck`, `pycheck`, `cslint`, `codemetrics`
**Companion documents:** [`dependably-config-unification-plan.md`](./dependably-config-unification-plan.md) (rationale + rollout), [`../conformance/dependably/`](../conformance/dependably/) (cross-language fixtures), [`../schema/dependably-v1.json`](../schema/dependably-v1.json) (JSON Schema).

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are used per RFC 2119.

This document is the runtime contract. Every Dependably tool implements the same
discovery, merge, exception, and validation behavior described here; the JSON Schema
is for editor tooling only and is not authoritative over this text.

---

## 1. File

- The configuration file is named **`.dependably`**. It is a single JSON object encoded UTF-8, with no file extension, committed at (typically) the repository root.
- `.dependably-check` is a **deprecated alias** name. Tools **MUST** still read it for the compatibility window (§7) and **MUST** emit exactly one stderr deprecation warning per run when they do.
- JSON does not permit comments. Tools **MUST NOT** require comments and **MUST NOT** accept a non-JSON superset (JSON5, etc.) for v1.

## 2. Discovery

2.1. Discovery walks **up** from a start directory (the directory of the analysis target, or the current working directory when there is no target) toward the filesystem root.

2.2. At **each** directory level, the tool **MUST** check names in this order:
  1. `.dependably` — if present, this file is selected.
  2. `.dependably-check` — if present (and `.dependably` was not), this file is selected and a deprecation warning is emitted.

2.3. If a directory contains **both** `.dependably` and `.dependably-check`, the tool **MUST** select `.dependably`, **MUST** ignore `.dependably-check`, and **MUST** warn:
  `warning: both .dependably and .dependably-check found in <dir>; using .dependably (.dependably-check is ignored — delete it)`.

2.4. The walk **MUST** stop after checking a directory that contains a `.git` entry (file or directory) — the repository boundary — or at the filesystem root, whichever comes first. The `.git`-containing directory is checked before the walk stops.

2.5. When no file is found, the tool **MUST** behave as if an empty config `{}` was loaded (built-in defaults only). This is not an error.

2.6. An explicit `--config <path>` **MUST** bypass discovery entirely, **MUST** error (operational exit) if the path does not exist, and **MUST** accept either file shape (§3) regardless of the file's name.

2.7. Deprecation and boundary warnings **MUST** go to stderr and **MUST NOT** affect exit codes or `--format json` payloads.

## 3. Top-level structure

```json
{
  "$schema": "https://dependably.dev/schema/dependably-v1.json",
  "version": 1,
  "common": { },
  "npm-check": { },
  "nucheck": { },
  "pycheck": { },
  "cslint": { },
  "codemetrics": { }
}
```

3.1. The document root **MUST** be a JSON object. A non-object root is a `CONFIG_SHAPE` error.

3.2. `$schema` (string) and `version` (integer) are always-legal top-level keys. `version` defaults to `1` when absent. A `version` greater than the highest the tool supports is a `CONFIG_VERSION` error.

3.3. Each tool reads exactly two sections: **`common`** (base) and its own **canonical section key**:

  | Tool | Canonical key | Deprecated alias key |
  |------|---------------|----------------------|
  | npm-check | `npm-check` | `npm` |
  | nucheck | `nucheck` | `nuget` |
  | pycheck | `pycheck` | `python` |
  | cslint | `cslint` | — |
  | codemetrics | `codemetrics` | — |

3.4. When both a canonical key and its alias are present, the tool **MUST** use the canonical section, **MUST** ignore the alias section, and **MUST** warn. When only the alias is present, the tool **MUST** read it and warn once.

3.5. All other top-level keys (sections belonging to other or future tools) **MUST** be ignored silently.

## 4. Section vocabulary

These keys are legal in `common` and in every tool section with identical semantics.

| Key | Type | Meaning |
|-----|------|---------|
| `rules` | object: ruleId → severity or `[severity, options]` | per-rule severity + options |
| `exceptions` | array of exception objects (§6) | targeted finding suppression |
| `exclude` | array of glob strings | paths the tool skips entirely |
| `failOn` | `{ "severity"?: string, "count"?: integer }` | the file form of the `--fail-on` CI gate |
| `allowedRegistryHosts` | array of strings | trusted registry hostnames |
| `allowedLocalFeeds` | array of strings | trusted repo-local feeds (used by nucheck; legal but inert elsewhere) |

4.1. A **rule entry** is either a severity string (`"error"`, `"warn"`, `"off"`) or a two-element array `[severity, optionsObject]`. An invalid severity is `INVALID_SEVERITY`; a non-object options element is `INVALID_RULE_OPTIONS`.

4.2. **Two severity vocabularies** exist and are deliberately distinct:
  - **Rule severity** — what a rule reports as: `error | warn | off`.
  - **Finding-severity ladder** — what `failOn.severity` gates on: `critical > high > moderate > low > info`. Tools **MUST** also accept the aliases `error → high` and `warning`/`warn → moderate`.

4.3. `failOn` semantics:
  - `failOn.severity` — trip the gate when any **unsuppressed** finding is at or above this ladder level.
  - `failOn.count` — trip the gate when the number of unsuppressed warning-class findings exceeds N.
  - A CLI `--fail-on` **MUST** override the file's `failOn`.

4.4. Each tool **MUST** publish a stable **rule-id registry** (README table + exported constant). Rule ids referenced anywhere in the file **MUST** come from some tool's registry.

## 5. Merge (`common` ↔ tool section)

A single rule governs how a tool section combines with `common`:

> **Scalars — the tool section overrides `common`. Maps (`rules`) — merged per rule-id; the tool's entry for a given id replaces `common`'s entry wholesale (no cross-section deep-merge of options). The list keys (`exclude`, `exceptions`, `allowedRegistryHosts`, `allowedLocalFeeds`) — UNION (concatenate then de-duplicate).**

5.1. De-duplication: `allowedRegistryHosts` and exception `package` names are compared **case-insensitively**, with lowercase as the canonical stored form. Glob strings (`exclude`, exception `path`) are compared **ordinally** (case-sensitive, exact).

5.2. This merge rule governs only `common` ↔ tool-section combination. Merging of a user rule entry over that rule's **built-in defaults** (within a single tool) is unaffected and continues per each tool's existing behavior.

5.3. `failOn` is a map for merge purposes: the tool section's `failOn.severity` / `failOn.count` each override `common`'s when present.

## 6. Exceptions

`exceptions` is an array. Each entry suppresses specific findings so they do not gate the run, without excluding whole files and without disabling a rule globally.

```json
{
  "rule":    "cyclomatic",
  "package": "log4net@2.0.8",
  "path":    "src/Parser/**",
  "symbol":  "Parser.ParseExpression",
  "id":      "GHSA-2cwj-8chv-9pp9",
  "reason":  "grandfathered; refactor tracked in #142",
  "expires": "2027-06-30"
}
```

| Field | Required | Type | Matches |
|-------|----------|------|---------|
| `rule` | **yes** | string | the finding's rule id (from a tool's registry, §4.4). No wildcard. |
| `package` | one selector required | string | package/dependency name, case-insensitive. An optional `@<version>` suffix pins to an exact version. |
| `path` | ↑ | glob string | the finding's file path, relative to the config file's directory. |
| `symbol` | ↑ | string | `Type` or `Type.Member` code location. |
| `id` | ↑ | string | a specific finding identifier (advisory id such as GHSA/CVE/OSV, or a tool finding-code instance). |
| `reason` | **yes** | non-empty string | audit trail. |
| `expires` | no | `YYYY-MM-DD` string | after this date the exception is inert (and warned about). |

6.1. `rule` and `reason` are **mandatory**. A missing/empty `reason` is `EXCEPTION_MISSING_REASON`. An entry with `rule` and no selector (`package`/`path`/`symbol`/`id`) is `EXCEPTION_NO_SELECTOR`. A malformed `expires` is `EXCEPTION_BAD_EXPIRES`.

6.2. **Matching:** all selectors present on an entry **MUST** match a finding for the entry to apply (AND within an entry). Multiple entries are OR. A matched finding is **suppressed**: it does not contribute to `failOn`, the exit code, or the `failOn.count` budget.

6.3. A suppressed finding **MUST** still be counted and reported. Human output shows a suppressed count (e.g. `12 findings (3 suppressed by .dependably)`); JSON output **MUST** carry suppressed findings with `"suppressed": true`. A `--show-suppressed` view **SHOULD** be available.

6.4. An exception that matches **nothing** in a run **MUST** produce an `unused exception` warning (not an error — partial/monorepo runs legitimately miss some).

6.5. An **expired** exception (today > `expires`) **MUST NOT** suppress; the tool **MUST** report it as expired (warning).

6.6. Exceptions from `common` and the tool section are unioned (§5); byte-identical entries are de-duplicated.

6.7. `symbol`/`id`/`package` selectors that a given tool's findings never carry are **ignored** when they appear in a `common` exception, but are an `EXCEPTION_BAD_SELECTOR` error when they appear in the **tool's own** section.

6.8. Fingerprint selectors (file+line+content hashes) are **not** part of v1. `id` is the extension point for finer identity.

## 7. Compatibility window

7.1. For **two minor releases** of each tool (or ~6 months, whichever is longer), tools **MUST** read all of: the `.dependably-check` filename; the alias section keys `npm`/`nuget`/`python`; and the following per-tool legacy keys, rewriting each to its standard form and warning once:

  | Legacy | Rewrites to |
  |--------|-------------|
  | `maxWarnings: N` (npm-check) | `failOn: { "count": N }` (`-1` ⇒ key absent) |
  | `.npm-checkrc.json` / `npm-check.config.json` (npm-check, cwd fallback) | unchanged behavior this cycle; deprecated |
  | `ignoreUnusedPackages: [X]` (nucheck) | `exceptions: [{ "rule": "unused-packages", "package": X }]` |
  | `failOn.<metric>: N` (codemetrics) | `rules: { "<metric>": ["error", { "max": N }] }` (`mi` ⇒ `min`) |
  | `scan.<toggle>: false` (cslint) | `rules: { "OP004"|"OP005"|"OP006": "off" }` |
  | `strict: true` (cslint) | `failOn: { "severity": "warning" }` |

7.2. When a canonical form and its legacy alias are both present, the canonical wins and the tool warns.

7.3. After the window, each tool's next major release **MUST** drop reading the deprecated names/keys.

## 8. Validation

| Condition | Outcome |
|-----------|---------|
| Unreadable file / malformed JSON / non-object root | typed error (operational exit): `CONFIG_READ`, `CONFIG_PARSE`, `CONFIG_SHAPE` |
| `version` greater than supported | typed error `CONFIG_VERSION` |
| Unknown **top-level section** | ignored silently |
| Unknown key inside `common` or the tool's own section | **warning** (stderr, non-gating) |
| Unknown rule id / exception `rule` in the tool's **own** section | typed error `UNKNOWN_RULE` |
| Unknown rule id / exception `rule` in **`common`** | ignored (may belong to a sibling tool) |
| Known key with wrong type / invalid value | typed error: `INVALID_SEVERITY`, `INVALID_RULE_OPTIONS`, `INVALID_FAIL_ON`, `EXCEPTION_MISSING_REASON`, `EXCEPTION_NO_SELECTOR`, `EXCEPTION_BAD_EXPIRES`, `EXCEPTION_BAD_SELECTOR` |
| Deprecated name/key/section in use | warning once per run, never gating |

8.1. Typed-error codes **MUST** be stable across tools (same code string for the same condition) so cross-language tests and user documentation stay uniform.

8.2. Operational (config) errors use each tool's existing operational exit code (the "exit 2 class"); they are distinct from findings-based failures.

## 9. Glob dialect

For v1, `path` selectors and `exclude` use each tool's existing glob dialect. Fixtures and documentation restrict themselves to the portable subset: `**` (any depth), `*` (within a segment), `?` (single char). Authors **SHOULD** stay within this subset for cross-tool `common` entries.

## 10. Error code reference

`CONFIG_READ`, `CONFIG_PARSE`, `CONFIG_SHAPE`, `CONFIG_VERSION`, `UNKNOWN_RULE`,
`INVALID_SEVERITY`, `INVALID_RULE_OPTIONS`, `INVALID_FAIL_ON`,
`EXCEPTION_MISSING_REASON`, `EXCEPTION_NO_SELECTOR`, `EXCEPTION_BAD_EXPIRES`,
`EXCEPTION_BAD_SELECTOR`.

## 11. Warning code reference

Tools render warnings as human-readable stderr text; the codes below are the stable
identities each warning maps to, so conformance fixtures (and any machine consumer) can
assert on them uniformly. Warnings never affect exit codes.

| Code | Emitted when |
|------|--------------|
| `DEPRECATED_FILENAME` | the selected file is named `.dependably-check` (§2.2) |
| `BOTH_FILES_PRESENT` | a directory holds both `.dependably` and `.dependably-check` (§2.3) |
| `DEPRECATED_ALIAS_SECTION` | an alias section key (`npm`/`nuget`/`python`) is read (§3.4) |
| `DEPRECATED_KEY` | a legacy key is read and rewritten (§7.1) |
| `UNKNOWN_KEY` | an unknown key appears in `common` or the tool's own section (§8) |
| `UNUSED_EXCEPTION` | an exception matched no finding in the run (§6.4) |
| `EXPIRED_EXCEPTION` | an exception's `expires` date has passed (§6.5) |
