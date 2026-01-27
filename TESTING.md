# Testing Guide

## Overview

This project has two types of tests:
- **Unit Tests**: Fast, isolated tests with mocks (< 1 second)
- **Integration Tests**: End-to-end tests with real npm operations in Docker (requires Docker)

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

# Run integration tests with Node 18 and npm 10
npm run docker:test:node18-npm10

# Or run all Node/npm combinations
npm run docker:test:all
```

**Available Docker test targets:**
- `npm run docker:test:node18-npm9` - Node 18 with npm 9
- `npm run docker:test:node18-npm10` - Node 18 with npm 10
- `npm run docker:test:node20` - Node 20 with npm 10
- `npm run docker:test:node22` - Node 22 with npm 10

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
npm run docker:test:node20
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
docker-compose -f tests/integration/docker/docker-compose.yml run --rm test-node18-npm10 sh
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

### GitHub Actions Example

```yaml
name: Tests

on: [push, pull_request]

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: 18
      - run: npm ci
      - run: npm run test:unit

  integration:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm run docker:build
      - run: npm run docker:test:node18-npm10
```

## Troubleshooting

### Docker not found

```bash
# Install Docker Desktop or Engine
# Then verify:
docker --version
```

### npm ci fails in container

```bash
# Check npm/Node compatibility
docker-compose -f tests/integration/docker/docker-compose.yml \
  run --rm test-node18-npm10 \
  sh -c "node --version && npm --version"

# Check network connectivity
docker-compose -f tests/integration/docker/docker-compose.yml \
  run --rm test-node18-npm10 \
  npm config get registry
```

### Tests timeout

Increase Jest timeout in tests or via environment:

```bash
# Via npm script
JEST_TIMEOUT=600000 npm run test:integration

# Or in test file
test('name', async () => { ... }, 600000);
```

### Port already in use

If tests fail with port conflicts:

```bash
# Stop all running containers
docker-compose -f tests/integration/docker/docker-compose.yml down

# Or remove all containers
docker container prune
```

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
npm run docker:test:node20
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
- [ ] GitHub Actions CI workflow
