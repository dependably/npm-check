// tests/unit/facts-document-sections.test.js
// `factsDocument` section by section: the module graph section when the walk
// was turned off, and code-unit ordering of every sorted list.
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectImportFacts, factsDocument } from '../../src/facts/index.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function put(root, rel, content) {
  const p = join(root, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function buildTree() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-sections-')));
  dirs.push(root);
  put(root, 'package.json', JSON.stringify({ name: 'app', dependencies: { zeta: '1.0.0', beta: '1.0.0' } }));
  put(root, 'src/index.js', "import 'zeta';\nimport 'beta';\nimport 'missing-b';\nimport 'missing-a';\n");
  for (const name of ['zeta', 'beta']) {
    put(root, `node_modules/${name}/package.json`, JSON.stringify({ name, version: '1.0.0' }));
    put(root, `node_modules/${name}/index.js`, 'export const x = 1;\n');
  }
  return root;
}

describe('factsDocument sections', () => {
  test('with the module graph off the section is disabled, zeroed and empty', () => {
    const root = buildTree();
    const doc = factsDocument(collectImportFacts(root, { moduleGraph: false }), { exitCode: 0 });
    expect(doc.moduleGraph).toEqual({
      enabled: false,
      filesParsed: 0,
      filesSkippedForSize: 0,
      unresolved: 0,
      truncated: false,
      nodeModulesMissing: false,
      weakPackages: [],
      reached: [],
      unresolvedByName: []
    });
    expect(doc.summary.moduleGraph).toEqual({ filesParsed: 0, reached: 0, unresolved: 0, truncated: false });
    expect(doc.summary.imports).toBe(4);
  });

  test('reached packages and unresolved names are sorted, and the summary counts them', () => {
    const root = buildTree();
    const doc = factsDocument(collectImportFacts(root));
    expect(doc.moduleGraph.enabled).toBe(true);
    expect(doc.moduleGraph.reached.map((p) => p.key)).toEqual(['beta@1.0.0\0node_modules/beta', 'zeta@1.0.0\0node_modules/zeta']);
    expect(doc.moduleGraph.unresolvedByName).toEqual([
      { package: 'missing-a', sites: [{ file: 'src/index.js', reason: 'package not installed: missing-a' }] },
      { package: 'missing-b', sites: [{ file: 'src/index.js', reason: 'package not installed: missing-b' }] }
    ]);
    expect(doc.summary.moduleGraph).toEqual({ filesParsed: 2, reached: 2, unresolved: 2, truncated: false });
  });

  test('workspace lists are sorted by name or directory, with paths made relative', () => {
    const root = buildTree();
    const facts = collectImportFacts(root, { moduleGraph: false });
    const doc = factsDocument({
      ...facts,
      workspace: {
        ...facts.workspace,
        depScopes: new Map([['zeta', 'runtime'], ['Alpha', 'dev'], ['beta', 'runtime']]),
        aliasLayers: [
          { dir: join(root, 'packages/ui'), prefixes: new Set(['~', '@ui']) },
          { dir: root, prefixes: new Set(['@app']) },
          { dir: join(root, 'packages/api'), prefixes: new Set(['@api']) }
        ],
        devDeclaredBy: new Map([
          ['tool-b', new Set(['packages/ui/package.json', 'package.json'])],
          ['tool-a', new Set(['package.json'])]
        ])
      }
    });
    expect(doc.workspace.depScopes).toEqual([
      { name: 'Alpha', scope: 'dev' },
      { name: 'beta', scope: 'runtime' },
      { name: 'zeta', scope: 'runtime' }
    ]);
    expect(doc.workspace.aliasScope).toEqual([
      { dir: '', prefixes: ['@app'] },
      { dir: 'packages/api', prefixes: ['@api'] },
      { dir: 'packages/ui', prefixes: ['@ui', '~'] }
    ]);
    expect(doc.workspace.devDeclaredBy).toEqual([
      { name: 'tool-a', manifests: ['package.json'] },
      { name: 'tool-b', manifests: ['package.json', 'packages/ui/package.json'] }
    ]);
  });
});
