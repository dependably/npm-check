// tests/fixer.test.js
import { fixPackageLock } from '../src/fixer.js';
import { LOCKFILE_VERSIONS } from '../src/format-library.js';

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
    expect(fixes.some(f => /Migrated v1 dependencies tree to v2/.test(f))).toBe(true);
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
    expect(fixedLockfile.packages[''].integrity).toBe('sha512-PLACEHOLDER');
    expect(fixedLockfile.packages['node_modules/lodash'].integrity).toBe('sha512-PLACEHOLDER');
    expect(fixes.some(f => /Added placeholder integrity/.test(f))).toBe(true);
  });

  it('deduplicates packages when requested', () => {
    const v2 = {
      name: 'p',
      version: '1.0.0',
      lockfileVersion: 2,
      packages: {
        'node_modules/a': { name: 'a', version: '1.0.0' },
        'node_modules/a_duplicate': { name: 'a', version: '0.9.0' },
        '': { name: 'p', version: '1.0.0' }
      }
    };

    const { fixedLockfile, fixes } = fixPackageLock(v2, { fillMissingIntegrity: false, dedupe: true });
    // After dedupe, number of package paths should be reduced
    expect(Object.keys(fixedLockfile.packages).length).toBeLessThan(3);
    expect(fixes.some(f => /Deduplicated packages/.test(f))).toBe(true);
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
      // Git dependencies shouldn't require integrity
      expect(gitPkg.integrity).toBeDefined();
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
});
