// tests/unit/vuln.test.js
import { checkVulnerabilities, VulnError } from '../../src/vuln.js';

const HASH_A = 'sha512-' + 'A'.repeat(86) + '==';

// An advisory record as returned by the bulk endpoint.
const adv = (severity, over = {}) => ({
  id: 1, title: 'Prototype pollution', severity,
  vulnerable_versions: '*', url: 'https://example.test/advisory/1', ...over
});

// Injectable fetcher: returns only the names present in the request body that
// also appear in `table` (mirrors the server filtering to submitted versions).
const fakeAdvisories = (table) => (registryBase, body) => {
  const out = {};
  for (const name of Object.keys(body)) if (table[name]) out[name] = table[name];
  return Promise.resolve(out);
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

describe('checkVulnerabilities', () => {
  it('flags a critical advisory as an error and fails the run (default minSeverity high)', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: fakeAdvisories({ bad: [adv('critical')] })
    });
    expect(result.valid).toBe(false);
    expect(result.vulnerable).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].package).toBe('bad');
    expect(result.warnings).toHaveLength(0);
  });

  it('treats a below-threshold advisory as a warning, not a failure', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const result = await checkVulnerabilities(lockfile, {
      minSeverity: 'high',
      fetchAdvisories: fakeAdvisories({ bad: [adv('low')] })
    });
    expect(result.valid).toBe(true);
    expect(result.vulnerable).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.errors).toHaveLength(0);
  });

  it('honors the minSeverity boundary (moderate)', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const atThreshold = await checkVulnerabilities(lockfile, {
      minSeverity: 'moderate', fetchAdvisories: fakeAdvisories({ bad: [adv('moderate')] })
    });
    expect(atThreshold.errors).toHaveLength(1);
    expect(atThreshold.valid).toBe(false);

    const belowThreshold = await checkVulnerabilities(lockfile, {
      minSeverity: 'high', fetchAdvisories: fakeAdvisories({ bad: [adv('moderate')] })
    });
    expect(belowThreshold.warnings).toHaveLength(1);
    expect(belowThreshold.valid).toBe(true);
  });

  it('reports a clean package with no advisories', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, { fetchAdvisories: fakeAdvisories({}) });
    expect(result.valid).toBe(true);
    expect(result.clean).toBe(1);
    expect(result.vulnerable).toBe(0);
  });

  it('marks packages unresolved (non-fatal) when the endpoint 404s', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, { fetchAdvisories: () => Promise.resolve(null) });
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedItems[0].reason).toMatch(/does not support/);
  });

  it('fails closed on unresolved when failOnUnresolved is set', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, {
      failOnUnresolved: true, fetchAdvisories: () => Promise.resolve(null)
    });
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
  });

  it('treats a network error as unresolved (not failed) by default', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: () => Promise.reject(new Error('ETIMEDOUT'))
    });
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedItems[0].reason).toMatch(/unreachable/);
  });

  it('does no network work when offline', async () => {
    let called = 0;
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, {
      offline: true, fetchAdvisories: () => { called++; return Promise.resolve({}); }
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
    let submitted = null;
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: (base, body) => { submitted = body; return Promise.resolve({}); }
    });
    expect(result.skipped).toBe(6); // root + workspace + link + no-version + git + file
    expect(result.scanned).toBe(1);
    expect(Object.keys(submitted)).toEqual(['real']);
  });

  it('groups requests by registry (one POST per registry)', async () => {
    const lockfile = lockfileWith({
      ...pkg('a'),
      'node_modules/b': {
        version: '1.0.0', integrity: HASH_A,
        resolved: 'https://npm.corp.example/b/-/b-1.0.0.tgz'
      }
    });
    const seen = [];
    await checkVulnerabilities(lockfile, {
      fetchAdvisories: (base) => { seen.push(base); return Promise.resolve({}); }
    });
    expect(seen).toHaveLength(2);
    expect(new Set(seen)).toEqual(new Set([reg, 'https://npm.corp.example']));
  });

  it('batches names per POST when batchSize is small', async () => {
    const lockfile = lockfileWith({ ...pkg('a'), ...pkg('b') });
    let calls = 0;
    await checkVulnerabilities(lockfile, {
      batchSize: 1, fetchAdvisories: (base, body) => { calls += Object.keys(body).length; return Promise.resolve({}); }
    });
    expect(calls).toBe(2);
  });

  it('rejects an invalid minSeverity', async () => {
    await expect(checkVulnerabilities(lockfileWith(pkg('a')), { minSeverity: 'bogus' }))
      .rejects.toThrow(VulnError);
  });

  it('rejects v1 lockfiles', async () => {
    await expect(checkVulnerabilities({ lockfileVersion: 1, dependencies: {} }, {}))
      .rejects.toThrow(VulnError);
  });
});
