// tests/validator.test.js
import { readFileSync } from 'fs';
import fs from 'fs';
import { validatePackageLock, ValidationError } from '../src/validator.js';
import { parseLockfile } from '../src/parser.js';
import { LOCKFILE_VERSIONS } from '../src/format-library.js';

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
});
