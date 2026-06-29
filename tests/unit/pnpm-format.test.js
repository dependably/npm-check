// tests/unit/pnpm-format.test.js
import {
  parsePnpmDepPath,
  resolvePnpmRegistryBase,
  forEachPnpmPackageEntry
} from '../../src/pnpm-format.js';
import { detectLockfileFlavor, forEachPackageEntry } from '../../src/format-library.js';
import { DEFAULT_REGISTRY } from '../../src/integrity.js';

describe('parsePnpmDepPath', () => {
  test('splits an unscoped name@version', () => {
    expect(parsePnpmDepPath('lodash@4.17.21')).toEqual({ name: 'lodash', version: '4.17.21' });
  });

  test('splits a scoped name@version (last @ wins)', () => {
    expect(parsePnpmDepPath('@babel/core@7.0.0')).toEqual({ name: '@babel/core', version: '7.0.0' });
  });

  test('strips a peer-dependency suffix before splitting', () => {
    // The inner @ of the peer (react@18.2.0) must not be mistaken for the separator.
    expect(parsePnpmDepPath('foo@1.0.0(react@18.2.0)')).toEqual({ name: 'foo', version: '1.0.0' });
    expect(parsePnpmDepPath('@scope/x@1.2.3(react@18.2.0)')).toEqual({ name: '@scope/x', version: '1.2.3' });
  });

  test('surfaces local file:/link: versions', () => {
    expect(parsePnpmDepPath('mylib@file:../mylib')).toEqual({ name: 'mylib', version: 'file:../mylib' });
    expect(parsePnpmDepPath('mylib@link:../mylib')).toEqual({ name: 'mylib', version: 'link:../mylib' });
  });
});

describe('resolvePnpmRegistryBase', () => {
  const config = {
    registry: 'https://registry.npmjs.org/',
    scopedRegistries: { '@scope': 'https://npm.mycorp.example/' }
  };

  test('uses the scoped registry for a matching scope', () => {
    expect(resolvePnpmRegistryBase('@scope/util', config)).toBe('https://npm.mycorp.example');
  });

  test('uses the default registry for an unscoped name', () => {
    expect(resolvePnpmRegistryBase('lodash', config)).toBe('https://registry.npmjs.org');
  });

  test('uses the default registry for an unmatched scope', () => {
    expect(resolvePnpmRegistryBase('@other/x', config)).toBe('https://registry.npmjs.org');
  });

  test('falls back to the public registry with no config', () => {
    expect(resolvePnpmRegistryBase('lodash')).toBe(DEFAULT_REGISTRY);
  });
});

describe('detectLockfileFlavor', () => {
  test('numeric lockfileVersion is npm', () => {
    expect(detectLockfileFlavor({ lockfileVersion: 3, packages: {} })).toBe('npm');
  });

  test('string lockfileVersion is pnpm', () => {
    expect(detectLockfileFlavor({ lockfileVersion: '9.0' })).toBe('pnpm');
  });

  test('importers/snapshots presence is pnpm', () => {
    expect(detectLockfileFlavor({ importers: {} })).toBe('pnpm');
    expect(detectLockfileFlavor({ snapshots: {} })).toBe('pnpm');
  });

  test('stamped __npmCheckMeta.flavor is trusted first', () => {
    const lf = { lockfileVersion: 3 };
    Object.defineProperty(lf, '__npmCheckMeta', { value: { flavor: 'pnpm' }, enumerable: false });
    expect(detectLockfileFlavor(lf)).toBe('pnpm');
  });
});

describe('forEachPnpmPackageEntry', () => {
  const lockfile = {
    importers: {
      '.': { dependencies: { lodash: { specifier: '^4', version: '4.17.21' } } },
      'packages/app': { dependencies: {} }
    },
    packages: {
      'lodash@4.17.21': { resolution: { integrity: 'sha512-AAA==' } },
      '@scope/util@1.0.0': { resolution: { integrity: 'sha512-BBB==' } },
      'left-pad@1.3.0': { resolution: { integrity: 'sha512-CCC==' }, deprecated: 'use padStart' },
      'some-git-dep@2.0.0': { resolution: { type: 'git', repo: 'git+https://x/y.git' } },
      'some-tarball@3.0.0': { resolution: { tarball: 'https://example.com/x.tgz' } },
      '@scope/peer-thing@1.2.3(react@18.2.0)': { resolution: { integrity: 'sha512-DDD==' } }
    },
    __npmCheckMeta: {
      flavor: 'pnpm',
      registry: 'https://registry.npmjs.org/',
      scopedRegistries: { '@scope': 'https://npm.mycorp.example/' }
    }
  };

  function collect() {
    const out = [];
    forEachPnpmPackageEntry(lockfile, (info) => out.push(info));
    return out;
  }

  test('emits the root importer and workspace importers', () => {
    const infos = collect();
    const root = infos.find((i) => i.key === '.');
    const ws = infos.find((i) => i.key === 'packages/app');
    expect(root.isRoot).toBe(true);
    expect(ws.isWorkspaceSource).toBe(true);
    expect(ws.isRoot).toBe(false);
  });

  test('classifies a registry package and stamps version/integrity/registryBase', () => {
    const lodash = collect().find((i) => i.key === 'lodash@4.17.21');
    expect(lodash.name).toBe('lodash');
    expect(lodash.entry.version).toBe('4.17.21');
    expect(lodash.entry.integrity).toBe('sha512-AAA==');
    expect(lodash.registryBase).toBe('https://registry.npmjs.org');
    expect(lodash.node.kind).toBe('registry');
    expect(lodash.isGitDep).toBe(false);
    expect(lodash.isFileDep).toBe(false);
  });

  test('routes a scoped package to its scoped registry', () => {
    const util = collect().find((i) => i.key === '@scope/util@1.0.0');
    expect(util.name).toBe('@scope/util');
    expect(util.registryBase).toBe('https://npm.mycorp.example');
  });

  test('surfaces the deprecated field on the synthesized entry', () => {
    const lp = collect().find((i) => i.key === 'left-pad@1.3.0');
    expect(lp.entry.deprecated).toBe('use padStart');
  });

  test('flags git and tarball deps so the checkers skip them', () => {
    const git = collect().find((i) => i.key === 'some-git-dep@2.0.0');
    const tarball = collect().find((i) => i.key === 'some-tarball@3.0.0');
    expect(git.isGitDep).toBe(true);
    expect(git.registryBase).toBeNull();
    expect(tarball.isFileDep).toBe(true); // no integrity → not registry-verifiable
  });

  test('strips a peer suffix on a packages key', () => {
    const peer = collect().find((i) => i.key.startsWith('@scope/peer-thing'));
    expect(peer.name).toBe('@scope/peer-thing');
    expect(peer.entry.version).toBe('1.2.3');
    expect(peer.node.kind).toBe('registry');
  });

  test('forEachPackageEntry dispatches pnpm lockfiles here', () => {
    const out = [];
    forEachPackageEntry(lockfile, (info) => out.push(info.key));
    expect(out).toContain('lodash@4.17.21');
    expect(out).toContain('.');
  });
});
