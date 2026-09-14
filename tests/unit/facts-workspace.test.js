// tests/unit/facts-workspace.test.js
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspace } from '../../src/facts/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NPM_APP = join(__dirname, '..', 'fixtures', 'facts', 'npm-app');
const SVELTE_APP = join(__dirname, '..', 'fixtures', 'facts', 'svelte-app');

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-ws-')));
  dirs.push(d);
  return d;
}
function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

describe('discoverWorkspace', () => {
  test('discovers .svelte source files and jsconfig.json path aliases', () => {
    const ws = discoverWorkspace(SVELTE_APP);
    expect(ws.sourceFiles.some((f) => f.endsWith('Vulnerable.svelte'))).toBe(true);
    expect(ws.aliasPrefixes.has('aliased-pkg')).toBe(true);
    expect(ws.aliasPrefixes.has('$lib')).toBe(true);
    expect(ws.diagnostics).toEqual([]);
  });

  test('reads every manifest: first-party names, "runtime anywhere wins" scopes, tsconfig aliases, sorted sources', () => {
    const ws = discoverWorkspace(NPM_APP);
    expect([...ws.firstPartyNames].sort()).toEqual(['@fixture/ui', '@fixture/utils', 'npm-fixture-app']);
    expect(ws.depScopes.get('lodash')).toBe('runtime');
    expect(ws.depScopes.get('supertest')).toBe('dev');
    expect(ws.depScopes.get('type-fest')).toBe('dev');
    expect([...ws.aliasPrefixes].sort()).toEqual(['@app', 'left-pad']);
    const rels = ws.sourceFiles.map((f) => f.slice(NPM_APP.length + 1));
    expect(rels).toEqual([...rels].sort());
    expect(rels).toContain('src/index.ts');
    expect(rels).toContain('packages/ui/src/button.tsx');
    expect(rels).toContain('test/app.test.ts');
  });

  test('a dev declaration in one manifest does not win over a runtime declaration in another', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'root', devDependencies: { shared: '1' } }));
    put(root, 'packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { shared: '1' }, peerDependencies: { peer: '1' }, optionalDependencies: { opt: '1' } }));
    const ws = discoverWorkspace(root);
    expect(ws.depScopes.get('shared')).toBe('runtime');
    expect(ws.depScopes.get('peer')).toBe('runtime');
    expect(ws.depScopes.get('opt')).toBe('runtime');
  });

  test('honours .gitignore and the built-in ignore list, and never follows into node_modules', () => {
    const root = tempDir();
    put(root, '.gitignore', 'generated/\n');
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'src/a.js', '');
    put(root, 'generated/b.js', '');
    put(root, 'dist/c.js', '');
    put(root, 'node_modules/dep/package.json', JSON.stringify({ name: 'dep', dependencies: { hidden: '1' } }));
    put(root, 'node_modules/dep/index.js', '');
    const ws = discoverWorkspace(root);
    expect(ws.sourceFiles.map((f) => f.slice(root.length + 1))).toEqual(['src/a.js']);
    expect(ws.firstPartyNames.has('dep')).toBe(false);
    expect(ws.depScopes.has('hidden')).toBe(false);
  });

  test('resolves tsconfig `extends` chains for inherited paths, and reports an unparseable config', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { '@base/*': ['base/*'] } } }));
    put(root, 'tsconfig.json', JSON.stringify({ extends: './tsconfig.base', compilerOptions: { paths: { '@app/*': ['src/*'] } } }));
    put(root, 'web/tsconfig.json', '{ not json');
    put(root, 'web/jsconfig.json', JSON.stringify({ extends: '@tsconfig/node20', compilerOptions: { paths: { utils: ['x'] } } }));
    const ws = discoverWorkspace(root);
    expect([...ws.aliasPrefixes].sort()).toEqual(['@app', '@base', 'utils']);
    expect(ws.diagnostics).toEqual(['unparseable tsconfig/jsconfig at web/tsconfig.json; aliases from it ignored']);
  });

  test('reports an unparseable package.json and keeps going', () => {
    const root = tempDir();
    put(root, 'package.json', '{');
    put(root, 'packages/a/package.json', JSON.stringify({ name: 'a' }));
    const ws = discoverWorkspace(root);
    expect(ws.diagnostics).toEqual(['unparseable package.json at package.json; skipped']);
    expect(ws.firstPartyNames.has('a')).toBe(true);
  });
});
