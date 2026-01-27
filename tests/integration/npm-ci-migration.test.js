import { migrateToVersion, LOCKFILE_VERSIONS } from '../../src/index.js';
import { createTestWorkspace, cleanNodeModules, readJSON, writeJSON } from './helpers/test-workspace.js';
import { runNpmCi, getNodeVersion, getNpmVersion } from './helpers/npm-runner.js';
import { captureNodeModulesState, compareNodeModulesStates } from './helpers/fs-compare.js';

describe('Integration: npm ci Migration Validation', () => {
  let nodeVersion;
  let npmVersion;

  beforeAll(async () => {
    nodeVersion = await getNodeVersion();
    npmVersion = await getNpmVersion();
    console.log(`\nRunning tests with Node ${nodeVersion} and npm ${npmVersion}\n`);
  });

  test('v2 to v3 migration produces identical node_modules', async () => {
    const workspace = await createTestWorkspace('simple-v2');

    try {
      // Step 1: Install with original v2 lockfile
      console.log('→ Installing with v2 lockfile...');
      const startV2 = Date.now();
      await runNpmCi(workspace.dir);
      const durationV2 = Date.now() - startV2;
      const v2State = await captureNodeModulesState(workspace.dir);
      console.log(`  ✓ Installed ${v2State.packageCount} packages in ${durationV2}ms`);

      // Step 2: Migrate lockfile to v3
      console.log('→ Migrating lockfile to v3...');
      const v2Lockfile = await readJSON(workspace.lockfilePath);

      // Verify it's v2
      expect(v2Lockfile.lockfileVersion).toBe(2);

      const v3Lockfile = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V3);

      // Verify migration changed version
      expect(v3Lockfile.lockfileVersion).toBe(LOCKFILE_VERSIONS.V3);
      console.log('  ✓ Migration completed (v2 → v3)');

      // Step 3: Clean and reinstall with v3 lockfile
      console.log('→ Cleaning node_modules...');
      await cleanNodeModules(workspace.dir);
      await writeJSON(workspace.lockfilePath, v3Lockfile);

      console.log('→ Installing with v3 lockfile...');
      const startV3 = Date.now();
      await runNpmCi(workspace.dir);
      const durationV3 = Date.now() - startV3;
      const v3State = await captureNodeModulesState(workspace.dir);
      console.log(`  ✓ Installed ${v3State.packageCount} packages in ${durationV3}ms`);

      // Step 4: Compare installations
      console.log('→ Comparing installations...');
      const comparison = compareNodeModulesStates(v2State, v3State);

      // Assertions - Check functional equivalence
      expect(comparison.identical).toBe(true);
      expect(comparison.versionMismatches).toEqual([]);
      expect(comparison.missingInV3).toEqual([]);
      expect(comparison.extraInV3).toEqual([]);

      console.log('  ✓ Installations are identical!');

    } finally {
      await workspace.cleanup();
    }
  }, 300000); // 5 minute timeout

  test('npm ci succeeds with v3 lockfile', async () => {
    const workspace = await createTestWorkspace('simple-v2');

    try {
      // Migrate and install directly with v3
      const v2Lockfile = await readJSON(workspace.lockfilePath);
      const v3Lockfile = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V3);
      await writeJSON(workspace.lockfilePath, v3Lockfile);

      // Should not throw
      await runNpmCi(workspace.dir);

      // Verify node_modules exists and has content
      const state = await captureNodeModulesState(workspace.dir);
      expect(state.packageCount).toBeGreaterThan(0);

    } finally {
      await workspace.cleanup();
    }
  }, 300000); // 5 minute timeout

  test('v3 lockfile has correct structure', async () => {
    const workspace = await createTestWorkspace('simple-v2');

    try {
      const v2Lockfile = await readJSON(workspace.lockfilePath);
      const v3Lockfile = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V3);

      // Verify v3 structure
      expect(v3Lockfile.lockfileVersion).toBe(LOCKFILE_VERSIONS.V3);
      expect(v3Lockfile.packages).toBeDefined();
      expect(Object.keys(v3Lockfile.packages).length).toBeGreaterThan(0);

    } finally {
      await workspace.cleanup();
    }
  });

  test('migration preserves root metadata', async () => {
    const workspace = await createTestWorkspace('simple-v2');

    try {
      const v2Lockfile = await readJSON(workspace.lockfilePath);
      const v3Lockfile = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V3);

      // Root metadata should be preserved
      expect(v3Lockfile.name).toBe(v2Lockfile.name);
      expect(v3Lockfile.version).toBe(v2Lockfile.version);

      // Version should be updated
      expect(v3Lockfile.lockfileVersion).toBe(3);
      expect(v2Lockfile.lockfileVersion).toBe(2);

    } finally {
      await workspace.cleanup();
    }
  });

});
