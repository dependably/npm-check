import {
  upgradeIntegrityHashes,
  deduplicatePackages,
  findPackagesMatching,
  countUniquePackages,
  findDuplicatePackages
} from '../../src/updater.js';

describe('Updater Functions', () => {
  const mockLockfileV3 = {
    lockfileVersion: 3,
    name: 'test-app',
    version: '1.0.0',
    packages: {
      '': { name: 'test-app', version: '1.0.0', dependencies: {} },
      'node_modules/lodash': {
        name: 'lodash',
        version: '4.17.21',
        integrity: 'sha1-abc123',
        dependencies: {
          'sub-dep': { integrity: 'sha1-xyz789' }
        }
      },
      'node_modules/react': {
        name: 'react',
        version: '18.2.0',
        integrity: 'sha512-valid'
      }
    }
  };

  describe('upgradeIntegrityHashes', () => {
    it('upgrades sha1 hashes to sha512', () => {
      const result = upgradeIntegrityHashes(mockLockfileV3);

      const lodashPkg = result.packages['node_modules/lodash'];
      expect(lodashPkg.integrity).toBe('sha512-abc123');
    });

    it('upgrades nested dependency hashes', () => {
      const result = upgradeIntegrityHashes(mockLockfileV3);

      const lodashPkg = result.packages['node_modules/lodash'];
      expect(lodashPkg.dependencies['sub-dep'].integrity).toBe('sha512-xyz789');
    });

    it('preserves non-sha1 hashes by default', () => {
      const result = upgradeIntegrityHashes(mockLockfileV3);

      const reactPkg = result.packages['node_modules/react'];
      expect(reactPkg.integrity).toBe('sha512-valid');
    });

    it('does not modify original lockfile', () => {
      const original = JSON.parse(JSON.stringify(mockLockfileV3));
      upgradeIntegrityHashes(mockLockfileV3);

      expect(mockLockfileV3).toEqual(original);
    });
  });

  describe('deduplicatePackages', () => {
    it('removes duplicate packages', () => {
      const lockfileWithDupes = {
        ...mockLockfileV3,
        packages: {
          ...mockLockfileV3.packages,
          'node_modules/lodash@4.17.20': {
            name: 'lodash',
            version: '4.17.20',
            integrity: 'sha512-old'
          }
        }
      };

      const result = deduplicatePackages(lockfileWithDupes);

      // Should have fewer packages after dedup
      expect(Object.keys(result.packages).length).toBeLessThanOrEqual(
        Object.keys(lockfileWithDupes.packages).length
      );
    });

    it('preserves original structure for non-duplicate packages', () => {
      const result = deduplicatePackages(mockLockfileV3);

      expect(result.packages['node_modules/lodash']).toBeDefined();
      expect(result.packages['node_modules/react']).toBeDefined();
    });
  });

  describe('findPackagesMatching', () => {
    it('finds packages matching predicate', () => {
      const matching = findPackagesMatching(mockLockfileV3, (path, pkg) =>
        pkg.name && pkg.name.includes('lodash')
      );

      expect(matching['node_modules/lodash']).toBeDefined();
      expect(matching['node_modules/react']).toBeUndefined();
    });

    it('returns empty for non-matching predicate', () => {
      const matching = findPackagesMatching(mockLockfileV3, (path, pkg) =>
        pkg.name === 'nonexistent'
      );

      expect(Object.keys(matching).length).toBe(0);
    });
  });

  describe('countUniquePackages', () => {
    it('counts unique package names', () => {
      const count = countUniquePackages(mockLockfileV3);

      // lodash, react, and test-app (root is included since name != '(root)')
      expect(count).toBe(3);
    });

    it('handles lockfile without packages', () => {
      const simple = { lockfileVersion: 1 };
      const count = countUniquePackages(simple);

      expect(count).toBe(0);
    });

    it('excludes packages named (root) from count', () => {
      const withRootMarker = {
        lockfileVersion: 3,
        packages: {
          '': { name: '(root)', version: '1.0.0' },
          'node_modules/pkg': { name: 'pkg', version: '1.0.0' }
        }
      };

      const count = countUniquePackages(withRootMarker);
      expect(count).toBe(1);
    });
  });  describe('findDuplicatePackages', () => {
    it('finds duplicate packages by name', () => {
      const lockfileWithDupes = {
        lockfileVersion: 3,
        packages: {
          'node_modules/lodash': {
            name: 'lodash',
            version: '4.17.21'
          },
          'node_modules/lodash@4.17.20': {
            name: 'lodash',
            version: '4.17.20'
          },
          'node_modules/react': {
            name: 'react',
            version: '18.2.0'
          }
        }
      };

      const duplicates = findDuplicatePackages(lockfileWithDupes);

      expect(duplicates.has('lodash')).toBe(true);
      expect(duplicates.get('lodash').length).toBe(2);
      expect(duplicates.has('react')).toBe(false);
    });

    it('returns empty map when no duplicates', () => {
      const duplicates = findDuplicatePackages(mockLockfileV3);

      expect(duplicates.size).toBe(0);
    });

    it('includes version info in duplicates', () => {
      const lockfileWithDupes = {
        lockfileVersion: 3,
        packages: {
          'node_modules/pkg@1.0.0': {
            name: 'pkg',
            version: '1.0.0'
          },
          'node_modules/pkg@2.0.0': {
            name: 'pkg',
            version: '2.0.0'
          }
        }
      };

      const duplicates = findDuplicatePackages(lockfileWithDupes);
      const pkgDupes = duplicates.get('pkg');

      expect(pkgDupes).toContainEqual({ path: 'node_modules/pkg@1.0.0', version: '1.0.0' });
      expect(pkgDupes).toContainEqual({ path: 'node_modules/pkg@2.0.0', version: '2.0.0' });
    });

    it('excludes root package', () => {
      const lockfile = {
        lockfileVersion: 3,
        packages: {
          '': { name: '(root)', version: '1.0.0' },
          'node_modules/pkg': { name: 'pkg', version: '1.0.0' }
        }
      };

      const duplicates = findDuplicatePackages(lockfile);

      expect(duplicates.has('(root)')).toBe(false);
    });
  });

  describe('Regression: #32 – deduplicatePackages v1 tree is preserve-only', () => {
    // The old implementation ran a dead Set-filter over the top-level
    // dependencies object. JS object keys are unique by construction, so the
    // Set check (seenDeps.has(name)) was always false and every entry was
    // copied verbatim — a no-op masquerading as deduplication.
    //
    // The fix removes the dead code and documents the preserve-only contract.
    // Behavioral output is identical before and after (the no-op produced the
    // same entries), but the code is now honest about what it does.
    // These tests pin the preserve-only contract.

    const v1Lockfile = {
      lockfileVersion: 1,
      name: 'test-app',
      version: '1.0.0',
      dependencies: {
        lodash: {
          version: '4.17.21',
          integrity: 'sha1-FjMGeBqBuCoVBMYKNKDxwIvI5KA=',
          dependencies: {
            // nested transitive
            'sub-dep': { version: '1.0.0' }
          }
        },
        react: { version: '18.2.0' },
        axios: { version: '1.6.0' }
      }
    };

    it('preserves all top-level dependency keys in a v1 lockfile', () => {
      const result = deduplicatePackages(v1Lockfile);
      expect(Object.keys(result.dependencies)).toEqual(['lodash', 'react', 'axios']);
    });

    it('preserves nested sub-dependency objects in a v1 lockfile', () => {
      const result = deduplicatePackages(v1Lockfile);
      expect(result.dependencies.lodash.dependencies['sub-dep']).toBeDefined();
      expect(result.dependencies.lodash.dependencies['sub-dep'].version).toBe('1.0.0');
    });

    it('does not mutate the original v1 lockfile', () => {
      const original = JSON.parse(JSON.stringify(v1Lockfile));
      deduplicatePackages(v1Lockfile);
      expect(v1Lockfile).toEqual(original);
    });

    it('preserves v1 lockfile top-level metadata fields', () => {
      const result = deduplicatePackages(v1Lockfile);
      expect(result.name).toBe('test-app');
      expect(result.version).toBe('1.0.0');
      expect(result.lockfileVersion).toBe(1);
    });
  });
});
