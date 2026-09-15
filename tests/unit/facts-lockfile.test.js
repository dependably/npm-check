// tests/unit/facts-lockfile.test.js
// The lockfile graph reader (src/facts/lockfile-graph.js): resolved closure,
// root dependencies, hoisting-accurate edges, and dev/runtime/optional read
// from what the lockfile asserts — never inferred. Ported from sbom-reach's
// analyzer-npm `lockfile.test.ts` (`discoverInstalledPackages` there is
// `discoverLockfileGraphs` here, and now also reports which files it read).
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parsePackageLockJson,
  parsePackageLockJsonGraph,
  parsePnpmLockYaml,
  parsePnpmLockYamlGraph,
  discoverLockfileGraphs,
  createMergeFold,
  mergeDiscovered
} from '../../src/facts/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_APP = join(__dirname, '..', 'fixtures', 'facts', 'npm-app');

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-lockfile-')));
  dirs.push(d);
  return d;
}

function writeNpmLock(dir, packages, sub = '') {
  const target = sub ? join(dir, sub) : dir;
  mkdirSync(target, { recursive: true });
  const path = join(target, 'package-lock.json');
  writeFileSync(path, JSON.stringify({ lockfileVersion: 3, packages }));
  return path;
}

describe('parsePackageLockJson', () => {
  test('extracts name+version for direct and transitive dependencies', () => {
    const pkgs = parsePackageLockJson(join(FIXTURE_APP, 'package-lock.json'));
    const byName = new Map(pkgs.map((p) => [p.name, p.version]));
    expect(byName.get('lodash')).toBe('4.17.20');
    expect(byName.get('express')).toBe('4.18.2');
    expect(byName.get('follow-redirects')).toBe('1.13.0');
    expect(byName.get('@types/express-serve-static-core')).toBe('4.17.0');
  });

  test('never emits the root "" entry', () => {
    const pkgs = parsePackageLockJson(join(FIXTURE_APP, 'package-lock.json'));
    expect(pkgs.some((p) => p.name === '')).toBe(false);
  });

  test('keeps a nested override as a distinct name+version from the top-level one', () => {
    const pkgs = parsePackageLockJson(join(FIXTURE_APP, 'package-lock.json'));
    const versions = pkgs.filter((p) => p.name === 'ansi-styles').map((p) => p.version).sort();
    expect(versions).toEqual(['3.2.1', '4.3.0']);
  });

  test('resolves edges with npm hoisting rules (nested copy shadows the hoisted one)', () => {
    const { edges } = parsePackageLockJsonGraph(join(FIXTURE_APP, 'package-lock.json'));
    expect(edges).toContainEqual({ from: 'chalk@4.1.0', to: 'ansi-styles@4.3.0' });
    expect(edges).toContainEqual({ from: 'supertest@6.1.0', to: 'ansi-styles@3.2.1' });
    expect(edges).toContainEqual({ from: 'axios@0.21.0', to: 'follow-redirects@1.13.0' });
  });

  test('returns an empty list for a lockfile with no packages object', () => {
    const dir = tempDir();
    const path = join(dir, 'package-lock.json');
    writeFileSync(path, JSON.stringify({ name: 'x', lockfileVersion: 3 }));
    expect(parsePackageLockJson(path)).toEqual([]);
  });

  test('carries the license field straight through, including a compound SPDX expression', () => {
    const path = writeNpmLock(tempDir(), {
      '': {},
      'node_modules/lodash': { version: '4.17.21', license: 'MIT' },
      'node_modules/dual': { version: '1.0.0', license: '(MIT OR Apache-2.0)' },
      'node_modules/no-license-field': { version: '1.0.0' }
    });
    const pkgs = parsePackageLockJson(path);
    expect(pkgs.find((p) => p.name === 'lodash').license).toBe('MIT');
    expect(pkgs.find((p) => p.name === 'dual').license).toBe('(MIT OR Apache-2.0)');
    expect(pkgs.find((p) => p.name === 'no-license-field').license).toBeUndefined();
  });

  test('carries integrity and resolved straight through, verbatim, in npm\'s own SRI spelling; absent when the entry had neither', () => {
    const path = writeNpmLock(tempDir(), {
      '': {},
      'node_modules/lodash': {
        version: '4.17.21',
        integrity: 'sha512-v2kDEe57lecTulaDIuNTPy3Ry4//eKlhYWYFRD/pMcSHkFO4M6VW7T2VG6QaAgTOFYYAKAeuMYVUj27EiaZWiA==',
        resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
      },
      'node_modules/no-integrity': { version: '1.0.0' }
    });
    const pkgs = parsePackageLockJson(path);
    const lodash = pkgs.find((p) => p.name === 'lodash');
    expect(lodash.integrity).toBe('sha512-v2kDEe57lecTulaDIuNTPy3Ry4//eKlhYWYFRD/pMcSHkFO4M6VW7T2VG6QaAgTOFYYAKAeuMYVUj27EiaZWiA==');
    expect(lodash.resolved).toBe('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz');
    const noIntegrity = pkgs.find((p) => p.name === 'no-integrity');
    expect(noIntegrity.integrity).toBeUndefined();
    expect(noIntegrity.resolved).toBeUndefined();
  });

  test('two paths for the same name@version with the SAME integrity merge silently; a genuine conflict drops it and reports a coded diagnostic', () => {
    const agreeing = parsePackageLockJsonGraph(
      writeNpmLock(tempDir(), {
        '': { dependencies: { 'app-dep': '1.0.0', shared: '2.0.0' } },
        'node_modules/app-dep': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
        'node_modules/app-dep/node_modules/shared': { version: '2.0.0', integrity: 'sha512-same' },
        'node_modules/shared': { version: '2.0.0', integrity: 'sha512-same' }
      })
    );
    expect(agreeing.packages.find((p) => p.name === 'shared').integrity).toBe('sha512-same');
    expect(agreeing.diagnostics).toEqual([]);

    const conflicting = parsePackageLockJsonGraph(
      writeNpmLock(tempDir(), {
        '': { dependencies: { 'app-dep': '1.0.0', shared: '2.0.0' } },
        'node_modules/app-dep': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
        'node_modules/app-dep/node_modules/shared': { version: '2.0.0', integrity: 'sha512-nested' },
        'node_modules/shared': { version: '2.0.0', integrity: 'sha512-hoisted' }
      })
    );
    expect(conflicting.packages.find((p) => p.name === 'shared').integrity).toBeUndefined();
    expect(conflicting.diagnostics).toHaveLength(1);
    expect(conflicting.diagnostics[0]).toMatch(/^NPM_INTEGRITY_CONFLICT: shared@2\.0\.0 has conflicting integrity hashes/);
    expect(conflicting.diagnostics[0]).toContain('sha512-nested');
    expect(conflicting.diagnostics[0]).toContain('sha512-hoisted');
  });

  test("reads npm's own per-entry flags for the WHOLE tree: dev → true, no flag → false, extraneous → absent", () => {
    const path = writeNpmLock(tempDir(), {
      '': {},
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/vitest': { version: '1.0.0', dev: true },
      'node_modules/fsevents': { version: '2.3.3', devOptional: true },
      'node_modules/leftover': { version: '0.0.1', extraneous: true }
    });
    const pkgs = parsePackageLockJson(path);
    expect(pkgs.find((p) => p.name === 'vitest').devDeclared).toBe(true);
    expect(pkgs.find((p) => p.name === 'lodash').devDeclared).toBe(false);
    expect(pkgs.find((p) => p.name === 'fsevents').devDeclared).toBe(false);
    expect(pkgs.find((p) => p.name === 'leftover').devDeclared).toBeUndefined();
  });

  test('a transitive package with no dev flag is runtime even when its only parent in the lockfile is dev', () => {
    const path = writeNpmLock(tempDir(), {
      '': { devDependencies: { vitest: '1.0.0' } },
      'node_modules/vitest': { version: '1.0.0', dev: true, dependencies: { tinypool: '0.8.0' } },
      'node_modules/tinypool': { version: '0.8.0' }
    });
    expect(parsePackageLockJson(path).find((p) => p.name === 'tinypool').devDeclared).toBe(false);
  });

  test('marks a root-direct devDependency devDeclared true; a root-direct runtime dependency devDeclared false', () => {
    const path = writeNpmLock(tempDir(), {
      '': { dependencies: { lodash: '4.17.21' }, devDependencies: { vitest: '1.0.0' } },
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/vitest': { version: '1.0.0', dev: true }
    });
    const { packages, rootDependencies } = parsePackageLockJsonGraph(path);
    expect(rootDependencies.sort()).toEqual(['lodash@4.17.21', 'vitest@1.0.0']);
    expect(packages.find((p) => p.name === 'vitest').devDeclared).toBe(true);
    expect(packages.find((p) => p.name === 'lodash').devDeclared).toBe(false);
  });

  test("a root devDependency that npm's flags say also ships through a runtime path stays runtime", () => {
    const path = writeNpmLock(tempDir(), {
      '': { dependencies: { 'app-dep': '1.0.0' }, devDependencies: { shared: '2.0.0' } },
      'node_modules/app-dep': { version: '1.0.0', dependencies: { shared: '2.0.0' } },
      'node_modules/shared': { version: '2.0.0' }
    });
    expect(parsePackageLockJsonGraph(path).packages.find((p) => p.name === 'shared').devDeclared).toBe(false);
  });

  test('a root-direct name in BOTH dependencies and devDependencies resolves to explicit runtime (false)', () => {
    const path = writeNpmLock(tempDir(), {
      '': { dependencies: { shared: '1.0.0' }, devDependencies: { shared: '1.0.0' } },
      'node_modules/shared': { version: '1.0.0' }
    });
    expect(parsePackageLockJsonGraph(path).packages.find((p) => p.name === 'shared').devDeclared).toBe(false);
  });

  test('the same name@version at two paths is folded "runtime anywhere wins", and the root-direct assertion lands on the surviving record', () => {
    const path = writeNpmLock(tempDir(), {
      '': { dependencies: { 'app-dep': '1.0.0', shared: '2.0.0' }, devDependencies: { 'a-tool': '1.0.0' } },
      'node_modules/a-tool': { version: '1.0.0', dev: true, dependencies: { shared: '2.0.0' } },
      'node_modules/a-tool/node_modules/shared': { version: '2.0.0', dev: true },
      'node_modules/app-dep': { version: '1.0.0' },
      'node_modules/shared': { version: '2.0.0' }
    });
    const { packages, rootDependencies } = parsePackageLockJsonGraph(path);
    expect(packages.filter((p) => p.name === 'shared')).toEqual([{ name: 'shared', version: '2.0.0', devDeclared: false }]);
    expect(rootDependencies.sort()).toEqual(['a-tool@1.0.0', 'app-dep@1.0.0', 'shared@2.0.0']);
  });

  test('marks optional: true entries scope "optional"; everything else stays absent', () => {
    const path = writeNpmLock(tempDir(), {
      '': {},
      'node_modules/lodash': { version: '4.17.21' },
      'node_modules/ajv-formats': { version: '3.0.1', optional: true }
    });
    const pkgs = parsePackageLockJson(path);
    expect(pkgs.find((p) => p.name === 'ajv-formats').scope).toBe('optional');
    expect(pkgs.find((p) => p.name === 'lodash').scope).toBeUndefined();
  });

  test('skips link: entries and entries without a version', () => {
    const path = writeNpmLock(tempDir(), {
      '': { dependencies: { ws: '1.0.0' } },
      'node_modules/ws': { resolved: 'packages/ws', link: true },
      'packages/ws': { name: 'ws', version: '1.0.0' },
      'node_modules/nover': {}
    });
    const { packages, rootDependencies } = parsePackageLockJsonGraph(path);
    expect(packages).toEqual([]);
    expect(rootDependencies).toEqual([]);
  });
});

describe('parsePnpmLockYaml', () => {
  test('extracts name+version from bare packages: keys, scoped and unscoped', () => {
    const dir = tempDir();
    const path = join(dir, 'pnpm-lock.yaml');
    writeFileSync(
      path,
      [
        "lockfileVersion: '9.0'",
        '',
        'packages:',
        '',
        '  lodash@4.17.21:',
        '    resolution: {integrity: sha512-x}',
        '',
        "  '@babel/core@7.24.0':",
        '    resolution: {integrity: sha512-y}',
        '',
        'snapshots:',
        '',
        '  lodash@4.17.21: {}',
        '',
        "  '@babel/core@7.24.0(supports-color@8.1.1)':",
        '    dependencies:',
        '      supports-color: 8.1.1'
      ].join('\n')
    );
    const pkgs = parsePnpmLockYaml(path);
    const byName = new Map(pkgs.map((p) => [p.name, p.version]));
    expect(byName.get('lodash')).toBe('4.17.21');
    expect(byName.get('@babel/core')).toBe('7.24.0');
    expect(pkgs).toHaveLength(2);
  });

  test('returns an empty list for a lockfile with no packages section', () => {
    const dir = tempDir();
    const path = join(dir, 'pnpm-lock.yaml');
    writeFileSync(path, "lockfileVersion: '9.0'\n");
    expect(parsePnpmLockYaml(path)).toEqual([]);
  });

  test('reads resolution.integrity verbatim; resolution.tarball becomes `resolved`; absent when the value carries neither', () => {
    const dir = tempDir();
    const path = join(dir, 'pnpm-lock.yaml');
    writeFileSync(
      path,
      [
        "lockfileVersion: '9.0'",
        '',
        'packages:',
        '',
        '  lodash@4.17.21:',
        '    resolution: {integrity: sha512-x, tarball: https://example.com/lodash-4.17.21.tgz}',
        '',
        '  no-tarball@1.0.0:',
        '    resolution: {integrity: sha512-y}',
        '',
        '  no-resolution@1.0.0: {}'
      ].join('\n')
    );
    const pkgs = parsePnpmLockYaml(path);
    const lodash = pkgs.find((p) => p.name === 'lodash');
    expect(lodash.integrity).toBe('sha512-x');
    expect(lodash.resolved).toBe('https://example.com/lodash-4.17.21.tgz');
    const noTarball = pkgs.find((p) => p.name === 'no-tarball');
    expect(noTarball.integrity).toBe('sha512-y');
    expect(noTarball.resolved).toBeUndefined();
    const noResolution = pkgs.find((p) => p.name === 'no-resolution');
    expect(noResolution.integrity).toBeUndefined();
    expect(noResolution.resolved).toBeUndefined();
  });

  test('marks a root-direct devDependency devDeclared true; a root-direct runtime dependency devDeclared false', () => {
    const dir = tempDir();
    const path = join(dir, 'pnpm-lock.yaml');
    writeFileSync(
      path,
      [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '  .:',
        '    dependencies:',
        '      lodash:',
        '        specifier: ^4.17.21',
        '        version: 4.17.21',
        '    devDependencies:',
        '      vitest:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        '',
        'packages:',
        '',
        '  lodash@4.17.21:',
        '    resolution: {integrity: sha512-x}',
        '',
        '  vitest@1.0.0:',
        '    resolution: {integrity: sha512-y}'
      ].join('\n')
    );
    const { packages, rootDependencies } = parsePnpmLockYamlGraph(path);
    expect(rootDependencies.sort()).toEqual(['lodash@4.17.21', 'vitest@1.0.0']);
    expect(packages.find((p) => p.name === 'vitest').devDeclared).toBe(true);
    expect(packages.find((p) => p.name === 'lodash').devDeclared).toBe(false);
  });

  test('a name in BOTH dependencies and devDependencies at the root resolves to explicit runtime (false)', () => {
    const dir = tempDir();
    const path = join(dir, 'pnpm-lock.yaml');
    writeFileSync(
      path,
      [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '  .:',
        '    dependencies:',
        '      shared:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        '    devDependencies:',
        '      shared:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        '',
        'packages:',
        '',
        '  shared@1.0.0:',
        '    resolution: {integrity: sha512-x}'
      ].join('\n')
    );
    expect(parsePnpmLockYamlGraph(path).packages.find((p) => p.name === 'shared').devDeclared).toBe(false);
  });

  test('reads EVERY importer: an empty root importer with packages/* importers still yields a graph', () => {
    const dir = tempDir();
    const path = join(dir, 'pnpm-lock.yaml');
    writeFileSync(
      path,
      [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .: {}',
        '',
        '  packages/core:',
        '    dependencies:',
        '      yaml:',
        '        specifier: ^2.0.0',
        '        version: 2.9.0',
        '      sibling:',
        '        specifier: workspace:*',
        '        version: link:../sibling',
        '    devDependencies:',
        '      vitest:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        '',
        '  packages/sibling:',
        '    dependencies:',
        '      vitest:',
        '        specifier: ^1.0.0',
        '        version: 1.0.0',
        '',
        'packages:',
        '',
        '  yaml@2.9.0:',
        '    resolution: {integrity: sha512-x}',
        '',
        '  vitest@1.0.0:',
        '    resolution: {integrity: sha512-y}',
        '',
        '  tinypool@0.8.0:',
        '    resolution: {integrity: sha512-z}',
        '',
        'snapshots:',
        '',
        '  yaml@2.9.0: {}',
        '',
        '  vitest@1.0.0:',
        '    dependencies:',
        '      tinypool: 0.8.0',
        '',
        '  tinypool@0.8.0: {}'
      ].join('\n')
    );
    const { packages, rootDependencies, edges } = parsePnpmLockYamlGraph(path);
    expect(rootDependencies.sort()).toEqual(['vitest@1.0.0', 'yaml@2.9.0']);
    expect(edges).toEqual([{ from: 'vitest@1.0.0', to: 'tinypool@0.8.0' }]);
    expect(packages.find((p) => p.name === 'yaml').devDeclared).toBe(false);
    expect(packages.find((p) => p.name === 'vitest').devDeclared).toBe(false);
    expect(packages.find((p) => p.name === 'tinypool').devDeclared).toBeUndefined();
  });
});

describe('mergeDiscovered', () => {
  test('runtime anywhere wins; optional survives only when both say so; first license kept', () => {
    const into = { name: 'a', version: '1', devDeclared: true, scope: 'optional' };
    mergeDiscovered(into, { name: 'a', version: '1', devDeclared: false, license: 'MIT' });
    expect(into).toEqual({ name: 'a', version: '1', devDeclared: false, license: 'MIT' });
    const silent = { name: 'b', version: '1' };
    mergeDiscovered(silent, { name: 'b', version: '1', devDeclared: true });
    expect(silent.devDeclared).toBe(true);
  });

  test('a matching integrity across sightings merges silently; the first `resolved` seen is kept without conflict checking', () => {
    const into = { name: 'a', version: '1', resolved: 'https://mirror-one.example/a-1.tgz' };
    mergeDiscovered(into, { name: 'a', version: '1', integrity: 'sha512-same', resolved: 'https://mirror-two.example/a-1.tgz' });
    expect(into.integrity).toBe('sha512-same');
    expect(into.resolved).toBe('https://mirror-one.example/a-1.tgz');
    mergeDiscovered(into, { name: 'a', version: '1', integrity: 'sha512-same' });
    expect(into.integrity).toBe('sha512-same');
  });

  test('a conflicting integrity drops to absent and reports a coded diagnostic naming both hashes; the fold param is optional', () => {
    const into = { name: 'a', version: '1', integrity: 'sha512-one' };
    const fold = createMergeFold();
    mergeDiscovered(into, { name: 'a', version: '1', integrity: 'sha512-two' }, fold);
    expect(into.integrity).toBeUndefined();
    expect(fold.diagnostics).toEqual([
      'NPM_INTEGRITY_CONFLICT: a@1 has conflicting integrity hashes (sha512-one vs sha512-two); dropped'
    ]);
    expect([...fold.integrityConflicts]).toEqual(['a@1']);

    // No fold supplied: the conflict still resolves to absent, it just has
    // nowhere to report to and nothing to remember past this one call.
    const silent = { name: 'b', version: '1', integrity: 'sha512-one' };
    mergeDiscovered(silent, { name: 'b', version: '1', integrity: 'sha512-two' });
    expect(silent.integrity).toBeUndefined();
  });

  test('once conflicted, a THIRD sighting cannot silently reinstate integrity, even one that agrees with the original value', () => {
    const into = { name: 'a', version: '1', integrity: 'sha512-one' };
    const fold = createMergeFold();
    mergeDiscovered(into, { name: 'a', version: '1', integrity: 'sha512-two' }, fold);
    expect(into.integrity).toBeUndefined();
    // A third sighting that matches the ORIGINAL value must not undo the
    // conflict -- the disagreement already means this name@version's hash
    // cannot be trusted, whatever a later sighting happens to say.
    mergeDiscovered(into, { name: 'a', version: '1', integrity: 'sha512-one' }, fold);
    expect(into.integrity).toBeUndefined();
    expect(fold.diagnostics).toHaveLength(1);
  });

  test('the conflict is keyed by name@version, not by record identity: a FRESH record for the same key cannot carry a hash back in, in either merge direction', () => {
    // The identity-keyed tracker this replaced marked the record OBJECT, so
    // every point a DiscoveredPackage is copied (`{ ...pkg }` at a
    // per-lockfile boundary) silently lost the mark, and a record that
    // arrived as the merge SOURCE was never consulted at all.
    const fold = createMergeFold();
    const first = { name: 'a', version: '1', integrity: 'sha512-one' };
    mergeDiscovered(first, { name: 'a', version: '1', integrity: 'sha512-two' }, fold);
    expect(first.integrity).toBeUndefined();

    // A different record object for the same name@version, folded as the
    // TARGET of a later, agreeing sighting.
    const copy = { name: 'a', version: '1' };
    mergeDiscovered(copy, { name: 'a', version: '1', integrity: 'sha512-one' }, fold);
    expect(copy.integrity).toBeUndefined();

    // ... and as the SOURCE: an untouched record that still carries a hash
    // must not keep it once this name@version is known to be conflicted.
    const untouched = { name: 'a', version: '1', integrity: 'sha512-one' };
    mergeDiscovered(untouched, { name: 'a', version: '1' }, fold);
    expect(untouched.integrity).toBeUndefined();

    // A different name@version is untouched by any of it.
    const other = { name: 'b', version: '1' };
    mergeDiscovered(other, { name: 'b', version: '1', integrity: 'sha512-b' }, fold);
    expect(other.integrity).toBe('sha512-b');
    expect(fold.diagnostics).toHaveLength(1);
  });
});

describe('discoverLockfileGraphs', () => {
  test('reads package-lock.json under srcDir and reports the file it read', () => {
    const { packages, diagnostics, files } = discoverLockfileGraphs(FIXTURE_APP);
    expect(packages.some((p) => p.name === 'lodash' && p.version === '4.17.20')).toBe(true);
    expect(diagnostics).toEqual([]);
    expect(files).toEqual([join(FIXTURE_APP, 'package-lock.json')]);
  });

  test('reads pnpm-lock.yaml when that is what is present', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'pnpm-lock.yaml'), ["lockfileVersion: '9.0'", '', 'packages:', '', '  chalk@4.1.0:', '    resolution: {integrity: sha512-z}'].join('\n'));
    const { packages, diagnostics, files } = discoverLockfileGraphs(dir);
    expect(packages).toEqual([{ name: 'chalk', version: '4.1.0', integrity: 'sha512-z' }]);
    expect(diagnostics).toEqual([]);
    expect(files).toEqual([join(dir, 'pnpm-lock.yaml')]);
  });

  test('reports NO_LOCKFILE when neither format is present', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x' }));
    const { packages, diagnostics, files } = discoverLockfileGraphs(dir);
    expect(packages).toEqual([]);
    expect(files).toEqual([]);
    expect(diagnostics.some((d) => d.startsWith('NO_LOCKFILE:'))).toBe(true);
  });

  test('an unparseable lockfile is a diagnostic naming the file, not an exception, and the rest is still read', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'package-lock.json'), '{ not json');
    writeNpmLock(dir, { '': {}, 'node_modules/lodash': { version: '4.17.21' } }, 'web');
    const { packages, diagnostics, files } = discoverLockfileGraphs(dir);
    expect(packages.map((p) => p.name)).toEqual(['lodash']);
    expect(files).toEqual([join(dir, 'web', 'package-lock.json')]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^NPM_LOCKFILE_UNPARSEABLE: unparseable package-lock\.json at package-lock\.json: /);
  });

  test('dedupes an identical name+version found in more than one lockfile', () => {
    const dir = tempDir();
    writeNpmLock(dir, { '': {}, 'node_modules/lodash': { version: '4.17.21' } });
    writeFileSync(join(dir, 'pnpm-lock.yaml'), ["lockfileVersion: '9.0'", '', 'packages:', '', '  lodash@4.17.21:', '    resolution: {integrity: sha512-a}'].join('\n'));
    const { packages } = discoverLockfileGraphs(dir);
    expect(packages).toEqual([{ name: 'lodash', version: '4.17.21', devDeclared: false, integrity: 'sha512-a' }]);
  });

  test('builds the graph from a lockfile that is not at the root', () => {
    const dir = tempDir();
    writeNpmLock(
      dir,
      {
        '': { dependencies: { axios: '0.21.0' } },
        'node_modules/axios': { version: '0.21.0', dependencies: { 'follow-redirects': '1.13.0' } },
        'node_modules/follow-redirects': { version: '1.13.0' }
      },
      'web'
    );
    const { packages, rootDependencies, edges, diagnostics } = discoverLockfileGraphs(dir);
    expect(packages.map((p) => p.name).sort()).toEqual(['axios', 'follow-redirects']);
    expect(rootDependencies).toEqual(['axios@0.21.0']);
    expect(edges).toEqual([{ from: 'axios@0.21.0', to: 'follow-redirects@1.13.0' }]);
    expect(diagnostics).toEqual([]);
  });

  test("every lockfile's root dependencies feed ONE workspace graph, root and nested alike", () => {
    const dir = tempDir();
    writeNpmLock(dir, { '': { dependencies: { lodash: '4.17.21' } }, 'node_modules/lodash': { version: '4.17.21' } });
    writeNpmLock(
      dir,
      {
        '': { devDependencies: { chalk: '4.1.0' } },
        'node_modules/chalk': { version: '4.1.0', dev: true, dependencies: { 'ansi-styles': '4.3.0' } },
        'node_modules/ansi-styles': { version: '4.3.0', dev: true }
      },
      'tools'
    );
    const { packages, rootDependencies, edges, diagnostics, files } = discoverLockfileGraphs(dir);
    expect(packages.map((p) => p.name).sort()).toEqual(['ansi-styles', 'chalk', 'lodash']);
    expect(rootDependencies.sort()).toEqual(['chalk@4.1.0', 'lodash@4.17.21']);
    expect(edges).toEqual([{ from: 'chalk@4.1.0', to: 'ansi-styles@4.3.0' }]);
    expect(diagnostics).toEqual([]);
    expect(files).toHaveLength(2);
  });

  test('a package two lockfiles disagree on merges "runtime anywhere wins"; optional survives only if both say so', () => {
    const dir = tempDir();
    writeNpmLock(
      dir,
      {
        '': { dependencies: { shared: '1.0.0', fsevents: '2.3.3' } },
        'node_modules/shared': { version: '1.0.0', license: 'MIT' },
        'node_modules/fsevents': { version: '2.3.3' }
      },
      'web'
    );
    writeNpmLock(
      dir,
      {
        '': { devDependencies: { shared: '1.0.0' }, optionalDependencies: { fsevents: '2.3.3' } },
        'node_modules/shared': { version: '1.0.0', dev: true },
        'node_modules/fsevents': { version: '2.3.3', optional: true }
      },
      'tools'
    );
    const { packages } = discoverLockfileGraphs(dir);
    const shared = packages.find((p) => p.name === 'shared');
    expect(shared.devDeclared).toBe(false);
    expect(shared.license).toBe('MIT');
    expect(packages.find((p) => p.name === 'fsevents').scope).toBeUndefined();
  });

  test('a package dev-only in one lockfile and unmentioned-scope in another stays dev', () => {
    const dir = tempDir();
    writeNpmLock(dir, { '': { devDependencies: { vitest: '1.0.0' } }, 'node_modules/vitest': { version: '1.0.0', dev: true } }, 'a');
    mkdirSync(join(dir, 'b'));
    writeFileSync(join(dir, 'b', 'pnpm-lock.yaml'), ["lockfileVersion: '9.0'", '', 'packages:', '', '  vitest@1.0.0:', '    resolution: {integrity: sha512-a}'].join('\n'));
    const { packages } = discoverLockfileGraphs(dir);
    expect(packages.find((p) => p.name === 'vitest').devDeclared).toBe(true);
  });

  test('a mixed run: most lockfiles agree, one disagrees on a hash for the same name@version -- that one package drops to absent with a diagnostic, everything else is unaffected', () => {
    // Three lockfiles feed one workspace graph (a real fan-out, not a
    // single-file edge case): two agree on `shared`'s hash, a third
    // resolves it to a DIFFERENT hash -- exactly the "one lockfile got a
    // tampered/mismatched artifact" shape this diagnostic exists to catch.
    // `lodash`, present in every file with the SAME hash, must be
    // completely unaffected by the neighboring conflict.
    const dir = tempDir();
    writeNpmLock(
      dir,
      {
        '': { dependencies: { shared: '1.0.0', lodash: '4.17.21' } },
        'node_modules/shared': { version: '1.0.0', integrity: 'sha512-good' },
        'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-lodash' }
      },
      'a'
    );
    writeNpmLock(
      dir,
      {
        '': { dependencies: { shared: '1.0.0', lodash: '4.17.21' } },
        'node_modules/shared': { version: '1.0.0', integrity: 'sha512-good' },
        'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-lodash' }
      },
      'b'
    );
    mkdirSync(join(dir, 'c'));
    writeFileSync(
      join(dir, 'c', 'pnpm-lock.yaml'),
      [
        "lockfileVersion: '9.0'",
        '',
        'packages:',
        '',
        '  shared@1.0.0:',
        '    resolution: {integrity: sha512-TAMPERED}',
        '',
        '  lodash@4.17.21:',
        '    resolution: {integrity: sha512-lodash}'
      ].join('\n')
    );
    const { packages, diagnostics, files } = discoverLockfileGraphs(dir);
    expect(files).toHaveLength(3);
    expect(packages.find((p) => p.name === 'lodash').integrity).toBe('sha512-lodash');
    expect(packages.find((p) => p.name === 'shared').integrity).toBeUndefined();
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toMatch(/^NPM_INTEGRITY_CONFLICT: shared@1\.0\.0 has conflicting integrity hashes/);
    expect(diagnostics[0]).toContain('sha512-good');
    expect(diagnostics[0]).toContain('sha512-TAMPERED');
  });

  // The two tests below COMPOSE the two merge sites -- the fold inside one
  // `parsePackageLockJsonGraph`, and the fold across lockfiles in
  // `discoverLockfileGraphs` -- which is where an identity-keyed conflict
  // memory silently evaporated: `addGraph` folds a fresh `{ ...pkg }` copy,
  // so the mark set on the per-lockfile record never crossed the boundary.
  // A test that stays inside ONE merge site pins nothing about the other.
  // Both orders are asserted because the conflicted record is the merge
  // TARGET in one and the merge SOURCE in the other, and those used to be
  // two different bugs.
  /** @param {string} conflictDir @param {string} agreeDir */
  function twoLockfilesOneConflicted(conflictDir, agreeDir) {
    const dir = tempDir();
    // Two paths in ONE lockfile resolve foo@1.0.0 to different hashes:
    // hoisted at the root, and nested under a package that pinned it.
    writeNpmLock(
      dir,
      {
        '': { dependencies: { foo: '1.0.0', bar: '2.0.0' } },
        'node_modules/foo': { version: '1.0.0', integrity: 'sha512-AAAAgood' },
        'node_modules/bar': { version: '2.0.0', dependencies: { foo: '1.0.0' } },
        'node_modules/bar/node_modules/foo': { version: '1.0.0', integrity: 'sha512-ZZZZevil' }
      },
      conflictDir
    );
    // A second lockfile that agrees with ONE of the two hashes. It must not
    // be able to reinstate the field: the disagreement already means this
    // name@version's hash cannot be trusted.
    writeNpmLock(
      dir,
      { '': { dependencies: { foo: '1.0.0' } }, 'node_modules/foo': { version: '1.0.0', integrity: 'sha512-AAAAgood' } },
      agreeDir
    );
    return discoverLockfileGraphs(dir);
  }

  test('an intra-lockfile conflict is not undone by a second lockfile that agrees (the conflicted record is the merge TARGET)', () => {
    const { packages, diagnostics, files } = twoLockfilesOneConflicted('a', 'b');
    expect(files).toHaveLength(2);
    const foo = packages.find((p) => p.name === 'foo');
    // The document must not say "dropped" and publish a hash in the same
    // breath -- that is the conflicting sighting being hidden, which is the
    // whole reason this diagnostic exists.
    expect(foo.integrity).toBeUndefined();
    expect(diagnostics.filter((d) => d.startsWith('NPM_INTEGRITY_CONFLICT:'))).toHaveLength(1);
    expect(diagnostics[0]).toContain('foo@1.0.0');
  });

  test('... and not by one read BEFORE it either (the conflicted record is the merge SOURCE)', () => {
    // Same pair, reverse discovery order (lockfile paths are read sorted, so
    // the agreeing file in `a/` is merged first and the conflicted one in
    // `b/` arrives as `other`). Where two disagreeing sightings SIT must not
    // decide whether a third sighting's hash gets published.
    const { packages, diagnostics, files } = twoLockfilesOneConflicted('b', 'a');
    expect(files).toHaveLength(2);
    const foo = packages.find((p) => p.name === 'foo');
    expect(foo.integrity).toBeUndefined();
    expect(diagnostics.filter((d) => d.startsWith('NPM_INTEGRITY_CONFLICT:'))).toHaveLength(1);
    expect(diagnostics[0]).toContain('foo@1.0.0');
  });

  test('a lockfile inside node_modules is never read', () => {
    const dir = tempDir();
    writeNpmLock(dir, { '': {}, 'node_modules/inner': { version: '9.9.9' } }, 'node_modules/dep');
    const { packages, diagnostics } = discoverLockfileGraphs(dir);
    expect(packages).toEqual([]);
    expect(diagnostics.some((d) => d.startsWith('NO_LOCKFILE:'))).toBe(true);
  });
});
