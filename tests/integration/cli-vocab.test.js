// tests/integration/cli-vocab.test.js
// End-to-end coverage for the canonical CLI vocabulary (P2b):
//   - the unified `--fail-on <key>=<value>` gate (severity= / count=)
//   - the deprecated `--strict` / `--max-warnings` / `--min-severity` aliases
//   - `--format json` replacing the retired boolean `--json` switch
//   - `--config` resolving a `.dependably-check` shared config
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { createTestWorkspace } from './helpers/test-workspace.js';

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

describe('Integration: CLI vocabulary (--fail-on gate)', () => {
  test('--fail-on count=0 fails on any warning (unpinned-v3)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['audit', ws.lockfilePath, '--fail-on', 'count=0'], { cwd: ws.dir });
      expect(r.code).toBe(1);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('--fail-on count=99 passes when warnings are within budget', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['audit', ws.lockfilePath, '--fail-on', 'count=99'], { cwd: ws.dir });
      expect(r.code).toBe(0);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('--strict is a deprecated alias for --fail-on count=0 (still gates, warns on stderr)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['audit', ws.lockfilePath, '--strict'], { cwd: ws.dir });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--strict is deprecated/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('--max-warnings is a deprecated alias that still warns on stderr', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['audit', ws.lockfilePath, '--max-warnings', '0'], { cwd: ws.dir });
      expect(r.code).toBe(1);
      expect(r.stderr).toMatch(/--max-warnings is deprecated/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('an invalid --fail-on key is a usage error (exit 2)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['audit', ws.lockfilePath, '--fail-on', 'bogus=1'], { cwd: ws.dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Unknown --fail-on key/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('an invalid --fail-on count value is a usage error (exit 2)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['audit', ws.lockfilePath, '--fail-on', 'count=-1'], { cwd: ws.dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Invalid --fail-on count/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('an invalid --fail-on severity value is a usage error (exit 2)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['vuln', ws.lockfilePath, '--offline', '--fail-on', 'severity=fatal'], { cwd: ws.dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Invalid --fail-on severity/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('--min-severity is a deprecated alias that still parses (warns on stderr)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      // Offline so the scan does no network work; we only assert the alias parses.
      const r = await runCli(['vuln', ws.lockfilePath, '--offline', '--min-severity', 'critical'], { cwd: ws.dir });
      expect(r.stderr).toMatch(/--min-severity is deprecated/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);
});

describe('Integration: CLI vocabulary (--format json replaces boolean --json)', () => {
  test('unused --format json emits machine-readable JSON', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['unused', ws.dir, '--format', 'json'], { cwd: ws.dir });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(Array.isArray(parsed.unused)).toBe(true);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('the retired boolean --json switch is now a rejected unknown option (exit 2)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['unused', ws.dir, '--json'], { cwd: ws.dir });
      // --json was retired: rather than be silently ignored (a fail-open), an
      // unrecognized option is a usage error — exit 2 with `unknown option`.
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/unknown option: '--json'/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);
});

describe('Integration: CLI vocabulary (--config reads .dependably-check)', () => {
  test('a discovered .dependably-check npm section configures the audit', async () => {
    const ws = await createTestWorkspace('audit-bad');
    try {
      // Disable every failing rule via the shared config's `npm` section → pass.
      await fs.writeFile(path.join(ws.dir, '.dependably-check'), JSON.stringify({
        npm: {
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
        }
      }));
      const r = await runCli(['audit', ws.lockfilePath], { cwd: ws.dir });
      expect(r.code).toBe(0);
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('--config can point directly at a .dependably-check file', async () => {
    const ws = await createTestWorkspace('audit-bad');
    try {
      const cfg = path.join(ws.dir, '.dependably-check');
      await fs.writeFile(cfg, JSON.stringify({
        npm: {
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
        }
      }));
      const r = await runCli(['audit', ws.lockfilePath, '--config', cfg], { cwd: ws.dir });
      expect(r.code).toBe(0);
    } finally {
      await ws.cleanup();
    }
  }, 30000);
});
