# Vendored conformance corpus

Copied from the Dependably spec repository. Do not edit these files here — a change made in
this copy is invisible to every other tool and will be overwritten by the next sync. Change
the spec repository instead, then re-run the sync.

| | |
|---|---|
| Source | https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec.git |
| Ref | `main` |
| Commit | `4bffaf66ea3c67fa5fb14687e118fa27cb31738b` |
| Committed | 2026-07-25T23:19:04-07:00 |

Re-sync with the spec repository's own script. It is not checked in here, so clone the spec
repository first and run the script from this repository's root:

```bash
git clone --depth 1 https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec /tmp/dependably-spec
/tmp/dependably-spec/tools/vendor.sh conformance main
```

The script rewrites this file and assumes it is running from a checkout that contains it, so
it will replace the block above with a bare `tools/vendor.sh` line — restore the clone-and-run
form after each sync.

A newer upstream commit is not automatically a problem: this copy pins the contract version
this tool is tested against. Update deliberately, and re-run the tool's test suite.
