// tests/unit/facts-document.test.js
// `factsDocument` (src/facts/document.js): Maps/Sets → sorted arrays,
// absolute → target-relative POSIX paths (keys keep their `\0` separator with
// the path half relativized), deterministic ordering, the summary arithmetic,
// and — by construction — no verdict vocabulary anywhere in the output.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectImportFacts, factsDocument } from '../../src/facts/index.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-doc-')));
  dirs.push(d);
  return d;
}
function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function pkg(root, name, version, files) {
  put(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version }));
  for (const [rel, content] of Object.entries(files)) put(root, `node_modules/${name}/${rel}`, content);
}

function buildTree() {
  const root = tempDir();
  put(root, 'package.json', JSON.stringify({ name: 'app', dependencies: { 'lib-a': '1.0.0' }, devDependencies: { tool: '1.0.0' } }));
  put(root, 'tsconfig.json', JSON.stringify({ compilerOptions: { paths: { '@app/*': ['src/*'] } } }));
  put(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages: { '': { dependencies: { 'lib-a': '1.0.0' } }, 'node_modules/lib-a': { version: '1.0.0', dependencies: { leaf: '2.0.0' } }, 'node_modules/leaf': { version: '2.0.0' } } }));
  put(root, 'src/index.js', "import { a } from 'lib-a';\nimport '@app/util';\nimport 'missing';\na();\n");
  put(root, 'src/util.js', 'export const u = 1;\n');
  pkg(root, 'lib-a', '1.0.0', { 'index.js': "import * as leaf from 'leaf';\nleaf.go();\nexport const a = 1;\n" });
  pkg(root, 'leaf', '2.0.0', { 'index.js': `// ${'x'.repeat(200)}\n` });
  return root;
}

describe('factsDocument', () => {
  test('renders every section with target-relative POSIX paths and relativized `\\0` keys', () => {
    const root = buildTree();
    const doc = factsDocument(collectImportFacts(root, { maxFileBytes: 100 }));
    expect(doc.summary).toEqual({
      scanned: 2,
      analyzed: 2,
      unanalyzable: 1,
      imports: 3,
      moduleGraph: { filesParsed: 1, reached: 2, unresolved: 1, truncated: false },
      exitCode: 0
    });
    expect(doc.workspace).toEqual({
      firstPartyNames: ['app'],
      depScopes: [
        { name: 'lib-a', scope: 'runtime' },
        { name: 'tool', scope: 'dev' }
      ],
      aliasPrefixes: ['@app'],
      aliasScope: [{ dir: '', prefixes: ['@app'] }],
      devDeclaredBy: [{ name: 'tool', manifests: ['package.json'] }],
      sourceFiles: 2,
      diagnostics: []
    });
    expect(doc.imports.map((f) => f.file)).toEqual(['src/index.js', 'src/util.js']);
    const [libA, alias, missing] = doc.imports[0].sites;
    expect(libA).toEqual({
      specifier: 'lib-a',
      package: 'lib-a',
      line: 1,
      snippet: "import { a } from 'lib-a';",
      kind: 'import',
      bindings: ['a'],
      referenced: ['a'],
      opaque: false,
      installed: { name: 'lib-a', dirName: 'lib-a', version: '1.0.0', root: 'node_modules/lib-a' }
    });
    expect(alias.package).toBeNull();
    expect(alias.installed).toBeUndefined();
    expect(missing).toMatchObject({ package: 'missing', bindings: [], referenced: [], opaque: false });
    expect(doc.imports[1]).toEqual({ file: 'src/util.js', dynamicUnknown: 0, parseErrors: [], sites: [] });

    const mg = doc.moduleGraph;
    expect(mg).toMatchObject({ enabled: true, filesParsed: 1, filesSkippedForSize: 1, unresolved: 1, truncated: false, nodeModulesMissing: false, weakPackages: ['leaf@2.0.0'] });
    expect(mg.reached.map((r) => r.key)).toEqual(['leaf@2.0.0\0node_modules/leaf', 'lib-a@1.0.0\0node_modules/lib-a']);
    const leaf = mg.reached[0];
    expect(leaf).toMatchObject({ name: 'leaf', dirName: 'leaf', version: '2.0.0', root: 'node_modules/leaf', dynamic: false, incomplete: true });
    expect(leaf.chain).toEqual(['lib-a@1.0.0\0node_modules/lib-a', 'leaf@2.0.0\0node_modules/leaf']);
    expect(leaf.importers).toEqual([
      { file: 'node_modules/lib-a/index.js', line: 1, snippet: "import * as leaf from 'leaf';", kind: 'import', bindings: ['go'], referenced: ['go'], opaque: false, fromPackage: 'lib-a@1.0.0\0node_modules/lib-a' }
    ]);
    expect(mg.reached[1].importers[0]).toMatchObject({ file: 'src/index.js', fromPackage: null });
    expect(mg.unresolvedByName).toEqual([{ package: 'missing', sites: [{ file: 'src/index.js', reason: 'package not installed: missing' }] }]);
    // Every chain/fromPackage key resolves to a reached entry.
    const keys = new Set(mg.reached.map((r) => r.key));
    for (const r of mg.reached) {
      for (const k of r.chain) expect(keys.has(k)).toBe(true);
      for (const imp of r.importers) if (imp.fromPackage !== null) expect(keys.has(imp.fromPackage)).toBe(true);
    }

    expect(doc.lockfile.files).toEqual(['package-lock.json']);
    expect(doc.lockfile.rootDependencies).toEqual(['lib-a@1.0.0']);
    expect(doc.lockfile.edges).toEqual([{ from: 'lib-a@1.0.0', to: 'leaf@2.0.0' }]);
    expect(doc.lockfile.packages.map((p) => `${p.name}@${p.version}`)).toEqual(['leaf@2.0.0', 'lib-a@1.0.0']);
    expect(doc.unanalyzable).toEqual([{ file: 'node_modules/leaf/index.js', kind: 'node-modules-file', reason: expect.stringMatching(/^too large to parse/) }]);
  });

  test('is deterministic and machine-independent: no absolute path survives, and the same tree gives the same bytes', () => {
    const root = buildTree();
    const a = JSON.stringify(factsDocument(collectImportFacts(root)));
    const b = JSON.stringify(factsDocument(collectImportFacts(root)));
    expect(a).toBe(b);
    expect(a.includes(root)).toBe(false);
    expect(a.includes(tmpdir())).toBe(false);
  });

  test('a NON-realpath\'d srcDir with node_modules hoisted ABOVE it still yields short ../ paths everywhere (adversarial-review repro)', () => {
    // Deliberately NOT realpath'd: on macOS os.tmpdir() is /var/folders/…,
    // a symlink to /private/var/folders/…, so srcDir-as-given and every
    // resolved (realpath'd) file disagree on their prefix. The old rule
    // preferred the realpath spelling only when it landed INSIDE the tree —
    // with the package one level up, both spellings climbed and the as-given
    // one produced `../../../../../../private/var/…` for every path.
    const ws = mkdtempSync(join(tmpdir(), 'npm-check-facts-hoist-'));
    dirs.push(ws);
    const app = join(ws, 'app');
    put(app, 'package.json', JSON.stringify({ name: 'app', dependencies: { hoisted: '1.0.0' } }));
    put(app, 'src/index.js', "import { h } from 'hoisted';\nh();\nimport 'missing';\n");
    put(ws, 'node_modules/hoisted/package.json', JSON.stringify({ name: 'hoisted', version: '1.0.0' }));
    put(ws, 'node_modules/hoisted/index.js', "import 'leaf';\nexport const h = 1;\n");
    put(ws, 'node_modules/leaf/package.json', JSON.stringify({ name: 'leaf', version: '1.0.0' }));
    put(ws, 'node_modules/leaf/index.js', `// ${'x'.repeat(200)}\n`);
    const facts = collectImportFacts(app, { maxFileBytes: 100 });
    const doc = factsDocument(facts);
    const site = doc.imports[0].sites[0];
    expect(site.installed.root).toBe('../node_modules/hoisted');
    expect(doc.moduleGraph.reached.map((r) => r.key)).toEqual(['hoisted@1.0.0\0../node_modules/hoisted', 'leaf@1.0.0\0../node_modules/leaf']);
    expect(doc.moduleGraph.reached[0].root).toBe('../node_modules/hoisted');
    expect(doc.moduleGraph.reached[1].chain).toEqual(['hoisted@1.0.0\0../node_modules/hoisted', 'leaf@1.0.0\0../node_modules/leaf']);
    expect(doc.moduleGraph.reached[1].importers[0]).toMatchObject({ file: '../node_modules/hoisted/index.js', fromPackage: 'hoisted@1.0.0\0../node_modules/hoisted' });
    expect(doc.moduleGraph.unresolvedByName).toEqual([{ package: 'missing', sites: [{ file: 'src/index.js', reason: 'package not installed: missing' }] }]);
    expect(doc.unanalyzable).toEqual([{ file: '../node_modules/leaf/index.js', kind: 'node-modules-file', reason: expect.stringMatching(/^too large to parse/) }]);
    const json = JSON.stringify(doc);
    expect(json).not.toContain('/private/');
    expect(json).not.toContain(ws);
    expect(json).not.toMatch(/\.\.\/\.\.\//);
  });

  test('carries no verdict vocabulary — facts, not findings', () => {
    const json = JSON.stringify(factsDocument(collectImportFacts(buildTree())));
    expect(json).not.toMatch(/"severity"|"purl"|"findings"|reachable|not-observed|"confidence"/);
  });

  test('with the module graph off, the section says so and the summary counts zero', () => {
    const doc = factsDocument(collectImportFacts(buildTree(), { moduleGraph: false }), { exitCode: 0 });
    expect(doc.moduleGraph).toEqual({ enabled: false, filesParsed: 0, filesSkippedForSize: 0, unresolved: 0, truncated: false, nodeModulesMissing: false, weakPackages: [], reached: [], unresolvedByName: [] });
    expect(doc.summary.moduleGraph).toEqual({ filesParsed: 0, reached: 0, unresolved: 0, truncated: false });
    expect(doc.summary.exitCode).toBe(0);
  });

  test('lists a file that parsed and imports nothing, with empty sites — "searched and found none" is a fact', () => {
    const root = tempDir();
    put(root, 'package.json', JSON.stringify({ name: 'app' }));
    put(root, 'src/quiet.js', 'export const q = 1;\n');
    const doc = factsDocument(collectImportFacts(root));
    expect(doc.imports).toEqual([{ file: 'src/quiet.js', dynamicUnknown: 0, parseErrors: [], sites: [] }]);
    expect(doc.summary).toMatchObject({ scanned: 1, analyzed: 1, imports: 0 });
    expect(doc.lockfile.diagnostics).toEqual([expect.stringMatching(/^NO_LOCKFILE:/)]);
  });
});
