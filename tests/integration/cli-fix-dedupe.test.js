// tests/integration/cli-fix-dedupe.test.js
// End-to-end guard for the destructive-dedupe regression: `fix` and `dedupe`
// must never drop required install-path entries from a real v3 packages map
// (whose entries carry no `.name` field). The old name#version dedupe silently
// dropped every such entry, gutting lockfiles down to the root.
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

describe('Integration: npm-check fix / dedupe are non-destructive', () => {
  test('dedupe preserves every install-path entry (dry-run and --write)', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const before = await readJSON(workspace.lockfilePath);
      const beforeKeys = Object.keys(before.packages).sort();
      expect(beforeKeys.length).toBe(3); // root + lodash + ms (both nameless)

      const dry = await runCli(['dedupe', workspace.lockfilePath], { cwd: workspace.dir });
      expect(dry.code).toBe(0);
      expect(dry.stdout).toMatch(/3 → 3 \(removed 0\)/);

      const write = await runCli(['dedupe', workspace.lockfilePath, '--write'], { cwd: workspace.dir });
      expect(write.code).toBe(0);
      const after = await readJSON(workspace.lockfilePath);
      expect(Object.keys(after.packages).sort()).toEqual(beforeKeys);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('fix preserves all entries and syncs a stale lockfile root from package.json', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      // Make the lockfile root stale relative to package.json (the rename/bump case).
      const lockfile = await readJSON(workspace.lockfilePath);
      lockfile.name = 'old-name';
      lockfile.version = '0.0.1';
      lockfile.packages[''].name = 'old-name';
      lockfile.packages[''].version = '0.0.1';
      await writeJSON(workspace.lockfilePath, lockfile);

      const result = await runCli(['fix', workspace.lockfilePath, '--write'], { cwd: workspace.dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/Synced/);

      const fixed = await readJSON(workspace.lockfilePath);
      // Every dependency entry survives.
      expect(Object.keys(fixed.packages).sort()).toEqual(
        ['', 'node_modules/lodash', 'node_modules/ms']
      );
      // Root identity now matches package.json.
      const pkg = await readJSON(workspace.packageJsonPath);
      expect(fixed.name).toBe(pkg.name);
      expect(fixed.version).toBe(pkg.version);
      expect(fixed.packages[''].name).toBe(pkg.name);

      const backups = await fs.readdir(path.join(workspace.dir, '.backups'));
      expect(backups.some((name) => name.includes('package-lock.json'))).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);
});
