// tests/unit/facts-typescript-missing.test.js
// The optional `typescript` peer: importing the facts barrel must never
// touch it (nothing runs at module load — a CJS bundle where esbuild has
// rewritten `import.meta.url` to `undefined` would otherwise throw
// ERR_INVALID_ARG_VALUE at import time, as a plain Error no TYPESCRIPT_MISSING
// handler sees), and only a parse throws FactsError('TYPESCRIPT_MISSING').
//
// Jest workers run in parallel and every other facts test needs typescript,
// so this never touches this repo's node_modules. It stages a copy of
// src/facts + src/schema.js in a temp package whose node_modules holds
// symlinks to the real fast-glob / ignore / yaml and NO typescript, then
// drives it in a child node process.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..');

let stage;
beforeAll(() => {
  stage = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-no-ts-')));
  mkdirSync(join(stage, 'src'), { recursive: true });
  cpSync(join(REPO, 'src', 'facts'), join(stage, 'src', 'facts'), { recursive: true });
  cpSync(join(REPO, 'src', 'schema.js'), join(stage, 'src', 'schema.js'));
  mkdirSync(join(stage, 'node_modules'), { recursive: true });
  for (const dep of ['fast-glob', 'ignore', 'yaml']) {
    // Node realpaths a symlinked package, so each one's own dependencies
    // still resolve from this repo's node_modules.
    symlinkSync(join(REPO, 'node_modules', dep), join(stage, 'node_modules', dep), 'dir');
  }
});
afterAll(() => {
  if (stage) rmSync(stage, { recursive: true, force: true });
});

function runInStage(script) {
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: stage, encoding: 'utf8', timeout: 30000 });
}

describe('the facts barrel without typescript installed', () => {
  test('imports cleanly and exposes every export — typescript is not touched at module load', () => {
    const r = runInStage(`
      const m = await import('./src/facts/index.js');
      console.log(JSON.stringify(Object.keys(m).sort()));
    `);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    const keys = JSON.parse(r.stdout);
    expect(keys).toEqual(expect.arrayContaining(['collectImportFacts', 'factsDocument', 'scanSource', 'ModuleResolver', 'walkModuleGraph', 'discoverWorkspace', 'discoverLockfileGraphs', 'loadTypeScript', 'FactsError', 'FACTS_SCHEMA_VERSION']));
  });

  test('loadTypeScript, scanSource, discoverWorkspace and collectImportFacts throw FactsError TYPESCRIPT_MISSING — nothing else', () => {
    const r = runInStage(`
      const m = await import('./src/facts/index.js');
      const out = [];
      for (const [name, fn] of [
        ['loadTypeScript', () => m.loadTypeScript()],
        ['scanSource', () => m.scanSource('x.ts', "import 'a';")],
        ['discoverWorkspace', () => m.discoverWorkspace(process.cwd())],
        ['collectImportFacts', () => m.collectImportFacts(process.cwd())],
      ]) {
        try { fn(); out.push([name, 'no throw']); }
        catch (e) { out.push([name, e instanceof m.FactsError, e.name, e.code, /optional peer dependency/.test(e.message)]); }
      }
      console.log(JSON.stringify(out));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual([
      ['loadTypeScript', true, 'FactsError', 'TYPESCRIPT_MISSING', true],
      ['scanSource', true, 'FactsError', 'TYPESCRIPT_MISSING', true],
      ['discoverWorkspace', true, 'FactsError', 'TYPESCRIPT_MISSING', true],
      ['collectImportFacts', true, 'FactsError', 'TYPESCRIPT_MISSING', true]
    ]);
  });

  test('the modules that do not parse still work: resolver, lockfile graph, specifier', () => {
    const r = runInStage(`
      const m = await import('./src/facts/index.js');
      const r = new m.ModuleResolver();
      console.log(JSON.stringify([
        r.resolve(process.cwd() + '/x.js', 'fs', 'import').kind,
        m.specifierToPackage('lodash/get', new Set()),
        m.discoverLockfileGraphs(process.cwd()).diagnostics[0].split(':')[0],
      ]));
    `);
    expect(r.status).toBe(0);
    expect(JSON.parse(r.stdout)).toEqual(['builtin', 'lodash', 'NO_LOCKFILE']);
  });
});
