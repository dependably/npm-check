// tests/integration/fix-checksums.test.js
// End-to-end test against the real npm registry: blank a known hash and
// verify fix-checksums restores exactly the original value.
import { execFile } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTestWorkspace, readJSON, writeJSON } from './helpers/test-workspace.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../bin/cli.js');

async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('Integration: npfix fix-checksums (real registry)', () => {
  test('restores a blanked integrity hash to the original registry value', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const original = await readJSON(workspace.lockfilePath);
      const originalHash = original.packages['node_modules/lodash'].integrity;
      expect(originalHash).toMatch(/^sha512-/);

      // Blank the hash, then ask fix-checksums to restore it
      delete original.packages['node_modules/lodash'].integrity;
      await writeJSON(workspace.lockfilePath, original);

      const result = await runCli(['fix-checksums', workspace.lockfilePath, '--write'], { cwd: workspace.dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Fixed from registry: 1/);

      const fixed = await readJSON(workspace.lockfilePath);
      expect(fixed.packages['node_modules/lodash'].integrity).toBe(originalHash);
      // The other package was untouched
      expect(fixed.packages['node_modules/ms'].integrity).toBe(
        original.packages['node_modules/ms'].integrity
      );
    } finally {
      await workspace.cleanup();
    }
  }, 60000);

  test('refuses v1 lockfiles with a migrate hint', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const lockfile = await readJSON(workspace.lockfilePath);
      const v1 = {
        name: lockfile.name,
        version: lockfile.version,
        lockfileVersion: 1,
        dependencies: {}
      };
      await writeJSON(workspace.lockfilePath, v1);

      const result = await runCli(['fix-checksums', workspace.lockfilePath], { cwd: workspace.dir });
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/migrate 3/);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);
});
