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

  // Regression (#1): pnpm v6 (lockfileVersion '6.0', pnpm 8) keys carry a leading slash
  // and an @-separated version. The old lastIndexOf('@')-with-leading-slash parse yielded
  // name='/lodash' — a bogus name fed straight into registry requests.
  test('v6 leading-slash unscoped key', () => {
    expect(parsePnpmDepPath('/lodash@4.17.21')).toEqual({ name: 'lodash', version: '4.17.21' });
  });

  test('v6 leading-slash scoped key', () => {
    expect(parsePnpmDepPath('/@scope/pkg@1.0.0')).toEqual({ name: '@scope/pkg', version: '1.0.0' });
    expect(parsePnpmDepPath('/@babel/core@7.0.0')).toEqual({ name: '@babel/core', version: '7.0.0' });
  });

  test('v6 leading-slash key with a paren peer suffix', () => {
    expect(parsePnpmDepPath('/foo@1.0.0(react@18.0.0)')).toEqual({ name: 'foo', version: '1.0.0' });
    expect(parsePnpmDepPath('/@scope/x@1.2.3(react@18.0.0)')).toEqual({ name: '@scope/x', version: '1.2.3' });
  });

  // Regression (#1): pnpm v5 (lockfileVersion '5.x', pnpm 6-7) keys have NO version `@`
  // at all — the version is slash-separated. The old parse produced
  // name='/lodash/4.17.21', version=null, so a vulnerable v5 lockfile scanned clean.
  test('v5 leading-slash unscoped key (slash-separated version)', () => {
    expect(parsePnpmDepPath('/lodash/4.17.21')).toEqual({ name: 'lodash', version: '4.17.21' });
  });

  test('v5 leading-slash scoped key (slash-separated version)', () => {
    expect(parsePnpmDepPath('/@scope/pkg/1.0.0')).toEqual({ name: '@scope/pkg', version: '1.0.0' });
    expect(parsePnpmDepPath('/@babel/core/7.0.0')).toEqual({ name: '@babel/core', version: '7.0.0' });
  });

  test('v5 leading-slash key with an underscore peer suffix', () => {
    // The peer suffix (`_react@16.13.1`, with `+`-joined multi-peers) must not leak
    // into the version, and its inner `@` must not be taken as the separator.
    expect(parsePnpmDepPath('/react-dom/16.13.1_react@16.13.1')).toEqual({
      name: 'react-dom',
      version: '16.13.1'
    });
    expect(parsePnpmDepPath('/@scope/x/1.2.3_react@16.0.0+react-dom@16.0.0')).toEqual({
      name: '@scope/x',
      version: '1.2.3'
    });
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
      // URL-tarball dep that ALSO carries integrity (the common pnpm shape) — must NOT
      // be misclassified as a registry package (#2). The key's "version" is the URL.
      'is-positive@https://registry.npmjs.org/is-positive/-/is-positive-3.1.0.tgz': {
        resolution: {
          integrity: 'sha512-EEE==',
          tarball: 'https://registry.npmjs.org/is-positive/-/is-positive-3.1.0.tgz'
        }
      },
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

  test('flags a URL-tarball dep that carries integrity (not a registry package) (#2)', () => {
    const t = collect().find((i) => i.name === 'is-positive');
    // Classified as a url/file dep despite having integrity — the checkers must skip
    // it (its "version" is the tarball URL, which no registry can resolve).
    expect(t.node.kind).toBe('tarball');
    expect(t.isFileDep).toBe(true);
    expect(t.registryBase).toBeNull();
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
