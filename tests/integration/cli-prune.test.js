// tests/integration/cli-prune.test.js
// End-to-end tests for `npm-check prune` orphan removal.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
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

describe('Integration: npm-check prune', () => {
  test('removes injected orphans with --write and creates a backup', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const lockfile = await readJSON(workspace.lockfilePath);
      lockfile.packages['node_modules/orphan-a'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/orphan-a/-/orphan-a-1.0.0.tgz',
        integrity: 'sha512-' + 'C'.repeat(86) + '=='
      };
      // orphan-a pulls orphan-b, but nothing reaches orphan-a → both orphaned
      lockfile.packages['node_modules/orphan-a'].dependencies = { 'orphan-b': '^1.0.0' };
      lockfile.packages['node_modules/orphan-b'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/orphan-b/-/orphan-b-1.0.0.tgz',
        integrity: 'sha512-' + 'D'.repeat(86) + '=='
      };
      await writeJSON(workspace.lockfilePath, lockfile);

      // Dry-run lists but does not write
      const dryRun = await runCli(['prune', workspace.lockfilePath], { cwd: workspace.dir });
      expect(dryRun.code).toBe(0);
      expect(dryRun.stdout).toMatch(/orphan-a/);
      expect(dryRun.stdout).toMatch(/orphan-b/);
      const untouched = await readJSON(workspace.lockfilePath);
      expect(untouched.packages['node_modules/orphan-a']).toBeDefined();

      // --write removes them
      const write = await runCli(['prune', workspace.lockfilePath, '--write'], { cwd: workspace.dir });
      expect(write.code).toBe(0);
      const pruned = await readJSON(workspace.lockfilePath);
      expect(pruned.packages['node_modules/orphan-a']).toBeUndefined();
      expect(pruned.packages['node_modules/orphan-b']).toBeUndefined();
      expect(pruned.packages['node_modules/lodash']).toBeDefined();

      const backups = await fs.readdir(path.join(workspace.dir, '.backups'));
      expect(backups.some((name) => name.includes('package-lock.json'))).toBe(true);

      // And the audit no-orphan-packages rule is clean afterwards
      // (the fixture is intentionally unpinned, so silence that rule for strict mode)
      const audit = await runCli([
        'audit', workspace.lockfilePath, '--strict', '--rule', 'pinned-versions:off'
      ], { cwd: workspace.dir });
      expect(audit.code).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('reports a fully-connected lockfile as clean', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const result = await runCli(['prune', workspace.lockfilePath], { cwd: workspace.dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/No orphaned packages found/);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);
});
