// tests/unit/pinner.test.js
import { classifyRange, pinVersions, detectIndent, PinnerError } from '../../src/pinner.js';

describe('classifyRange', () => {
  const cases = [
    ['4.17.21', 'exact'],
    ['1.0.0-beta.1', 'exact'],
    ['^4.17.21', 'caret'],
    ['^1.0', 'caret'],
    ['^2', 'caret'],
    ['~4.17.21', 'tilde'],
    ['~1.2', 'tilde'],
    ['>=1.0.0', 'complex'],
    ['>=1.0.0 <2.0.0', 'complex'],
    ['1.x', 'complex'],
    ['*', 'complex'],
    ['latest', 'complex'],
    ['1.0.0 - 2.0.0', 'complex'],
    ['^1.0.0 || ^2.0.0', 'complex'],
    ['', 'complex'],
    [null, 'complex'],
    ['npm:other-pkg@^1.0.0', 'alias'],
    ['workspace:*', 'workspace'],
    ['file:../local', 'file'],
    ['link:../local', 'link'],
    ['git+https://github.com/user/repo.git', 'git'],
    ['git://github.com/user/repo.git', 'git'],
    ['github:user/repo', 'git'],
    ['https://example.com/pkg.tgz', 'url']
  ];

  it.each(cases)('classifies %p as %p', (range, expected) => {
    expect(classifyRange(range)).toBe(expected);
  });
});

function makeFixture() {
  const packageJson = {
    name: 'test-project',
    version: '1.0.0',
    dependencies: {
      'caret-pkg': '^4.17.20',
      'tilde-pkg': '~2.1.0',
      'exact-pkg': '3.0.0',
      'complex-pkg': '>=1.0.0',
      'git-pkg': 'git+https://github.com/user/repo.git',
      'missing-pkg': '^9.9.9'
    },
    devDependencies: {
      'dev-pkg': '^1.0.0'
    },
    peerDependencies: {
      'peer-pkg': '^5.0.0'
    }
  };

  const lockfile = {
    name: 'test-project',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'test-project',
        version: '1.0.0',
        dependencies: {
          'caret-pkg': '^4.17.20',
          'tilde-pkg': '~2.1.0',
          'exact-pkg': '3.0.0',
          'complex-pkg': '>=1.0.0',
          'git-pkg': 'git+https://github.com/user/repo.git',
          'missing-pkg': '^9.9.9'
        },
        devDependencies: { 'dev-pkg': '^1.0.0' },
        peerDependencies: { 'peer-pkg': '^5.0.0' }
      },
      'node_modules/caret-pkg': { version: '4.17.21' },
      'node_modules/tilde-pkg': { version: '2.1.5' },
      'node_modules/exact-pkg': { version: '3.0.0' },
      'node_modules/complex-pkg': { version: '1.4.0' },
      'node_modules/dev-pkg': { version: '1.0.3' },
      'node_modules/peer-pkg': { version: '5.2.0' }
    }
  };

  return { packageJson, lockfile };
}

describe('pinVersions', () => {
  it('rewrites caret and tilde ranges to lockfile-resolved versions', () => {
    const { packageJson, lockfile } = makeFixture();
    const result = pinVersions(packageJson, lockfile);

    expect(result.packageJson.dependencies['caret-pkg']).toBe('4.17.21');
    expect(result.packageJson.dependencies['tilde-pkg']).toBe('2.1.5');
    expect(result.packageJson.devDependencies['dev-pkg']).toBe('1.0.3');
    expect(result.changes).toContainEqual({ section: 'dependencies', name: 'caret-pkg', from: '^4.17.20', to: '4.17.21' });
    expect(result.changes).toContainEqual({ section: 'dependencies', name: 'tilde-pkg', from: '~2.1.0', to: '2.1.5' });
  });

  it('syncs the lockfile root entry', () => {
    const { packageJson, lockfile } = makeFixture();
    const result = pinVersions(packageJson, lockfile);

    expect(result.lockfile.packages[''].dependencies['caret-pkg']).toBe('4.17.21');
    expect(result.lockfile.packages[''].devDependencies['dev-pkg']).toBe('1.0.3');
    // Non-pinned ranges left alone in root entry
    expect(result.lockfile.packages[''].dependencies['complex-pkg']).toBe('>=1.0.0');
  });

  it('leaves exact versions untouched without reporting them', () => {
    const { packageJson, lockfile } = makeFixture();
    const result = pinVersions(packageJson, lockfile);

    expect(result.packageJson.dependencies['exact-pkg']).toBe('3.0.0');
    expect(result.changes.find((c) => c.name === 'exact-pkg')).toBeUndefined();
    expect(result.skipped.find((s) => s.name === 'exact-pkg')).toBeUndefined();
  });

  it('skips complex/git ranges with reasons', () => {
    const { packageJson, lockfile } = makeFixture();
    const result = pinVersions(packageJson, lockfile);

    expect(result.packageJson.dependencies['complex-pkg']).toBe('>=1.0.0');
    expect(result.packageJson.dependencies['git-pkg']).toBe('git+https://github.com/user/repo.git');
    expect(result.skipped).toContainEqual({ section: 'dependencies', name: 'complex-pkg', range: '>=1.0.0', reason: 'complex-range' });
    expect(result.skipped).toContainEqual({ section: 'dependencies', name: 'git-pkg', range: 'git+https://github.com/user/repo.git', reason: 'git-range' });
  });

  it('skips dependencies missing from the lockfile and warns', () => {
    const { packageJson, lockfile } = makeFixture();
    const result = pinVersions(packageJson, lockfile);

    expect(result.packageJson.dependencies['missing-pkg']).toBe('^9.9.9');
    expect(result.skipped).toContainEqual({ section: 'dependencies', name: 'missing-pkg', range: '^9.9.9', reason: 'not-in-lockfile' });
    expect(result.warnings.some((w) => w.includes('npm install'))).toBe(true);
  });

  it('excludes peerDependencies by default, includes with includePeer', () => {
    const { packageJson, lockfile } = makeFixture();

    const without = pinVersions(packageJson, lockfile);
    expect(without.packageJson.peerDependencies['peer-pkg']).toBe('^5.0.0');

    const withPeer = pinVersions(packageJson, lockfile, { includePeer: true });
    expect(withPeer.packageJson.peerDependencies['peer-pkg']).toBe('5.2.0');
    expect(withPeer.lockfile.packages[''].peerDependencies['peer-pkg']).toBe('5.2.0');
  });

  it('pins package.json only for v1 lockfiles, with a warning', () => {
    const { packageJson } = makeFixture();
    const v1 = {
      name: 'test-project',
      version: '1.0.0',
      lockfileVersion: 1,
      dependencies: {
        'caret-pkg': { version: '4.17.21' },
        'tilde-pkg': { version: '2.1.5' },
        'exact-pkg': { version: '3.0.0' },
        'complex-pkg': { version: '1.4.0' },
        'dev-pkg': { version: '1.0.3' }
      }
    };

    const result = pinVersions(packageJson, v1);

    expect(result.packageJson.dependencies['caret-pkg']).toBe('4.17.21');
    expect(result.warnings.some((w) => w.includes('v1'))).toBe(true);
  });

  it('does not mutate inputs', () => {
    const { packageJson, lockfile } = makeFixture();
    const pkgSnapshot = JSON.parse(JSON.stringify(packageJson));
    const lockSnapshot = JSON.parse(JSON.stringify(lockfile));

    pinVersions(packageJson, lockfile);

    expect(packageJson).toEqual(pkgSnapshot);
    expect(lockfile).toEqual(lockSnapshot);
  });

  it('throws on missing inputs', () => {
    expect(() => pinVersions(null, {})).toThrow(PinnerError);
    expect(() => pinVersions({}, null)).toThrow(PinnerError);
  });

  it('pins caret/tilde ranges inside npm `overrides` (incl. nested), leaving refs/exacts alone', () => {
    const packageJson = {
      name: 'p', version: '1.0.0',
      dependencies: { foo: '^1.0.0' },
      overrides: {
        'caret-pkg': '^4.17.20',                     // → 4.17.21
        nested: { '.': '~2.1.0', child: '3.0.0' },   // '.' → nested resolves 2.1.5; child exact
        reffed: '$foo',                              // reference — untouched, not reported
        complex: '>=1.0.0'                           // complex — skipped
      }
    };
    const lockfile = {
      name: 'p', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { name: 'p', version: '1.0.0', dependencies: { foo: '^1.0.0' } },
        'node_modules/foo': { version: '1.2.3' },
        'node_modules/caret-pkg': { version: '4.17.21' },
        'node_modules/nested': { version: '2.1.5' }
      }
    };

    const result = pinVersions(packageJson, lockfile);
    const ov = result.packageJson.overrides;
    expect(ov['caret-pkg']).toBe('4.17.21');
    expect(ov.nested['.']).toBe('2.1.5');
    expect(ov.nested.child).toBe('3.0.0');   // exact — untouched
    expect(ov.reffed).toBe('$foo');          // $-ref — untouched
    expect(ov.complex).toBe('>=1.0.0');      // complex — untouched
    expect(result.changes).toContainEqual({ section: 'overrides', name: 'caret-pkg', from: '^4.17.20', to: '4.17.21' });
    expect(result.changes).toContainEqual({ section: 'overrides', name: 'nested > .', from: '~2.1.0', to: '2.1.5' });
    expect(result.skipped).toContainEqual({ section: 'overrides', name: 'complex', range: '>=1.0.0', reason: 'complex-range' });
    // The $-reference is neither changed nor skipped (it's not a range).
    expect(result.changes.some((c) => c.name === 'reffed')).toBe(false);
    expect(result.skipped.some((s) => s.name === 'reffed')).toBe(false);
  });

  it('does NOT pin a nested override whose name resolves to multiple versions', () => {
    // A nested override targets a shadowed install path; the top-level entry can
    // be a different instance. Here `b` exists at 1.0.0 (top-level) and 2.3.4
    // (under a) — pinning to 1.0.0 would invert the `^2.0.0` override. Skip it.
    const packageJson = {
      name: 'p', version: '1.0.0',
      overrides: { a: { b: '^2.0.0' } }
    };
    const lockfile = {
      name: 'p', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { name: 'p', version: '1.0.0' },
        'node_modules/b': { version: '1.0.0' },
        'node_modules/a': { version: '1.5.0' },
        'node_modules/a/node_modules/b': { version: '2.3.4' }
      }
    };

    const result = pinVersions(packageJson, lockfile);
    expect(result.packageJson.overrides.a.b).toBe('^2.0.0'); // untouched
    expect(result.skipped).toContainEqual({ section: 'overrides', name: 'a > b', range: '^2.0.0', reason: 'ambiguous-resolution' });
    // ambiguous-resolution must NOT trigger the "run npm install" (not-in-lockfile) warning
    expect(result.warnings.some((w) => w.includes('npm install'))).toBe(false);
  });
});

describe('detectIndent', () => {
  it('detects four-space indentation', () => {
    expect(detectIndent('{\n    "name": "x"\n}\n')).toBe('    ');
  });

  it('detects tab indentation', () => {
    expect(detectIndent('{\n\t"name": "x"\n}\n')).toBe('\t');
  });

  it('defaults to two spaces', () => {
    expect(detectIndent('{}')).toBe('  ');
    expect(detectIndent(null)).toBe('  ');
  });
});
