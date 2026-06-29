// tests/integration/cli-schema-formats.test.js
// End-to-end coverage for the deprecated/remediate schema-conformance cleanup:
//   - `--format human` is the default (the `pretty` token was renamed)
//   - `--format json` emits the shared finding-schema envelope as ONE valid object
//   - the retired `pretty` token is now an invalid --format value (exit 2)
//   - `upgrade` still runs as the documented alias of `migrate 3`
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
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

// Assert the stdout is exactly ONE valid shared-schema envelope.
function expectEnvelope(stdout) {
  const env = JSON.parse(stdout); // throws if stdout is not a single JSON object
  expect(env.tool).toBe('npm-check');
  expect(typeof env.toolVersion).toBe('string');
  expect(env.schemaVersion).toBe('1.0');
  expect(typeof env.target).toBe('string');
  expect(env.summary).toBeDefined();
  expect(Array.isArray(env.findings)).toBe(true);
  // Non-negotiables: summary.findings == findings.length, exitCode present.
  expect(env.summary.findings).toBe(env.findings.length);
  expect(typeof env.summary.exitCode).toBe('number');
  // Every finding's severity is one of the five ladder strings.
  for (const f of env.findings) {
    expect(['critical', 'high', 'moderate', 'low', 'info']).toContain(f.severity);
  }
  return env;
}

describe('Integration: deprecated --format', () => {
  test('--format json (offline) emits one valid shared-schema envelope', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['deprecated', ws.lockfilePath, '--offline', '--format', 'json'], { cwd: ws.dir });
      expect(r.code).toBe(0);
      const env = expectEnvelope(r.stdout);
      expect(env.summary.exitCode).toBe(0); // matches the real exit code
      expect(env.extra.scan).toBeDefined(); // scan-completeness state preserved
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('--format human (the pretty rename) prints the readable scan output', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['deprecated', ws.lockfilePath, '--offline', '--format', 'human'], { cwd: ws.dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Scanned:/);
      expect(() => JSON.parse(r.stdout)).toThrow(); // human output is not JSON
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('the retired `pretty` token is now an invalid --format value (exit 2)', async () => {
    const ws = await createTestWorkspace('unpinned-v3');
    try {
      const r = await runCli(['deprecated', ws.lockfilePath, '--offline', '--format', 'pretty'], { cwd: ws.dir });
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/Invalid --format/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);
});

describe('Integration: remediate --format', () => {
  // A dependency-free workspace: the scanners find no candidates, so remediate
  // does zero network work and yields an empty (but valid) envelope.
  async function emptyWorkspace() {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plf-remediate-'));
    await fs.writeFile(path.join(tmpDir, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' }, null, 2), 'utf8');
    await fs.writeFile(path.join(tmpDir, 'package-lock.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'demo', version: '1.0.0' } } }, null, 2), 'utf8');
    return { dir: tmpDir, cleanup: () => fs.rm(tmpDir, { recursive: true, force: true }) };
  }

  test('--format json emits one valid shared-schema envelope (exit 0)', async () => {
    const ws = await emptyWorkspace();
    try {
      const r = await runCli(['remediate', ws.dir, '--format', 'json'], { cwd: ws.dir });
      expect(r.code).toBe(0);
      const env = expectEnvelope(r.stdout);
      expect(env.summary.exitCode).toBe(0); // remediate is an action command — always 0
      expect(env.extra).toHaveProperty('changed');
    } finally {
      await ws.cleanup();
    }
  }, 30000);

  test('--format human (the pretty rename) prints the readable remediation output', async () => {
    const ws = await emptyWorkspace();
    try {
      const r = await runCli(['remediate', ws.dir, '--format', 'human'], { cwd: ws.dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/Remediation Results/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);
});

describe('Integration: upgrade alias of migrate 3', () => {
  test('`upgrade` still migrates a v2 lockfile to v3', async () => {
    const ws = await createTestWorkspace('simple-v2');
    try {
      const r = await runCli(['upgrade', ws.lockfilePath], { cwd: ws.dir });
      expect(r.code).toBe(0);
      expect(r.stdout).toMatch(/v2 → v3|version 3/);
    } finally {
      await ws.cleanup();
    }
  }, 30000);
});
