// tests/unit/facts-cli-human.test.js
// `npm-check imports --format human`: the module graph line of the summary in
// each of its three states (not walked, node_modules missing, walked).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(__dirname, '../../bin/cli.js');

function runCli(args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: os.tmpdir(), timeout: 60000 });
}

let dir;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-cli-human-')));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function put(rel, content) {
  const p = path.join(dir, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function app() {
  put('package.json', JSON.stringify({ name: 'app', dependencies: { lib: '1.0.0', loader: '1.0.0' } }));
  put('src/index.js', "import 'lib';\nimport 'loader';\n");
}

describe('imports --format human: the module graph line', () => {
  test('says the graph was not walked under --no-module-graph', () => {
    app();
    const r = runCli(['imports', dir, '--format', 'human', '--no-module-graph']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`Import facts for ${dir}`);
    expect(r.stdout).toContain('2 import site(s)');
    expect(r.stdout).toContain('module graph: not walked (--no-module-graph)');
    expect(r.stdout).not.toContain('node_modules file(s) parsed');
  });

  test('says node_modules is not installed when nothing could be followed', () => {
    app();
    const r = runCli(['imports', dir, '--format', 'human']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('module graph: node_modules is not installed — 2 import(s) unresolved, nothing followed');
    expect(r.stdout).not.toContain('not walked');
  });

  test('reports parsed files, reached packages and packages that load modules dynamically', () => {
    app();
    put('node_modules/lib/package.json', JSON.stringify({ name: 'lib', version: '1.0.0' }));
    put('node_modules/lib/index.js', 'export const x = 1;\n');
    put('node_modules/loader/package.json', JSON.stringify({ name: 'loader', version: '1.0.0' }));
    put('node_modules/loader/index.js', 'module.exports = (name) => require(name);\n');
    const r = runCli(['imports', dir, '--format', 'human']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('module graph: 2 node_modules file(s) parsed, 2 installed package copy(ies) reached, 0 import(s) unresolved');
    expect(r.stdout).not.toContain('truncated at the file budget');
    expect(r.stdout).toMatch(/1 reached package\(s\) load modules dynamically or were not fully parsed: loader@1\.0\.0/);
  });

  test('flags a walk that stopped at the file budget', () => {
    app();
    put('node_modules/lib/package.json', JSON.stringify({ name: 'lib', version: '1.0.0' }));
    put('node_modules/lib/index.js', "import './a.js';\nimport './b.js';\n");
    put('node_modules/lib/a.js', '');
    put('node_modules/lib/b.js', '');
    put('node_modules/loader/package.json', JSON.stringify({ name: 'loader', version: '1.0.0' }));
    put('node_modules/loader/index.js', '');
    const r = runCli(['imports', dir, '--format', 'human', '--max-files', '1']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('(truncated at the file budget)');
  });
});
