# npm-check (`@dependably/npm-check`)

A toolkit for **validating, migrating, fixing, and auditing npm `package-lock.json`
files** (lockfile v1/v2/v3) — plus registry-backed integrity, vulnerability,
deprecation, and license checks that work straight from the lockfile, with no
`node_modules` and no `npm audit` subprocess. Ships a `npm-check` CLI and a library.

> This GitHub repository is the public mirror — please file issues and pull requests here.

## Install

`@dependably/npm-check` publishes to the private **Dependably registry** — the
same feed the rest of this org's CI installs from — never to public npmjs. On a
machine that carries the org's registry credentials:

```bash
npm install -g @dependably/npm-check
# or run once, without installing:
npx @dependably/npm-check
```

Without those credentials, build and run from source — the repository is public
and needs no registry access of its own: see
[CONTRIBUTING.md](https://github.com/dependably/npm-check/blob/main/CONTRIBUTING.md).

Requires Node.js ≥ 22.

## Quick start

```bash
# Run every check and print one grouped report (the default command)
npm-check

# Validate the lockfile (+ sibling package.json + .npmrc)
npm-check validate

# Scan straight from the lockfile — no node_modules needed
npm-check vuln
npm-check deprecated

# Migrate to lockfile v3, or pin ^/~ ranges to the resolved versions
npm-check migrate 3 --write
npm-check pin --write

# CI gate: fail on any audit warning
npm-check audit --fail-on count=0
```

Commands that change files need `--write` (backups are automatic). Add
`--format json` for machine-readable output. See the
**[CLI reference](https://github.com/dependably/npm-check/blob/main/docs/CLI.md)**
for every command, flag, and exit code.

## What it does

- **Validate** — structural, semantic, and integrity checks across the lockfile, `package.json`, and `.npmrc`.
- **Migrate** — convert between lockfile v1 ↔ v2 ↔ v3.
- **Fix** — fill missing/placeholder/sha1 integrity, dedupe, repair structure (non-destructive).
- **Audit** — an opinionated, configurable lint for CI (non-zero exit on failure).
- **Verify integrity** — check locked hashes against the registry's authoritative hashes to catch a tampered or drifted lockfile.
- **Vulnerabilities & deprecations** — scan locked versions against the npm advisory endpoint and deprecation notices.
- **Licenses** — validate SPDX expressions against an approved list.
- **Pin / prune / unused** — lock ranges (incl. `overrides`) to exact versions, remove orphaned entries, flag unused deps.
- **Import facts** — report what the source tree imports (per-file imports, bindings, the module graph through `node_modules`, lockfile graphs) as a JSON document for another tool to consume. See below.
- **pnpm** — read-only checks and config validation for `pnpm-lock.yaml`.

## Import facts (`npm-check imports`)

`npm-check imports <dir>` exports what a JavaScript/TypeScript/Svelte tree
imports, as data for another tool. It is the same parse-only scan
[sbom-reach](https://github.com/dependably/sbom-reach) uses for its npm
reachability verdicts — the imports of every first-party file, the binding
names each site introduces and which of them the file actually references,
each site resolved to the installed copy it loads, the statically resolved
module graph *through* `node_modules`, and the dependency graph the lockfiles
record — published instead of judged. Nothing is written, nothing is gated: a
successful scan always exits `0`.

```bash
npm-check imports ./src                     # the facts document, as JSON
npm-check imports ./src --format human      # its summary
npm-check imports ./src --no-module-graph   # first-party imports only
```

npm-check reports **npm language facts only**. It knows nothing about purls,
SBOMs or vulnerabilities, and it draws no conclusion: whether a package is
*reachable* is a verdict, and verdicts belong to the consumer.

**Facts are not findings.** An import site has no severity — "lodash is
imported on line 3" is not a problem to fix — so squeezing it into the
findings envelope's `findings` array would be a lie, and would let `--fail-on`
gate CI on ordinary imports. `imports` therefore emits a **sibling document
type**: the same envelope identity every Dependably tool shares (`tool`,
`toolVersion`, `schemaVersion`, `target`, `summary`), with `findings` replaced
by the facts sections, and an explicit `documentType: "imports"`
discriminator so a consumer never has to guess the payload from whichever key
happens to be present. A document with no `documentType` is a findings
document (schema `1.0` predates the split, and the findings envelope is
unchanged). This is the same contract pycheck's `--imports` established for
Python.

The load-bearing part is `unanalyzable`: every file the scan could not read,
every `.svelte` file whose `<script>` extraction reported a problem, every
`node_modules` file the walk skipped, and a walk cut off by its file budget is
listed with a `kind` and a `reason`, so that an absence of evidence is only
ever read as a negative when the search actually ran. The command needs the
optional `typescript` peer dependency (any 5.6+ release) and exits `2` with
`TYPESCRIPT_MISSING` when it is not installed. The full document shape is in
the [CLI reference](https://github.com/dependably/npm-check/blob/main/docs/CLI.md#imports-command);
the library form (`@dependably/npm-check/facts`) is in the
[API guide](https://github.com/dependably/npm-check/blob/main/docs/API.md#import-facts-dependablynpm-checkfacts).

## Documentation

- **[CLI reference](https://github.com/dependably/npm-check/blob/main/docs/CLI.md)** — all commands, flags, exit codes, JSON output
- **[API guide](https://github.com/dependably/npm-check/blob/main/docs/API.md)** — using it as a library
- [Changelog](https://github.com/dependably/npm-check/blob/main/CHANGELOG.md)

## License

[Apache-2.0](LICENSE)
