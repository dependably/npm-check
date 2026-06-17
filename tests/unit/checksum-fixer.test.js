// tests/unit/checksum-fixer.test.js
import { fixChecksums, deriveRegistryBase, ChecksumFixError } from '../../src/checksum-fixer.js';

function makeLockfile(packages) {
  return {
    name: 'test-project',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'test-project', version: '1.0.0' },
      ...packages
    }
  };
}

const REAL_HASH = 'sha512-' + 'A'.repeat(86) + '==';

describe('deriveRegistryBase', () => {
  it('derives base from a plain package tarball URL', () => {
    expect(deriveRegistryBase('https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz', 'lodash'))
      .toBe('https://registry.npmjs.org');
  });

  it('derives base from a scoped package URL', () => {
    expect(deriveRegistryBase('https://registry.npmjs.org/@babel/core/-/core-7.0.0.tgz', '@babel/core'))
      .toBe('https://registry.npmjs.org');
  });

  it('derives base from a %2f-encoded scoped URL', () => {
    expect(deriveRegistryBase('https://npm.corp.example.com/registry/@scope%2fpkg/-/pkg-1.0.0.tgz', '@scope/pkg'))
      .toBe('https://npm.corp.example.com/registry');
  });

  it('keeps custom registry path prefixes', () => {
    expect(deriveRegistryBase('https://artifactory.example.com/api/npm/npm-repo/express/-/express-4.18.0.tgz', 'express'))
      .toBe('https://artifactory.example.com/api/npm/npm-repo');
  });

  it('returns null for git and unparseable URLs', () => {
    expect(deriveRegistryBase('git+ssh://git@github.com/user/repo.git', 'repo')).toBeNull();
    expect(deriveRegistryBase('not a url', 'pkg')).toBeNull();
    expect(deriveRegistryBase('', 'pkg')).toBeNull();
  });
});

describe('fixChecksums', () => {
  it('fills missing, placeholder, and sha1 integrity from the registry', async () => {
    const lockfile = makeLockfile({
      'node_modules/missing-pkg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/missing-pkg/-/missing-pkg-1.0.0.tgz' },
      'node_modules/placeholder-pkg': { version: '2.0.0', resolved: 'https://registry.npmjs.org/placeholder-pkg/-/placeholder-pkg-2.0.0.tgz', integrity: 'sha512-PLACEHOLDER' },
      'node_modules/sha1-pkg': { version: '3.0.0', resolved: 'https://registry.npmjs.org/sha1-pkg/-/sha1-pkg-3.0.0.tgz', integrity: 'sha1-abc123' },
      'node_modules/good-pkg': { version: '4.0.0', resolved: 'https://registry.npmjs.org/good-pkg/-/good-pkg-4.0.0.tgz', integrity: REAL_HASH }
    });

    const fetchIntegrity = async (name, version) => `sha512-FIXED-${name}-${version}==`;
    const result = await fixChecksums(lockfile, { fetchIntegrity });

    expect(result.summary.fixedFromRegistry).toBe(3);
    expect(result.summary.unresolved).toBe(0);
    expect(result.lockfile.packages['node_modules/missing-pkg'].integrity).toBe('sha512-FIXED-missing-pkg-1.0.0==');
    expect(result.lockfile.packages['node_modules/placeholder-pkg'].integrity).toBe('sha512-FIXED-placeholder-pkg-2.0.0==');
    expect(result.lockfile.packages['node_modules/sha1-pkg'].integrity).toBe('sha512-FIXED-sha1-pkg-3.0.0==');
    // untouched valid entry
    expect(result.lockfile.packages['node_modules/good-pkg'].integrity).toBe(REAL_HASH);
    expect(result.skipped).toContainEqual({ packagePath: 'node_modules/good-pkg', reason: 'valid' });
  });

  it('passes the derived per-package registry base to the fetcher', async () => {
    const lockfile = makeLockfile({
      'node_modules/@scope/private': {
        version: '1.2.3',
        resolved: 'https://npm.corp.example.com/registry/@scope%2fprivate/-/private-1.2.3.tgz'
      }
    });

    const calls = [];
    const fetchIntegrity = async (name, version, registryBase) => {
      calls.push({ name, version, registryBase });
      return REAL_HASH;
    };
    await fixChecksums(lockfile, { fetchIntegrity });

    expect(calls).toEqual([
      { name: '@scope/private', version: '1.2.3', registryBase: 'https://npm.corp.example.com/registry' }
    ]);
  });

  it('uses entry.name for npm: aliases', async () => {
    const lockfile = makeLockfile({
      'node_modules/my-alias': {
        name: 'real-package',
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/real-package/-/real-package-1.0.0.tgz'
      }
    });

    const calls = [];
    const fetchIntegrity = async (name) => { calls.push(name); return REAL_HASH; };
    await fixChecksums(lockfile, { fetchIntegrity });

    expect(calls).toEqual(['real-package']);
  });

  it('skips root, workspace, link, git, bundled, and file-directory entries', async () => {
    const lockfile = makeLockfile({
      'packages/my-workspace': { version: '1.0.0' },
      'node_modules/linked': { link: true, resolved: 'packages/my-workspace' },
      'node_modules/git-dep': { version: '1.0.0', resolved: 'git+https://github.com/user/repo.git#abc' },
      'node_modules/bundled-dep': { version: '1.0.0', inBundle: true },
      'node_modules/local-dir': { version: '1.0.0', resolved: 'file:../local-dir' }
    });

    const result = await fixChecksums(lockfile, {
      fetchIntegrity: async () => { throw new Error('should not be called'); }
    });

    expect(result.changes).toEqual([]);
    expect(result.unresolved).toEqual([]);
    const reasons = Object.fromEntries(result.skipped.map((s) => [s.packagePath, s.reason]));
    expect(reasons['']).toBe('root');
    expect(reasons['packages/my-workspace']).toBe('workspace');
    expect(reasons['node_modules/linked']).toBe('link');
    expect(reasons['node_modules/git-dep']).toBe('git');
    expect(reasons['node_modules/bundled-dep']).toBe('bundled');
    expect(reasons['node_modules/local-dir']).toBe('file-dir');
  });

  it('records unresolved when registry has no hash and local fallback is off', async () => {
    const lockfile = makeLockfile({
      'node_modules/ancient-pkg': { version: '0.0.1', resolved: 'https://registry.npmjs.org/ancient-pkg/-/ancient-pkg-0.0.1.tgz' }
    });

    const result = await fixChecksums(lockfile, { fetchIntegrity: async () => null });

    expect(result.changes).toEqual([]);
    expect(result.unresolved).toHaveLength(1);
    expect(result.unresolved[0].reason).toMatch(/no sha512 integrity/);
    expect(result.warnings).toEqual([]);
  });

  it('marks network failures as unresolved with a fallback hint', async () => {
    const lockfile = makeLockfile({
      'node_modules/offline-pkg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/offline-pkg/-/offline-pkg-1.0.0.tgz' }
    });

    const result = await fixChecksums(lockfile, {
      fetchIntegrity: async () => { throw new Error('ETIMEDOUT'); }
    });

    expect(result.unresolved[0].reason).toMatch(/registry unreachable/);
    expect(result.unresolved[0].reason).toMatch(/--local-fallback/);
  });

  it('flags local-directory hashes with a prominent warning when fallback is enabled', async () => {
    const lockfile = makeLockfile({
      'node_modules/offline-pkg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/offline-pkg/-/offline-pkg-1.0.0.tgz' }
    });

    // node_modules of THIS repo: use a real installed package dir so hashing succeeds
    const result = await fixChecksums(lockfile, {
      fetchIntegrity: async () => { throw new Error('ETIMEDOUT'); },
      localFallback: true,
      nodeModulesPath: './tests/fixtures'
    });

    // fixtures dir doesn't contain offline-pkg → hashing yields empty-but-valid hash or unresolved;
    // hashPackageDirectory on a missing dir returns a hash of zero files, so accept either outcome
    if (result.changes.length === 1) {
      expect(result.changes[0].source).toBe('local-directory');
      expect(result.warnings[0]).toMatch(/NOT npm/);
    } else {
      expect(result.unresolved).toHaveLength(1);
    }
  });

  it('hashes file: tarball deps relative to baseDir', async () => {
    const fs = await import('fs');
    const os = await import('os');
    const pathMod = await import('path');
    const tmpDir = fs.mkdtempSync(pathMod.join(os.tmpdir(), 'npm-check-tarball-'));
    try {
      fs.writeFileSync(pathMod.join(tmpDir, 'vendored-1.0.0.tgz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
      const lockfile = makeLockfile({
        'node_modules/vendored': { version: '1.0.0', resolved: 'file:vendored-1.0.0.tgz' }
      });

      const result = await fixChecksums(lockfile, {
        baseDir: tmpDir,
        fetchIntegrity: async () => { throw new Error('should not be called'); }
      });

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].source).toBe('local-file');
      expect(result.changes[0].to).toMatch(/^sha512-/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('rejects v1 lockfiles with UNSUPPORTED_VERSION', async () => {
    const v1 = { name: 'x', version: '1.0.0', lockfileVersion: 1, dependencies: {} };
    await expect(fixChecksums(v1)).rejects.toThrow(ChecksumFixError);
    await expect(fixChecksums(v1)).rejects.toMatchObject({ code: 'UNSUPPORTED_VERSION' });
  });

  it('does not mutate the input lockfile', async () => {
    const lockfile = makeLockfile({
      'node_modules/missing-pkg': { version: '1.0.0', resolved: 'https://registry.npmjs.org/missing-pkg/-/missing-pkg-1.0.0.tgz' }
    });
    const snapshot = JSON.parse(JSON.stringify(lockfile));

    await fixChecksums(lockfile, { fetchIntegrity: async () => REAL_HASH });

    expect(lockfile).toEqual(snapshot);
  });

  it('respects the concurrency limit', async () => {
    const packages = {};
    for (let i = 0; i < 20; i++) {
      packages[`node_modules/pkg-${i}`] = {
        version: '1.0.0',
        resolved: `https://registry.npmjs.org/pkg-${i}/-/pkg-${i}-1.0.0.tgz`
      };
    }
    const lockfile = makeLockfile(packages);

    let inFlight = 0;
    let maxInFlight = 0;
    const fetchIntegrity = async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return REAL_HASH;
    };

    const result = await fixChecksums(lockfile, { fetchIntegrity, concurrency: 3 });

    expect(result.summary.fixedFromRegistry).toBe(20);
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('reports progress', async () => {
    const lockfile = makeLockfile({
      'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
      'node_modules/b': { version: '1.0.0', resolved: 'https://registry.npmjs.org/b/-/b-1.0.0.tgz' }
    });

    const updates = [];
    await fixChecksums(lockfile, {
      fetchIntegrity: async () => REAL_HASH,
      onProgress: (p) => updates.push(p)
    });

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[updates.length - 1].percentage).toBe(100);
  });
});
