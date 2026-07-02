# Contributing to npm-check

Thanks for your interest in improving `@dependably/npm-check`.

## Requirements

- **Node.js ≥ 22** and **npm ≥ 10** (see `engines`).
- The package is ESM (`"type": "module"`). The npm core path is
  **dependency-free**; the only runtime dependency is `yaml`, loaded lazily and
  only when parsing a `pnpm-lock.yaml`. Please keep the npm path zero-dependency.

## Getting started

```bash
git clone https://github.com/dependably/npm-check.git
cd npm-check
npm install
npm run setup:hooks   # enable the pre-commit hook (lint + fast tests)
```

## The gate (run before opening a PR)

```bash
npm run lint          # eslint (must be clean)
npm test              # full jest suite (unit + integration)
npm run test:unit     # unit only (fast)
npm run test:coverage # coverage report
```

- All checks must pass; `prepublishOnly` also runs `test` + `lint`.
- New behavior needs tests. For a bug fix, add a regression test that **fails
  before** your change and passes after.
- See [`docs/TESTING.md`](./docs/TESTING.md) for the test layout (unit
  per-module in `tests/unit/`, integration incl. a real `npm ci` compare in
  `tests/integration/`).

## Style & design

- ESLint enforces style; keep functions within the project's complexity budget
  (refactor rather than nesting deeply).
- Non-destructive by default: write/transform commands are opt-in via `--write`.
- Match the surrounding code's idiom, comment density, and error-typing (each
  subsystem has its own `*Error` class and structured `{ valid, errors,
  warnings, info }`-style results).
- Update `CHANGELOG.md` (under `## [Unreleased]`) and the relevant docs
  (`README.md`, and `CLAUDE.md` for architecture) when you change behavior.

## Pull requests

1. Branch off `main` (`fix/…`, `feat/…`, `chore/…`).
2. Keep the change focused; include tests and a clear description.
3. Ensure lint + tests are green. CI runs the same gate plus a secret scan and a
   Node matrix.

## Reporting security issues

Please do **not** open a public issue for a vulnerability — see
[`SECURITY.md`](./SECURITY.md).

## License

By contributing you agree that your contributions are licensed under the
project's [Apache-2.0](./LICENSE) license.
