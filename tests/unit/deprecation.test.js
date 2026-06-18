// tests/unit/deprecation.test.js
import { checkDeprecations, DeprecationError } from '../../src/deprecation.js';

const HASH_A = 'sha512-' + 'A'.repeat(86) + '==';

// Injectable fetcher: returns a manifest with `deprecated` set for any name@version
// present in `table` (keyed by name), null for names mapped to null, {} otherwise.
const fakeManifests = (table) => (name, version) => {
  if (!(name in table)) return Promise.resolve({}); // exists, not deprecated
  const value = table[name];
  if (value === null) return Promise.resolve(null); // 404 / not found
  return Promise.resolve({ name, version, deprecated: value });
};

function lockfileWith(pkgs) {
  return {
    name: 'demo', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'demo', version: '1.0.0' }, ...pkgs }
  };
}

const reg = 'https://registry.npmjs.org';
function pkg(name, version = '1.0.0', extra = {}) {
  return {
    [`node_modules/${name}`]: {
      version,
      resolved: `${reg}/${name}/-/${name}-${version}.tgz`,
      integrity: HASH_A,
      ...extra
    }
  };
}

describe('checkDeprecations', () => {
  it('flags a deprecated package as a warning by default (does not fail the run)', async () => {
    const lockfile = lockfileWith(pkg('old'));
    const result = await checkDeprecations(lockfile, {
      fetchManifest: fakeManifests({ old: 'use new-pkg instead' })
    });
    expect(result.valid).toBe(true);
    expect(result.deprecated).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].package).toBe('old');
    expect(result.warnings[0].message).toBe('use new-pkg instead');
    expect(result.errors).toHaveLength(0);
  });

  it('fails the run when failOnDeprecated is set', async () => {
    const lockfile = lockfileWith(pkg('old'));
    const result = await checkDeprecations(lockfile, {
      failOnDeprecated: true,
      fetchManifest: fakeManifests({ old: 'deprecated' })
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('reports a clean package with no deprecation notice', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkDeprecations(lockfile, { fetchManifest: fakeManifests({}) });
    expect(result.valid).toBe(true);
    expect(result.clean).toBe(1);
    expect(result.deprecated).toBe(0);
  });

  it('treats an empty-string deprecated field as not deprecated', async () => {
    const lockfile = lockfileWith(pkg('undeprecated'));
    const result = await checkDeprecations(lockfile, {
      fetchManifest: fakeManifests({ undeprecated: '' })
    });
    expect(result.deprecated).toBe(0);
    expect(result.clean).toBe(1);
  });

  it('treats a bare `true` deprecated field as deprecated with a generic message', async () => {
    const lockfile = lockfileWith(pkg('old'));
    const result = await checkDeprecations(lockfile, {
      fetchManifest: fakeManifests({ old: true })
    });
    expect(result.deprecated).toBe(1);
    expect(result.warnings[0].message).toBe('deprecated');
  });

  it('marks packages unresolved (non-fatal) when the registry 404s', async () => {
    const lockfile = lockfileWith(pkg('gone'));
    const result = await checkDeprecations(lockfile, {
      fetchManifest: fakeManifests({ gone: null })
    });
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedItems[0].reason).toMatch(/no manifest/);
  });

  it('fails closed on unresolved when failOnUnresolved is set', async () => {
    const lockfile = lockfileWith(pkg('gone'));
    const result = await checkDeprecations(lockfile, {
      failOnUnresolved: true, fetchManifest: fakeManifests({ gone: null })
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('treats a network error as unresolved (not failed) by default', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkDeprecations(lockfile, {
      fetchManifest: () => Promise.reject(new Error('ETIMEDOUT'))
    });
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedItems[0].reason).toMatch(/unreachable/);
  });

  it('does no network work when offline', async () => {
    let called = 0;
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkDeprecations(lockfile, {
      offline: true, fetchManifest: () => { called++; return Promise.resolve({}); }
    });
    expect(called).toBe(0);
    expect(result.scanned).toBe(0);
    expect(result.skipped).toBe(2); // root + the one package
    expect(result.valid).toBe(true);
  });

  it('skips root, workspace, link, git, file, and version-less entries', async () => {
    const lockfile = lockfileWith({
      'packages/app': { name: 'app', version: '1.0.0' }, // workspace source
      'node_modules/linked': { link: true, resolved: 'packages/app' },
      'node_modules/no-version': { resolved: `${reg}/no-version/-/no-version-1.0.0.tgz` },
      'node_modules/from-git': { version: '1.0.0', resolved: 'git+https://github.com/x/y.git' },
      'node_modules/from-file': { version: '1.0.0', resolved: 'file:../local' },
      ...pkg('real')
    });
    const seen = [];
    const result = await checkDeprecations(lockfile, {
      fetchManifest: (name) => { seen.push(name); return Promise.resolve({}); }
    });
    expect(result.skipped).toBe(6); // root + workspace + link + no-version + git + file
    expect(result.scanned).toBe(1);
    expect(seen).toEqual(['real']);
  });

  it('fetches an identical name@version once and attributes it to every entry', async () => {
    // Two lockfile paths resolving the same package version → one fetch, two findings.
    const lockfile = lockfileWith({
      'node_modules/dup': {
        version: '1.0.0', integrity: HASH_A,
        resolved: `${reg}/dup/-/dup-1.0.0.tgz`
      },
      'node_modules/nested/node_modules/dup': {
        version: '1.0.0', integrity: HASH_A,
        resolved: `${reg}/dup/-/dup-1.0.0.tgz`
      }
    });
    let calls = 0;
    const result = await checkDeprecations(lockfile, {
      fetchManifest: () => { calls++; return Promise.resolve({ deprecated: 'old' }); }
    });
    expect(calls).toBe(1);
    expect(result.scanned).toBe(2);
    expect(result.deprecated).toBe(2);
    expect(result.warnings).toHaveLength(2);
  });

  it('groups by registry so private registries are queried with their own base', async () => {
    const lockfile = lockfileWith({
      ...pkg('a'),
      'node_modules/b': {
        version: '1.0.0', integrity: HASH_A,
        resolved: 'https://npm.corp.example/b/-/b-1.0.0.tgz'
      }
    });
    const seen = [];
    await checkDeprecations(lockfile, {
      fetchManifest: (name, version, registryBase) => { seen.push(registryBase); return Promise.resolve({}); }
    });
    expect(new Set(seen)).toEqual(new Set([reg, 'https://npm.corp.example']));
  });

  it('rejects v1 lockfiles', async () => {
    await expect(checkDeprecations({ lockfileVersion: 1, dependencies: {} }, {}))
      .rejects.toThrow(DeprecationError);
  });
});
