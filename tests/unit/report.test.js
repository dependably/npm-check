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
      'structure', 'package-json', 'npmrc', 'pnpm-config', 'integrity', 'vuln', 'deprecated', 'unresolved', 'resolved',
      'licenses', 'install-scripts', 'git', 'remote', 'pinned', 'orphans', 'unused', 'fund'
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

  // moonlitlabs/npm-check#33: a genuine hash mismatch must be labeled distinctly
  // from a package that merely couldn't be checked (unresolved), both in the
  // summary bit and in the detail line's category prefix.
  it('prefixes a genuine hash mismatch detail line with "mismatched:"', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchIntegrity: fakeRegistry({ 'good-pkg': HASH_B }) })
    );
    const integrity = report.sections.find((s) => s.id === 'integrity');
    expect(integrity.summary).toMatch(/1 mismatched/);
    expect(integrity.summary).not.toMatch(/unresolved/);
    expect(integrity.findings).toHaveLength(1);
    expect(integrity.findings[0].message).toMatch(/^mismatched: good-pkg: /);
  });

  // moonlitlabs/npm-check#33: `checkIntegrity` fails closed by folding an
  // unresolved entry into BOTH `unresolvedItems` and `errors`/`failed` — the
  // OLD summary read this as "1 mismatched · 1 unresolved" (implying two
  // distinct problem packages, and a detail count of 2) for what is really
  // ONE package that simply could not be checked. The summary must not claim a
  // "mismatched" (tamper) package here.
  //
  // moonlitlabs/npm-check#35: that single "could not be checked" entry no
  // longer lives in the Integrity section at all — it moves to the shared
  // "Unresolved (could not check)" section, tagged `check: 'integrity'`, so
  // Integrity's own findings/summary only ever describe what it FOUND.
  it('moves an unresolved (not mismatched) integrity entry to the shared Unresolved section', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchIntegrity: fakeRegistry({}) }) // registry has no sha512 for good-pkg → unresolved
    );
    const integrity = report.sections.find((s) => s.id === 'integrity');
    expect(integrity.summary).not.toMatch(/mismatched/);
    expect(integrity.summary).not.toMatch(/unresolved/);
    expect(integrity.findings).toHaveLength(0);

    const unresolved = report.sections.find((s) => s.id === 'unresolved');
    expect(unresolved.status).toBe('error'); // failOnUnresolved defaults true
    expect(unresolved.summary).toBe('1 integrity');
    expect(unresolved.findings).toHaveLength(1);
    expect(unresolved.findings[0].check).toBe('integrity');
    expect(unresolved.findings[0].message).toMatch(/^\[integrity\] good-pkg@1\.0\.0: /);
  });

  // moonlitlabs/npm-check#33: `secure-resolved` and `no-remote-deps` both flag a
  // package resolved from a host neither rule's default allowlist trusts — one
  // root cause (the mirror host), reported twice (once per rule/section). The
  // report cross-references and collapses the "Remote-URL deps" duplicate into
  // one grouped-by-host finding instead of one line per duplicated package.
  it('cross-references Resolved URLs and Remote-URL deps instead of double-reporting the same untrusted host', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/mirror-pkg'] = {
      name: 'mirror-pkg', version: '1.0.0',
      resolved: 'https://mirror.example.ca/mirror-pkg/-/mirror-pkg-1.0.0.tgz',
      integrity: HASH_A
    };
    const report = await runReport(
      { lockfile, packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchIntegrity: fakeRegistry({ 'good-pkg': HASH_A, 'mirror-pkg': HASH_A }) })
    );

    const resolved = report.sections.find((s) => s.id === 'resolved');
    const remote = report.sections.find((s) => s.id === 'remote');

    // "Resolved URLs" still reports the untrusted host per package (unchanged —
    // it's the primary, more specific finding).
    expect(resolved.findings.some((f) => f.location === 'node_modules/mirror-pkg')).toBe(true);

    // "Remote-URL deps" collapses into ONE grouped-by-host finding — the root
    // cause counted once, not the duplicated package line again.
    expect(remote.findings).toHaveLength(1);
    expect(remote.findings[0].location).toBeNull();
    expect(remote.findings[0].message).toMatch(/1 package resolved from "mirror\.example\.ca"/);
    expect(remote.findings[0].message).toMatch(/already reported under Resolved URLs/);
  });

  it('lists every duplicated Remote-URL deps package individually under verbose:true (--verbose)', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/mirror-pkg'] = {
      name: 'mirror-pkg', version: '1.0.0',
      resolved: 'https://mirror.example.ca/mirror-pkg/-/mirror-pkg-1.0.0.tgz',
      integrity: HASH_A
    };
    const report = await runReport(
      { lockfile, packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ verbose: true, fetchIntegrity: fakeRegistry({ 'good-pkg': HASH_A, 'mirror-pkg': HASH_A }) })
    );
    const remote = report.sections.find((s) => s.id === 'remote');
    expect(remote.findings.some((f) => f.location === 'node_modules/mirror-pkg')).toBe(true);
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
    // Genuinely empty (clean lockfile → no offline hygiene findings) → honest skip.
    // Flag-neutral label: `integrity:false` can't tell --offline from --no-integrity.
    // moonlitlabs/npm-check#35: the fixed status column already says "skipped";
    // the detail text is just the bare reason (no more "skipped (registry check
    // skipped)" stutter).
    expect(integrity.status).toBe('skip');
    expect(integrity.summary).toMatch(/--offline/);
  });

  it('surfaces offline integrity-hygiene findings even when the registry check is off (issue #26)', async () => {
    const lockfile = cleanLockfile();
    // Missing integrity → the offline `integrity-hygiene` rule flags it (error tier)
    // and buckets it into the integrity section — with no network at all.
    delete lockfile.packages['node_modules/good-pkg'].integrity;
    let called = 0;
    const report = await runReport(
      { lockfile, packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      { nodeModulesPath: NO_NM, integrity: false, vuln: false, deprecated: false,
        fetchIntegrity: () => { called++; return Promise.resolve(HASH_A); } }
    );
    expect(called).toBe(0); // no network — the finding is purely offline
    const integrity = report.sections.find((s) => s.id === 'integrity');
    // A skipped section must NOT silently carry findings: the status reflects the
    // finding severity, and the summary says the registry check was skipped but N remain.
    expect(integrity.status).toBe('error');
    expect(integrity.summary).toMatch(/registry check skipped/);
    expect(integrity.summary).toMatch(/offline finding/);
    expect(integrity.findings.length).toBeGreaterThan(0);
    expect(report.summary.errors).toBeGreaterThanOrEqual(1);
    expect(report.summary.pass).toBe(false);
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
    // moonlitlabs/npm-check#35: singular unit grammar for exactly 1 flagged package/advisory.
    expect(vuln.summary).toMatch(/1 vulnerable package \(1 advisory\)/);
  });

  it('runs the Pinned versions section for a pnpm lockfile (not N/A) and flags pnpm.overrides', async () => {
    // pinned-versions is npm+pnpm flavored, so on a pnpm lockfile the section must
    // be LIVE — not rendered "N/A (pnpm)" while still carrying/counting findings.
    const pnpmLock = { lockfileVersion: '9.0', importers: { '.': {} } };
    const packageJson = { name: 'p', version: '1.0.0', license: 'MIT', pnpm: { overrides: { 'foo@1': '^1.2.0' } } };
    const report = await runReport(
      { lockfile: pnpmLock, packageJson, filePath: 'pnpm-lock.yaml' },
      baseOpts()
    );
    const pinned = report.sections.find((s) => s.id === 'pinned');
    expect(pinned.status).not.toBe('skip');
    expect(pinned.summary).not.toMatch(/N\/A/);
    expect(pinned.findings.some((f) => /not pinned/.test(f.message))).toBe(true);
  });

  it('surfaces an id-LESS critical advisory instead of silently passing (fail-open regression)', async () => {
    // The vuln envelope was fixed to discriminate on `reason`, but report.js still
    // dropped advisories with no `id` (the check gated on advisoryId), so an
    // id-less critical advisory produced status:pass and exit 0 in the flagship
    // report command. It must fail the run and render the finding.
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchAdvisories: fakeAdvisories({ 'good-pkg': [advisory('critical', { id: undefined })] }) })
    );
    const vuln = report.sections.find((s) => s.id === 'vuln');
    expect(vuln.status).toBe('error');
    expect(vuln.findings.some((f) => /Prototype pollution/.test(f.message))).toBe(true);
    expect(report.summary.pass).toBe(false);
  });

  it('vuln findings carry the full advisory data (no collapse to error/warn + message)', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({
        fetchAdvisories: fakeAdvisories({
          'good-pkg': [advisory('critical', { id: 42, url: 'https://x.test/42', patched_versions: '>=1.2.0' })]
        })
      })
    );
    const vuln = report.sections.find((s) => s.id === 'vuln');
    const f = vuln.findings.find((x) => x.advisoryId === 42);
    expect(f).toMatchObject({
      severity: 'error', // report tier (drives the gate + icons)
      package: 'good-pkg',
      version: '1.0.0',
      advisoryId: 42,
      title: 'Prototype pollution',
      advisorySeverity: 'critical', // the TRUE 5-level severity survives structurally
      fixedVersion: '>=1.2.0',
      url: 'https://x.test/42'
    });
    // The same richness round-trips through `--format json` as the shared envelope:
    // the top-level finding carries the TRUE ladder severity, advisory data under
    // `extra`, and the report-tier (gate) severity preserved under `extra.reportSeverity`.
    const json = JSON.parse(formatReport(report, { format: 'json' }));
    expect(json.tool).toBe('npm-check');
    expect(json.schemaVersion).toBe('1.0');
    const jf = json.findings.find((x) => x.ruleId === '42');
    expect(jf.severity).toBe('critical'); // advisorySeverity → top-level ladder severity
    expect(jf.category).toBe('vulnerability');
    expect(jf.remediation).toBe('upgrade to >=1.2.0');
    expect(jf.extra.advisoryId).toBe(42);
    expect(jf.extra.fixedVersion).toBe('>=1.2.0');
    expect(jf.extra.references).toContain('https://x.test/42');
    expect(jf.extra.reportSeverity).toBe('error'); // the gate signal survives under extra
  });

  // moonlitlabs/npm-check#35: a scan that couldn't complete at all no longer
  // makes its OWN section report error/warn (it found nothing — it just
  // couldn't check) — that signal now lives solely in the shared "Unresolved"
  // section, which still rolls up into the same report.summary gate.
  it('fails the report by default when the vuln scan cannot complete (registry error)', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchAdvisories: () => Promise.reject(new Error('ECONNREFUSED')) })
    );
    expect(report.summary.pass).toBe(false);
    expect(report.summary.errors).toBeGreaterThanOrEqual(1);
    const vuln = report.sections.find((s) => s.id === 'vuln');
    expect(vuln.status).toBe('pass'); // no advisory found — the scan just couldn't run
    expect(vuln.findings).toHaveLength(0);
    const unresolved = report.sections.find((s) => s.id === 'unresolved');
    expect(unresolved.status).toBe('error');
    expect(unresolved.findings.some((f) => f.check === 'vuln' && /could not scan|ECONNREFUSED/.test(f.message))).toBe(true);
  });

  it('fails the report by default when integrity cannot be verified (registry error)', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchIntegrity: () => Promise.reject(new Error('ETIMEDOUT')) })
    );
    expect(report.summary.pass).toBe(false);
    const integrity = report.sections.find((s) => s.id === 'integrity');
    expect(integrity.status).toBe('pass'); // no mismatch found — the scan just couldn't run
    const unresolved = report.sections.find((s) => s.id === 'unresolved');
    expect(unresolved.status).toBe('error');
    expect(unresolved.findings.some((f) => f.check === 'integrity')).toBe(true);
  });

  it('downgrades an incomplete scan to a warning under --allow-unresolved (failOnUnresolved:false)', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ failOnUnresolved: false, fetchAdvisories: () => Promise.reject(new Error('ECONNREFUSED')) })
    );
    // maxWarnings defaults to -1 (unlimited) → warnings alone still pass
    expect(report.summary.pass).toBe(true);
    expect(report.summary.errors).toBe(0);
    const vuln = report.sections.find((s) => s.id === 'vuln');
    expect(vuln.status).toBe('pass');
    const unresolved = report.sections.find((s) => s.id === 'unresolved');
    expect(unresolved.status).toBe('warn');
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

  it('frames install scripts as npm v12 blocked when the project has no allowScripts', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    lockfile.packages['node_modules/native'] = {
      name: 'native', version: '2.0.0', hasInstallScript: true,
      resolved: 'https://registry.npmjs.org/native/-/native-2.0.0.tgz', integrity: HASH_A
    };
    const packageJson = cleanPackageJson(); // no allowScripts map

    const report = await runReport({ lockfile, packageJson, filePath: 'package-lock.json' }, baseOpts());
    const scripts = report.sections.find((s) => s.id === 'install-scripts');
    expect(scripts.summary).toBe('2 scripts · 2 blocked by npm v12 (no allowScripts)');
    expect(scripts.findings).toHaveLength(2); // every script blocked under v12
    expect(scripts.findings[0].message).toMatch(/npm v12 blocks install scripts by default/);
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

  it('surfaces an unexpected license-check failure as an error finding, not a silent skip (issue #26)', async () => {
    // Both paths exist (so the benign existsSync skips don't fire), but pointing the
    // approved-licenses CSV at a directory makes checkLicenses throw (EISDIR). The old
    // catch-all swallowed this into a passing skip; it must now trip the gate.
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ nodeModulesPath: process.cwd(), licensesCsv: process.cwd() })
    );
    const licenses = report.sections.find((s) => s.id === 'licenses');
    expect(licenses.status).toBe('error'); // NOT 'skip'
    expect(licenses.summary).toMatch(/check failed/);
    expect(licenses.findings.some((f) => /license check failed/.test(f.message))).toBe(true);
    expect(report.summary.errors).toBeGreaterThanOrEqual(1);
    expect(report.summary.pass).toBe(false); // no longer a silent green
  });

  it('applies the --fail-on severity= gate across all sections, not just vuln (issue #9)', async () => {
    // A warn-tier install-scripts finding (ladder severity `low`) with NO errors and an
    // unlimited warning budget — the only thing that can fail the run is the severity gate.
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    const target = { lockfile, packageJson: cleanPackageJson(), filePath: 'package-lock.json' };

    // severity=high: the warn-tier finding (low) is below the gate → still passes.
    const high = await runReport(target, baseOpts({ minSeverity: 'high' }));
    expect(high.summary.errors).toBe(0);
    expect(high.summary.warnings).toBeGreaterThan(0);
    expect(high.summary.pass).toBe(true);

    // severity=moderate: low < moderate → still passes.
    const moderate = await runReport(target, baseOpts({ minSeverity: 'moderate' }));
    expect(moderate.summary.pass).toBe(true);

    // severity=low: the same non-vuln warn-tier finding is now at/above the gate → FAILS.
    // (On the old code this passed — the gate only shaped the vuln stage: fail-open.)
    const low = await runReport(target, baseOpts({ minSeverity: 'low' }));
    expect(low.summary.errors).toBe(0);
    expect(low.summary.warnings).toBeGreaterThan(0);
    expect(low.summary.pass).toBe(false);
  });

  // moonlitlabs/npm-check#35: the vuln summary previously said "4 vulnerable"
  // (packages) while the section header said "(8)" (advisories) — same report,
  // two different unlabeled units. Both now spell out the unit, and agree:
  // 2 vulnerable PACKAGES, one of which carries 2 advisories, for 3 total.
  it('labels the vuln summary and header in the same unit — packages vs advisories', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/second-pkg'] = {
      version: '2.0.0',
      resolved: 'https://registry.npmjs.org/second-pkg/-/second-pkg-2.0.0.tgz',
      integrity: HASH_A
    };
    lockfile.packages[''].dependencies['second-pkg'] = '2.0.0';
    const report = await runReport(
      { lockfile, packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({
        fetchIntegrity: fakeRegistry({ 'good-pkg': HASH_A, 'second-pkg': HASH_A }),
        fetchAdvisories: fakeAdvisories({
          'good-pkg': [advisory('critical', { id: 1 }), advisory('high', { id: 2, title: 'Second issue' })],
          'second-pkg': [advisory('moderate', { id: 3 })]
        })
      })
    );
    const vuln = report.sections.find((s) => s.id === 'vuln');
    expect(vuln.findings).toHaveLength(3); // 3 advisories total
    expect(vuln.summary).toMatch(/^2 scanned · 2 vulnerable packages \(3 advisories\)/);

    const out = formatReport(report, { format: 'human' });
    expect(out).toContain('Known vulnerabilities — 3 advisories in 2 packages');
  });

  // moonlitlabs/npm-check#35: a could-not-scan entry from ANY check (integrity,
  // vuln, deprecated) is a distinct signal from what that check actually found —
  // it no longer gets filed under whichever check's section happens to run last
  // (previously "Deprecated packages"). It's collected in one shared section
  // instead, tagged with which check couldn't complete.
  it('collects could-not-scan entries from every check into the shared Unresolved section, not into Deprecated packages', async () => {
    const report = await runReport(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({
        fetchAdvisories: () => Promise.reject(new Error('ECONNREFUSED')),
        fetchManifest: () => Promise.reject(new Error('ETIMEDOUT'))
      })
    );
    const vuln = report.sections.find((s) => s.id === 'vuln');
    const deprecated = report.sections.find((s) => s.id === 'deprecated');
    const unresolved = report.sections.find((s) => s.id === 'unresolved');

    expect(vuln.findings).toHaveLength(0);
    expect(deprecated.findings).toHaveLength(0);
    expect(unresolved.status).toBe('error'); // failOnUnresolved defaults true
    expect(unresolved.findings).toHaveLength(2);
    expect(unresolved.findings.map((f) => f.check).sort()).toEqual(['deprecated', 'vuln']);
    // Breakdown by originating check, so a reader knows which scan(s) failed
    // without opening the detail block.
    expect(unresolved.summary).toBe('1 vuln · 1 deprecated');

    const out = formatReport(report, { format: 'human' });
    expect(out).toContain('Unresolved (could not check)');
    expect(out).not.toMatch(/Deprecated packages —/); // no findings → no detail block at all
  });
});

describe('formatReport', () => {
  it('renders a grouped pretty report with section table and summary', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    const out = formatReport(
      await runReport({ lockfile, packageJson: cleanPackageJson(), filePath: 'web/package-lock.json' }, baseOpts()),
      { format: 'human' }
    );
    expect(out).toContain('npm-check report — web/package-lock.json');
    expect(out).toContain('Integrity (registry)');
    expect(out).toContain('Install scripts');
    expect(out).toMatch(/\d+ problem/);
  });

  it('renders all-clear when nothing is wrong', async () => {
    const out = formatReport(
      await runReport({ lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' }, baseOpts()),
      { format: 'human' }
    );
    expect(out).toContain('all checks passed');
  });

  // moonlitlabs/npm-check#35: a fixed status-column vocabulary (ok / N warnings /
  // N errors / skipped) with one glyph per state (✓ / ⚠ / ✖ / ·), consistent
  // across every section — instead of each check inventing its own phrasing
  // (`valid`, `all TLS / trusted`, `skipped (no approved-licenses.csv)`, …) with
  // an unexplained `·` marker. Check-specific detail still follows in parens.
  it('renders a fixed status column with a matching glyph per section, detail in a trailing parenthetical', async () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true; // warn-tier finding
    const report = await runReport(
      { lockfile, packageJson: cleanPackageJson(), filePath: 'package-lock.json' },
      baseOpts({ fetchIntegrity: fakeRegistry({ 'good-pkg': HASH_B }) }) // hash mismatch → error-tier
    );
    const out = formatReport(report, { format: 'human' });

    // error state: ✖ glyph, "N errors" label, detail (incl. "mismatched") in parens.
    expect(out).toMatch(/✖\s+Integrity \(registry\)\s+1 error\s+\(.*mismatched.*\)/);
    // warn state: ⚠ glyph, "N warnings" label.
    expect(out).toMatch(/⚠\s+Install scripts\s+1 warning\s+\(/);
    // pass state: ✓ glyph, fixed "ok" label — the check-specific phrasing
    // ("valid") is demoted to the trailing detail instead of being the status.
    expect(out).toMatch(/✓\s+Structure & format\s+ok\s+\(valid\)/);
    // skip state: · glyph, fixed "skipped" label.
    expect(out).toMatch(/·\s+Licenses\s+skipped\s+\(no node_modules\)/);
  });

  it('uses the same status phrasing for the same state across two different runs', async () => {
    const passOut = formatReport(
      await runReport({ lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' }, baseOpts()),
      { format: 'human' }
    );
    const lockfile2 = cleanLockfile();
    lockfile2.packages['node_modules/good-pkg'].hasInstallScript = true;
    const warnOut = formatReport(
      await runReport({ lockfile: lockfile2, packageJson: cleanPackageJson(), filePath: 'package-lock.json' }, baseOpts()),
      { format: 'human' }
    );
    // Structure & format is 'ok' in both runs — same fixed phrasing either way.
    expect(passOut).toMatch(/✓\s+Structure & format\s+ok\s+\(valid\)/);
    expect(warnOut).toMatch(/✓\s+Structure & format\s+ok\s+\(valid\)/);
    // Install scripts flips from ok to a warning — the vocabulary for each
    // state is the same fixed word, not a bespoke phrase per run.
    expect(passOut).toMatch(/✓\s+Install scripts\s+ok\s+\(none\)/);
    expect(warnOut).toMatch(/⚠\s+Install scripts\s+1 warning\s+\(/);
  });

  it('emits the shared finding-schema envelope under --format json', async () => {
    const report = await runReport({ lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: 'package-lock.json' }, baseOpts());
    const json = JSON.parse(formatReport(report, { format: 'json' }));
    // The six uniform core keys.
    expect(json.tool).toBe('npm-check');
    expect(typeof json.toolVersion).toBe('string');
    expect(json.schemaVersion).toBe('1.0');
    expect(json.target).toBe('package-lock.json');
    expect(Array.isArray(json.findings)).toBe(true);
    expect(json.summary.findings).toBe(json.findings.length); // never truncated
    expect(json.summary.exitCode).toBe(0); // clean report → exit 0
    expect(json.summary.bySeverity).toEqual({ critical: 0, high: 0, moderate: 0, low: 0, info: 0 });
    // The report's section grouping + gate signal (pass/errors/warnings) live under extra.
    expect(json.extra.sections).toHaveLength(17);
    expect(json.extra.summary.pass).toBe(true);
  });

  it('rejects an unknown format', () => {
    expect(() => formatReport({ filePath: 'x', sections: [], summary: { errors: 0, warnings: 0, total: 0 } }, { format: 'xml' }))
      .toThrow(ReportError);
  });
});
