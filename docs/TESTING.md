# Testing Guide

## Overview

This project has 700+ tests of two types:
- **Unit Tests** (~675, `tests/unit/`): fast, isolated tests with mocks
- **Integration Tests** (~60, `tests/integration/`): end-to-end tests with real npm operations, optionally in Docker

## Running Tests

### Unit Tests Only (Fast)

```bash
npm run test:unit
```

Runs all tests in `tests/unit/` directory. These are fast and don't require Docker.

### Integration Tests (Docker Required)

```bash
# Build Docker images first (one-time setup)
npm run docker:build

# Run integration tests on the minimum supported Node (22)
npm run docker:test:node22

# Or run all supported Node/npm combinations
npm run docker:test:all
```

**Available Docker test targets** (the package supports Node >= 22):
- `npm run docker:test:node22` - Node 22 with npm 10 (minimum supported)
- `npm run docker:test:node24` - Node 24 with npm 11 (current)

### All Tests (Unit + Integration)

```bash
npm run test:all
```

This will run unit tests first, then integration tests locally (without Docker).

## Docker Requirements

Integration tests can run in two modes:

### With Docker (Recommended for CI/CD)

Docker provides complete environment isolation and reproducible versions:

**Install Docker:**
- **macOS**: [Docker Desktop](https://www.docker.com/products/docker-desktop)
- **Linux**: [Docker Engine](https://docs.docker.com/engine/install/)
- **Windows**: [Docker Desktop with WSL2](https://docs.docker.com/desktop/windows/)

**Verify installation:**
```bash
docker --version
docker-compose --version
```

### Without Docker (Local Development)

Integration tests can run locally if your Node/npm versions are compatible:

```bash
# Skip docker-build step, run locally
npm run test:integration
```

This will use your system Node and npm versions.

## Test Structure

```
tests/
├── unit/                          # Fast unit tests
│   ├── *.test.js                  # Test files
│   └── jest.setup.js              # Jest setup
├── integration/                   # Integration tests with npm/Docker
│   ├── npm-ci-migration.test.js   # Main migration validation tests
│   ├── docker/
│   │   ├── Dockerfile             # Test container image
│   │   ├── docker-compose.yml     # Multi-version testing
│   │   └── entrypoint.sh          # Container entry script
│   └── helpers/
│       ├── test-workspace.js      # Workspace management
│       ├── npm-runner.js          # npm ci execution
│       └── fs-compare.js          # node_modules comparison
└── fixtures/
    └── simple-v2/                 # Test fixture (v2 lockfile)
        ├── package.json           # Minimal project (5 deps)
        └── package-lock.json      # Real v2 lockfile
```

## Integration Test Workflow

The integration tests validate that migration from v2 to v3 lockfiles produces identical `node_modules`:

1. **Install with v2 lockfile** → capture package list and versions
2. **Migrate lockfile to v3** → apply migration transformation
3. **Validate v3 schema** → ensure lockfile passes validation
4. **Clean node_modules** → start fresh
5. **Install with v3 lockfile** → npm ci with migrated lockfile
6. **Compare installations** → verify identical package list/versions

Success means: **same packages, same versions, identical installations**.

## Adding Integration Tests

### Step 1: Create Fixture

Create a new fixture directory with `package.json` and `package-lock.json`:

```bash
mkdir -p tests/fixtures/my-test-project
cd tests/fixtures/my-test-project

# Create package.json
cat > package.json << 'EOF'
{
  "name": "my-test-fixture",
  "version": "1.0.0",
  "private": true,
  "dependencies": {
    "lodash": "4.17.21"
  }
}
EOF

# Generate lockfile
npm install --lockfile-version=2

# Remove node_modules
rm -rf node_modules
```

### Step 2: Create Test File

Add test in `tests/integration/` using the helpers:

```javascript
import { createTestWorkspace, readJSON, writeJSON, cleanNodeModules } from './helpers/test-workspace.js';
import { runNpmCi } from './helpers/npm-runner.js';
import { captureNodeModulesState, compareNodeModulesStates } from './helpers/fs-compare.js';
import { migrateToVersion, validatePackageLock, LOCKFILE_VERSIONS } from '../../src/index.js';

test('my scenario', async () => {
  const workspace = await createTestWorkspace('my-test-project');

  try {
    // Your test logic here
    const lockfile = await readJSON(workspace.lockfilePath);
    const migrated = migrateToVersion(lockfile, LOCKFILE_VERSIONS.V3);

    // Verify results
    const validation = validatePackageLock(migrated);
    expect(validation.valid).toBe(true);
  } finally {
    await workspace.cleanup();
  }
}, 300000); // 5 minute timeout
```

### Step 3: Run Tests

```bash
# Locally
npm run test:integration

# In Docker
npm run docker:build
npm run docker:test:node22
```

## Debugging

### Failed Tests

Workspaces are preserved on failure at `/tmp/plf-test-*`:

```bash
# Find the workspace
ls /tmp/plf-test-*

# Inspect the files
cat /tmp/plf-test-*/*/package-lock.json
```

### Interactive Docker Session

Debug inside a Docker container:

```bash
docker-compose -f tests/integration/docker/docker-compose.yml run --rm test-node22-npm10 sh
```

Then inside the container:

```sh
# Check versions
node --version
npm --version

# Run tests
npm run test:integration

# Inspect workspace
ls -la /tmp/plf-test-*
```

### View Docker Logs

```bash
docker-compose -f tests/integration/docker/docker-compose.yml logs -f
```

### Enable Debug Output

```bash
# Run with debug logging
DEBUG=* npm run test:integration

# Or set npm loglevel
npm run test:integration -- --env.NPM_LOGLEVEL=debug
```

## Performance Considerations

### Test Execution Time

- **Unit tests**: < 1 second
- **Single integration test**: 20-60 seconds (includes npm install)
- **All Docker targets**: 5-10 minutes (sequential)
- **Docker build time**: 2-5 minutes (one-time, cached)

### Optimization Tips

1. **Use volume mounts** - Docker compose uses read-only mounts for faster startup
2. **Cache npm packages** - Docker compose creates named volumes for npm cache
3. **Run in parallel** - Unit tests run in parallel, integration tests run serially
4. **Clean builds** - Docker images are rebuilt when Dockerfile changes

### Local vs Docker Performance

| Task | Local | Docker |
|------|-------|--------|
| Unit tests | Fast | Slower (container overhead) |
| Integration tests | Fast | Slower (npm install) |
| Setup | Instant | Requires `docker:build` |
| Reproducibility | Depends on env | Guaranteed |
| CI/CD | Flaky | Stable |

## CI/CD Integration

The real pipeline lives in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml): lint + the unit suite on a Node version matrix (22, 24), plus a secret scan and a pack/build check. Integration tests are Docker/registry-based and stay on-demand (run them locally with the commands above).

## Troubleshooting

The two common failures:

- **Docker not found** — install Docker Desktop/Engine and verify with `docker --version`.
- **Tests timeout** — integration tests run real `npm ci`; raise the timeout via `JEST_TIMEOUT=600000 npm run test:integration` or per test (`test('name', async () => { ... }, 600000)`).

For anything container-side (npm/Node mismatch, registry access, stale containers), debug inside the container with the [interactive Docker session](#interactive-docker-session) above, and `docker-compose -f tests/integration/docker/docker-compose.yml down` to clear stale state.

## Performance Profiling

### Profile npm install

```javascript
import { getNodeVersion, getNpmVersion } from './helpers/npm-runner.js';

test('profile npm ci', async () => {
  const start = Date.now();
  await runNpmCi(workspace.dir);
  const duration = Date.now() - start;
  console.log(`npm ci took ${duration}ms`);
});
```

### Monitor Docker performance

```bash
# Watch container resource usage
docker stats

# In another terminal
npm run docker:test:node22
```

## Best Practices

1. **Keep fixtures minimal** - Fewer dependencies = faster tests
2. **Use mocks for unit tests** - Don't test npm/npm registry
3. **Use Docker for reproducibility** - CI/CD should use Docker
4. **Clean up workspaces** - Always call `workspace.cleanup()`
5. **Set timeouts appropriately** - Integration tests need more time
6. **Test edge cases** - Not just happy path
7. **Document test purpose** - Why does this test exist?

## Future Enhancements

- [ ] Add v3→v2 reverse migration tests
- [ ] Add complex fixture with nested dependencies
- [ ] Test workspace/monorepo configurations
- [ ] Add git dependency tests
- [ ] Performance benchmarking suite
