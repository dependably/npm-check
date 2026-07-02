// tests/unit/cli-args.test.js
// Regression tests for two CLI argument footguns fixed in bin/cli.js:
//   Issue #28 — getVersion() used .pathname instead of fileURLToPath, breaking
//               on Windows (leading /C:/) and on paths with percent-encoded chars.
//   Issue #25 — inapplicable --fail-on keys (e.g. count= on vuln) were silently
//               ignored; --rule <id> without :<severity> was a silent no-op.
//
// All tests that need a real lockfile use a minimal fixture written to a temp dir.

import { spawnSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../bin/cli.js');
const NODE = process.execPath;

// Spawn the CLI synchronously, capturing stdout + stderr. cwd defaults to a temp
// dir that has no lockfile so file-not-found errors surface cleanly if needed.
function runCli(args, opts = {}) {
  return spawnSync(NODE, [CLI, ...args], {
    encoding: 'utf8',
    cwd: opts.cwd || os.tmpdir(),
    timeout: 15000
  });
}

// ---------------------------------------------------------------------------
// Issue #28 — getVersion: fileURLToPath instead of .pathname
// ---------------------------------------------------------------------------

describe('getVersion: fileURLToPath fix (issue #28)', () => {
  test('--version prints the package version, not "unknown"', () => {
    const result = runCli(['--version']);
    expect(result.status).toBe(0);
    // Must look like a semver string, never the fallback "unknown"
    expect(result.stdout).toMatch(/npm-check version \d+\.\d+\.\d+/);
    expect(result.stdout).not.toContain('unknown');
  });

  test('fileURLToPath decodes percent-encoded chars that .pathname leaves raw (regression)', () => {
    // This is the core of the bug: on any OS, a file:// URL with an encoded
    // space has pathname = '…with%20space…' but fileURLToPath gives '…with space…'.
    // fs.readFileSync on the former would fail; the latter is the real path.
    const url = new URL('file:///some/path/with%20space/package.json');
    // Old behaviour (buggy):
    expect(url.pathname).toBe('/some/path/with%20space/package.json');
    // New behaviour (fixed):
    expect(fileURLToPath(url)).toBe('/some/path/with space/package.json');
  });
});

// ---------------------------------------------------------------------------
// Issue #25 (part A) — --rule <id> without :<severity> must exit 2
// ---------------------------------------------------------------------------

describe('--rule spec validation (issue #25)', () => {
  // A temp dir with a minimal lockfile so audit can start. The --rule error
  // fires before the lockfile is read, but we need the file to exist so the
  // rejection is for the rule spec, not for a missing lockfile.
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-cli-test-'));
    const lockfile = {
      name: 'test', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'test', version: '1.0.0' } }
    };
    fs.writeFileSync(
      path.join(tmpDir, 'package-lock.json'),
      JSON.stringify(lockfile, null, 2)
    );
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('--rule pinned-versions (no colon) exits 2 with a clear message', () => {
    const result = runCli(['audit', '--rule', 'pinned-versions'], { cwd: tmpDir });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid --rule spec "pinned-versions"');
    expect(result.stderr).toContain('--rule <id>:<severity>');
  });

  test('--rule pinned-versions: (empty severity after colon) exits 2', () => {
    const result = runCli(['audit', '--rule', 'pinned-versions:'], { cwd: tmpDir });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('Invalid --rule spec "pinned-versions:"');
  });

  test('--rule pinned-versions:error (valid spec) does NOT exit 2 for a rule-spec reason', () => {
    const result = runCli(['audit', '--rule', 'pinned-versions:error'], { cwd: tmpDir });
    // May exit 0 or 1 (findings), but must not exit 2 for the spec format.
    expect(result.stderr).not.toContain('Invalid --rule spec');
  });

  test('--rule bogus:banana (bad severity value) exits 2 via mergeConfig, not the spec check', () => {
    // The spec format is valid (has a colon + non-empty rhs), so the format
    // check passes. mergeConfig rejects the unknown severity → exit 2.
    const result = runCli(['audit', '--rule', 'bogus:banana'], { cwd: tmpDir });
    expect(result.status).toBe(2);
    // Should NOT be our spec format message
    expect(result.stderr).not.toContain('Invalid --rule spec "bogus:banana"');
  });
});

// ---------------------------------------------------------------------------
// Issue #25 (part B) — inapplicable --fail-on keys per command must exit 2
// ---------------------------------------------------------------------------

describe('vuln: rejects inapplicable --fail-on keys (issue #25)', () => {
  test('vuln --fail-on count=0 exits 2 (count= has no meaning for a severity scanner)', () => {
    const result = runCli(['vuln', '--fail-on', 'count=0']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--fail-on count=');
    expect(result.stderr).toContain('"vuln"');
  });

  test('vuln --fail-on count=5 also exits 2', () => {
    const result = runCli(['vuln', '--fail-on', 'count=5']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--fail-on count=');
  });

  test('vuln --fail-on severity=critical is valid (exits for file issues, not flag)', () => {
    const result = runCli(['vuln', '--fail-on', 'severity=critical']);
    // Must NOT exit 2 with our "count= not supported" message
    expect(result.stderr).not.toContain('--fail-on count=');
    // Hint present for when it DOES exit 2 (missing lockfile), to confirm it's
    // not our assertion:
    if (result.status === 2) {
      expect(result.stderr).not.toContain('"vuln"');
    }
  });
});

describe('deprecated: rejects inapplicable --fail-on keys (issue #25)', () => {
  test('deprecated --fail-on severity=high exits 2 (severity= not on the deprecation ladder)', () => {
    const result = runCli(['deprecated', '--fail-on', 'severity=high']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--fail-on severity=');
    expect(result.stderr).toContain('"deprecated"');
  });

  test('deprecated --fail-on count=3 exits 2 (non-zero count undefined for this command)', () => {
    const result = runCli(['deprecated', '--fail-on', 'count=3']);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('count=3');
    expect(result.stderr).toContain('"deprecated"');
  });

  test('deprecated --fail-on count=0 is valid (means fail on any deprecation)', () => {
    const result = runCli(['deprecated', '--fail-on', 'count=0']);
    // Must NOT exit 2 with our "not supported" message
    expect(result.stderr).not.toContain('is not supported by the "deprecated"');
  });
});

describe('audit: rejects inapplicable --fail-on keys (issue #25)', () => {
  let tmpDir;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-cli-test-'));
    const lockfile = {
      name: 'test', version: '1.0.0', lockfileVersion: 3,
      packages: { '': { name: 'test', version: '1.0.0' } }
    };
    fs.writeFileSync(
      path.join(tmpDir, 'package-lock.json'),
      JSON.stringify(lockfile, null, 2)
    );
  });

  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('audit --fail-on severity=critical exits 2 (severity= not supported by audit)', () => {
    const result = runCli(['audit', '--fail-on', 'severity=critical'], { cwd: tmpDir });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('--fail-on severity=');
    expect(result.stderr).toContain('"audit"');
  });

  test('audit --fail-on count=0 is valid (any finding fails)', () => {
    const result = runCli(['audit', '--fail-on', 'count=0'], { cwd: tmpDir });
    // Must NOT exit 2 for the --fail-on severity= reason
    expect(result.stderr).not.toContain('--fail-on severity= is not supported by the "audit"');
  });

  test('audit --fail-on count=5 is valid (5-warning budget)', () => {
    const result = runCli(['audit', '--fail-on', 'count=5'], { cwd: tmpDir });
    expect(result.stderr).not.toContain('--fail-on severity= is not supported by the "audit"');
  });
});
