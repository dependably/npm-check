// tests/integration/cli-audit.test.js
// End-to-end tests for `npfix audit` exit codes and output formats.
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

describe('Integration: npfix audit', () => {
  test('exits 0 on a clean lockfile', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      // unpinned-v3 has caret/tilde ranges → pinned-versions warnings, but
      // warnings alone pass by default
      const result = await runCli(['audit', workspace.lockfilePath], { cwd: workspace.dir });
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/warn\s+pinned-versions/);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('exits 1 on the audit-bad fixture with the expected findings', async () => {
    const workspace = await createTestWorkspace('audit-bad');
    try {
      const result = await runCli(['audit', workspace.lockfilePath], { cwd: workspace.dir });
      expect(result.code).toBe(1);
      expect(result.stdout).toMatch(/lockfile-version/);
      expect(result.stdout).toMatch(/integrity-hygiene/);
      expect(result.stdout).toMatch(/secure-resolved/);
      expect(result.stdout).toMatch(/sha1/);
      expect(result.stdout).toMatch(/non-TLS/);
      expect(result.stdout).toMatch(/untrusted registry host/);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('--strict turns pinned-versions warnings into failure', async () => {
    const workspace = await createTestWorkspace('unpinned-v3');
    try {
      const result = await runCli(['audit', workspace.lockfilePath, '--strict'], { cwd: workspace.dir });
      expect(result.code).toBe(1);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('--rule overrides flip the exit code', async () => {
    const workspace = await createTestWorkspace('audit-bad');
    try {
      const result = await runCli([
        'audit', workspace.lockfilePath,
        '--rule', 'lockfile-version:off',
        '--rule', 'integrity-hygiene:off',
        '--rule', 'secure-resolved:off',
        '--rule', 'valid-structure:off',
        '--rule', 'lockfile-sync:off'
      ], { cwd: workspace.dir });
      expect(result.code).toBe(0);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('--format json emits parseable output', async () => {
    const workspace = await createTestWorkspace('audit-bad');
    try {
      const result = await runCli(['audit', workspace.lockfilePath, '--format', 'json'], { cwd: workspace.dir });
      expect(result.code).toBe(1);
      const parsed = JSON.parse(result.stdout);
      expect(parsed.pass).toBe(false);
      expect(parsed.summary.errors).toBeGreaterThan(0);
      expect(Array.isArray(parsed.findings)).toBe(true);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('config file is discovered and exits 2 when broken', async () => {
    const workspace = await createTestWorkspace('audit-bad');
    try {
      // Valid config that disables everything → pass
      await fs.writeFile(path.join(workspace.dir, '.npfixrc.json'), JSON.stringify({
        rules: {
          'lockfile-version': 'off',
          'valid-structure': 'off',
          'integrity-hygiene': 'off',
          'secure-resolved': 'off',
          'pinned-versions': 'off',
          'lockfile-sync': 'off',
          'no-orphan-packages': 'off',
          'unused-dependencies': 'off'
        }
      }));
      const ok = await runCli(['audit', workspace.lockfilePath], { cwd: workspace.dir });
      expect(ok.code).toBe(0);

      // Broken config → operational error
      await fs.writeFile(path.join(workspace.dir, '.npfixrc.json'), '{ not json');
      const broken = await runCli(['audit', workspace.lockfilePath], { cwd: workspace.dir });
      expect(broken.code).toBe(2);
      expect(broken.stderr).toMatch(/Audit error/);
    } finally {
      await workspace.cleanup();
    }
  }, 30000);

  test('exits 2 for a missing lockfile', async () => {
    const result = await runCli(['audit', '/nonexistent/package-lock.json']);
    expect(result.code).toBe(2);
  }, 30000);
});
