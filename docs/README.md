# Documentation index

## At the repo root

| Doc | What it covers |
| --- | --- |
| [README.md](../README.md) | Overview, install, quick start |
| [CHANGELOG.md](../CHANGELOG.md) | Release history (Keep a Changelog format) |
| [CONTRIBUTING.md](../CONTRIBUTING.md) | Dev setup, the lint/test gate, style and PR conventions |
| [SECURITY.md](../SECURITY.md) | How to report a vulnerability |
| [CLAUDE.md](../CLAUDE.md) | Architecture overview of every module (also the AI-assistant project brief) |

## In `docs/`

| Doc | What it covers |
| --- | --- |
| [CLI.md](./CLI.md) | Full CLI reference — every command, flag, exit code, and JSON output |
| [API.md](./API.md) | Using npm-check as a library |
| [PERFORMANCE.md](./PERFORMANCE.md) | Large-lockfile utilities: batching, chunking, memory-efficient operations |
| [TESTING.md](./TESTING.md) | Test layout, unit vs Docker integration tests, adding fixtures, troubleshooting |

## Elsewhere

| Doc | What it covers |
| --- | --- |
| [dependably-spec](https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec) | The normative `.dependably` config contract, its JSON Schema, and the conformance corpus shared by every Dependably tool. npm-check vendors the corpus into `conformance/dependably/`; see `conformance/VENDOR.md` for the pinned commit. |
