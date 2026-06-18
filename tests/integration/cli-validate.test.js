// tests/integration/cli-validate.test.js
// End-to-end tests for `npm-check validate` — focused on graceful handling of a
// malformed package.json (must report, not crash) alongside a valid lockfile.
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTestWorkspace } from './helpers/test-workspace.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../bin/cli.js');

// execFile rejects on non-zero exit; normalize to {code, stdout, stderr}
async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('Integration: npm-check validate', () => {
  test('reports a malformed package.json instead of crashing', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      await fs.writeFile(workspace.packageJsonPath, '{ not: valid json,,,', 'utf8');
      const result = await runCli(['validate', workspace.lockfilePath], { cwd: workspace.dir });

      // fails the run (exit 1) — but as a reported finding, not an uncaught throw
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/PJ_PARSE_ERROR|not valid JSON/);
      expect(result.stdout).toMatch(/"valid": false/);
      // a crash would surface a Node stack trace on stderr — there must be none
      expect(result.stderr).not.toMatch(/at .*\(.*:\d+:\d+\)/);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('still reports the lockfile result when package.json is broken', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      await fs.writeFile(workspace.packageJsonPath, '{ broken', 'utf8');
      const result = await runCli(['validate', workspace.lockfilePath], { cwd: workspace.dir });
      expect(result.stdout).toMatch(/package-lock\.json/);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);
});
