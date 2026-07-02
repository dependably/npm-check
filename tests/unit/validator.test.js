// tests/validator.test.js
import fs from 'fs';
import { validatePackageLock } from '../../src/validator.js';
import { LOCKFILE_VERSIONS } from '../../src/format-library.js';

describe('Package Lockfile Validator', () => {
  let testLockfilePath;

  beforeEach(() => {
    // Create a temporary test lockfile for each test
    testLockfilePath = './test-package-lock.json';
  });

  afterEach(() => {
    // Clean up test file
    if (testLockfilePath && fs.existsSync(testLockfilePath)) {
      fs.unlinkSync(testLockfilePath);
    }
  });

  describe('Basic Validation', () => {
    it('should validate a valid v1 lockfile', () => {
      const lockfile = {
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

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(0);
      expect(result.info.version).toBe(LOCKFILE_VERSIONS.V1);
    });

    it('should detect invalid lockfile version', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 999, // Invalid version
        dependencies: {}
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'VERSION_MISMATCH')).toBe(true);
    });

    it('should validate a valid v2 lockfile', () => {
      const lockfile = {
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

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(true);
      expect(result.errors.length).toBe(0);
      expect(result.warnings.length).toBe(0);
      expect(result.info.version).toBe(LOCKFILE_VERSIONS.V2);
    });
  });

  describe('Error Handling', () => {
    it('should detect missing required fields', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1
        // Missing dependencies
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_DEPENDENCIES')).toBe(true);
    });

    it('should detect invalid package name', () => {
      const lockfile = {
        name: 123, // Invalid name
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {}
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_NAME')).toBe(true);
    });

    it('should detect invalid version format', () => {
      const lockfile = {
        name: 'test-project',
        version: 'invalid-version', // Invalid version
        lockfileVersion: 1,
        dependencies: {}
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_VERSION')).toBe(true);
    });
  });

  describe('Package Validation', () => {
    it('should validate package integrity', () => {
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
                integrity: 'invalid-integrity' // Invalid integrity
              }
            }
          }
        }
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'INVALID_INTEGRITY')).toBe(true);
    });

    it('should warn about missing integrity', () => {
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

      const result = validatePackageLock(lockfile, { allowMissingIntegrity: false });
      expect(result.valid).toBe(false);
      expect(result.warnings.some(w => w.code === 'MISSING_INTEGRITY')).toBe(true);
    });
  });

  describe('Dependency Validation', () => {
    it('should validate dependency tree', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            dependencies: {
              '>react-16.6.3 || >=17': 'true'
            }
          }
        }
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(true);
    });

    it('should detect invalid dependency structure', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 1,
        dependencies: {
          lodash: '4.17.21' // Missing required fields
        }
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_DEP_VERSION')).toBe(true);
    });
  });

  describe('Package JSON Validation', () => {
    it('should validate against package.json', () => {
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
                integrity: 'sha512-v2kDEe57lecTlla7BZWAYsPpsLvIqjIDxzSfAC2K+sRfoNy4donAyZLdOdFoMk6MvA5sUJu7S+3HYCBPAcfUbyw=='
              }
            }
          }
        }
      };

      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: {
          lodash: '4.17.21'
        }
      };

      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });
      expect(result.valid).toBe(true);
    });

    it('should detect missing dependencies in lockfile', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0'
            // Missing lodash dependency
          }
        }
      };

      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        dependencies: {
          lodash: '4.17.21'
        }
      };

      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });
      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_IN_LOCKFILE')).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('handles workspace packages with link flag', () => {
      const lockfile = {
        name: 'monorepo',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'monorepo', version: '1.0.0' },
          'packages/app': { name: '@org/app', version: '1.0.0', link: true },
          'packages/lib': { name: '@org/lib', version: '1.0.0', link: true }
        }
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(true);
    });

    it('handles git dependencies with resolved URLs', () => {
      const lockfile = {
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/git-pkg': {
            name: 'git-pkg',
            version: '0.0.0-git+https://github.com/user/repo.git#commit',
            resolved: 'git+https://github.com/user/repo.git#commit'
          }
        }
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(true);
    });

    it('handles optional dependencies correctly', () => {
      const lockfile = {
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test',
            version: '1.0.0',
            optionalDependencies: { sharp: '*' }
          },
          'node_modules/sharp': {
            name: 'sharp',
            version: '0.30.0',
            optional: true
          }
        }
      };

      const result = validatePackageLock(lockfile);
      // Should handle optional dependencies without crashing
      expect(result).toBeDefined();
    });

    it('handles peer dependencies with peerDependencies field', () => {
      const lockfile = {
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/react': {
            name: 'react',
            version: '18.0.0',
            peerDependencies: { 'react-dom': '18' }
          }
        }
      };

      const result = validatePackageLock(lockfile);
      // Should handle peer dependencies without crashing
      expect(result).toBeDefined();
    });

    it('handles bundled dependencies', () => {
      const lockfile = {
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test',
            version: '1.0.0',
            dependencies: { bundled: '*' }
          },
          'node_modules/bundled': {
            name: 'bundled',
            version: '1.0.0',
            bundled: true
          }
        }
      };

      const result = validatePackageLock(lockfile);
      // Should handle bundled dependencies without crashing
      expect(result).toBeDefined();
    });

    it('validates lockfile with multiple package scopes', () => {
      const lockfile = {
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 3,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/@org/pkg1': { name: '@org/pkg1', version: '1.0.0' },
          'node_modules/@org/pkg2': { name: '@org/pkg2', version: '2.0.0' },
          'node_modules/@other/pkg': { name: '@other/pkg', version: '1.5.0' }
        }
      };

      const result = validatePackageLock(lockfile);
      expect(result.valid).toBe(true);
    });

    it('handles missing integrity with allowMissingIntegrity option', () => {
      const lockfile = {
        name: 'test',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/pkg': { name: 'pkg', version: '1.0.0' }
        }
      };

      const result = validatePackageLock(lockfile, { allowMissingIntegrity: true });
      expect(result.valid).toBe(true);
    });

    it('should cause valid: false with strictMode when warnings present', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'test-project', version: '1.0.0' },
          'node_modules/pkg': {
            name: 'pkg',
            version: '1.0.0'
            // Missing integrity - will generate warning
          }
        }
      };

      const result = validatePackageLock(lockfile, {
        allowMissingIntegrity: false,
        strictMode: true
      });

      expect(result.valid).toBe(false);
      expect(result.warnings.length > 0).toBe(true);
    });

    it('should generate warning for invalid resolved URL', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': { name: 'test-project', version: '1.0.0' },
          'node_modules/pkg': {
            name: 'pkg',
            version: '1.0.0',
            resolved: 'not-a-valid-url'
          }
        }
      };

      const result = validatePackageLock(lockfile);

      expect(result.warnings.some(w => w.code === 'INVALID_RESOLVED')).toBe(true);
    });

    it('should detect missing devDependencies in lockfile', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0'
            // Missing jest devDependency
          }
        }
      };

      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        devDependencies: {
          jest: '27.0.0'
        }
      };

      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_DEV_IN_LOCKFILE')).toBe(true);
    });

    it('should detect missing optionalDependencies in lockfile', () => {
      const lockfile = {
        name: 'test-project',
        version: '1.0.0',
        lockfileVersion: 2,
        packages: {
          '': {
            name: 'test-project',
            version: '1.0.0'
            // Missing optional dependency
          }
        }
      };

      const packageJson = {
        name: 'test-project',
        version: '1.0.0',
        optionalDependencies: {
          'optional-pkg': '1.0.0'
        }
      };

      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.code === 'MISSING_OPT_IN_LOCKFILE')).toBe(true);
    });
  });

  describe('Regression: #21 – sha1/multi-hash integrity, non-string resolved, v1 package.json cross-check', () => {
    // Bug 1a: sha1 integrity was rejected as INVALID_INTEGRITY; now it is
    // accepted as structurally valid and emits a LEGACY_INTEGRITY warning instead.
    it('accepts sha1 integrity without an error and warns LEGACY_INTEGRITY', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/pkg': {
            name: 'pkg', version: '1.0.0',
            integrity: 'sha1-abc123def456abc123def456abc123def456abc1'
          }
        }
      };
      const result = validatePackageLock(lockfile);
      expect(result.errors.some(e => e.code === 'INVALID_INTEGRITY')).toBe(false);
      expect(result.warnings.some(w => w.code === 'LEGACY_INTEGRITY')).toBe(true);
    });

    // Bug 1b: sha1 integrity in the v1 dependencies tree was also rejected.
    it('accepts sha1 integrity in v1 dependencies tree without an error', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 1,
        dependencies: {
          lodash: {
            version: '4.17.21',
            integrity: 'sha1-FjMGeBqBuCoVBMYKNKDxwIvI5KA='
          }
        }
      };
      const result = validatePackageLock(lockfile);
      expect(result.errors.some(e => e.code === 'INVALID_INTEGRITY')).toBe(false);
      expect(result.warnings.some(w => w.code === 'LEGACY_INTEGRITY')).toBe(true);
    });

    // Bug 1c: multi-hash SRI strings ('sha512-... sha1-...') were rejected
    // because the old regex had no whitespace support.
    it('accepts multi-hash SRI integrity (sha512 + sha1) without an error', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/pkg': {
            name: 'pkg', version: '1.0.0',
            integrity: 'sha512-abc123XYZ= sha1-def456GHI='
          }
        }
      };
      const result = validatePackageLock(lockfile);
      // Multi-hash with sha1 token → no error; sha1 token triggers legacy warning
      expect(result.errors.some(e => e.code === 'INVALID_INTEGRITY')).toBe(false);
      expect(result.warnings.some(w => w.code === 'LEGACY_INTEGRITY')).toBe(true);
    });

    // Bug 1c (pure sha512 multi-hash): should produce no error and no legacy warning.
    it('accepts multi-hash SRI with only sha512 tokens and no legacy warning', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/pkg': {
            name: 'pkg', version: '1.0.0',
            integrity: 'sha512-aaaa= sha512-bbbb='
          }
        }
      };
      const result = validatePackageLock(lockfile);
      expect(result.errors.some(e => e.code === 'INVALID_INTEGRITY')).toBe(false);
      expect(result.warnings.some(w => w.code === 'LEGACY_INTEGRITY')).toBe(false);
    });

    // Bug 2: a non-string resolved value crashed with TypeError; now it emits
    // INVALID_RESOLVED without throwing.
    it('does not crash on numeric resolved and emits INVALID_RESOLVED warning', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/pkg': {
            name: 'pkg', version: '1.0.0',
            resolved: 42
          }
        }
      };
      expect(() => validatePackageLock(lockfile)).not.toThrow();
      const result = validatePackageLock(lockfile);
      expect(result.warnings.some(w => w.code === 'INVALID_RESOLVED')).toBe(true);
    });

    it('does not crash on object resolved value and emits INVALID_RESOLVED warning', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' },
          'node_modules/pkg': {
            name: 'pkg', version: '1.0.0',
            resolved: { url: 'https://example.com' }
          }
        }
      };
      expect(() => validatePackageLock(lockfile)).not.toThrow();
      const result = validatePackageLock(lockfile);
      expect(result.warnings.some(w => w.code === 'INVALID_RESOLVED')).toBe(true);
    });

    // Bug 3: validateAgainstPackageJson always returned false-missing for v1
    // lockfiles because packages[''] is absent, so every dep was flagged even
    // when it existed in the dependencies tree.
    it('v1 cross-check: does not false-report present deps as missing', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 1,
        dependencies: {
          lodash: { version: '4.17.21' },
          react: { version: '18.2.0' }
        }
      };
      const packageJson = {
        name: 'test', version: '1.0.0',
        dependencies: { lodash: '^4.0.0', react: '^18.0.0' }
      };
      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });
      expect(result.errors.some(e => e.code === 'MISSING_IN_LOCKFILE')).toBe(false);
    });

    it('v1 cross-check: correctly detects a dep missing from the tree', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 1,
        dependencies: {
          lodash: { version: '4.17.21' }
          // axios is absent
        }
      };
      const packageJson = {
        name: 'test', version: '1.0.0',
        dependencies: { lodash: '^4.0.0', axios: '^1.0.0' }
      };
      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });
      expect(result.errors.some(e => e.code === 'MISSING_IN_LOCKFILE' && e.message.includes('axios'))).toBe(true);
      expect(result.errors.some(e => e.code === 'MISSING_IN_LOCKFILE' && e.message.includes('lodash'))).toBe(false);
    });

    it('v1 cross-check: devDependencies are checked against the tree', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 1,
        dependencies: {
          jest: { version: '27.0.0' }
        }
      };
      const packageJson = {
        name: 'test', version: '1.0.0',
        devDependencies: { jest: '^27.0.0', missing: '^1.0.0' }
      };
      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });
      expect(result.errors.some(e => e.code === 'MISSING_DEV_IN_LOCKFILE' && e.message.includes('missing'))).toBe(true);
      expect(result.errors.some(e => e.code === 'MISSING_DEV_IN_LOCKFILE' && e.message.includes('jest'))).toBe(false);
    });

    // peerDependencies is now also cross-checked (both v1 and v2/v3 paths).
    it('v2 cross-check: peerDependencies are detected as missing', () => {
      const lockfile = {
        name: 'test', version: '1.0.0', lockfileVersion: 2,
        packages: {
          '': { name: 'test', version: '1.0.0' }
          // No peerDependencies on root entry
        }
      };
      const packageJson = {
        name: 'test', version: '1.0.0',
        peerDependencies: { react: '>=18' }
      };
      const result = validatePackageLock(lockfile, packageJson, { validateAgainstPackageJson: true });
      expect(result.errors.some(e => e.code === 'MISSING_PEER_IN_LOCKFILE')).toBe(true);
    });
  });
});
