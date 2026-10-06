// tests/unit/facts-resolve-exports.test.js
// `resolveExports` on its own (conditions, arrays, patterns, blocked and
// malformed maps) and the `ModuleResolver` paths around it: query/fragment
// stripping, exports targets that escape or are missing, exports-less
// subpaths, and paths that are neither a file nor a directory.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModuleResolver, resolveExports } from '../../src/facts/index.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-resolve-')));
  dirs.push(d);
  return d;
}
function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function pkg(root, name, manifest, files) {
  put(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0', ...manifest }));
  for (const rel of files) put(root, `node_modules/${name}/${rel}`, '');
}

const IMPORT = new Set(['import', 'node', 'default']);
const REQUIRE = new Set(['require', 'node', 'default']);

describe('resolveExports', () => {
  test('a string map is the root entry only', () => {
    expect(resolveExports('./index.js', '.', IMPORT)).toBe('./index.js');
    expect(resolveExports('./index.js', './sub', IMPORT)).toBeUndefined();
  });

  test('a conditions object answers the root entry by the first matching condition', () => {
    const map = { import: './esm.mjs', require: './cjs.cjs' };
    expect(resolveExports(map, '.', IMPORT)).toBe('./esm.mjs');
    expect(resolveExports(map, '.', REQUIRE)).toBe('./cjs.cjs');
    expect(resolveExports(map, './sub', IMPORT)).toBeUndefined();
    expect(resolveExports({ browser: './b.js' }, '.', IMPORT)).toBeUndefined();
  });

  test('nested conditions are followed until a string is reached', () => {
    const map = { '.': { browser: './b.js', import: { deno: './deno.js', node: './node.mjs' }, default: './d.js' } };
    expect(resolveExports(map, '.', IMPORT)).toBe('./node.mjs');
    expect(resolveExports(map, '.', REQUIRE)).toBe('./d.js');
  });

  test('an array falls through to the first entry that resolves', () => {
    expect(resolveExports([{ browser: './b.js' }, './fallback.js'], '.', IMPORT)).toBe('./fallback.js');
    expect(resolveExports([{ browser: './b.js' }], '.', IMPORT)).toBeUndefined();
    expect(resolveExports({ './x': [{ browser: './b.js' }, { import: './x.mjs' }] }, './x', IMPORT)).toBe('./x.mjs');
    expect(resolveExports({ './x': [{ browser: './b.js' }] }, './x', IMPORT)).toBeUndefined();
  });

  test('an exact key wins over a pattern, and null blocks the subpath', () => {
    const map = { './*': './lib/*.js', './internal': null, './exact': './exact.js' };
    expect(resolveExports(map, './exact', IMPORT)).toBe('./exact.js');
    expect(resolveExports(map, './internal', IMPORT)).toBeNull();
    expect(resolveExports(map, './other', IMPORT)).toBe('./lib/other.js');
  });

  test('a pattern substitutes the captured part, inside conditions and arrays too', () => {
    expect(resolveExports({ './features/*': { import: './esm/*.mjs', require: './cjs/*.cjs' } }, './features/a/b', IMPORT)).toBe('./esm/a/b.mjs');
    expect(resolveExports({ './features/*': { import: './esm/*.mjs', require: './cjs/*.cjs' } }, './features/a', REQUIRE)).toBe('./cjs/a.cjs');
    expect(resolveExports({ './*': [{ browser: './web/*.js' }, './lib/*.js'] }, './x', IMPORT)).toBe('./lib/x.js');
    expect(resolveExports({ './internal/*': null, './*': './lib/*.js' }, './internal/x', IMPORT)).toBeNull();
  });

  test('the longest pattern prefix wins, then the longer key', () => {
    const map = { './*': './any/*', './*.css': './css/*.css', './icons/*': './icons/*.svg' };
    expect(resolveExports(map, './400.css', IMPORT)).toBe('./css/400.css');
    expect(resolveExports(map, './icons/home', IMPORT)).toBe('./icons/home.svg');
    expect(resolveExports(map, './plain', IMPORT)).toBe('./any/plain');
  });

  test('nothing matches: no pattern fits, the subpath is shorter than prefix plus suffix, or the map is malformed', () => {
    expect(resolveExports({ './a/*': './a/*.js' }, './b/x', IMPORT)).toBeUndefined();
    expect(resolveExports({ './ab*ba': './x/*.js' }, './aba', IMPORT)).toBeUndefined();
    expect(resolveExports(null, '.', IMPORT)).toBeUndefined();
    expect(resolveExports(42, '.', IMPORT)).toBeUndefined();
    expect(resolveExports({ '.': 42 }, '.', IMPORT)).toBeUndefined();
  });
});

describe('ModuleResolver', () => {
  function buildTree() {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app', imports: { '#util': './src/util.js' } }));
    put(root, 'src/index.js', '');
    put(root, 'src/util.js', '');
    put(root, 'src/logo.svg', '');
    return root;
  }

  test('strips a query or fragment from a relative or bare specifier, but not from a #imports key', () => {
    const root = buildTree();
    pkg(root, 'lib', {}, ['index.js', 'style.css']);
    const r = new ModuleResolver();
    const from = join(root, 'src/index.js');
    expect(r.resolve(from, './util.js?raw', 'import').path).toBe(join(root, 'src/util.js'));
    expect(r.resolve(from, './util.js#section', 'import').path).toBe(join(root, 'src/util.js'));
    expect(r.resolve(from, './util.js?a=1#b?c', 'import').path).toBe(join(root, 'src/util.js'));
    expect(r.resolve(from, './logo.svg?url', 'import')).toMatchObject({ kind: 'asset', path: join(root, 'src/logo.svg') });
    expect(r.resolve(from, 'lib/style.css?inline', 'import')).toMatchObject({ kind: 'asset', path: join(root, 'node_modules/lib/style.css') });
    expect(r.resolve(from, './missing.js?raw', 'import')).toEqual({ kind: 'unresolved', reason: 'not found: ./missing.js' });
    expect(r.resolve(from, '#util', 'import').path).toBe(join(root, 'src/util.js'));
    expect(r.resolve(from, '#nope', 'import').reason).toBe('imports map does not map #nope');
  });

  test('an exports target must stay inside the package and exist', () => {
    const root = buildTree();
    pkg(root, 'escapes', { exports: { '.': './../outside.js' } }, []);
    pkg(root, 'not-relative', { exports: { '.': 'lib/index.js' } }, ['lib/index.js']);
    pkg(root, 'gone', { exports: { '.': './lib/index.js' } }, []);
    pkg(root, 'dir-target', { exports: { '.': './lib', './feature': { import: './esm/feature.js', require: './cjs/feature.js' } } }, ['lib/index.js', 'esm/feature.js', 'cjs/feature.js']);
    const r = new ModuleResolver();
    const from = join(root, 'src/index.js');
    expect(r.resolve(from, 'escapes', 'import').reason).toBe('invalid exports target ./../outside.js');
    expect(r.resolve(from, 'not-relative', 'import').reason).toBe('invalid exports target lib/index.js');
    expect(r.resolve(from, 'gone', 'import').reason).toBe('exports target missing: ./lib/index.js');
    expect(r.resolve(from, 'dir-target', 'import').path).toBe(join(root, 'node_modules/dir-target/lib/index.js'));
    expect(r.resolve(from, 'dir-target/feature', 'import').path).toBe(join(root, 'node_modules/dir-target/esm/feature.js'));
    expect(r.resolve(from, 'dir-target/feature', 'require').path).toBe(join(root, 'node_modules/dir-target/cjs/feature.js'));
    expect(r.resolve(from, 'dir-target/other', 'import').reason).toBe('exports map does not expose "other" of dir-target');
    expect(r.resolve(from, 'gone/x', 'import').reason).toBe('exports map does not expose "x" of gone');
  });

  test('a package without exports resolves subpaths from disk, and reports a missing entry point', () => {
    const root = buildTree();
    pkg(root, 'plain', { exports: null }, ['lib/x.js', 'lib/dir/index.js']);
    pkg(root, 'empty', {}, ['README.md']);
    put(root, 'node_modules/bad-json/package.json', '{ not json');
    put(root, 'node_modules/bad-json/index.js', '');
    put(root, 'node_modules/scalar-json/package.json', '7');
    put(root, 'node_modules/scalar-json/index.js', '');
    const r = new ModuleResolver();
    const from = join(root, 'src/index.js');
    expect(r.resolve(from, 'plain/lib/x', 'import').path).toBe(join(root, 'node_modules/plain/lib/x.js'));
    expect(r.resolve(from, 'plain/lib/dir', 'import').path).toBe(join(root, 'node_modules/plain/lib/dir/index.js'));
    expect(r.resolve(from, 'plain/lib/missing', 'import').reason).toBe('not found in package: lib/missing');
    expect(r.resolve(from, 'plain', 'import').reason).toBe('no entry point in plain');
    expect(r.resolve(from, 'empty', 'import').reason).toBe('no entry point in empty');
    expect(r.resolve(from, 'bad-json', 'import').path).toBe(join(root, 'node_modules/bad-json/index.js'));
    expect(r.resolve(from, 'scalar-json', 'import').path).toBe(join(root, 'node_modules/scalar-json/index.js'));
  });

  test('a path that is neither a file nor a directory does not resolve', () => {
    const root = buildTree();
    const r = new ModuleResolver();
    expect(r.resolve(join(root, 'src/index.js'), '/dev/null', 'import')).toEqual({ kind: 'unresolved', reason: 'not found: /dev/null' });
  });
});
