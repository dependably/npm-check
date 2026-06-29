// tests/integration/cli-exit-codes.test.js
// End-to-end checks that the CLI's process exit codes follow the suite convention:
//   0  clean run (and --help / --version)
//   1  findings / vulns (a blocking result)
//   2  usage errors (unknown command/flag, invalid flag value, missing lockfile)
//      and operational/internal errors
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../bin/cli.js');

// execFile rejects on non-zero exit; normalize to {code, stdout, stderr}.
async function runCli(args, options = {}) {
  try {
    const { stdout, stderr } = await execFileAsync('node', [CLI, ...args], options);
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: err.code, stdout: err.stdout || '', stderr: err.stderr || '' };
  }
}

describe('Integration: CLI exit codes (suite convention)', () => {
  let emptyDir;
  let lockDir;

  beforeAll(async () => {
    // A directory with no package-lock.json / pnpm-lock.yaml.
    emptyDir = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-check-exit-'));
    // A directory WITH a minimal valid v3 lockfile, so flag parsing is reached.
    lockDir = await fs.mkdtemp(path.join(os.tmpdir(), 'npm-check-exit-lock-'));
    await fs.writeFile(
      path.join(lockDir, 'package-lock.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'demo', version: '1.0.0' } } }),
      'utf8'
    );
  });

  afterAll(async () => {
    await fs.rm(emptyDir, { recursive: true, force: true });
    await fs.rm(lockDir, { recursive: true, force: true });
  });

  // The missing-lockfile case must be 2 for EVERY subcommand (it was 1 for migrate).
  test.each(['report', 'vuln', 'deprecated', 'validate', 'migrate', 'upgrade', 'prune', 'audit'])(
    'exits 2 when the lockfile is missing (%s)',
    async (command) => {
      const result = await runCli([command], { cwd: emptyDir });
      expect(result.code).toBe(2);
    },
    30000
  );

  test('exits 2 on an unknown command', async () => {
    const result = await runCli(['bogus-command'], { cwd: emptyDir });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Unknown command/);
  });

  test('exits 2 on an invalid flag value (lockfile present, so flag parsing is reached)', async () => {
    const result = await runCli(['vuln', '--offline', '--format', 'xml'], { cwd: lockDir });
    expect(result.code).toBe(2);
    expect(result.stderr).toMatch(/Invalid --format/);
  });

  test('--help and --version exit 0', async () => {
    const help = await runCli(['--help'], { cwd: emptyDir });
    expect(help.code).toBe(0);
    const version = await runCli(['--version'], { cwd: emptyDir });
    expect(version.code).toBe(0);
    expect(version.stdout).toMatch(/npm-check version/);
  });

  test('-v is NOT a version alias (version is long-only)', async () => {
    // `-v` must not print the version banner; it falls through to the default
    // report command, which exits 2 here because emptyDir has no lockfile.
    const result = await runCli(['-v'], { cwd: emptyDir });
    expect(result.stdout).not.toMatch(/npm-check version/);
    expect(result.code).toBe(2);
  });
});
