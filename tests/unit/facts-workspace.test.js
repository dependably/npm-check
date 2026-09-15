// tests/unit/facts-workspace.test.js
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverWorkspace, governedByManifest } from '../../src/facts/index.js';

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

  test('honours .gitignore, and never follows into node_modules', () => {
    const root = tempDir();
    put(root, '.gitignore', 'generated/\ndist/\n');
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

  describe('source is not excluded by directory name (sbom-reach GitLab #31)', () => {
    /**
     * `IGNORE_DIRS` used to drop `dist`, `build`, `out`, `coverage`, `.next`,
     * `.turbo` and `vendor` by NAME. In a real project those names are often
     * source (SvelteDocs keeps its build pipeline in a tracked, non-gitignored
     * `build/`). `.gitignore` decides now.
     */
    test('reads a tracked, non-gitignored build/', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, '.gitignore', 'node_modules/\ndemo-dist/\n');
      put(root, 'build/pipeline.js', '// header\nexport const x = 1;\n');
      put(root, 'src/index.js', "export const name = 'app';\n");
      const rels = discoverWorkspace(root).sourceFiles.map((f) => f.slice(root.length + 1));
      expect(rels).toEqual(['build/pipeline.js', 'src/index.js']);
    });

    test('reads out/, coverage/ and vendor/ on the same rule', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'out/a.js', '');
      put(root, 'coverage/b.js', '');
      put(root, 'vendor/c.js', '');
      put(root, 'dist/d.js', '');
      const rels = discoverWorkspace(root).sourceFiles.map((f) => f.slice(root.length + 1));
      expect(rels).toEqual(['coverage/b.js', 'dist/d.js', 'out/a.js', 'vendor/c.js']);
    });

    test('still excludes a gitignored dist/', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, '.gitignore', 'node_modules/\ndist/\n');
      put(root, 'dist/bundle.js', '');
      put(root, 'src/index.js', "export const name = 'app';\n");
      const rels = discoverWorkspace(root).sourceFiles.map((f) => f.slice(root.length + 1));
      expect(rels).toEqual(['src/index.js']);
    });

    test('honours a nested .gitignore, not only the root one', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'root', private: true }));
      put(root, '.gitignore', 'node_modules/\n');
      put(root, 'packages/lib/.gitignore', 'dist/\n');
      put(root, 'packages/lib/package.json', JSON.stringify({ name: 'lib' }));
      put(root, 'packages/lib/dist/bundle.js', '');
      put(root, 'packages/lib/src/index.js', '');
      // Another package's build output, ignored nowhere: still read.
      put(root, 'packages/app/package.json', JSON.stringify({ name: 'app' }));
      put(root, 'packages/app/dist/bundle.js', '');
      const rels = discoverWorkspace(root).sourceFiles.map((f) => f.slice(root.length + 1));
      expect(rels).toEqual(['packages/app/dist/bundle.js', 'packages/lib/src/index.js']);
    });

    test('lets a nested .gitignore re-include what the root ignored', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, '.gitignore', 'build/\n');
      put(root, 'tools/.gitignore', '!build/\n');
      put(root, 'build/generated.js', '');
      put(root, 'tools/build/pipeline.js', '');
      const rels = discoverWorkspace(root).sourceFiles.map((f) => f.slice(root.length + 1));
      expect(rels).toEqual(['tools/build/pipeline.js']);
    });

    test('never lists a node_modules file as first-party source', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'src/index.js', '');
      put(root, 'node_modules/unrelated/package.json', JSON.stringify({ name: 'unrelated', version: '1.0.0' }));
      put(root, 'node_modules/unrelated/index.js', '');
      put(root, 'node_modules/.bin/whatever.js', '');
      const rels = discoverWorkspace(root).sourceFiles.map((f) => f.slice(root.length + 1));
      expect(rels).toEqual(['src/index.js']);
    });

    test("does not read a dependency's own .gitignore as this tree's policy", () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'node_modules/unrelated/package.json', JSON.stringify({ name: 'unrelated', version: '1.0.0' }));
      put(root, 'node_modules/unrelated/.gitignore', 'src/\n');
      put(root, 'src/index.js', '');
      const rels = discoverWorkspace(root).sourceFiles.map((f) => f.slice(root.length + 1));
      expect(rels).toEqual(['src/index.js']);
    });
  });

  describe('OUTPUT_DIR_SCANNED', () => {
    test('names the output-shaped directories that were scanned', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'build/pipeline.js', '');
      put(root, 'dist/bundle.js', '');
      put(root, 'src/index.js', '');
      const diag = discoverWorkspace(root).diagnostics.find((d) => d.startsWith('OUTPUT_DIR_SCANNED:'));
      expect(diag).toContain('build/, dist/');
      expect(diag).toContain('gitignore them');
    });

    test('stays quiet when those directories are gitignored', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, '.gitignore', 'build/\ndist/\n');
      put(root, 'build/pipeline.js', '');
      put(root, 'dist/bundle.js', '');
      put(root, 'src/index.js', '');
      expect(discoverWorkspace(root).diagnostics.some((d) => d.startsWith('OUTPUT_DIR_SCANNED:'))).toBe(false);
    });

    test('stays quiet for an ordinary tree', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'src/index.js', '');
      expect(discoverWorkspace(root).diagnostics.some((d) => d.startsWith('OUTPUT_DIR_SCANNED:'))).toBe(false);
    });
  });

  describe('aliasScope: paths aliases are scoped to the subtree of the config that declares them', () => {
    test('a config outside src/ does not apply to a file inside src/', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'src/index.js', '');
      put(root, 'vendor/lib/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'js-yaml': ['./stub.ts'] } } }));
      const ws = discoverWorkspace(root);
      const srcFile = ws.sourceFiles.find((f) => f.endsWith('src/index.js'));
      expect([...ws.aliasScope.for(srcFile)]).toEqual([]);
      // FOR REPORTING ONLY: the union still lists it, so "did the tree declare
      // this alias at all?" remains answerable.
      expect(ws.aliasPrefixes.has('js-yaml')).toBe(true);
    });

    test('a config governs files in its own subtree', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'vendor/lib/tsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'js-yaml': ['./stub.ts'] } } }));
      put(root, 'vendor/lib/index.js', '');
      const ws = discoverWorkspace(root);
      const vendorFile = ws.sourceFiles.find((f) => f.endsWith('vendor/lib/index.js'));
      expect([...ws.aliasScope.for(vendorFile)]).toEqual(['js-yaml']);
    });

    test('a root tsconfig governs the whole tree', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { 'js-yaml': ['./shim.ts'] } } }));
      put(root, 'src/index.js', '');
      const ws = discoverWorkspace(root);
      const srcFile = ws.sourceFiles.find((f) => f.endsWith('src/index.js'));
      expect([...ws.aliasScope.for(srcFile)]).toEqual(['js-yaml']);
    });

    test('scopes by the config that was FOUND, not by what it extends', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { 'js-yaml': ['./shim.ts'] } } }));
      put(root, 'vendor/lib/tsconfig.json', JSON.stringify({ extends: '../../tsconfig.base.json' }));
      put(root, 'src/index.js', '');
      const ws = discoverWorkspace(root);
      const srcFile = ws.sourceFiles.find((f) => f.endsWith('src/index.js'));
      // The root `tsconfig.base.json` is itself a root-level config, so its
      // aliases legitimately govern the whole tree.
      expect([...ws.aliasScope.for(srcFile)]).toEqual(['js-yaml']);

      const root2 = tempDir();
      put(root2, 'package.json', JSON.stringify({ name: 'app' }));
      put(root2, 'vendor/lib/tsconfig.base.json', JSON.stringify({ compilerOptions: { paths: { 'js-yaml': ['./shim.ts'] } } }));
      put(root2, 'vendor/lib/tsconfig.json', JSON.stringify({ extends: './tsconfig.base.json' }));
      put(root2, 'src/index.js', '');
      const ws2 = discoverWorkspace(root2);
      const srcFile2 = ws2.sourceFiles.find((f) => f.endsWith('src/index.js'));
      // vendor/lib/tsconfig.json adds nothing outside vendor/lib/.
      expect([...ws2.aliasScope.for(srcFile2)]).toEqual([]);
    });
  });

  describe('devDeclaredBy', () => {
    test('records which manifest(s) declared a dev-only dependency', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'app' }));
      put(root, 'vendor/tool/package.json', JSON.stringify({ name: 'tool', devDependencies: { 'js-yaml': '^4.1.0' } }));
      const ws = discoverWorkspace(root);
      expect(ws.devDeclaredBy.get('js-yaml')).toEqual(['vendor/tool/package.json']);
    });

    test('is pruned once "runtime anywhere wins" settles a name runtime', () => {
      const root = tempDir();
      put(root, 'package.json', JSON.stringify({ name: 'root', devDependencies: { shared: '1' } }));
      put(root, 'packages/a/package.json', JSON.stringify({ name: 'a', dependencies: { shared: '1' } }));
      const ws = discoverWorkspace(root);
      expect(ws.depScopes.get('shared')).toBe('runtime');
      expect(ws.devDeclaredBy.has('shared')).toBe(false);
    });
  });

  describe('governedByManifest', () => {
    test('a root manifest governs the whole tree', () => {
      expect(governedByManifest('package.json', 'src/index.js')).toBe(true);
      expect(governedByManifest('package.json', 'vendor/tool/lib.js')).toBe(true);
    });

    test("a nested manifest governs only its own subtree", () => {
      expect(governedByManifest('vendor/tool/package.json', 'vendor/tool/lib.js')).toBe(true);
      expect(governedByManifest('vendor/tool/package.json', 'src/index.js')).toBe(false);
    });
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
    expect(ws.diagnostics).toEqual([
      'NPM_TSCONFIG_UNPARSEABLE: unparseable tsconfig/jsconfig at web/tsconfig.json; aliases from it ignored'
    ]);
  });

  test('reports an unparseable package.json and keeps going', () => {
    const root = tempDir();
    put(root, 'package.json', '{');
    put(root, 'packages/a/package.json', JSON.stringify({ name: 'a' }));
    const ws = discoverWorkspace(root);
    expect(ws.diagnostics).toEqual(['NPM_MANIFEST_UNPARSEABLE: unparseable package.json at package.json; skipped']);
    expect(ws.firstPartyNames.has('a')).toBe(true);
  });
});
