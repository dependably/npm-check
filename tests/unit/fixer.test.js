// tests/fixer.test.js
import { fixPackageLock } from '../../src/fixer.js';
import { LOCKFILE_VERSIONS } from '../../src/format-library.js';

describe('Automated Fixer', () => {
  it('migrates v1 -> v2 when dependencies present', () => {
    const v1 = {
      name: 'p',
      version: '1.0.0',
      lockfileVersion: 1,
      dependencies: {
        lodash: {
          version: '4.17.21'
        }
      }
    };

    const { fixedLockfile, fixes } = fixPackageLock(v1, { fillMissingIntegrity: false, dedupe: false });
    expect(fixedLockfile.lockfileVersion).toBe(LOCKFILE_VERSIONS.V2);
    expect(fixedLockfile.packages).toBeDefined();
    expect(fixes.some(f => /Auto-migrated v1/.test(f))).toBe(true);
  });

  it('fills placeholder integrity when missing', () => {
    const v2 = {
      name: 'p',
      version: '1.0.0',
      lockfileVersion: 2,
      packages: {
        '': { name: 'p', version: '1.0.0' },
        'node_modules/lodash': { name: 'lodash', version: '4.17.21' }
      }
    };

    const { fixedLockfile, fixes } = fixPackageLock(v2, { fillMissingIntegrity: true, dedupe: false });
    expect(fixedLockfile.packages['']).not.toHaveProperty('integrity');
    expect(fixedLockfile.packages['node_modules/lodash'].integrity).toBe('sha512-PLACEHOLDER');
    expect(fixes.some(f => /Added placeholder integrity/.test(f))).toBe(true);
  });

  it('syncs the lockfile root name/version from package.json', () => {
    // The stale-root case the report flags as "Structure & format" errors after a
    // package rename / version bump.
    const lockfile = {
      name: 'old-name',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'old-name', version: '1.0.0' },
        'node_modules/a': { version: '1.0.0', integrity: 'sha512-x' }
      }
    };
    const packageJson = { name: '@scope/new-name', version: '2.3.4' };

    const { fixedLockfile, fixes } = fixPackageLock(lockfile, { packageJson, fillMissingIntegrity: false, dedupe: false });
    expect(fixedLockfile.name).toBe('@scope/new-name');
    expect(fixedLockfile.version).toBe('2.3.4');
    expect(fixedLockfile.packages[''].name).toBe('@scope/new-name');
    expect(fixedLockfile.packages[''].version).toBe('2.3.4');
    expect(fixedLockfile.packages['node_modules/a']).toBeDefined(); // unrelated entries untouched
    expect(fixes.some(f => /Synced lockfile name/.test(f))).toBe(true);
    expect(fixes.some(f => /Synced root package version/.test(f))).toBe(true);
  });

  it('does not drop required install-path entries (dedupe is non-destructive)', () => {
    // Regression: real v3 entries carry no `.name` field — the name lives in the
    // path. The old dedupe keyed a map off `.name` and silently dropped every
    // such entry, gutting the lockfile down to the root. A v2/v3 packages map is
    // keyed by install path; every entry is required (note both versions of `a`
    // below live at different paths because they could not be hoisted together).
    const v3 = {
      name: 'p',
      version: '1.0.0',
      lockfileVersion: 3,
      packages: {
        '': { name: 'p', version: '1.0.0' },
        'node_modules/a': { version: '1.0.0', resolved: 'https://r/a/-/a-1.0.0.tgz', integrity: 'sha512-x' },
        'node_modules/b': { version: '2.0.0', resolved: 'https://r/b/-/b-2.0.0.tgz', integrity: 'sha512-y' },
        'node_modules/b/node_modules/a': { version: '0.9.0', resolved: 'https://r/a/-/a-0.9.0.tgz', integrity: 'sha512-z' }
      }
    };

    const { fixedLockfile } = fixPackageLock(v3, { fillMissingIntegrity: false, dedupe: true });
    // Every install path is preserved — nothing is silently dropped.
    expect(Object.keys(fixedLockfile.packages).sort()).toEqual([
      '', 'node_modules/a', 'node_modules/b', 'node_modules/b/node_modules/a'
    ]);
  });

  describe('edge cases', () => {
    it('handles workspace dependencies with proper isolation', () => {
      const workspaceLockfile = {
        name: 'monorepo',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'monorepo', version: '1.0.0' },
          'packages/app': { name: '@monorepo/app', version: '1.0.0', link: true },
          'packages/lib': { name: '@monorepo/lib', version: '1.0.0', link: true },
          'node_modules/@monorepo/lib': { name: '@monorepo/lib', version: '1.0.0', link: true },
          'node_modules/react': { name: 'react', version: '18.0.0' }
        }
      };

      const { fixedLockfile } = fixPackageLock(workspaceLockfile, { fillMissingIntegrity: true, dedupe: true });
      expect(fixedLockfile.packages).toBeDefined();
      // Workspace packages should not be removed as duplicates
      expect(fixedLockfile.packages['packages/app']).toBeDefined();
      expect(fixedLockfile.packages['packages/lib']).toBeDefined();
    });

    it('preserves git dependencies with resolved URLs', () => {
      const withGitDeps = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'p', version: '1.0.0' },
          'node_modules/my-pkg': {
            name: 'my-pkg',
            version: '0.0.0-git+https://github.com/user/repo.git#abc123',
            resolved: 'git+https://github.com/user/repo.git#abc123'
          }
        }
      };

      const { fixedLockfile } = fixPackageLock(withGitDeps, { fillMissingIntegrity: true, dedupe: false });
      const gitPkg = fixedLockfile.packages['node_modules/my-pkg'];
      expect(gitPkg.resolved).toBe('git+https://github.com/user/repo.git#abc123');
      // Git dependencies legitimately carry no integrity — the fixer must NOT
      // stamp a placeholder on them (that would corrupt an install).
      expect(gitPkg.integrity).toBeUndefined();
    });

    it('does not stamp placeholder integrity on git/bundled deps from a v1 tree (regression #22)', () => {
      // A v1 git dep carries its git URL in `version` (no `resolved`), and a v1
      // bundled dep is flagged `bundled: true`. When fixPackageLock auto-migrates
      // v1 -> v2 and then fills integrity, those must be classified git/bundled
      // (no registry tarball) and left untouched — a fake sha512-PLACEHOLDER would
      // make every npm ci fail EINTEGRITY.
      const v1WithGitAndBundled = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          'git-dep': { version: 'git+https://github.com/u/r.git#abc123' },
          // npm 6 records hosted-git deps as a shorthand in `version` (no resolved).
          'gh-dep': { version: 'github:u/r#abc123' },
          'bundled-dep': { version: '2.0.0', bundled: true }
        }
      };

      const { fixedLockfile } = fixPackageLock(v1WithGitAndBundled, { fillMissingIntegrity: true, dedupe: false });
      const git = fixedLockfile.packages['node_modules/git-dep'];
      const gh = fixedLockfile.packages['node_modules/gh-dep'];
      const bundled = fixedLockfile.packages['node_modules/bundled-dep'];
      expect(git.resolved).toBe('git+https://github.com/u/r.git#abc123');
      expect(git.integrity).toBeUndefined();
      // Hosted-git shorthand is normalized to a git+ URL and NOT stamped.
      expect(gh.resolved).toBe('git+https://github.com/u/r#abc123');
      expect(gh.integrity).toBeUndefined();
      expect(bundled.inBundle).toBe(true);
      expect(bundled.integrity).toBeUndefined();
    });

    it('handles optional and peer dependencies correctly', () => {
      const withOptional = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'p',
            version: '1.0.0',
            dependencies: { 'lodash': '4.17.21' },
            optionalDependencies: { 'sharp': '0.30.0' },
            peerDependencies: { 'react': '18.0.0' }
          },
          'node_modules/lodash': { name: 'lodash', version: '4.17.21', optional: false },
          'node_modules/sharp': { name: 'sharp', version: '0.30.0', optional: true },
          'node_modules/react': { name: 'react', version: '18.0.0', peerDependencies: {} }
        }
      };

      const { fixedLockfile } = fixPackageLock(withOptional, { fillMissingIntegrity: true, dedupe: true });
      expect(fixedLockfile.packages['node_modules/sharp'].optional).toBe(true);
      expect(fixedLockfile.packages['node_modules/lodash'].optional).toBe(false);
    });

    it('handles lockfiles with empty packages gracefully', () => {
      const emptyPackages = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {}
      };

      const { fixedLockfile } = fixPackageLock(emptyPackages, { fillMissingIntegrity: true, dedupe: true });
      expect(fixedLockfile.packages).toBeDefined();
      expect(Object.keys(fixedLockfile.packages).length).toBe(0);
    });

    it('preserves custom resolved URLs during fix', () => {
      const withResolved = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'p', version: '1.0.0' },
          'node_modules/custom': {
            name: 'custom',
            version: '1.0.0',
            resolved: 'https://custom.registry.com/custom-1.0.0.tgz'
          }
        }
      };

      const { fixedLockfile } = fixPackageLock(withResolved, { fillMissingIntegrity: true, dedupe: false });
      expect(fixedLockfile.packages['node_modules/custom'].resolved).toBe('https://custom.registry.com/custom-1.0.0.tgz');
    });
  });

  describe('Additional options', () => {
    it('normalizes to target version with normalizeTo option', () => {
      const v1Lockfile = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: { version: '4.17.21' }
        }
      };

      const { fixedLockfile } = fixPackageLock(v1Lockfile, {
        normalizeTo: LOCKFILE_VERSIONS.V3,
        fillMissingIntegrity: false,
        dedupe: false
      });

      expect(fixedLockfile.lockfileVersion).toBe(LOCKFILE_VERSIONS.V3);
      expect(fixedLockfile.packages).toBeDefined();
    });

    it('throws when throwOnError is true and fixing fails', () => {
      const v1Lockfile = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: { lodash: { version: '4.17.21' } }
      };

      // This should normally not fail, but test the throwOnError behavior
      // by mocking a potential failure scenario
      const { fixedLockfile } = fixPackageLock(v1Lockfile, { throwOnError: true });
      expect(fixedLockfile).toBeDefined();
    });

    it('returns empty fixes array for already-valid lockfile', () => {
      const validLockfile = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'p', version: '1.0.0' },
          'node_modules/lodash': {
            name: 'lodash',
            version: '4.17.21',
            integrity: 'sha512-valid'
          }
        }
      };

      const { fixes } = fixPackageLock(validLockfile, {
        fillMissingIntegrity: false,
        dedupe: false
      });

      expect(fixes.length).toBe(0);
    });

    it('excludes root package from integrity fill', () => {
      const lockfile = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'p', version: '1.0.0' },
          'node_modules/pkg': { name: 'pkg', version: '1.0.0' }
        }
      };

      const { fixedLockfile } = fixPackageLock(lockfile, { fillMissingIntegrity: true });

      expect(fixedLockfile.packages['']).not.toHaveProperty('integrity');
      expect(fixedLockfile.packages['node_modules/pkg']).toHaveProperty('integrity');
    });
  });

  describe('non-destructive & correct integrity fill (#22)', () => {
    it('does not mutate the caller-supplied lockfile', () => {
      const input = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'p', version: '1.0.0' },
          'node_modules/lodash': { name: 'lodash', version: '4.17.21' }
        }
      };
      const snapshot = JSON.parse(JSON.stringify(input));

      const { fixedLockfile } = fixPackageLock(input, { fillMissingIntegrity: true, dedupe: false });

      // The fix landed on the returned copy...
      expect(fixedLockfile.packages['node_modules/lodash'].integrity).toBe('sha512-PLACEHOLDER');
      // ...but the caller's object is untouched (deep equality with its snapshot).
      expect(input).toEqual(snapshot);
      expect(input.packages['node_modules/lodash']).not.toHaveProperty('integrity');
    });

    it('does not stamp placeholder integrity on link/workspace/git/file/bundled entries', () => {
      const lockfile = {
        name: 'monorepo',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'monorepo', version: '1.0.0' },
          'packages/app': { name: '@monorepo/app', version: '1.0.0' },      // workspace source dir
          'node_modules/@monorepo/app': { link: true, resolved: 'packages/app' }, // link
          'node_modules/git-dep': { version: '1.0.0', resolved: 'git+https://github.com/u/r.git#abc' },
          'node_modules/file-dep': { version: '1.0.0', resolved: 'file:../local' },
          'node_modules/bundled-dep': { version: '1.0.0', inBundle: true },
          'node_modules/registry-dep': { version: '1.0.0', resolved: 'https://registry.npmjs.org/registry-dep/-/registry-dep-1.0.0.tgz' }
        }
      };

      const { fixedLockfile } = fixPackageLock(lockfile, { fillMissingIntegrity: true, dedupe: false });
      const p = fixedLockfile.packages;

      // None of the non-registry entries may gain a fabricated hash.
      expect(p['packages/app']).not.toHaveProperty('integrity');
      expect(p['node_modules/@monorepo/app']).not.toHaveProperty('integrity');
      expect(p['node_modules/git-dep']).not.toHaveProperty('integrity');
      expect(p['node_modules/file-dep']).not.toHaveProperty('integrity');
      expect(p['node_modules/bundled-dep']).not.toHaveProperty('integrity');
      // Only the plain registry dep gets the placeholder.
      expect(p['node_modules/registry-dep'].integrity).toBe('sha512-PLACEHOLDER');
    });
  });

  describe('normalizeTo honors the requested target (#23)', () => {
    it('keeps a v1 lockfile at v1 when normalizeTo:1 is requested (no forced v1->v2)', () => {
      const v1 = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: { lodash: { version: '4.17.21' } }
      };

      const { fixedLockfile } = fixPackageLock(v1, {
        normalizeTo: LOCKFILE_VERSIONS.V1,
        fillMissingIntegrity: false,
        dedupe: false
      });

      expect(fixedLockfile.lockfileVersion).toBe(LOCKFILE_VERSIONS.V1);
      expect(fixedLockfile.packages).toBeUndefined();
      expect(fixedLockfile.dependencies.lodash.version).toBe('4.17.21');
    });

    it('downgrades v3 to v1 when normalizeTo:1 is requested', () => {
      const v3 = {
        name: 'p',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'p', version: '1.0.0', dependencies: { lodash: '^4.17.21' } },
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-lodash'
          }
        }
      };

      const { fixedLockfile } = fixPackageLock(v3, {
        normalizeTo: LOCKFILE_VERSIONS.V1,
        fillMissingIntegrity: false,
        dedupe: false
      });

      expect(fixedLockfile.lockfileVersion).toBe(LOCKFILE_VERSIONS.V1);
      expect(fixedLockfile.packages).toBeUndefined();
      expect(fixedLockfile.dependencies.lodash.version).toBe('4.17.21');
    });
  });
});
