// tests/unit/pruner.test.js
import { findOrphanedPackages, prunePackages, PrunerError } from '../../src/pruner.js';

function makeLockfile(packages, extra = {}) {
  return {
    name: 'test-project',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'test-project', version: '1.0.0', ...extra.root },
      ...packages
    },
    ...extra.top
  };
}

describe('findOrphanedPackages', () => {
  it('finds no orphans in a fully-connected lockfile', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^1.0.0' } },
        'node_modules/b': { version: '1.0.0' }
      },
      { root: { dependencies: { a: '^1.0.0' } } }
    );

    const { orphans } = findOrphanedPackages(lockfile);
    expect(orphans).toEqual([]);
  });

  it('flags entries unreachable from the root', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/a': { version: '1.0.0' },
        'node_modules/orphan': { version: '2.0.0' },
        'node_modules/orphan-dep': { version: '3.0.0' }
      },
      { root: { dependencies: { a: '^1.0.0' } } }
    );
    // orphan depends on orphan-dep, but nothing reaches orphan itself
    lockfile.packages['node_modules/orphan'].dependencies = { 'orphan-dep': '^3.0.0' };

    const { orphans } = findOrphanedPackages(lockfile);
    expect(orphans.map((o) => o.key).sort()).toEqual([
      'node_modules/orphan',
      'node_modules/orphan-dep'
    ]);
  });

  it('follows nested node_modules resolution (nearest wins)', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/a': { version: '1.0.0', dependencies: { b: '^2.0.0' } },
        'node_modules/a/node_modules/b': { version: '2.0.0' },
        'node_modules/b': { version: '1.0.0' }
      },
      { root: { dependencies: { a: '^1.0.0', b: '^1.0.0' } } }
    );

    const { orphans, reachable } = findOrphanedPackages(lockfile);
    expect(orphans).toEqual([]);
    expect(reachable.has('node_modules/a/node_modules/b')).toBe(true);
  });

  it('treats a nested duplicate as orphaned when the parent is gone', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/gone/node_modules/b': { version: '2.0.0' },
        'node_modules/b': { version: '1.0.0' }
      },
      { root: { dependencies: { b: '^1.0.0' } } }
    );

    const { orphans } = findOrphanedPackages(lockfile);
    expect(orphans.map((o) => o.key)).toEqual(['node_modules/gone/node_modules/b']);
  });

  it('follows devDependencies and peerDependencies from the root', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/dev-tool': { version: '1.0.0' },
        'node_modules/peer-lib': { version: '1.0.0' }
      },
      { root: { devDependencies: { 'dev-tool': '^1.0.0' }, peerDependencies: { 'peer-lib': '^1.0.0' } } }
    );

    const { orphans } = findOrphanedPackages(lockfile);
    expect(orphans).toEqual([]);
  });

  it('follows peerDependencies of installed packages', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/a': { version: '1.0.0', peerDependencies: { peer: '^1.0.0' } },
        'node_modules/peer': { version: '1.0.0' }
      },
      { root: { dependencies: { a: '^1.0.0' } } }
    );

    const { orphans } = findOrphanedPackages(lockfile);
    expect(orphans).toEqual([]);
  });

  it('keeps workspace entries and follows their deps and links', () => {
    const lockfile = makeLockfile(
      {
        'packages/app': { version: '1.0.0', dependencies: { lib: '^1.0.0' } },
        'node_modules/app': { link: true, resolved: 'packages/app' },
        'node_modules/lib': { version: '1.0.0' }
      },
      { root: { dependencies: { app: '^1.0.0' } } }
    );

    const { orphans } = findOrphanedPackages(lockfile);
    expect(orphans).toEqual([]);
  });

  it('resolves aliased install names by key, not real package name', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/my-alias': { name: 'real-package', version: '1.0.0' }
      },
      { root: { dependencies: { 'my-alias': 'npm:real-package@^1.0.0' } } }
    );

    const { orphans } = findOrphanedPackages(lockfile);
    expect(orphans).toEqual([]);
  });

  it('rejects v1 lockfiles', () => {
    const v1 = { name: 'x', version: '1.0.0', lockfileVersion: 1, dependencies: {} };
    expect(() => findOrphanedPackages(v1)).toThrow(PrunerError);
  });
});

describe('prunePackages', () => {
  it('removes orphans and reports them', () => {
    const lockfile = makeLockfile(
      {
        'node_modules/a': { version: '1.0.0' },
        'node_modules/orphan': { version: '2.0.0' }
      },
      { root: { dependencies: { a: '^1.0.0' } } }
    );

    const result = prunePackages(lockfile);
    expect(result.removed).toEqual([
      { key: 'node_modules/orphan', name: 'orphan', version: '2.0.0' }
    ]);
    expect(result.lockfile.packages['node_modules/orphan']).toBeUndefined();
    expect(result.lockfile.packages['node_modules/a']).toBeDefined();
  });

  it('returns the lockfile unchanged when there is nothing to prune', () => {
    const lockfile = makeLockfile(
      { 'node_modules/a': { version: '1.0.0' } },
      { root: { dependencies: { a: '^1.0.0' } } }
    );

    const result = prunePackages(lockfile);
    expect(result.removed).toEqual([]);
    expect(result.lockfile).toBe(lockfile);
  });

  it('does not mutate the input lockfile', () => {
    const lockfile = makeLockfile(
      { 'node_modules/orphan': { version: '2.0.0' } },
      { root: { dependencies: {} } }
    );
    const snapshot = JSON.parse(JSON.stringify(lockfile));

    prunePackages(lockfile);
    expect(lockfile).toEqual(snapshot);
  });

  it('warns about the untouched legacy tree on v2 lockfiles', () => {
    const lockfile = makeLockfile(
      { 'node_modules/orphan': { version: '2.0.0' } },
      { root: { dependencies: {} }, top: { dependencies: { orphan: { version: '2.0.0' } } } }
    );
    lockfile.lockfileVersion = 2;

    const result = prunePackages(lockfile);
    expect(result.removed).toHaveLength(1);
    expect(result.warnings.some((w) => w.includes('legacy dependencies tree'))).toBe(true);
    // legacy tree untouched
    expect(result.lockfile.dependencies).toEqual({ orphan: { version: '2.0.0' } });
  });
});
