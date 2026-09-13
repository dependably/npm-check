// tests/unit/facts-module-graph.test.js
// The resolver (src/facts/resolve.js) and the walker (src/facts/modulegraph.js):
// exports maps, nested shadowing, pnpm's symlinked layout by realpath, and the
// honesty rules — dynamic, incomplete, unresolvedByName, truncated,
// unanalyzable. Every tree is built in a temp dir; nothing here depends on a
// real install. Ported from the resolver/walker half of sbom-reach's
// analyzer-npm `module-graph.test.ts` (its verdict cases stayed there).
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleResolver, packageRootOf, resolveExports, scanSource, walkModuleGraph, packageKey, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES } from '../../src/facts/index.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-graph-')));
  dirs.push(d);
  return d;
}

/** Writes a file (and its directories) under root. */
function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}

function pkg(root, name, version, files, manifest = {}) {
  const base = `node_modules/${name}`;
  // `name` may be a nested path ("dev-tool/node_modules/vuln-leaf"); the package's own name is the last package segment.
  const marker = 'node_modules/';
  const realName = name.includes(marker) ? name.slice(name.lastIndexOf(marker) + marker.length) : name;
  put(root, `${base}/package.json`, JSON.stringify({ name: realName, version, ...manifest }));
  for (const [rel, content] of Object.entries(files)) put(root, `${base}/${rel}`, content);
}

/**
 * app/src/index.js → lib-a (exports map) → lib-b (main) → vuln-leaf@1.0.0
 * app/src/index.js → dev-tool (only in a config file) → vuln-leaf@2.0.0 (nested copy)
 */
function buildTree() {
  const root = tempDir();
  put(root, 'package.json', JSON.stringify({ name: 'app', version: '0.0.0', dependencies: { 'lib-a': '1.0.0' }, devDependencies: { 'dev-tool': '1.0.0' } }));
  put(root, 'src/index.js', "import { helperA } from 'lib-a';\nhelperA();\n");
  put(root, 'tool.config.js', "import tool from 'dev-tool';\nexport default tool();\n");
  pkg(
    root,
    'lib-a',
    '1.0.0',
    {
      'dist/index.mjs': "import { fromB } from 'lib-b';\nexport function helperA() { return fromB(); }\n",
      'dist/index.cjs': "const { fromB } = require('lib-b');\nexports.helperA = () => fromB();\n"
    },
    { exports: { '.': { import: './dist/index.mjs', require: './dist/index.cjs' } } }
  );
  pkg(root, 'lib-b', '1.0.0', { 'lib/main.js': "import { danger, safe } from 'vuln-leaf';\nexport function fromB() { return safe(); }\n" }, { main: 'lib/main.js' });
  pkg(root, 'vuln-leaf', '1.0.0', { 'index.js': 'export function danger() {}\nexport function safe() {}\n' });
  pkg(root, 'dev-tool', '1.0.0', { 'index.js': "import { danger } from 'vuln-leaf';\nexport default function tool() { return danger(); }\n" });
  pkg(root, 'dev-tool/node_modules/vuln-leaf', '2.0.0', { 'index.js': 'export function danger() {}\n' });
  return root;
}

function roots(root, rels) {
  return rels.map((rel) => {
    const file = join(root, rel);
    return { file, scan: scanSource(rel, readFileSync(file, 'utf8')) };
  });
}

describe('ModuleResolver', () => {
  test('follows exports maps with import/require conditions, main, and index probing', () => {
    const root = buildTree();
    const r = new ModuleResolver();
    const fromApp = join(root, 'src/index.js');
    const a = r.resolve(fromApp, 'lib-a', 'import');
    expect(a.kind).toBe('file');
    expect(a.path.endsWith('lib-a/dist/index.mjs')).toBe(true);
    const aReq = r.resolve(fromApp, 'lib-a', 'require');
    expect(aReq.path.endsWith('lib-a/dist/index.cjs')).toBe(true);
    const b = r.resolve(join(root, 'node_modules/lib-a/dist/index.mjs'), 'lib-b', 'import');
    expect(b.path.endsWith('lib-b/lib/main.js')).toBe(true);
    const leaf = r.resolve(join(root, 'node_modules/lib-b/lib/main.js'), 'vuln-leaf', 'import');
    expect(leaf.pkg.version).toBe('1.0.0');
  });

  test('a nested node_modules copy shadows the hoisted one for files inside its parent package', () => {
    const root = buildTree();
    const r = new ModuleResolver();
    const leaf = r.resolve(join(root, 'node_modules/dev-tool/index.js'), 'vuln-leaf', 'import');
    expect(leaf.pkg.version).toBe('2.0.0');
  });

  test('reports builtins, aliases, uninstalled packages, blocked exports and .d.ts-only targets distinctly', () => {
    const root = buildTree();
    put(root, 'node_modules/types-only/package.json', JSON.stringify({ name: 'types-only', version: '1.0.0', main: 'index.d.ts' }));
    put(root, 'node_modules/types-only/index.d.ts', 'export {};');
    put(root, 'node_modules/blocked/package.json', JSON.stringify({ name: 'blocked', version: '1.0.0', exports: { '.': './index.js', './internal': null } }));
    put(root, 'node_modules/blocked/index.js', '');
    const r = new ModuleResolver(new Set(['@app']));
    const from = join(root, 'src/index.js');
    expect(r.resolve(from, 'fs', 'import').kind).toBe('builtin');
    expect(r.resolve(from, 'node:fs/promises', 'import').kind).toBe('builtin');
    expect(r.resolve(from, '@app/utils', 'import').kind).toBe('alias');
    expect(r.resolve(from, 'not-installed', 'import')).toEqual({ kind: 'unresolved', reason: 'package not installed: not-installed' });
    expect(r.resolve(from, 'types-only', 'import').kind).toBe('unresolved');
    expect(r.resolve(from, 'blocked/internal', 'import').reason).toMatch(/blocks/);
    expect(r.resolve(from, 'blocked/other', 'import').reason).toMatch(/does not expose/);
    expect(r.resolve(from, 'blocked', 'import').kind).toBe('file');
    expect(r.resolve(from, '', 'import').kind).toBe('unresolved');
    expect(r.resolve(from, '@scope', 'import').reason).toMatch(/malformed scoped/);
    expect(r.resolve(from, 'data:text/javascript,1', 'import').reason).toBe('URL specifier');
  });

  test('maps ./x.js in a TypeScript source to ./x.ts, and package.json imports (#internal)', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app', imports: { '#util': './src/util.ts', '#dep': 'lib-a' } }));
    put(root, 'src/index.ts', '');
    put(root, 'src/util.ts', '');
    pkg(root, 'lib-a', '1.0.0', { 'index.js': '' });
    const r = new ModuleResolver();
    const rel = r.resolve(join(root, 'src/index.ts'), './util.js', 'import');
    expect(rel.path.endsWith('src/util.ts')).toBe(true);
    const hash = r.resolve(join(root, 'src/index.ts'), '#util', 'import');
    expect(hash.path.endsWith('src/util.ts')).toBe(true);
    // a bare-specifier alias through `imports`
    expect(r.resolve(join(root, 'src/index.ts'), '#dep', 'import').pkg.name).toBe('lib-a');
    expect(r.resolve(join(root, 'src/index.ts'), '#missing', 'import').kind).toBe('unresolved');
    // a query/fragment is stripped; a JSON file is an asset, not a file to parse
    put(root, 'src/data.json', '{}');
    expect(r.resolve(join(root, 'src/index.ts'), './data.json?raw', 'import').kind).toBe('asset');
  });

  test('packageOf derives the package from the LAST node_modules segment, scope included, with the directory name kept for aliased installs', () => {
    const root = tempDir();
    put(root, 'node_modules/@scope/pkg/package.json', JSON.stringify({ name: '@scope/pkg', version: '3.1.4' }));
    put(root, 'node_modules/@scope/pkg/esm/package.json', JSON.stringify({ type: 'module' }));
    put(root, 'node_modules/@scope/pkg/esm/index.js', '');
    put(root, 'node_modules/string-width-cjs/package.json', JSON.stringify({ name: 'string-width', version: '4.2.3' }));
    put(root, 'node_modules/string-width-cjs/index.js', '');
    const r = new ModuleResolver();
    const scoped = r.packageOf(join(root, 'node_modules/@scope/pkg/esm/index.js'));
    expect(scoped).toMatchObject({ name: '@scope/pkg', dirName: '@scope/pkg', version: '3.1.4' });
    const aliased = r.packageOf(join(root, 'node_modules/string-width-cjs/index.js'));
    expect(aliased).toMatchObject({ name: 'string-width', dirName: 'string-width-cjs', version: '4.2.3' });
    expect(r.packageOf(join(root, 'src/index.js'))).toBeUndefined();
    expect(packageRootOf('/x/node_modules/a/node_modules/@s/b/lib/c.js')).toBe('/x/node_modules/a/node_modules/@s/b');
    expect(packageRootOf('/x/src/a.js')).toBeUndefined();
    expect(packageRootOf('/x/node_modules')).toBeUndefined();
    expect(packageRootOf('/x/node_modules/@s')).toBeUndefined();
  });

  test('http/https/http2 are builtins, not URL specifiers', () => {
    const r = new ModuleResolver();
    expect(r.resolve('/x/a.js', 'http', 'require').kind).toBe('builtin');
    expect(r.resolve('/x/a.js', 'https', 'import').kind).toBe('builtin');
    expect(r.resolve('/x/a.js', 'http2', 'import').kind).toBe('builtin');
    expect(r.resolve('/x/a.js', 'https://example.com/x.js', 'import').kind).toBe('unresolved');
  });
});

describe('resolveExports', () => {
  const conds = new Set(['import', 'node', 'default']);
  test('handles strings, arrays, condition objects, subpath maps and * patterns', () => {
    expect(resolveExports('./index.js', '.', conds)).toBe('./index.js');
    expect(resolveExports('./index.js', './x', conds)).toBeUndefined();
    expect(resolveExports({ import: './a.mjs', require: './a.cjs' }, '.', conds)).toBe('./a.mjs');
    expect(resolveExports({ import: './a.mjs' }, './x', conds)).toBeUndefined();
    expect(resolveExports({ '.': { default: './i.js' }, './feature': './f.js', './lib/*': './src/*.js' }, './lib/x', conds)).toBe('./src/x.js');
    expect(resolveExports({ './*': './dist/*', './internal/*': null }, './internal/secret', conds)).toBeNull();
    expect(resolveExports({ './a': './a.js' }, './b', conds)).toBeUndefined();
    expect(resolveExports([{ types: './x.d.ts' }, './x.js'], '.', conds)).toBe('./x.js');
    expect(resolveExports({ '.': { import: ['./a.mjs'] } }, '.', conds)).toBe('./a.mjs');
    expect(resolveExports(null, '.', conds)).toBeUndefined();
    expect(resolveExports(42, '.', conds)).toBeUndefined();
  });

  test('exports pattern ties go to the longer key', () => {
    const conds2 = new Set(['import', 'default']);
    expect(resolveExports({ './*': './*.css', './*.css': './*.css' }, './400.css', conds2)).toBe('./400.css');
    expect(resolveExports({ './*': './dist/*.js', './*.js': './dist/*.js' }, './foo.js', conds2)).toBe('./dist/foo.js');
  });
});

describe('walkModuleGraph', () => {
  test('exports its defaults and the key shape', () => {
    expect(DEFAULT_MAX_FILES).toBe(25000);
    expect(DEFAULT_MAX_FILE_BYTES).toBe(1500000);
    expect(packageKey({ name: 'Foo', dirName: 'foo', version: '1.0.0', root: '/r/node_modules/foo' })).toBe('foo@1.0.0\0/r/node_modules/foo');
  });

  test('reaches packages through the chain with per-copy versions, importers and shortest chains', () => {
    const root = buildTree();
    const resolver = new ModuleResolver();
    const graph = walkModuleGraph({ srcDir: root, resolver, roots: roots(root, ['src/index.js', 'tool.config.js']), scan: scanSource });
    expect(graph.truncated).toBe(false);
    expect(graph.unresolved).toBe(0);
    expect(graph.unanalyzable).toEqual([]);
    expect(graph.filesParsed).toBe(5);
    const v1 = graph.byNameVersion.get('vuln-leaf@1.0.0');
    const v2 = graph.byNameVersion.get('vuln-leaf@2.0.0');
    expect(v1).toHaveLength(1);
    expect(v2).toHaveLength(1);
    expect(v1[0].chain.map((k) => graph.reached.get(k).name)).toEqual(['lib-a', 'lib-b', 'vuln-leaf']);
    expect(v2[0].chain.map((k) => graph.reached.get(k).name)).toEqual(['dev-tool', 'vuln-leaf']);
    // lib-b imported `danger` and `safe` but only REFERENCED `safe`.
    const importerOfV1 = v1[0].importers[0];
    expect([...importerOfV1.bindings].sort()).toEqual(['danger', 'safe']);
    expect(importerOfV1.referenced).toEqual(['safe']);
    expect(importerOfV1.fromPackage).toBe(graph.byName.get('lib-b')[0].key);
    // A first-party importer has no fromPackage.
    const libA = graph.byName.get('lib-a')[0];
    expect(libA.importers).toHaveLength(1);
    expect(libA.importers[0].fromPackage).toBeUndefined();
    expect(libA.importers[0].file).toBe(join(root, 'src/index.js'));
    expect(libA.chain).toEqual([libA.key]);
  });

  test('flags dynamic requires and oversized files, stops at the file budget, and lists what it did not parse', () => {
    const root = tempDir();
    put(root, 'src/index.js', "import 'loader';\nimport 'big';\nimport 'chain-1';\n");
    pkg(root, 'loader', '1.0.0', { 'index.js': 'const name = process.env.X; require(name);\n' });
    pkg(root, 'big', '1.0.0', { 'index.js': `// ${'x'.repeat(200)}\n` });
    for (let i = 1; i <= 5; i++) pkg(root, `chain-${i}`, '1.0.0', { 'index.js': i < 5 ? `import 'chain-${i + 1}';\n` : '' });
    const resolver = new ModuleResolver();
    const graph = walkModuleGraph({ srcDir: root, resolver, roots: roots(root, ['src/index.js']), scan: scanSource, maxFileBytes: 100, maxFiles: 3 });
    expect(graph.byName.get('loader')[0].dynamic).toBe(true);
    expect(graph.byName.get('big')[0].incomplete).toBe(true);
    expect(graph.filesSkippedForSize).toBe(1);
    expect(graph.truncated).toBe(true);
    expect(graph.filesPastBudget).toBeGreaterThan(0);
    expect(graph.weakPackages).toEqual(['big@1.0.0', 'loader@1.0.0']);
    expect(graph.unanalyzable).toEqual([{ file: join(root, 'node_modules/big/index.js'), reason: expect.stringMatching(/^too large to parse: \d+ bytes exceeds the 100-byte limit$/) }]);
  });

  test('a type-only import is never an edge', () => {
    const root = tempDir();
    put(root, 'src/index.ts', "import type { T } from 'types-pkg';\n");
    pkg(root, 'types-pkg', '1.0.0', { 'index.js': "import 'hidden';\n" });
    pkg(root, 'hidden', '1.0.0', { 'index.js': '' });
    const graph = walkModuleGraph({ srcDir: root, resolver: new ModuleResolver(), roots: roots(root, ['src/index.ts']), scan: scanSource });
    expect(graph.reached.size).toBe(0);
  });

  test('follows a pure re-export barrel (no import/require substring) instead of going dark behind it', () => {
    const root = tempDir();
    put(root, 'src/index.js', "import { x } from 'barrel';\nx();\n");
    pkg(root, 'barrel', '1.0.0', {
      'index.js': 'export * from "./main.js";\nexport * as default from "./main.js";\n',
      'main.js': "import { danger } from 'vuln-leaf';\nexport const x = () => danger();\n"
    });
    pkg(root, 'vuln-leaf', '1.0.0', { 'index.js': 'export function danger() {}\n' });
    const graph = walkModuleGraph({ srcDir: root, resolver: new ModuleResolver(), roots: roots(root, ['src/index.js']), scan: scanSource });
    const leaf = graph.byName.get('vuln-leaf')[0];
    expect(leaf.chain.map((k) => graph.reached.get(k).name)).toEqual(['barrel', 'vuln-leaf']);
  });

  test("resolves through pnpm's symlinked .pnpm layout by realpath, so a package's own dependencies are found — one physical copy is ONE reached package", () => {
    const root = tempDir();
    put(root, 'src/index.js', "import 'mid';\n");
    put(root, 'node_modules/.pnpm/mid@1.0.0/node_modules/mid/package.json', JSON.stringify({ name: 'mid', version: '1.0.0' }));
    put(root, 'node_modules/.pnpm/mid@1.0.0/node_modules/mid/index.js', "import { danger } from 'vuln-leaf';\ndanger();\n");
    put(root, 'node_modules/.pnpm/vuln-leaf@1.0.0/node_modules/vuln-leaf/package.json', JSON.stringify({ name: 'vuln-leaf', version: '1.0.0' }));
    put(root, 'node_modules/.pnpm/vuln-leaf@1.0.0/node_modules/vuln-leaf/index.js', 'export function danger() {}\n');
    symlinkSync(join(root, 'node_modules/.pnpm/vuln-leaf@1.0.0/node_modules/vuln-leaf'), join(root, 'node_modules/.pnpm/mid@1.0.0/node_modules/vuln-leaf'), 'dir');
    symlinkSync(join(root, 'node_modules/.pnpm/mid@1.0.0/node_modules/mid'), join(root, 'node_modules/mid'), 'dir');
    const graph = walkModuleGraph({ srcDir: root, resolver: new ModuleResolver(), roots: roots(root, ['src/index.js']), scan: scanSource });
    expect(graph.unresolved).toBe(0);
    const leaf = graph.byName.get('vuln-leaf');
    expect(leaf).toHaveLength(1);
    expect(leaf[0].importers).toHaveLength(1);
    expect(leaf[0].root).toContain('.pnpm/vuln-leaf@1.0.0/node_modules/vuln-leaf');
    expect(leaf[0].chain.map((k) => graph.reached.get(k).name)).toEqual(['mid', 'vuln-leaf']);
  });

  test('an unresolved import that NAMES a package is recorded under that name with where and why', () => {
    const root = tempDir();
    put(root, 'src/index.js', "import 'mid';\n");
    pkg(root, 'mid', '1.0.0', { 'index.js': "import 'vuln-leaf';\nimport '@scope/missing/sub';\n" });
    const graph = walkModuleGraph({ srcDir: root, resolver: new ModuleResolver(), roots: roots(root, ['src/index.js']), scan: scanSource });
    expect(graph.unresolved).toBe(2);
    expect(graph.unresolvedByName.get('vuln-leaf')).toEqual([{ file: join(root, 'node_modules/mid/index.js'), reason: 'package not installed: vuln-leaf' }]);
    expect(graph.unresolvedByName.get('@scope/missing')).toHaveLength(1);
    // mid itself is complete: nothing RELATIVE inside it went missing.
    expect(graph.byName.get('mid')[0].incomplete).toBe(false);
  });

  test('a dangling relative import inside a package marks it incomplete, not silently', () => {
    const root = tempDir();
    put(root, 'src/index.js', "import 'broken';\n");
    pkg(root, 'broken', '1.0.0', { 'index.js': "import './missing.js';\n" });
    const graph = walkModuleGraph({ srcDir: root, resolver: new ModuleResolver(), roots: roots(root, ['src/index.js']), scan: scanSource });
    expect(graph.byName.get('broken')[0].incomplete).toBe(true);
    expect(graph.weakPackages).toEqual(['broken@1.0.0']);
    expect(graph.unresolvedByName.size).toBe(0);
  });

  test("a package's own internal imports are traversed but never count as importers", () => {
    const root = tempDir();
    put(root, 'src/index.js', "import 'mid';\n");
    pkg(root, 'mid', '1.0.0', { 'index.js': "import { safe } from 'vuln-leaf';\nsafe();\n" });
    pkg(root, 'vuln-leaf', '1.0.0', {
      'index.js': "import { danger } from './danger.js';\nexport { danger };\nexport function safe() {}\n",
      'danger.js': "import { helper } from './lib/helper.js';\nexport function danger() { helper(); }\n",
      'lib/helper.js': 'export function helper() {}\n'
    });
    const graph = walkModuleGraph({ srcDir: root, resolver: new ModuleResolver(), roots: roots(root, ['src/index.js']), scan: scanSource });
    const leaf = graph.byName.get('vuln-leaf')[0];
    expect(leaf.importers).toHaveLength(1);
    expect(leaf.importers[0].file).toBe(join(root, 'node_modules/mid/index.js'));
    expect(graph.filesParsed).toBe(4);
  });

  test('an aliased install is indexed under both its package.json name and its directory name', () => {
    const root = tempDir();
    put(root, 'src/index.js', "import 'string-width-cjs';\n");
    put(root, 'node_modules/string-width-cjs/package.json', JSON.stringify({ name: 'string-width', version: '4.2.3' }));
    put(root, 'node_modules/string-width-cjs/index.js', '');
    const graph = walkModuleGraph({ srcDir: root, resolver: new ModuleResolver(), roots: roots(root, ['src/index.js']), scan: scanSource });
    expect(graph.byName.get('string-width')).toHaveLength(1);
    expect(graph.byName.get('string-width-cjs')).toHaveLength(1);
    expect(graph.byNameVersion.get('string-width-cjs@4.2.3')[0]).toBe(graph.byName.get('string-width')[0]);
  });
});
