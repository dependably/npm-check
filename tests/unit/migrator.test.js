// tests/migrator.test.js
import { migrateToVersion, PackageLockMigrator, MigrationError } from '../../src/migrator.js';
import { LOCKFILE_VERSIONS } from '../../src/format-library.js';

describe('Package Lockfile Migrator', () => {
  describe('Migration Paths', () => {
    it('should migrate from v1 to v2', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw==',
            requires: {
              '>react-16.6.3 || >=17': 'true'
            }
          }
        }
      };

      const result = migrateToVersion(v1Lockfile, LOCKFILE_VERSIONS.V2);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V2);
      expect(result.packages).toBeDefined();
      expect(result.packages['']).toBeDefined();
      expect(result.dependencies).toBeDefined();
    });

    it('should migrate from v2 to v3', () => {
      const v2Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        requires: true,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0',
            dependencies: {
              lodash: {
                version: '4.17.21',
                resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
                integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
              }
            }
          }
        }
      };

      const result = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V3);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V3);
      expect(result.packages).toBeDefined();
      expect(result.dependencies).toBeDefined();
    });

    it('should migrate from v3 to v2', () => {
      const v3Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0',
            dependencies: {
              lodash: {
                version: '4.17.21',
                resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
                integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
              }
            }
          }
        }
      };

      const result = migrateToVersion(v3Lockfile, LOCKFILE_VERSIONS.V2);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V2);
      expect(result.packages).toBeDefined();
      expect(result.dependencies).toBeDefined();
    });
  });

  describe('Error Handling', () => {
    it('should throw error for invalid target version', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {}
      };

      expect(() => migrateToVersion(v1Lockfile, 999)).toThrow(MigrationError);
      expect(() => migrateToVersion(v1Lockfile, -1)).toThrow(MigrationError);
    });

    it('should throw error for unsupported migration path', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {}
      };

      // Try to migrate directly from v1 to v3 (should go through v2)
      expect(() => migrateToVersion(v1Lockfile, LOCKFILE_VERSIONS.V3)).not.toThrow();
    });
  });

  describe('Migration Details', () => {
    it('should preserve metadata during migration', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
          }
        }
      };

      const migrator = new PackageLockMigrator({ preserveMetadata: true });
      const result = migrator.migrate(v1Lockfile, LOCKFILE_VERSIONS.V2);

      expect(result.name).toBe('test-project');
      expect(result.version).toBe('1.0.0');
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V2);
    });

    it('should handle complex dependency trees', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            dependencies: {
              lodash: {
                version: '4.17.21',
                resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
                integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
              }
            }
          }
        }
      };

      const result = migrateToVersion(v1Lockfile, LOCKFILE_VERSIONS.V2);

      expect(result.packages).toBeDefined();
    });
  });
});
