# Security Policy

## Supported versions

The latest published `@dependably/npm-check` release on npm receives security
fixes. Older minor versions are not maintained — please upgrade to the latest
`1.x` before reporting.

| Version | Supported |
| ------- | --------- |
| latest `1.x` | ✅ |
| < latest | ❌ |

## Reporting a vulnerability

Please report security issues **privately** — do not open a public issue for an
unfixed vulnerability.

- Preferred: open a [GitHub private security advisory](https://github.com/dependably/npm-check/security/advisories/new).
- Or email **michael@dependably.ca** with `[security] npm-check` in the subject.

Please include a description, affected version, and a minimal reproduction (a
lockfile/package.json snippet is ideal). We aim to acknowledge within a few
business days and to ship a fix or mitigation for confirmed issues promptly.

## Scope & threat model

npm-check parses **untrusted** `package-lock.json` / `package.json` and fetches
metadata from registries whose base is derived from the lockfile's `resolved`
URLs. Relevant hardening already in place, and the kind of report we care about:

- **Registry fetch** is bounded (response size cap, wall-clock deadline,
  `http`/`https` scheme selection, same-host redirects only) and package names
  are validated + percent-encoded before use in a URL. Reports of SSRF, request
  smuggling, resource exhaustion (memory/CPU/ReDoS), or a crash triggered by a
  crafted lockfile/manifest are in scope.
- **No install / no code execution:** npm-check never runs install scripts or
  executes package code; it reads the lockfile and (optionally) files under
  `node_modules`. A path that leads to code execution from untrusted input is a
  high-priority report.
- **Secrets:** the `.npmrc` validator flags plaintext auth tokens and never
  echoes their values. A path that logs or exfiltrates a secret is in scope.

By default all commands are read-only; write/transform commands require an
explicit `--write`.
