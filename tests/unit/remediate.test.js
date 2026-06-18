// tests/unit/remediate.test.js
import { remediateDependencies, RemediationError } from '../../src/remediate.js';

const HASH = 'sha512-' + 'A'.repeat(86) + '==';
const reg = 'https://registry.npmjs.org';

function pkgEntry(name, version) {
  return {
    [`node_modules/${name}`]: {
      version,
      resolved: `${reg}/${name}/-/${name}-${version}.tgz`,
      integrity: HASH
    }
  };
}

function lockfileWith(pkgs, rootDeps = {}) {
  return {
    name: 'demo', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'demo', version: '1.0.0', ...rootDeps }, ...pkgs }
  };
}

// Injectable scan transports.
const deprecate = (names) => (name, version) =>
  Promise.resolve(names.includes(name) ? { name, version, deprecated: 'use newer' } : {});
const advise = (table) => (registryBase, body) => {
  const out = {};
  for (const n of Object.keys(body)) if (table[n]) out[n] = table[n];
  return Promise.resolve(out);
};
const adv = (severity) => ({ id: 1, title: 'bug', severity, vulnerable_versions: '*', url: 'u' });
const latest = (table) => (name) => Promise.resolve(table[name] || null);

describe('remediateDependencies', () => {
  it('bumps a deprecated direct devDependency to latest, preserving the caret', async () => {
    const lockfile = lockfileWith(pkgEntry('eslint', '8.57.1'), { devDependencies: { eslint: '^8.0.0' } });
    const packageJson = { name: 'demo', version: '1.0.0', devDependencies: { eslint: '^8.0.0' } };

    const result = await remediateDependencies(lockfile, packageJson, {
      fetchManifest: deprecate(['eslint']),
      fetchAdvisories: advise({}),
      fetchLatest: latest({ eslint: '9.39.0' })
    });

    expect(result.changed).toBe(true);
    expect(result.bumped).toHaveLength(1);
    expect(result.bumped[0]).toMatchObject({ package: 'eslint', section: 'devDependencies', from: '^8.0.0', to: '^9.39.0' });
    expect(result.bumped[0].reasons).toContain('deprecated');
    // Written into the returned package.json and synced into the lockfile root.
    expect(result.packageJson.devDependencies.eslint).toBe('^9.39.0');
    expect(result.lockfile.packages[''].devDependencies.eslint).toBe('^9.39.0');
  });

  it('preserves an exact (pinned) range as exact', async () => {
    const lockfile = lockfileWith(pkgEntry('eslint', '8.57.1'), { devDependencies: { eslint: '8.57.1' } });
    const packageJson = { name: 'demo', version: '1.0.0', devDependencies: { eslint: '8.57.1' } };
    const result = await remediateDependencies(lockfile, packageJson, {
      fetchManifest: deprecate(['eslint']), fetchAdvisories: advise({}), fetchLatest: latest({ eslint: '9.39.0' })
    });
    expect(result.bumped[0].to).toBe('9.39.0'); // no caret added
  });

  it('reports a transitive flagged package as guidance, not a bump', async () => {
    // minimatch is vulnerable but is NOT a direct dependency.
    const lockfile = lockfileWith(pkgEntry('minimatch', '3.1.2'), { devDependencies: { eslint: '^8.0.0' } });
    const packageJson = { name: 'demo', version: '1.0.0', devDependencies: { eslint: '^8.0.0' } };
    const result = await remediateDependencies(lockfile, packageJson, {
      fetchManifest: deprecate([]),
      fetchAdvisories: advise({ minimatch: [adv('high')] }),
      fetchLatest: latest({})
    });
    expect(result.bumped).toHaveLength(0);
    expect(result.guidance.map((g) => g.package)).toContain('minimatch');
    expect(result.guidance[0].kind).toBe('transitive');
    expect(result.changed).toBe(false);
  });

  it('does not bump for an advisory below the severity threshold', async () => {
    const lockfile = lockfileWith(pkgEntry('lodash', '4.17.21'), { dependencies: { lodash: '^4.0.0' } });
    const packageJson = { name: 'demo', version: '1.0.0', dependencies: { lodash: '^4.0.0' } };
    const result = await remediateDependencies(lockfile, packageJson, {
      minSeverity: 'high',
      fetchManifest: deprecate([]),
      fetchAdvisories: advise({ lodash: [adv('low')] }), // below high → warning, not a target
      fetchLatest: latest({ lodash: '5.0.0' })
    });
    expect(result.bumped).toHaveLength(0);
    expect(result.changed).toBe(false);
  });

  it('skips complex/git ranges with a reason', async () => {
    const lockfile = lockfileWith(pkgEntry('eslint', '8.57.1'), { devDependencies: { eslint: '>=8 <9' } });
    const packageJson = { name: 'demo', version: '1.0.0', devDependencies: { eslint: '>=8 <9' } };
    const result = await remediateDependencies(lockfile, packageJson, {
      fetchManifest: deprecate(['eslint']), fetchAdvisories: advise({}), fetchLatest: latest({ eslint: '9.39.0' })
    });
    expect(result.bumped).toHaveLength(0);
    expect(result.skipped[0]).toMatchObject({ package: 'eslint' });
    expect(result.skipped[0].reason).toMatch(/complex/);
  });

  it('guides (not bumps) when the dep is already at latest yet still flagged', async () => {
    const lockfile = lockfileWith(pkgEntry('eslint', '9.39.0'), { devDependencies: { eslint: '^9.39.0' } });
    const packageJson = { name: 'demo', version: '1.0.0', devDependencies: { eslint: '^9.39.0' } };
    const result = await remediateDependencies(lockfile, packageJson, {
      fetchManifest: deprecate(['eslint']), fetchAdvisories: advise({}), fetchLatest: latest({ eslint: '9.39.0' })
    });
    expect(result.bumped).toHaveLength(0);
    expect(result.guidance[0].kind).toBe('latest-still-affected');
  });

  it('records a warning when the registry has no latest version', async () => {
    const lockfile = lockfileWith(pkgEntry('eslint', '8.57.1'), { devDependencies: { eslint: '^8.0.0' } });
    const packageJson = { name: 'demo', version: '1.0.0', devDependencies: { eslint: '^8.0.0' } };
    const result = await remediateDependencies(lockfile, packageJson, {
      fetchManifest: deprecate(['eslint']), fetchAdvisories: advise({}), fetchLatest: latest({})
    });
    expect(result.bumped).toHaveLength(0);
    expect(result.warnings[0]).toMatchObject({ package: 'eslint' });
  });

  it('does not mutate the input package.json', async () => {
    const lockfile = lockfileWith(pkgEntry('eslint', '8.57.1'), { devDependencies: { eslint: '^8.0.0' } });
    const packageJson = { name: 'demo', version: '1.0.0', devDependencies: { eslint: '^8.0.0' } };
    const snapshot = JSON.stringify(packageJson);
    await remediateDependencies(lockfile, packageJson, {
      fetchManifest: deprecate(['eslint']), fetchAdvisories: advise({}), fetchLatest: latest({ eslint: '9.39.0' })
    });
    expect(JSON.stringify(packageJson)).toBe(snapshot);
  });

  it('rejects v1 lockfiles and missing inputs', async () => {
    await expect(remediateDependencies({ lockfileVersion: 1 }, {})).rejects.toThrow(RemediationError);
    await expect(remediateDependencies(null, {})).rejects.toThrow(RemediationError);
    await expect(remediateDependencies(lockfileWith({}), null)).rejects.toThrow(RemediationError);
  });
});
