// tests/integration/cli-pin.test.js
// End-to-end tests for `npfix pin` file rewriting and backups.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTestWorkspace, readJSON } from './helpers/test-workspace.js';

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

describe('Integration: npfix pin', () => {
  test('dry-run reports changes without touching files', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const before = await readJSON(workspace.packageJsonPath);
      const result = await runCli(['pin', workspace.dir], { cwd: workspace.dir });

      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/\^4\.17\.20 → 4\.17\.21/);
      expect(result.stdout).toMatch(/~2\.1\.0 → 2\.1\.3/);
      expect(result.stdout).toMatch(/--write/);

      const after = await readJSON(workspace.packageJsonPath);
      expect(after).toEqual(before);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('--write pins package.json, syncs lockfile root, and creates backups', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const result = await runCli(['pin', workspace.dir, '--write'], { cwd: workspace.dir });
      expect(result.code).toBe(0);

      const packageJson = await readJSON(workspace.packageJsonPath);
      expect(packageJson.dependencies.lodash).toBe('4.17.21');
      expect(packageJson.devDependencies.ms).toBe('2.1.3');

      const lockfile = await readJSON(workspace.lockfilePath);
      expect(lockfile.packages[''].dependencies.lodash).toBe('4.17.21');
      expect(lockfile.packages[''].devDependencies.ms).toBe('2.1.3');

      // Backups are created in .backups/ next to the written files
      const backupDir = path.join(workspace.dir, '.backups');
      const entries = await fs.readdir(backupDir);
      expect(entries.some((name) => name.includes('package.json'))).toBe(true);
      expect(entries.some((name) => name.includes('package-lock.json'))).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('pinned project passes the audit pinned-versions rule', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      await runCli(['pin', workspace.dir, '--write'], { cwd: workspace.dir });
      const audit = await runCli(['audit', workspace.lockfilePath, '--strict'], { cwd: workspace.dir });
      expect(audit.code).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);
});
