// tests/unit/vuln.test.js
import { checkVulnerabilities, VulnError, vulnEnvelope } from '../../src/vuln.js';

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

  it('surfaces the patched/fixed version on a finding when the advisory provides it', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: fakeAdvisories({ bad: [adv('critical', { patched_versions: '>=2.0.0' })] })
    });
    expect(result.errors[0].fixedVersion).toBe('>=2.0.0');
    // It also rides along on the per-package details advisories.
    const detail = result.details.find((d) => d.vulnerable);
    expect(detail.advisories[0].fixedVersion).toBe('>=2.0.0');
  });

  it('does not fabricate a fixedVersion when the advisory has none (or marks none available)', async () => {
    const lockfile = lockfileWith({ ...pkg('a'), ...pkg('b') });
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: fakeAdvisories({
        a: [adv('critical')], // no patched_versions field at all
        b: [adv('critical', { patched_versions: '<0.0.0' })] // sentinel: no fix published
      })
    });
    const byPkg = Object.fromEntries(result.errors.map((e) => [e.package, e.fixedVersion]));
    expect(byPkg.a).toBeNull();
    expect(byPkg.b).toBeNull();
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

  // "Obtained data, nothing found" — the registry successfully reported no advisories.
  // This is a normal clean result and MUST keep exiting 0 (do not fail closed here).
  it('reports a clean package with no advisories (stays valid / exit 0)', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, { fetchAdvisories: fakeAdvisories({}) });
    expect(result.valid).toBe(true);
    expect(result.clean).toBe(1);
    expect(result.vulnerable).toBe(0);
  });

  // P0 fail-closed: the bulk endpoint 404s → advisory data could NOT be obtained, so
  // the scan didn't complete. By default that must FAIL the run, never report clean.
  it('fails closed by default when the endpoint is unsupported (404)', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, { fetchAdvisories: () => Promise.resolve(null) });
    expect(result.valid).toBe(false);
    expect(result.unresolved).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.unresolvedItems[0].reason).toMatch(/does not support/);
  });

  // P0 fail-closed: a registry/network error means we couldn't scan → fail the run.
  it('fails closed by default when a registry/network error aborts the scan', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: () => Promise.reject(new Error('ECONNREFUSED'))
    });
    expect(result.valid).toBe(false);
    expect(result.unresolved).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.unresolvedItems[0].reason).toMatch(/unreachable/);
  });

  // The explicit opt-out (CLI: --allow-unresolved) restores lenient behavior for
  // users who genuinely accept an incomplete/offline scan.
  it('keeps unresolved non-fatal when failOnUnresolved is opted out', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, {
      failOnUnresolved: false, fetchAdvisories: () => Promise.reject(new Error('ETIMEDOUT'))
    });
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.errors).toHaveLength(0);
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

  it('captures cve, vulnerable range and references on a finding', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: fakeAdvisories({
        bad: [adv('critical', {
          vulnerable_versions: '<2.0.0', cves: ['CVE-2024-9999'],
          references: ['https://ref.test/a', { url: 'https://ref.test/b' }]
        })]
      })
    });
    const f = result.errors[0];
    expect(f.cve).toBe('CVE-2024-9999');
    expect(f.vulnerableRange).toBe('<2.0.0');
    expect(f.references).toEqual(['https://ref.test/a', 'https://ref.test/b', 'https://example.test/advisory/1']);
  });
});

describe('vulnEnvelope (shared finding schema)', () => {
  it('wraps a result in the suite envelope with the six core keys', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: fakeAdvisories({ bad: [adv('critical', { patched_versions: '>=2.0.0' })] })
    });
    const env = vulnEnvelope(result, { target: 'package-lock.json', exitCode: 1 });

    expect(env.tool).toBe('npm-check');
    expect(typeof env.toolVersion).toBe('string');
    expect(env.schemaVersion).toBe('1.0');
    expect(env.target).toBe('package-lock.json');
    expect(env.summary.scanned).toBe(result.scanned);
    expect(env.summary.findings).toBe(env.findings.length); // never truncated
    expect(env.summary.exitCode).toBe(1); // matches the real exit code
    expect(env.summary.bySeverity).toEqual({ critical: 1, high: 0, moderate: 0, low: 0, info: 0 });
  });

  it('maps an advisory to the Finding shape with advisory data under extra', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const result = await checkVulnerabilities(lockfile, {
      fetchAdvisories: fakeAdvisories({
        bad: [adv('high', { id: 1337, patched_versions: '>=2.0.0', vulnerable_versions: '<2.0.0', cves: ['CVE-2024-1'] })]
      })
    });
    const env = vulnEnvelope(result, { target: 'package-lock.json', exitCode: 1 });
    const f = env.findings[0];

    expect(f.severity).toBe('high'); // npm ladder kept verbatim
    expect(f.ruleId).toBe('1337'); // advisoryId
    expect(f.category).toBe('vulnerability');
    expect(f.message).toBe('Prototype pollution'); // advisory title
    expect(f.location).toBeNull(); // a package advisory is not file-scoped
    expect(f.remediation).toBe('upgrade to >=2.0.0');
    expect(f.extra).toEqual({
      package: 'bad',
      installedVersion: '1.0.0',
      fixedVersion: '>=2.0.0',
      advisoryId: 1337,
      cve: 'CVE-2024-1',
      vulnerableRange: '<2.0.0',
      references: ['https://example.test/advisory/1']
    });
  });

  it('includes below-threshold warnings in findings and preserves scan state under extra', async () => {
    const lockfile = lockfileWith(pkg('bad'));
    const result = await checkVulnerabilities(lockfile, {
      minSeverity: 'high', fetchAdvisories: fakeAdvisories({ bad: [adv('low')] })
    });
    const env = vulnEnvelope(result, { target: 'package-lock.json', exitCode: 0 });
    expect(env.findings).toHaveLength(1);
    expect(env.findings[0].severity).toBe('low');
    expect(env.summary.bySeverity.low).toBe(1);
    expect(env.extra.scan.vulnerable).toBe(1);
    expect(env.extra.scan.valid).toBe(true);
  });

  it('keeps unresolved scan state in extra (gate signal) with zero advisory findings', async () => {
    const lockfile = lockfileWith(pkg('good'));
    const result = await checkVulnerabilities(lockfile, { fetchAdvisories: () => Promise.resolve(null) });
    const env = vulnEnvelope(result, { target: 'package-lock.json', exitCode: 1 });
    expect(env.findings).toHaveLength(0);
    expect(env.summary.findings).toBe(0);
    expect(env.summary.exitCode).toBe(1); // fail-closed: scan couldn't complete
    expect(env.extra.scan.unresolved).toBe(1);
    expect(env.extra.scan.valid).toBe(false);
  });
});
