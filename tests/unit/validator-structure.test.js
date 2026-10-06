// tests/unit/validator-structure.test.js
// Structural error codes of validatePackageLock: malformed root fields,
// malformed v1 dependency entries and malformed packages-map entries.
import { validatePackageLock } from '../../src/validator.js';

const codes = (list) => list.map((e) => e.code);
const SHA512 = 'sha512-' + 'A'.repeat(86) + '==';

function v3(packages) {
  return { name: 'app', version: '1.0.0', lockfileVersion: 3, packages: { '': { name: 'app', version: '1.0.0' }, ...packages } };
}
function v1(dependencies) {
  return { name: 'app', version: '1.0.0', lockfileVersion: 1, dependencies };
}

describe('validatePackageLock structure', () => {
  it('accepts well formed v1 and v3 lockfiles', () => {
    expect(validatePackageLock(v3({ 'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz', integrity: SHA512 } }))).toMatchObject({ valid: true, errors: [], warnings: [] });
    expect(validatePackageLock(v1({ a: { version: '1.0.0', integrity: SHA512, requires: { b: '^1.0.0' } } }))).toMatchObject({ valid: true, errors: [] });
  });

  it('reports a missing packages map on a v3 lockfile', () => {
    const r = validatePackageLock({ name: 'app', version: '1.0.0', lockfileVersion: 3 });
    expect(r.valid).toBe(false);
    expect(codes(r.errors)).toContain('MISSING_PACKAGES_MAP');
  });

  it('reports a missing dependencies tree on a v1 lockfile', () => {
    const r = validatePackageLock({ name: 'app', version: '1.0.0', lockfileVersion: 1 });
    expect(codes(r.errors)).toContain('MISSING_DEPENDENCIES');
  });

  it('reports a root version that is not major.minor.patch', () => {
    const r = validatePackageLock({ ...v3({}), version: '1.0' });
    expect(codes(r.errors)).toEqual(['INVALID_VERSION']);
  });

  it('reports v1 dependency entries that are null, arrays, numbers, bare strings or versionless', () => {
    const r = validatePackageLock(v1({
      nulled: null,
      listed: ['1.0.0'],
      numbered: 7,
      bare: '1.0.0',
      versionless: { resolved: 'https://registry.npmjs.org/x/-/x-1.0.0.tgz' },
      fine: { version: '1.0.0' }
    }));
    expect(r.valid).toBe(false);
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([
      ['INVALID_DEPENDENCY', 'Dependency nulled is not an object'],
      ['INVALID_DEPENDENCY', 'Dependency listed is not an object'],
      ['INVALID_DEPENDENCY', 'Dependency numbered is not an object'],
      ['MISSING_DEP_VERSION', 'Missing or invalid version for bare'],
      ['MISSING_DEP_VERSION', 'Missing or invalid version for versionless']
    ]);
  });

  it('reports packages-map entries that are not objects, or lack a name (root) or version', () => {
    const r = validatePackageLock({
      name: 'app', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { version: '1.0.0' },
        'node_modules/scalar': 'oops',
        'node_modules/versionless': { resolved: 'https://registry.npmjs.org/v/-/v-1.0.0.tgz' },
        'node_modules/linked': { link: true, resolved: 'packages/linked' }
      }
    });
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([
      ['INVALID_PACKAGE_NAME', 'Missing or invalid name for package at '],
      ['INVALID_PACKAGE', 'Package at node_modules/scalar is not an object'],
      ['INVALID_PACKAGE_VERSION', 'Missing or invalid version for package at node_modules/versionless']
    ]);
  });

  it('reports a malformed integrity as an error and a non URL resolved value as a warning', () => {
    const r = validatePackageLock(v3({
      'node_modules/bad-hash': { version: '1.0.0', integrity: 'md5-abc' },
      'node_modules/bad-url': { version: '1.0.0', integrity: SHA512, resolved: 42 },
      'node_modules/odd-scheme': { version: '1.0.0', integrity: SHA512, resolved: 'ftp://example.test/x.tgz' }
    }));
    expect(r.errors.map((e) => [e.code, e.message])).toEqual([['INVALID_INTEGRITY', 'Invalid integrity hash for package at node_modules/bad-hash']]);
    expect(r.warnings).toEqual([
      { code: 'INVALID_RESOLVED', message: 'Invalid resolved URL for package at node_modules/bad-url: 42' },
      { code: 'INVALID_RESOLVED', message: 'Invalid resolved URL for package at node_modules/odd-scheme: ftp://example.test/x.tgz' }
    ]);
  });

  it('takes an options object in the packageJson position', () => {
    const lockfile = v3({ 'node_modules/a': { version: '1.0.0' } });
    expect(validatePackageLock(lockfile).valid).toBe(true);
    const r = validatePackageLock(lockfile, { allowMissingIntegrity: false });
    expect(r.valid).toBe(false);
    expect(codes(r.errors)).toContain('MISSING_INTEGRITY');
    expect(codes(r.warnings)).toContain('MISSING_INTEGRITY');
  });
});
