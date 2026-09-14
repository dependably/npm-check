// tests/unit/facts-cli.test.js
// `npm-check imports` end to end: the facts document on stdout, exit 0 on a
// successful scan (never 1), exit 2 on usage errors, and the vocabulary
// (`--format`, `--no-module-graph`, `--max-files`, `--max-file-bytes`; the
// retired boolean `--json` is an unknown option). Also pins that the findings
// envelope (`report --format json`) still carries NO `documentType`.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../bin/cli.js');
const NPM_APP = path.join(__dirname, '../fixtures/facts/npm-app');
const SVELTE_APP = path.join(__dirname, '../fixtures/facts/svelte-app');

function runCli(args, opts = {}) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: opts.cwd || os.tmpdir(), timeout: 60000 });
}

describe('imports: the facts document', () => {
  test('defaults to --format json, emits documentType "imports", exits 0', () => {
    const r = runCli(['imports', NPM_APP]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.tool).toBe('npm-check');
    expect(doc.documentType).toBe('imports');
    expect(doc.schemaVersion).toBe('1.1');
    expect(doc.target).toBe(NPM_APP);
    expect(doc.findings).toBeUndefined();
    expect(doc.summary.scanned).toBe(6);
    expect(doc.summary.analyzed).toBe(6);
    expect(doc.summary.imports).toBe(11);
    expect(doc.summary.exitCode).toBe(0);
    expect(Array.isArray(doc.unanalyzable)).toBe(true);
    expect(doc.imports.map((f) => f.file)).toContain('src/index.ts');
    expect(doc.lockfile.files).toEqual(['package-lock.json']);
  });

  test('the clean svelte fixture has no unanalyzable entry and its .svelte sites carry real line numbers', () => {
    const r = runCli(['imports', SVELTE_APP]);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.unanalyzable).toEqual([]);
    const both = doc.imports.find((f) => f.file === 'src/ModuleAndInstance.svelte');
    expect(both.sites.map((s) => [s.specifier, s.line])).toEqual([
      ['module-only-pkg', 2],
      ['vuln-lib', 6]
    ]);
  });

  test('--no-module-graph turns the walk off and the document says so', () => {
    const r = runCli(['imports', NPM_APP, '--no-module-graph']);
    expect(r.status).toBe(0);
    const doc = JSON.parse(r.stdout);
    expect(doc.moduleGraph.enabled).toBe(false);
    expect(doc.summary.moduleGraph).toEqual({ filesParsed: 0, reached: 0, unresolved: 0, truncated: false });
  });

  test('--max-files / --max-file-bytes are valued flags whose values are not read as options', () => {
    const r = runCli(['imports', NPM_APP, '--max-files', '1', '--max-file-bytes', '10']);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).documentType).toBe('imports');
  });

  test('--format human prints the summary, not the document', () => {
    const r = runCli(['imports', NPM_APP, '--format', 'human']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Import facts for ${NPM_APP}`);
    expect(r.stdout).toMatch(/6 first-party source file\(s\) found, 6 analyzed/);
    expect(r.stdout).toMatch(/11 import site\(s\)/);
    expect(() => JSON.parse(r.stdout)).toThrow();
  });

  test('a bare `imports` with no dir scans the current directory as "."', () => {
    const r = runCli(['imports'], { cwd: SVELTE_APP });
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout).target).toBe('.');
  });
});

describe('imports: usage errors are exit 2, never 1', () => {
  test('a missing target directory', () => {
    const r = runCli(['imports', path.join(os.tmpdir(), 'npm-check-no-such-dir-' + Date.now())]);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Directory not found/);
  });

  test('the retired boolean --json switch is an unknown option', () => {
    const r = runCli(['imports', NPM_APP, '--json']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/unknown option: '--json'/);
  });

  test('a bad --format value', () => {
    const r = runCli(['imports', NPM_APP, '--format', 'yaml']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Invalid --format value/);
  });

  test('a non-positive --max-files', () => {
    const r = runCli(['imports', NPM_APP, '--max-files', '0']);
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/Invalid --max-files value/);
  });

  test('--help lists the command and its options', () => {
    const r = runCli(['--help']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/imports \[dir\]/);
    expect(r.stdout).toMatch(/--no-module-graph/);
    expect(r.stdout).toMatch(/TYPESCRIPT_MISSING/);
  });
});

describe('report --format json (findings envelope) is unchanged', () => {
  let tmpDir;
  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-facts-cli-'));
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), JSON.stringify({ name: 'test', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'test', version: '1.0.0' } } }, null, 2));
  });
  afterAll(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('has no documentType', () => {
    const r = runCli(['report', '--format', 'json', '--offline'], { cwd: tmpDir });
    const doc = JSON.parse(r.stdout);
    expect(doc.tool).toBe('npm-check');
    expect('documentType' in doc).toBe(false);
    expect(Array.isArray(doc.findings)).toBe(true);
  });
});
