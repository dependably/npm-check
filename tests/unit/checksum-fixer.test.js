// tests/unit/checksum-fixer.test.js
import { fixChecksums, deriveRegistryBase, ChecksumFixError } from '../../src/checksum-fixer.js';
import fs from 'fs';
import os from 'os';
import path from 'path';

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

function makeV2Lockfile(packages, dependencies) {
  return {
    name: 'test-project',
    version: '1.0.0',
    lockfileVersion: 2,
    requires: true,
    packages: {
      '': { name: 'test-project', version: '1.0.0' },
      ...packages
    },
    dependencies
  };
}

const REAL_HASH = 'sha512-' + 'A'.repeat(86) + '==';

// sha512 of zero bytes — the constant hashPackageDirectory returns when the
// directory is absent (walkDir silently swallows ENOENT and returns []).
const SHA512_OF_NOTHING = 'sha512-z4PhNX7vuL3xVChQ1m2AB9Yg5AULVxXcg/SpIdNs6c5H0NE8XYXysP+DGNKHfuwvY7kxvUdBeoGlODJ6+SfaPg==';

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

  it('local fallback: emits NOT-npm warning when hashing a real directory', async () => {
    // Replaces the old lenient if/else test; we now need a real directory to
    // confirm the success path and its warning.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-lf-'));
    try {
      const pkgDir = path.join(tmpDir, 'node_modules', 'online-pkg');
      fs.mkdirSync(pkgDir, { recursive: true });
      fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = 1;');

      const lockfile = makeLockfile({
        'node_modules/online-pkg': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/online-pkg/-/online-pkg-1.0.0.tgz'
        }
      });

      const result = await fixChecksums(lockfile, {
        fetchIntegrity: async () => { throw new Error('ETIMEDOUT'); },
        localFallback: true,
        baseDir: tmpDir
      });

      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].source).toBe('local-directory');
      expect(result.warnings[0]).toMatch(/NOT npm/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('#17: an existing-but-empty package dir is unresolved, not a garbage hash', async () => {
    // An interrupted install can leave an empty package directory. hashPackageDirectory
    // digests zero files to the constant sha512-of-nothing; recording that as a
    // "fix" is worse than leaving the entry unresolved.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-empty-'));
    try {
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'empty-pkg'), { recursive: true }); // no files

      const lockfile = makeLockfile({
        'node_modules/empty-pkg': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/empty-pkg/-/empty-pkg-1.0.0.tgz'
        }
      });

      const result = await fixChecksums(lockfile, {
        fetchIntegrity: async () => null,
        localFallback: true,
        baseDir: tmpDir
      });

      expect(result.changes).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
      expect(result.changes.some(c => c.to === SHA512_OF_NOTHING)).toBe(false);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('#17: a symlink at the package path escaping the project root is rejected', async () => {
    // The textual containment check can't see through a symlink; realpath must.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-symlink-'));
    try {
      const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-outside-'));
      fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
      const nm = path.join(tmpDir, 'node_modules');
      fs.mkdirSync(nm, { recursive: true });
      try {
        fs.symlinkSync(outside, path.join(nm, 'escapee'), 'dir');
      } catch {
        return; // platform without symlink permission — skip
      }

      const lockfile = makeLockfile({
        'node_modules/escapee': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/escapee/-/escapee-1.0.0.tgz'
        }
      });

      const result = await fixChecksums(lockfile, {
        fetchIntegrity: async () => null,
        localFallback: true,
        baseDir: tmpDir
      });

      expect(result.changes).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
      fs.rmSync(outside, { recursive: true, force: true });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('hashes file: tarball deps relative to baseDir', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-tarball-'));
    try {
      fs.writeFileSync(path.join(tmpDir, 'vendored-1.0.0.tgz'), Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
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

  // --- Regression tests for issue #17 ---

  it('#17: absent local-fallback directory is reported as unresolved, not recorded as a garbage hash', async () => {
    // When the package directory does not exist on disk, the old code called
    // hashPackageDirectory on the missing path; because collectPackageFiles
    // silently swallows ENOENT and returns [], the hasher digested zero bytes
    // and returned the constant SHA512_OF_NOTHING.  That constant was then
    // written into the lockfile as though it were a real integrity value.
    // The fix adds an fs.existsSync guard that short-circuits to unresolved.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-17a-'));
    try {
      // node_modules/absent-pkg deliberately does NOT exist inside tmpDir.
      const lockfile = makeLockfile({
        'node_modules/absent-pkg': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/absent-pkg/-/absent-pkg-1.0.0.tgz'
          // no integrity — needs fix
        }
      });

      const result = await fixChecksums(lockfile, {
        fetchIntegrity: async () => null, // registry has no hash
        localFallback: true,
        baseDir: tmpDir
      });

      // Must be unresolved, not a spurious change with the garbage constant hash.
      expect(result.changes).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('#17: containment check rejects path-traversal keys in local fallback', async () => {
    // A hostile lockfile key like node_modules/../../secret would — without the
    // containment guard — resolve to a path outside the project root and hash
    // an arbitrary directory, disclosing its contents as a digest.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-17b-'));
    try {
      // Construct a lockfile with a traversal key.  forEachPackageEntry just
      // iterates lockfile.packages, so any key reaches classifyEntry / tryLocalFallback.
      const maliciousLockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test-project', version: '1.0.0' },
          'node_modules/../../secret': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz'
            // no integrity — would be a fix candidate
          }
        }
      };

      const result = await fixChecksums(maliciousLockfile, {
        fetchIntegrity: async () => null, // registry returns nothing, triggers local fallback
        localFallback: true,
        baseDir: tmpDir
      });

      // The traversal key must be rejected; no hash must be recorded.
      expect(result.changes).toEqual([]);
      expect(result.unresolved).toHaveLength(1);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('#17: nested package uses the full lockfile key path, not just the last segment', async () => {
    // Old code: pkgDir = path.join(nodeModulesPath, key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length))
    // For key 'node_modules/a/node_modules/b', lastIndexOf finds the SECOND
    // 'node_modules/' so the slice produces just 'b'; pkgDir becomes
    // <nodeModulesPath>/b — the hoisted copy, which may be absent or a different
    // version.  When absent, hashPackageDirectory returns SHA512_OF_NOTHING.
    // New code: pkgDir = path.resolve(path.join(baseDir, key)) which correctly
    // resolves to baseDir/node_modules/a/node_modules/b.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-17c-'));
    try {
      // Create only the NESTED path; the hoisted path (node_modules/b) does NOT exist.
      const nestedDir = path.join(tmpDir, 'node_modules', 'a', 'node_modules', 'b');
      fs.mkdirSync(nestedDir, { recursive: true });
      fs.writeFileSync(path.join(nestedDir, 'index.js'), 'module.exports = "b-nested";');

      const lockfile = makeLockfile({
        'node_modules/a': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
          integrity: REAL_HASH // valid — will not be fixed
        },
        'node_modules/a/node_modules/b': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz'
          // no integrity — needs fix
        }
      });

      const result = await fixChecksums(lockfile, {
        fetchIntegrity: async () => null, // no registry hash, triggers local fallback
        localFallback: true,
        baseDir: tmpDir
      });

      // New code finds the correct nested directory and records a real hash.
      expect(result.changes).toHaveLength(1);
      expect(result.changes[0].packagePath).toBe('node_modules/a/node_modules/b');
      expect(result.changes[0].source).toBe('local-directory');
      // The hash must NOT be the constant sha512-of-nothing that the old code
      // produced when it landed on the absent hoisted node_modules/b path.
      expect(result.changes[0].to).not.toBe(SHA512_OF_NOTHING);
      expect(result.changes[0].to).toMatch(/^sha512-/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // --- Regression tests for issue #19 ---

  it('#19: v2 lockfile — applyChanges mirrors integrity into the legacy dependencies tree', async () => {
    // Old code only updated lockfile.packages; the legacy dependencies tree
    // retained the stale/missing integrity, so the two sections disagreed —
    // the exact inconsistency the validator is documented to flag.
    const lockfile = makeV2Lockfile(
      {
        'node_modules/foo': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz'
          // no integrity — needs fix
        }
      },
      {
        foo: {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/foo/-/foo-1.0.0.tgz'
          // also missing integrity in the legacy tree
        }
      }
    );

    const result = await fixChecksums(lockfile, {
      fetchIntegrity: async () => REAL_HASH
    });

    expect(result.changes).toHaveLength(1);
    // packages map is updated
    expect(result.lockfile.packages['node_modules/foo'].integrity).toBe(REAL_HASH);
    // legacy dependencies tree is also updated (the fix)
    expect(result.lockfile.dependencies.foo.integrity).toBe(REAL_HASH);
    // input lockfile is not mutated
    expect(lockfile.dependencies.foo.integrity).toBeUndefined();
  });

  it('#19: v2 lockfile — legacy tree is updated for nested packages too', async () => {
    // Verify that packages at node_modules/a/node_modules/b correctly map to
    // dependencies.a.dependencies.b in the legacy tree.
    const lockfile = makeV2Lockfile(
      {
        'node_modules/a': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
          integrity: REAL_HASH
        },
        'node_modules/a/node_modules/b': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz'
          // no integrity
        }
      },
      {
        a: {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz',
          integrity: REAL_HASH,
          dependencies: {
            b: {
              version: '2.0.0',
              resolved: 'https://registry.npmjs.org/b/-/b-2.0.0.tgz'
              // no integrity
            }
          }
        }
      }
    );

    const result = await fixChecksums(lockfile, {
      fetchIntegrity: async (name) => `sha512-FIXED-${name}${'='.repeat(84)}`
    });

    expect(result.changes).toHaveLength(1);
    expect(result.changes[0].packagePath).toBe('node_modules/a/node_modules/b');
    // packages map updated
    expect(result.lockfile.packages['node_modules/a/node_modules/b'].integrity)
      .toMatch(/^sha512-FIXED-b/);
    // nested legacy tree updated
    expect(result.lockfile.dependencies.a.dependencies.b.integrity)
      .toMatch(/^sha512-FIXED-b/);
    // unchanged entry untouched in both trees
    expect(result.lockfile.packages['node_modules/a'].integrity).toBe(REAL_HASH);
    expect(result.lockfile.dependencies.a.integrity).toBe(REAL_HASH);
  });

  it('#19: v3 lockfile — applyChanges does not add a spurious dependencies key', async () => {
    // v3 lockfiles have no dependencies tree; applyChanges must not fabricate one.
    const lockfile = makeLockfile({
      'node_modules/bar': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/bar/-/bar-1.0.0.tgz'
      }
    });

    const result = await fixChecksums(lockfile, {
      fetchIntegrity: async () => REAL_HASH
    });

    expect(result.lockfile.dependencies).toBeUndefined();
    expect(result.lockfile.packages['node_modules/bar'].integrity).toBe(REAL_HASH);
  });

  it('#19: mixed partial-failure — successful hashes update both trees; unresolved entries corrupt neither', async () => {
    // A batch where some entries get fixed and some do not. Verify the two
    // lockfile sections stay consistent for the fixed subset, and unresolved
    // entries leave both sections unchanged.
    const lockfile = makeV2Lockfile(
      {
        'node_modules/ok': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/ok/-/ok-1.0.0.tgz'
        },
        'node_modules/fail': {
          version: '2.0.0',
          resolved: 'https://registry.npmjs.org/fail/-/fail-2.0.0.tgz'
        }
      },
      {
        ok: { version: '1.0.0', resolved: 'https://registry.npmjs.org/ok/-/ok-1.0.0.tgz' },
        fail: { version: '2.0.0', resolved: 'https://registry.npmjs.org/fail/-/fail-2.0.0.tgz' }
      }
    );

    const result = await fixChecksums(lockfile, {
      fetchIntegrity: async (name) => (name === 'ok' ? REAL_HASH : null)
    });

    expect(result.changes).toHaveLength(1);
    expect(result.unresolved).toHaveLength(1);

    // Fixed entry: both sections updated consistently.
    expect(result.lockfile.packages['node_modules/ok'].integrity).toBe(REAL_HASH);
    expect(result.lockfile.dependencies.ok.integrity).toBe(REAL_HASH);

    // Unresolved entry: neither section should have a spurious hash.
    expect(result.lockfile.packages['node_modules/fail'].integrity).toBeUndefined();
    expect(result.lockfile.dependencies.fail.integrity).toBeUndefined();
  });
});
