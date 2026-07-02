// tests/migrator.test.js
import { migrateToVersion, PackageLockMigrator, MigrationError } from '../../src/migrator.js';
import { LOCKFILE_VERSIONS } from '../../src/format-library.js';

// A realistic v3 lockfile with a nested (shadowed) dependency so path-keyed
// entries and their reconstruction into a legacy tree are exercised.
function makeV3Lockfile() {
  return {
    name: 'test-project',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': {
        name: 'test-project',
        version: '1.0.0',
        dependencies: { chalk: '^4.1.2' },
        devDependencies: { jest: '^29.0.0' }
      },
      'node_modules/chalk': {
        version: '4.1.2',
        resolved: 'https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz',
        integrity: 'sha512-oKnbhFyRIXpUuez8iBMmyEa4nbj4IOQyuhc/wy9kY7/WVPcwIO9VA668Pu8RkO7+0G76SLROeyw9CpQ061i4mA==',
        dependencies: { 'ansi-styles': '^4.1.0' }
      },
      'node_modules/ansi-styles': {
        version: '4.3.0',
        resolved: 'https://registry.npmjs.org/ansi-styles/-/ansi-styles-4.3.0.tgz',
        integrity: 'sha512-zbB9rCJAT1rbjiVDb2hqKFHNYLxgtk8NURxZ3IZwD3F6NtxbXZQCnnSi1Lkx+IDohdPlFp222wVALIheZJQSEg=='
      },
      'node_modules/chalk/node_modules/ansi-styles': {
        version: '3.2.1',
        resolved: 'https://registry.npmjs.org/ansi-styles/-/ansi-styles-3.2.1.tgz',
        integrity: 'sha512-legacyhashvalueforansistylesthreeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee=='
      }
    }
  };
}

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
            integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
          }
        }
      };

      const result = migrateToVersion(v1Lockfile, LOCKFILE_VERSIONS.V2);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V2);
      // v2 is dual-format: packages map AND the legacy dependencies tree.
      expect(result.packages['']).toBeDefined();
      expect(result.packages['node_modules/lodash']).toBeDefined();
      expect(result.packages['node_modules/lodash'].version).toBe('4.17.21');
      expect(result.packages['node_modules/lodash'].integrity).toBe(v1Lockfile.dependencies.lodash.integrity);
      // Legacy tree preserved verbatim (v1 tree IS a valid v2 legacy tree).
      expect(result.dependencies.lodash.version).toBe('4.17.21');
    });

    it('should migrate from v2 to v3 (drops the legacy dependencies tree)', () => {
      const v2Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        requires: true,
        dependencies: {
          lodash: {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
          }
        },
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0',
            dependencies: { lodash: '^4.17.21' }
          },
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
          }
        }
      };

      const result = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V3);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V3);
      // v3 is packages-map ONLY: the legacy tree (and top-level requires) are gone.
      expect(result.dependencies).toBeUndefined();
      expect(result.requires).toBeUndefined();
      // The root '' entry and every resolution must survive.
      expect(result.packages['']).toBeDefined();
      expect(result.packages[''].dependencies).toEqual({ lodash: '^4.17.21' });
      expect(result.packages['node_modules/lodash'].integrity).toBe(v2Lockfile.packages['node_modules/lodash'].integrity);
      expect(Object.keys(result.packages).sort()).toEqual(['', 'node_modules/lodash']);
    });

    it('should migrate from v3 to v2 (reconstructs a resolution-object tree)', () => {
      const v3Lockfile = makeV3Lockfile();

      const result = migrateToVersion(v3Lockfile, LOCKFILE_VERSIONS.V2);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V2);
      expect(result.requires).toBe(true);
      // packages map preserved verbatim (incl. root and nested shadow).
      expect(Object.keys(result.packages).sort()).toEqual([
        '', 'node_modules/ansi-styles', 'node_modules/chalk', 'node_modules/chalk/node_modules/ansi-styles'
      ]);
      // Legacy tree nodes are resolution objects, not range strings.
      expect(result.dependencies.chalk.version).toBe('4.1.2');
      expect(result.dependencies.chalk.resolved).toBe('https://registry.npmjs.org/chalk/-/chalk-4.1.2.tgz');
      expect(result.dependencies.chalk.integrity).toBe(v3Lockfile.packages['node_modules/chalk'].integrity);
      // `requires` carries the range map from the entry's dependencies.
      expect(result.dependencies.chalk.requires).toEqual({ 'ansi-styles': '^4.1.0' });
      // Nested (shadowed) dependency lands under its parent, not at the top level.
      expect(result.dependencies.chalk.dependencies['ansi-styles'].version).toBe('3.2.1');
      expect(result.dependencies['ansi-styles'].version).toBe('4.3.0');
    });
  });

  describe('Round-trip invariants', () => {
    it('v3 -> v2 -> v3 preserves the packages map (lossless)', () => {
      const v3 = makeV3Lockfile();
      const back = migrateToVersion(migrateToVersion(v3, LOCKFILE_VERSIONS.V2), LOCKFILE_VERSIONS.V3);

      expect(back.lockfileVersion).toBe(LOCKFILE_VERSIONS.V3);
      expect(back.dependencies).toBeUndefined();
      expect(back.packages).toEqual(v3.packages);
    });

    it('v2 -> v3 -> v2 preserves the packages map', () => {
      const v3 = makeV3Lockfile();
      const v2 = migrateToVersion(v3, LOCKFILE_VERSIONS.V2);
      const back = migrateToVersion(migrateToVersion(v2, LOCKFILE_VERSIONS.V3), LOCKFILE_VERSIONS.V2);

      expect(back.lockfileVersion).toBe(LOCKFILE_VERSIONS.V2);
      expect(back.packages).toEqual(v2.packages);
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

    it('should support v1 to v3 (multi-step via v2)', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {}
      };

      // v1 -> v3 goes through v2 and must not throw.
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

    it('should handle complex (nested) dependency trees on v1 -> v2', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-toplodash',
            requires: { 'nested-dep': '^1.0.0' },
            dependencies: {
              'nested-dep': {
                version: '1.0.0',
                resolved: 'https://registry.npmjs.org/nested-dep/-/nested-dep-1.0.0.tgz',
                integrity: 'sha512-nested'
              }
            }
          }
        }
      };

      const result = migrateToVersion(v1Lockfile, LOCKFILE_VERSIONS.V2);

      // Both the top-level and nested resolutions get path-keyed entries.
      expect(result.packages['node_modules/lodash'].version).toBe('4.17.21');
      expect(result.packages['node_modules/lodash'].dependencies).toEqual({ 'nested-dep': '^1.0.0' });
      expect(result.packages['node_modules/lodash/node_modules/nested-dep'].version).toBe('1.0.0');
      expect(result.packages['node_modules/lodash/node_modules/nested-dep'].integrity).toBe('sha512-nested');
    });

    it('should support downgrading v3 to v1 (documented legacy-compat path)', () => {
      const v3Lockfile = makeV3Lockfile();

      const result = migrateToVersion(v3Lockfile, LOCKFILE_VERSIONS.V1);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V1);
      // v1 is dependencies-tree only — no packages map, no top-level requires.
      expect(result.packages).toBeUndefined();
      expect(result.requires).toBeUndefined();
      expect(result.dependencies.chalk.version).toBe('4.1.2');
      expect(result.dependencies.chalk.integrity).toBe(v3Lockfile.packages['node_modules/chalk'].integrity);
    });

    it('should support downgrading v2 to v1 (keeps the legacy tree)', () => {
      const v2Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        requires: true,
        dependencies: {
          lodash: {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-lodashhash'
          }
        },
        packages: {
          '': { name: 'test-project', version: '1.0.0', dependencies: { lodash: '^4.17.21' } },
          'node_modules/lodash': {
            version: '4.17.21',
            resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz',
            integrity: 'sha512-lodashhash'
          }
        }
      };

      const result = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V1);
      expect(result.lockfileVersion).toBe(LOCKFILE_VERSIONS.V1);
      expect(result.packages).toBeUndefined();
      // The existing legacy tree is kept as-is.
      expect(result.dependencies).toEqual(v2Lockfile.dependencies);
    });

    it('should build packages-map entries carrying resolution data on v1 -> v2', () => {
      const v1Lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          express: {
            version: '4.18.0',
            resolved: 'https://registry.npmjs.org/express/-/express-4.18.0.tgz',
            integrity: 'sha512-abc123'
          }
        }
      };

      const result = migrateToVersion(v1Lockfile, LOCKFILE_VERSIONS.V2);

      // Regression for #8: the whole v1 tree must NOT be crammed into
      // packages[''].dependencies as objects. Each resolution becomes its own
      // path-keyed entry, and the root's dependencies are range strings.
      expect(result.packages['']).toBeDefined();
      expect(result.packages[''].dependencies.express).toBe('4.18.0');
      expect(result.packages['node_modules/express']).toBeDefined();
      expect(result.packages['node_modules/express'].version).toBe('4.18.0');
      expect(result.packages['node_modules/express'].resolved).toBe('https://registry.npmjs.org/express/-/express-4.18.0.tgz');
      expect(result.packages['node_modules/express'].integrity).toBe('sha512-abc123');
    });

    it('should preserve workspace/link entries during v2 to v3 migration', () => {
      const v2Lockfile = {
        name: 'monorepo',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'monorepo', version: '1.0.0' },
          'packages/app': { name: '@monorepo/app', version: '1.0.0', link: true },
          'node_modules/lodash': { name: 'lodash', version: '4.17.21' }
        }
      };

      const result = migrateToVersion(v2Lockfile, LOCKFILE_VERSIONS.V3);

      expect(result.packages['']).toBeDefined();
      expect(result.packages['packages/app']).toBeDefined();
      expect(result.packages['packages/app'].link).toBe(true);
      expect(result.packages['node_modules/lodash']).toBeDefined();
      // Workspace source dirs must NOT leak into a reconstructed legacy tree.
      expect(result.dependencies).toBeUndefined();
    });
  });
});
