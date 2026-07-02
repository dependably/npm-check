# npm-check (`@dependably/npm-check`)

A toolkit for **validating, migrating, fixing, and auditing npm `package-lock.json`
files** (lockfile v1/v2/v3) — plus registry-backed integrity, vulnerability,
deprecation, and license checks that work straight from the lockfile, with no
`node_modules` and no `npm audit` subprocess. Ships a `npm-check` CLI and a library.

> This GitHub repository is the public mirror — please file issues and pull requests here.

## Install

```bash
npm install -g @dependably/npm-check
# or run once, without installing:
npx @dependably/npm-check
```

Requires Node.js ≥ 22. Building from source: see
[CONTRIBUTING.md](https://github.com/dependably/npm-check/blob/main/CONTRIBUTING.md).

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
- **pnpm** — read-only checks and config validation for `pnpm-lock.yaml`.

## Documentation

- **[CLI reference](https://github.com/dependably/npm-check/blob/main/docs/CLI.md)** — all commands, flags, exit codes, JSON output
- **[API guide](https://github.com/dependably/npm-check/blob/main/docs/API.md)** — using it as a library
- [Performance](https://github.com/dependably/npm-check/blob/main/docs/PERFORMANCE.md) ·
  [Testing](https://github.com/dependably/npm-check/blob/main/docs/TESTING.md)
- [Changelog](https://github.com/dependably/npm-check/blob/main/CHANGELOG.md) ·
  [Contributing](https://github.com/dependably/npm-check/blob/main/CONTRIBUTING.md) ·
  [Security](https://github.com/dependably/npm-check/blob/main/SECURITY.md)

## License

[Apache-2.0](LICENSE)
