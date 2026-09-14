// tests/unit/facts-collect.test.js
// `collectImportFacts` (src/facts/collect.js): the one-call collector — every
// first-party site resolved to the copy it loads, the module graph, ONE
// lockfile discovery, and the load-bearing `unanalyzable` list. Fixture-based
// cases run with `moduleGraph: false` because the resolver walks UP from the
// fixture the way Node does and would find this repo's own node_modules;
// graph cases use temp trees with their own node_modules.
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectImportFacts, makeRelOf, FactsError, scanSource } from '../../src/facts/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NPM_APP = join(__dirname, '..', 'fixtures', 'facts', 'npm-app');
const SVELTE_APP = join(__dirname, '..', 'fixtures', 'facts', 'svelte-app');

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-collect-')));
  dirs.push(d);
  return d;
}
function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function pkg(root, name, version, files, manifest = {}) {
  put(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version, ...manifest }));
  for (const [rel, content] of Object.entries(files)) put(root, `node_modules/${name}/${rel}`, content);
}

describe('collectImportFacts on the npm-app fixture (no module graph)', () => {
  const facts = collectImportFacts(NPM_APP, { moduleGraph: false });

  test('records srcDir, every first-party file with a POSIX rel path, and one lockfile discovery', () => {
    expect(facts.srcDir).toBe(resolve(NPM_APP));
    expect(facts.graph).toBeUndefined();
    expect(facts.nodeModulesMissing).toBe(false);
    expect(facts.files.map((f) => f.rel)).toEqual([
      'packages/ui/src/button.tsx',
      'packages/utils/src/index.ts',
      'src/helper.ts',
      'src/index.ts',
      'src/shim/left-pad.ts',
      'test/app.test.ts'
    ]);
    expect(facts.lockfile.files).toEqual([join(NPM_APP, 'package-lock.json')]);
    expect(facts.lockfile.packages.some((p) => p.name === 'lodash' && p.version === '4.17.20')).toBe(true);
    expect(facts.lockfile.diagnostics).toEqual([]);
    expect(facts.unanalyzable).toEqual([]);
  });

  test('attributes each site to the package it names; aliases and first-party specifiers name none', () => {
    const index = facts.files.find((f) => f.rel === 'src/index.ts');
    const byPkg = Object.fromEntries(index.sites.map((s) => [s.specifier, s.package]));
    expect(byPkg).toEqual({
      lodash: 'lodash',
      express: 'express',
      'dayjs/plugin/utc': 'dayjs',
      'type-fest': 'type-fest',
      'left-pad': undefined, // tsconfig paths alias → not a package import
      '@app/helper': undefined,
      axios: 'axios',
      chalk: 'chalk'
    });
    expect(index.sites.find((s) => s.specifier === 'type-fest').kind).toBe('type-only-import');
    expect(index.sites.find((s) => s.specifier === 'chalk').kind).toBe('dynamic-import');
    expect(index.scan.dynamicUnknown).toBe(1);
    expect(facts.dynamicUnknownTotal).toBe(1);
    // A sibling workspace package is still NAMED (the fact) — deciding it is
    // first-party wiring is the consumer's, via workspace.firstPartyNames.
    const button = facts.files.find((f) => f.rel === 'packages/ui/src/button.tsx');
    expect(button.sites.map((s) => s.package)).toEqual(['lodash', '@fixture/utils']);
    expect(facts.workspace.firstPartyNames.has('@fixture/utils')).toBe(true);
  });

  test('an alias, a first-party specifier and an uninstalled package have no `installed`', () => {
    // (Other sites MAY resolve: the resolver walks up from the fixture the way
    // Node does, and this repo's own node_modules is above it.)
    const index = facts.files.find((f) => f.rel === 'src/index.ts');
    expect(index.sites.find((s) => s.specifier === 'left-pad').installed).toBeUndefined();
    expect(index.sites.find((s) => s.specifier === '@app/helper').installed).toBeUndefined();
    const button = facts.files.find((f) => f.rel === 'packages/ui/src/button.tsx');
    expect(button.sites.find((s) => s.specifier === '@fixture/utils').installed).toBeUndefined();
  });
});

describe('collectImportFacts: unanalyzable is load-bearing', () => {
  test('a .svelte file with a detected extraction problem is `file-partial`, its sites still present', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'src/Ok.svelte', "<script>\n  import lodash from 'lodash';\n</script>\n");
    put(root, 'src/Broken.svelte', "<script>\n  import axios from 'axios';\n  const x = ;\n</script>\n");
    const facts = collectImportFacts(root, { moduleGraph: false });
    expect(facts.files.map((f) => f.rel)).toEqual(['src/Broken.svelte', 'src/Ok.svelte']);
    expect(facts.files[0].sites.map((s) => s.package)).toEqual(['axios']);
    expect(facts.unanalyzable).toEqual([{ file: 'src/Broken.svelte', kind: 'file-partial', reason: expect.stringMatching(/^line 3: /) }]);
  });

  test('the clean svelte fixture produces no unanalyzable entry (a markup-only component is not a problem)', () => {
    const facts = collectImportFacts(SVELTE_APP, { moduleGraph: false });
    expect(facts.unanalyzable).toEqual([]);
    expect(facts.files.map((f) => [f.rel, f.sites.length])).toEqual([
      ['src/Aliased.svelte', 1],
      ['src/MarkupOnly.svelte', 0],
      ['src/ModuleAndInstance.svelte', 2],
      ['src/Vulnerable.svelte', 1]
    ]);
    expect(facts.files[0].sites[0].package).toBeUndefined(); // `aliased-pkg` is a jsconfig alias
  });

  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  const testUnlessRoot = asRoot ? test.skip : test;
  testUnlessRoot('an unreadable first-party file is listed as `file`, never silently skipped', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'src/ok.js', "import 'lodash';\n");
    put(root, 'src/locked.js', "import 'secret';\n");
    chmodSync(join(root, 'src/locked.js'), 0o000);
    try {
      const facts = collectImportFacts(root, { moduleGraph: false });
      expect(facts.workspace.sourceFiles).toHaveLength(2);
      expect(facts.files.map((f) => f.rel)).toEqual(['src/ok.js']);
      // The reason is the error CODE, never Node's message: that would carry
      // the absolute path, and reasons must compare across machines.
      expect(facts.unanalyzable).toEqual([{ file: 'src/locked.js', kind: 'file', reason: 'unreadable: EACCES' }]);
      expect(JSON.stringify(facts.unanalyzable)).not.toContain(root);
    } finally {
      chmodSync(join(root, 'src/locked.js'), 0o644);
    }
  });

  test('a node_modules file skipped for size is `node-modules-file`, and a budget stop is a `walk` entry', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'src/index.js', "import 'big';\nimport 'chain-1';\n");
    pkg(root, 'big', '1.0.0', { 'index.js': `// ${'x'.repeat(200)}\n` });
    for (let i = 1; i <= 4; i++) pkg(root, `chain-${i}`, '1.0.0', { 'index.js': i < 4 ? `import 'chain-${i + 1}';\n` : '' });
    const facts = collectImportFacts(root, { maxFileBytes: 100, maxFiles: 2 });
    expect(facts.graph.truncated).toBe(true);
    expect(facts.unanalyzable).toEqual([
      { file: 'node_modules/big/index.js', kind: 'node-modules-file', reason: expect.stringMatching(/^too large to parse/) },
      { file: 'node_modules', kind: 'walk', reason: expect.stringMatching(/^file budget 2 reached; \d+ resolved file\(s\) past that frontier/) }
    ]);
  });
});

describe('collectImportFacts with an installed tree', () => {
  test('resolves each first-party site to the installed copy it loads and walks the graph with the same resolver', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app', dependencies: { 'lib-a': '1.0.0' } }));
    put(root, 'src/index.js', "import { a } from 'lib-a';\nimport 'string-width-cjs';\nimport 'missing';\na();\n");
    pkg(root, 'lib-a', '1.0.0', { 'index.js': "import 'leaf';\nexport const a = 1;\n" });
    pkg(root, 'leaf', '2.0.0', { 'index.js': '' });
    put(root, 'node_modules/string-width-cjs/package.json', JSON.stringify({ name: 'string-width', version: '4.2.3' }));
    put(root, 'node_modules/string-width-cjs/index.js', '');
    const facts = collectImportFacts(root);
    const [site, aliased, missing] = facts.files[0].sites;
    expect(site.installed).toEqual({ name: 'lib-a', dirName: 'lib-a', version: '1.0.0', root: join(facts.realSrcDir, 'node_modules/lib-a') });
    // The fact, not the match: the copy it landed in is `string-width` in a
    // `string-width-cjs` directory; `package` still says what the specifier NAMED.
    expect(aliased.package).toBe('string-width-cjs');
    expect(aliased.installed).toMatchObject({ name: 'string-width', dirName: 'string-width-cjs', version: '4.2.3' });
    expect(missing.installed).toBeUndefined();
    expect(facts.nodeModulesMissing).toBe(false);
    expect(facts.graph.filesParsed).toBe(3);
    expect(facts.graph.byName.get('leaf')[0].chain.map((k) => facts.graph.reached.get(k).name)).toEqual(['lib-a', 'leaf']);
    expect(facts.graph.unresolvedByName.get('missing')).toHaveLength(1);
    expect(facts.lockfile.diagnostics).toEqual([expect.stringMatching(/^NO_LOCKFILE:/)]);
    expect(facts.unanalyzable).toEqual([]);
  });

  test('nodeModulesMissing is true only when nothing resolved, something was unresolved, and there is no node_modules', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'src/index.js', "import 'lodash';\n");
    expect(collectImportFacts(root).nodeModulesMissing).toBe(true);
    // Nothing imported at all: nothing was unresolved, so nothing is "missing".
    const quiet = tempDir();
    put(quiet, 'package.json', JSON.stringify({ name: 'app' }));
    put(quiet, 'src/index.js', 'export const x = 1;\n');
    expect(collectImportFacts(quiet).nodeModulesMissing).toBe(false);
  });

  test('an injected scanner is used for first-party AND node_modules files', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'src/index.js', "import 'lib-a';\n");
    pkg(root, 'lib-a', '1.0.0', { 'index.js': "import 'leaf';\n" });
    pkg(root, 'leaf', '1.0.0', { 'index.js': '' });
    const seen = [];
    const scan = (rel, content) => {
      seen.push(rel);
      return scanSource(rel, content);
    };
    collectImportFacts(root, { scan });
    expect(seen).toEqual(['src/index.js', 'node_modules/lib-a/index.js', 'node_modules/leaf/index.js']);
  });
});

describe('makeRelOf', () => {
  test('relativizes against whichever spelling of srcDir the file sits under, POSIX separators', () => {
    const rel = makeRelOf('/given/src', '/real/src');
    expect(rel('/given/src/a/b.js')).toBe('a/b.js');
    expect(rel('/real/src/a/b.js')).toBe('a/b.js');
    expect(rel('/elsewhere/x.js').startsWith('..')).toBe(true);
  });

  test('srcDir itself relativizes to "" — byte-identical to sbom-reach\'s relOf, which a consumer emits verbatim', () => {
    expect(makeRelOf('/given/src', '/real/src')('/given/src')).toBe('');
    expect(makeRelOf('/given/src', '/real/src')('/real/src')).toBe('');
    expect(makeRelOf('/same/src', '/same/src')('/same/src')).toBe('');
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    const facts = collectImportFacts(root, { moduleGraph: false });
    expect(makeRelOf(facts.srcDir, facts.realSrcDir)(facts.srcDir)).toBe('');
  });

  test('prefers the spelling with FEWER `..` segments, so a file ABOVE a symlinked srcDir never becomes a to-the-root chain', () => {
    // srcDir as given: /var/tmp/ws/app; its realpath: /private/var/tmp/ws/app.
    // A file hoisted one level above, spelled by realpath (as every resolved
    // file is): /private/var/tmp/ws/node_modules/x/index.js.
    const rel = makeRelOf('/var/tmp/ws/app', '/private/var/tmp/ws/app');
    expect(rel('/private/var/tmp/ws/node_modules/x/index.js')).toBe('../node_modules/x/index.js');
    // Inside the tree, either spelling is fine and neither climbs.
    expect(rel('/private/var/tmp/ws/app/src/a.js')).toBe('src/a.js');
    expect(rel('/var/tmp/ws/app/src/a.js')).toBe('src/a.js');
    // A tie (both climb the same amount) keeps the as-given spelling.
    expect(rel('/var/tmp/ws/other.js')).toBe('../other.js');
  });
});

describe('FactsError', () => {
  test('carries a code and a name', () => {
    const err = new FactsError('TYPESCRIPT_MISSING', 'msg');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FactsError');
    expect(err.code).toBe('TYPESCRIPT_MISSING');
    expect(err.message).toBe('msg');
  });
});
