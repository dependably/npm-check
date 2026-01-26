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
    expect(fixedLockfile.packages[''].integrity).toBe('sha256-PLACEHOLDER');
    expect(fixedLockfile.packages['node_modules/lodash'].integrity).toBe('sha256-PLACEHOLDER');
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
});
