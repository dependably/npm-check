// tests/unit/report.test.js
import { runReport, formatReport, ReportError } from '../../src/report.js';

const HASH_A = 'sha512-' + 'A'.repeat(86) + '==';
const HASH_B = 'sha512-' + 'B'.repeat(86) + '==';

// node_modules path that does not exist → license check degrades to "skipped"
const NO_NM = '/nonexistent/node_modules';

function cleanLockfile() {
  return {
    name: 'demo',
    version: '1.0.0',
    lockfileVersion: 3,
    packages: {
      '': { name: 'demo', version: '1.0.0', dependencies: { 'good-pkg': '1.0.0' } },
      'node_modules/good-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/good-pkg/-/good-pkg-1.0.0.tgz',
        integrity: HASH_A
      }
    }
  };
}

function cleanPackageJson() {
  return { name: 'demo', version: '1.0.0', license: 'MIT', dependencies: { 'good-pkg': '1.0.0' } };
}

const fakeRegistry = (table) => (name) => Promise.resolve(table[name] || null);

// Injectable bulk-advisory fetcher: returns advisories for names present in `table`.
const fakeAdvisories = (table) => (registryBase, body) => {
  const out = {};
  for (const name of Object.keys(body)) if (table[name]) out[name] = table[name];
  return Promise.resolve(out);
};
const advisory = (severity, over = {}) => ({
  id: 1, title: 'Prototype pollution', severity, vulnerable_versions: '*', url: 'https://x.test/1', ...over
});

const baseOpts = (extra = {}) => ({
  nodeModulesPath: NO_NM, // license skips
  fetchIntegrity: fakeRegistry({ 'good-pkg': HASH_A }),
  fetchAdvisories: fakeAdvisories({}), // no vulns by default; no network
  fetchManifest: () => Promise.resolve({}), // not deprecated by default; no network
  ...extra
});

describe('runReport', () => {
  it('throws without a lockfile', async () => {
    await expect(runReport({})).rejects.toThrow(ReportError);
  });

  it('reports all sections; clean lockfile passes', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts()
    );
    expect(report.sections.map((s) => s.id)).toEqual([
      'structure', 'package-json', 'npmrc', 'integrity', 'vuln', 'deprecated', 'resolved', 'licenses',
      'install-scripts', 'git', 'remote', 'pinned', 'orphans', 'unused', 'fund'
    ]);

    const vuln = report.sections.find((s) => s.id === 'vuln');
    expect(vuln.status).toBe('pass');
    expect(vuln.summary).toMatch(/1 scanned/);
    expect(report.summary.pass).toBe(true);
    expect(report.summary.errors).toBe(0);

    const integrity = report.sections.find((s) => s.id === 'integrity');
    expect(integrity.status).toBe('pass');
    expect(integrity.summary).toMatch(/1 verified/);

    const licenses = report.sections.find((s) => s.id === 'licenses');
    expect(licenses.status).toBe('skip');
    expect(licenses.summary).toMatch(/no node_modules/);
  });

  it('fails when the lockfile hash differs from the registry', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchIntegrity: fakeRegistry({ 'good-pkg': HASH_B }) })
    );
    expect(report.summary.pass).toBe(false);
    expect(report.summary.errors).toBe(1);
    const integrity = report.sections.find((s) => s.id === 'integrity');
    expect(integrity.status).toBe('error');
    expect(integrity.findings.some((f) => /differs from registry/.test(f.message))).toBe(true);
  });

  it('routes audit findings into install-scripts and pinned sections (warnings only → pass)', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    lockfile.packages[''].dependencies['good-pkg'] = '^1.0.0'; // keep root in sync
    const packageJson = cleanPackageJson();
    packageJson.dependencies['good-pkg'] = '^1.0.0'; // unpinned (but synced)

    const report = await runReport(
      { lockfile, packageJson, filePath: 'package-lock.json' },
      baseOpts()
    );
    expect(report.summary.errors).toBe(0);
    expect(report.summary.warnings).toBeGreaterThanOrEqual(2);
    expect(report.summary.pass).toBe(true);

    const scripts = report.sections.find((s) => s.id === 'install-scripts');
    expect(scripts.status).toBe('warn');
    expect(scripts.findings).toHaveLength(1);

    const pinned = report.sections.find((s) => s.id === 'pinned');
    expect(pinned.status).toBe('warn');
  });

  it('routes package.json validation findings into the package-json section', async () => {
    const packageJson = cleanPackageJson();
    packageJson.version = 'not-semver';

    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson, filePath: 'package-lock.json' },
      baseOpts()
    );

    const section = report.sections.find((s) => s.id === 'package-json');
    expect(section.title).toBe('package.json');
    expect(section.status).toBe('error');
    expect(section.findings.some((f) => /invalid version/.test(f.message))).toBe(true);
    expect(report.summary.pass).toBe(false);

    const npmrc = report.sections.find((s) => s.id === 'npmrc');
    expect(npmrc.title).toBe('.npmrc (config)');
    expect(npmrc.status).toBe('pass'); // no .npmrc in cwd
  });

  it('skips the integrity section under --offline (integrity:false) without network', async () => {
    let called = 0;
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      { nodeModulesPath: NO_NM, integrity: false, vuln: false, deprecated: false, fetchIntegrity: () => { called++; return Promise.resolve(HASH_A); } }
    );
    expect(called).toBe(0);
    const integrity = report.sections.find((s) => s.id === 'integrity');
    expect(integrity.status).toBe('skip');
    expect(integrity.summary).toMatch(/offline/);
  });

  it('skips the vuln section when vuln:false without network', async () => {
    let called = 0;
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      { nodeModulesPath: NO_NM, integrity: false, vuln: false, deprecated: false,
        fetchAdvisories: () => { called++; return Promise.resolve({}); } }
    );
    expect(called).toBe(0);
    const vuln = report.sections.find((s) => s.id === 'vuln');
    expect(vuln.status).toBe('skip');
    expect(vuln.summary).toMatch(/offline/);
  });

  it('fails the run when a critical advisory is found', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchAdvisories: fakeAdvisories({ 'good-pkg': [advisory('critical')] }) })
    );
    expect(report.summary.pass).toBe(false);
    const vuln = report.sections.find((s) => s.id === 'vuln');
    expect(vuln.status).toBe('error');
    expect(vuln.findings.some((f) => /Prototype pollution/.test(f.message))).toBe(true);
  });

  it('shows allowed/blocked install-script counts for an npm v12 (allowScripts) file', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    lockfile.packages['node_modules/native'] = {
      name: 'native', version: '2.0.0', hasInstallScript: true,
      resolved: 'https://registry.npmjs.org/native/-/native-2.0.0.tgz', integrity: HASH_A
    };
    const packageJson = cleanPackageJson();
    packageJson.allowScripts = { 'good-pkg@1.0.0': true }; // native left pending → blocked

    const report = await runReport({ lockfile, packageJson, filePath: 'package-lock.json' }, baseOpts());
    const scripts = report.sections.find((s) => s.id === 'install-scripts');
    expect(scripts.summary).toBe('2 scripts · 1 allowed · 1 blocked');
    expect(scripts.findings).toHaveLength(1); // only the blocked one
    expect(scripts.findings[0].location).toBe('node_modules/native');
  });

  it('strict mode turns warnings into a failure', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    const report = await runReport(
      { lockfile, packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ strict: true, maxWarnings: 0 })
    );
    expect(report.summary.warnings).toBeGreaterThan(0);
    expect(report.summary.pass).toBe(false);
  });
});

describe('formatReport', () => {
  it('renders a grouped pretty report with section table and summary', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    const out = formatReport(
      await runReport({ lockfile, packageJson: cleanPackageJson(), filePath: 'web/package-lock.json' }, baseOpts()),
      { format: 'pretty' }
    );
    expect(out).toContain('npm-check report — web/package-lock.json');
    expect(out).toContain('Integrity (registry)');
    expect(out).toContain('Install scripts');
    expect(out).toMatch(/✖ \d+ problem/);
  });

  it('renders all-clear when nothing is wrong', async () => {
    const out = formatReport(
      await runReport({ lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' }, baseOpts()),
      { format: 'pretty' }
    );
    expect(out).toContain('✔ all checks passed');
  });

  it('round-trips JSON', async () => {
    const report = await runReport({ lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' }, baseOpts());
    const json = JSON.parse(formatReport(report, { format: 'json' }));
    expect(json.summary.pass).toBe(true);
    expect(json.sections).toHaveLength(15);
  });

  it('rejects an unknown format', () => {
    expect(() => formatReport({ filePath: 'x', sections: [], summary: { errors: 0, warnings: 0, total: 0 } }, { format: 'xml' }))
      .toThrow(ReportError);
  });
});
