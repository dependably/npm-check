// tests/updater.test.js
import { upgradeIntegrityHashes, deduplicatePackages } from '../src/updater.js';
import { LOCKFILE_VERSIONS } from '../src/format-library.js';

describe('Package Lockfile Updater', () => {
  describe('upgradeIntegrityHashes', () => {
    it('should upgrade sha1 hashes to sha256', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0',
            dependencies: {
              lodash: {
                version: '4.17.21',
                integrity: 'sha1-abc123...' // Mock sha1 hash
              }
            }
          }
        }
      };

      const result = upgradeIntegrityHashes(lockfile);
      expect(result.packages[''].dependencies.lodash.integrity).toMatch(/^sha256-/);
    });

    it('should not modify valid sha256 hashes', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0',
            dependencies: {
              lodash: {
                version: '4.17.21',
                integrity: 'sha256-abc123...' // Valid sha256 hash
              }
            }
          }
        }
      };

      const originalHash = lockfile.packages[''].dependencies.lodash.integrity;
      const result = upgradeIntegrityHashes(lockfile);
      expect(result.packages[''].dependencies.lodash.integrity).toBe(originalHash);
    });

    it('should process nested dependencies', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0',
            dependencies: {
              lodash: {
                version: '4.17.21',
                integrity: 'sha1-abc123...',
                dependencies: {
                  '>react-16.6.3 || >=17': {
                    version: '16.13.1',
                    integrity: 'sha1-def456...'
                  }
                }
              }
            }
          }
        }
      };

      const result = upgradeIntegrityHashes(lockfile);
      expect(result.packages[''].dependencies.lodash.integrity).toMatch(/^sha256-/);
      expect(result.packages[''].dependencies.lodash.dependencies['>react-16.6.3 || >=17'].integrity).toMatch(/^sha256-/);
    });

    it('should handle missing integrity hashes', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0',
            dependencies: {
              lodash: {
                version: '4.17.21'
                // Missing integrity
              }
            }
          }
        }
      };

      const result = upgradeIntegrityHashes(lockfile);
      expect(result.packages[''].dependencies.lodash.integrity).toBeUndefined();
    });
  });

  describe('deduplicatePackages', () => {
    it('should deduplicate packages in packages map', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0'
          },
          'node_modules/lodash': {
            name: 'lodash',
            version: '4.17.21'
          },
          'node_modules/react': {
            name: 'react',
            version: '16.13.1'
          },
          'node_modules/lodash': { // Duplicate entry
            name: 'lodash',
            version: '4.17.21'
          }
        }
      };

      const result = deduplicatePackages(lockfile);
      expect(Object.keys(result.packages).length).toBe(3); // Should have 3 unique entries
      expect(result.packages['node_modules/lodash']).toBeDefined();
    });

    it('should keep latest version by default', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0'
          },
          'node_modules/lodash': {
            name: 'lodash',
            version: '4.17.21'
          },
          'node_modules/react': {
            name: 'react',
            version: '16.13.1'
          },
          'node_modules/lodash': { // Duplicate entry
            name: 'lodash',
            version: '4.18.0'
          }
        }
      };

      const result = deduplicatePackages(lockfile, { keepLatest: true });
      expect(result.packages['node_modules/lodash'].version).toBe('4.18.0');
    });

    it('should deduplicate dependencies tree', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            dependencies: {
              lodash: {
                version: '4.17.21'
              }
            }
          },
          lodash: {
            version: '4.17.21'
          }
        }
      };

      const result = deduplicatePackages(lockfile);
      expect(Object.keys(result.dependencies).length).toBe(1);
    });
  });
});
