// tests/integration/cli-pin.test.js
// End-to-end tests for `npm-check pin` file rewriting and backups.
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

describe('Integration: npm-check pin', () => {
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

  // Regression: a flag before the positional (`pin --write <path>`) must not
  // shadow the path. Previously `pin` read only argv[1], so the flag landed
  // there and the target silently fell back to cwd — writing to the wrong
  // project. Run from an unrelated cwd, point at the target's lockfile *file*
  // path, and assert only the target is rewritten.
  test('--write before a lockfile path targets that project, not cwd', async () => {
    const target = await createTestWorkspace('unpinned-v3');
    const elsewhere = await createTestWorkspace('unpinned-v3');
    try {
      const cwdBefore = await readJSON(elsewhere.packageJsonPath);

      const result = await runCli(['pin', '--write', target.lockfilePath], { cwd: elsewhere.dir });
      expect(result.code).toBe(0);

      // Target project was pinned…
      const targetPkg = await readJSON(target.packageJsonPath);
      expect(targetPkg.dependencies.lodash).toBe('4.17.21');

      // …and the cwd project was left completely untouched.
      const cwdAfter = await readJSON(elsewhere.packageJsonPath);
      expect(cwdAfter).toEqual(cwdBefore);
    } finally {
      await target.cleanup();
      await elsewhere.cleanup();
    }
  }, 30000);

  test('pinned project passes the audit pinned-versions rule', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      await runCli(['pin', workspace.dir, '--write'], { cwd: workspace.dir });
      // This asserts the pinned-versions rule is satisfied, via the gate. Scope
      // the run to that claim: the fixture is a bare package.json + lockfile
      // copied to a temp dir with no `.npmrc`, so the default-on
      // `min-release-age` rule warns about a cooldown this fixture was never
      // meant to carry, and `--strict` turns any warning into exit 1. Silencing
      // it by id keeps the assertion — the audit must still exit 0 on every
      // other rule — instead of relaxing it.
      const audit = await runCli([
        'audit', workspace.lockfilePath, '--strict', '--rule', 'min-release-age:off'
      ], { cwd: workspace.dir });
      expect(audit.code).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);
});
