// tests/unit/audit.test.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runAudit, formatAuditReport, rules, AuditError } from '../../src/audit.js';

const GOOD_HASH = 'sha512-' + 'A'.repeat(86) + '==';

// Project dir on disk so filesystem-backed rules (unused-dependencies) see a
// source file importing the fixture's dependency
let projDir;
let projLockfilePath;

beforeAll(() => {
  projDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-audit-proj-'));
  fs.writeFileSync(path.join(projDir, 'app.js'), `import goodPkg from 'good-pkg';\n`);
  projLockfilePath = path.join(projDir, 'package-lock.json');
});

afterAll(() => {
  fs.rmSync(projDir, { recursive: true, force: true });
});

function cleanLockfile() {
  return {
    name: 'clean-project',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'clean-project', version: '1.0.0', dependencies: { 'good-pkg': '1.0.0' } },
      'node_modules/good-pkg': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/good-pkg/-/good-pkg-1.0.0.tgz',
        integrity: GOOD_HASH
      }
    }
  };
}

function cleanPackageJson() {
  return {
    name: 'clean-project',
    version: '1.0.0',
    license: 'MIT',
    dependencies: { 'good-pkg': '1.0.0' }
  };
}

describe('runAudit', () => {
  it('passes a clean lockfile with no findings', () => {
    const report = runAudit({
      lockfile: cleanLockfile(),
      packageJson: cleanPackageJson(),
      filePath: projLockfilePath
    });
    expect(report.findings).toEqual([]);
    expect(report.pass).toBe(true);
    expect(report.summary).toEqual({ errors: 0, warnings: 0, total: 0, byRule: {} });
  });

  it('throws without a lockfile', () => {
    expect(() => runAudit({})).toThrow(AuditError);
  });

  describe('lockfile-version rule', () => {
    it('fails lockfiles below the minimum version', () => {
      const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
      const report = runAudit({ lockfile, packageJson: cleanPackageJson() });

      const finding = report.findings.find((f) => f.ruleId === 'lockfile-version');
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('error');
      expect(finding.message).toMatch(/lockfileVersion is 2, minimum required is 3/);
      expect(report.pass).toBe(false);
    });

    it('respects a configured minVersion', () => {
      const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
      const report = runAudit(
        { lockfile, packageJson: cleanPackageJson() },
        { rules: { 'lockfile-version': ['error', { minVersion: 2 }] } }
      );
      expect(report.findings.filter((f) => f.ruleId === 'lockfile-version')).toEqual([]);
    });
  });

  describe('valid-structure rule', () => {
    it('reports validator errors', () => {
      const lockfile = cleanLockfile();
      delete lockfile.name;
      const report = runAudit({ lockfile, packageJson: cleanPackageJson() });

      const finding = report.findings.find((f) => f.ruleId === 'valid-structure');
      expect(finding).toBeDefined();
      expect(finding.severity).toBe('error');
    });
  });

  describe('integrity-hygiene rule', () => {
    it('flags missing, placeholder, and sha1 hashes', () => {
      const lockfile = cleanLockfile();
      lockfile.packages['node_modules/no-hash'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/no-hash/-/no-hash-1.0.0.tgz'
      };
      lockfile.packages['node_modules/placeholder'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/placeholder/-/placeholder-1.0.0.tgz',
        integrity: 'sha512-PLACEHOLDER'
      };
      lockfile.packages['node_modules/old-hash'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/old-hash/-/old-hash-1.0.0.tgz',
        integrity: 'sha1-abc123'
      };

      const report = runAudit({ lockfile, packageJson: cleanPackageJson() });
      const hygiene = report.findings.filter((f) => f.ruleId === 'integrity-hygiene');
      expect(hygiene).toHaveLength(3);
      expect(hygiene.map((f) => f.packagePath).sort()).toEqual([
        'node_modules/no-hash', 'node_modules/old-hash', 'node_modules/placeholder'
      ]);
    });

    it('exempts git deps and allows sha1 when configured', () => {
      const lockfile = cleanLockfile();
      lockfile.packages['node_modules/git-dep'] = {
        version: '1.0.0',
        resolved: 'git+https://github.com/user/repo.git#abc'
      };
      lockfile.packages['node_modules/old-hash'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/old-hash/-/old-hash-1.0.0.tgz',
        integrity: 'sha1-abc123'
      };

      const report = runAudit(
        { lockfile, packageJson: cleanPackageJson() },
        { rules: { 'integrity-hygiene': ['error', { allowSha1: true }], 'secure-resolved': 'off' } }
      );
      expect(report.findings.filter((f) => f.ruleId === 'integrity-hygiene')).toEqual([]);
    });
  });

  describe('secure-resolved rule', () => {
    it('flags http URLs and untrusted hosts', () => {
      const lockfile = cleanLockfile();
      lockfile.packages['node_modules/insecure'] = {
        version: '1.0.0',
        resolved: 'http://registry.npmjs.org/insecure/-/insecure-1.0.0.tgz',
        integrity: GOOD_HASH
      };
      lockfile.packages['node_modules/foreign'] = {
        version: '1.0.0',
        resolved: 'https://evil-mirror.example.com/foreign/-/foreign-1.0.0.tgz',
        integrity: GOOD_HASH
      };

      const report = runAudit({ lockfile, packageJson: cleanPackageJson() });
      const secure = report.findings.filter((f) => f.ruleId === 'secure-resolved');
      expect(secure).toHaveLength(2);
      expect(secure.find((f) => f.packagePath === 'node_modules/insecure').message).toMatch(/non-TLS/);
      expect(secure.find((f) => f.packagePath === 'node_modules/foreign').message).toMatch(/untrusted registry host/);
    });

    it('honors allowedHosts, allowHttp, and allowGit options', () => {
      const lockfile = cleanLockfile();
      lockfile.packages['node_modules/corp'] = {
        version: '1.0.0',
        resolved: 'https://npm.corp.example.com/corp/-/corp-1.0.0.tgz',
        integrity: GOOD_HASH
      };
      lockfile.packages['node_modules/git-dep'] = {
        version: '1.0.0',
        resolved: 'git+https://github.com/user/repo.git#abc'
      };

      const report = runAudit(
        { lockfile, packageJson: cleanPackageJson() },
        {
          rules: {
            'secure-resolved': ['error', { allowedHosts: ['registry.npmjs.org', 'npm.corp.example.com'], allowGit: false }],
            'integrity-hygiene': 'off'
          }
        }
      );
      const secure = report.findings.filter((f) => f.ruleId === 'secure-resolved');
      expect(secure).toHaveLength(1);
      expect(secure[0].packagePath).toBe('node_modules/git-dep');
      expect(secure[0].message).toMatch(/git dependency not allowed/);
    });
  });

  describe('install-scripts rule', () => {
    function lockfileWithInstallScripts() {
      const lockfile = cleanLockfile();
      lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
      lockfile.packages['node_modules/sneaky-pkg'] = {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/sneaky-pkg/-/sneaky-pkg-2.0.0.tgz',
        integrity: GOOD_HASH,
        hasInstallScript: true
      };
      return lockfile;
    }

    it('flags every package with a lifecycle install script', () => {
      const report = runAudit({ lockfile: lockfileWithInstallScripts(), packageJson: cleanPackageJson() });
      const scripts = report.findings.filter((f) => f.ruleId === 'install-scripts');
      expect(scripts).toHaveLength(2);
      expect(scripts[0].severity).toBe('warn');
      expect(scripts.map((f) => f.packagePath).sort())
        .toEqual(['node_modules/good-pkg', 'node_modules/sneaky-pkg']);
      expect(scripts.find((f) => f.packagePath === 'node_modules/sneaky-pkg').message)
        .toMatch(/runs a lifecycle install script/);
    });

    it('honors the allow list', () => {
      const report = runAudit(
        { lockfile: lockfileWithInstallScripts(), packageJson: cleanPackageJson() },
        { rules: { 'install-scripts': ['warn', { allow: ['good-pkg'] }] } }
      );
      const scripts = report.findings.filter((f) => f.ruleId === 'install-scripts');
      expect(scripts).toHaveLength(1);
      expect(scripts[0].packagePath).toBe('node_modules/sneaky-pkg');
    });

    it('produces no findings when no package declares an install script', () => {
      const report = runAudit({ lockfile: cleanLockfile(), packageJson: cleanPackageJson() });
      expect(report.findings.filter((f) => f.ruleId === 'install-scripts')).toEqual([]);
    });
  });

  describe('pinned-versions rule', () => {
    it('warns on caret/tilde ranges with resolved versions', () => {
      const packageJson = cleanPackageJson();
      packageJson.dependencies['good-pkg'] = '^1.0.0';
      packageJson.devDependencies = { 'tilde-pkg': '~2.0.0' };

      const report = runAudit({ lockfile: cleanLockfile(), packageJson });
      const pinned = report.findings.filter((f) => f.ruleId === 'pinned-versions');
      expect(pinned).toHaveLength(2);
      expect(pinned[0].severity).toBe('warn');
      expect(pinned.find((f) => f.packagePath === 'package.json#dependencies/good-pkg').message)
        .toMatch(/range "\^1\.0\.0" is not pinned \(resolved: 1\.0\.0\)/);
    });

    it('honors the ignore list and complex ranges are not findings', () => {
      const packageJson = cleanPackageJson();
      packageJson.dependencies['good-pkg'] = '^1.0.0';
      packageJson.dependencies['range-pkg'] = '>=1.0.0';

      const report = runAudit(
        { lockfile: cleanLockfile(), packageJson },
        { rules: { 'pinned-versions': ['warn', { ignore: ['good-pkg'] }] } }
      );
      expect(report.findings.filter((f) => f.ruleId === 'pinned-versions')).toEqual([]);
    });

    it('emits a single warning when package.json is missing', () => {
      const report = runAudit({ lockfile: cleanLockfile(), packageJson: null });
      const pinned = report.findings.filter((f) => f.ruleId === 'pinned-versions');
      expect(pinned).toHaveLength(1);
      expect(pinned[0].severity).toBe('warn');
      expect(pinned[0].message).toMatch(/rule skipped/);
    });
  });

  describe('lockfile-sync rule', () => {
    it('passes when package.json and the lockfile agree', () => {
      const report = runAudit({
        lockfile: cleanLockfile(),
        packageJson: cleanPackageJson(),
        filePath: projLockfilePath
      });
      expect(report.findings.filter((f) => f.ruleId === 'lockfile-sync')).toEqual([]);
    });

    it('flags deps declared in package.json but missing from the lockfile', () => {
      const packageJson = cleanPackageJson();
      packageJson.dependencies['brand-new-pkg'] = '^1.0.0';

      const report = runAudit({ lockfile: cleanLockfile(), packageJson, filePath: projLockfilePath });
      const sync = report.findings.filter((f) => f.ruleId === 'lockfile-sync');
      expect(sync.some((f) => f.packagePath === 'package.json#dependencies/brand-new-pkg' && /missing from the lockfile root/.test(f.message))).toBe(true);
      expect(sync.some((f) => /not installed in the lockfile packages map/.test(f.message))).toBe(true);
      expect(report.pass).toBe(false);
    });

    it('flags range mismatches and lockfile-only leftovers', () => {
      const lockfile = cleanLockfile();
      lockfile.packages[''].dependencies['good-pkg'] = '^0.9.0'; // drifted range
      lockfile.packages[''].dependencies['removed-pkg'] = '2.0.0'; // no longer declared
      lockfile.packages['node_modules/removed-pkg'] = {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/removed-pkg/-/removed-pkg-2.0.0.tgz',
        integrity: GOOD_HASH
      };

      const report = runAudit({ lockfile, packageJson: cleanPackageJson(), filePath: projLockfilePath });
      const sync = report.findings.filter((f) => f.ruleId === 'lockfile-sync');
      expect(sync.some((f) => /range mismatch/.test(f.message))).toBe(true);
      expect(sync.some((f) => f.packagePath === 'package-lock.json#dependencies/removed-pkg' && /not declared in package.json/.test(f.message))).toBe(true);
    });

    it('flags name/version mismatches', () => {
      const packageJson = { ...cleanPackageJson(), version: '2.0.0' };
      const report = runAudit({ lockfile: cleanLockfile(), packageJson, filePath: projLockfilePath });
      const sync = report.findings.filter((f) => f.ruleId === 'lockfile-sync');
      expect(sync.some((f) => /version mismatch/.test(f.message))).toBe(true);
    });
  });

  describe('no-orphan-packages rule', () => {
    it('flags unreachable lockfile entries with a prune hint', () => {
      const lockfile = cleanLockfile();
      lockfile.packages['node_modules/orphan'] = {
        version: '9.9.9',
        resolved: 'https://registry.npmjs.org/orphan/-/orphan-9.9.9.tgz',
        integrity: GOOD_HASH
      };

      const report = runAudit({ lockfile, packageJson: cleanPackageJson(), filePath: projLockfilePath });
      const orphans = report.findings.filter((f) => f.ruleId === 'no-orphan-packages');
      expect(orphans).toHaveLength(1);
      expect(orphans[0].severity).toBe('warn');
      expect(orphans[0].packagePath).toBe('node_modules/orphan');
      expect(orphans[0].message).toMatch(/npm-check prune/);
    });
  });

  describe('unused-dependencies rule', () => {
    it('flags declared deps that are never imported', () => {
      const packageJson = cleanPackageJson();
      packageJson.dependencies['never-imported'] = '^1.0.0';
      const lockfile = cleanLockfile();
      lockfile.packages[''].dependencies['never-imported'] = '^1.0.0';
      lockfile.packages['node_modules/never-imported'] = {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/never-imported/-/never-imported-1.0.0.tgz',
        integrity: GOOD_HASH
      };

      const report = runAudit({ lockfile, packageJson, filePath: projLockfilePath });
      const unused = report.findings.filter((f) => f.ruleId === 'unused-dependencies');
      expect(unused).toHaveLength(1);
      expect(unused[0].severity).toBe('warn');
      expect(unused[0].packagePath).toBe('package.json#dependencies/never-imported');
      expect(unused[0].message).toMatch(/flagged for removal/);
      // imported dep is not flagged
      expect(unused.some((f) => f.packagePath.includes('good-pkg'))).toBe(false);
    });

    it('honors the ignore option', () => {
      const packageJson = cleanPackageJson();
      packageJson.dependencies['config-plugin'] = '^1.0.0';

      const report = runAudit(
        { lockfile: cleanLockfile(), packageJson, filePath: projLockfilePath },
        { rules: { 'unused-dependencies': ['warn', { ignore: ['config-plugin'] }], 'lockfile-sync': 'off' } }
      );
      expect(report.findings.filter((f) => f.ruleId === 'unused-dependencies')).toEqual([]);
    });
  });

  describe('no-fund rule', () => {
    function lockfileWithFunding() {
      const lockfile = cleanLockfile();
      lockfile.packages['node_modules/good-pkg'].funding = {
        type: 'opencollective',
        url: 'https://opencollective.com/good'
      };
      return lockfile;
    }

    it('flags packages that emit funding solicitations', () => {
      const report = runAudit({
        lockfile: lockfileWithFunding(),
        packageJson: cleanPackageJson(),
        filePath: projLockfilePath
      });
      const fund = report.findings.filter((f) => f.ruleId === 'no-fund');
      expect(fund).toHaveLength(1);
      expect(fund[0].severity).toBe('warn');
      expect(fund[0].packagePath).toBe('.npmrc');
      expect(fund[0].message).toMatch(/1 package emit/);
      expect(fund[0].message).toMatch(/fund=false/);
    });

    it('does not flag when no package declares funding', () => {
      const report = runAudit({
        lockfile: cleanLockfile(),
        packageJson: cleanPackageJson(),
        filePath: projLockfilePath
      });
      expect(report.findings.filter((f) => f.ruleId === 'no-fund')).toEqual([]);
    });

    it('is silenced by a project .npmrc with fund=false', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-fund-'));
      try {
        fs.writeFileSync(path.join(dir, '.npmrc'), 'fund = false\n');
        const report = runAudit({
          lockfile: lockfileWithFunding(),
          packageJson: cleanPackageJson(),
          filePath: path.join(dir, 'package-lock.json')
        });
        expect(report.findings.filter((f) => f.ruleId === 'no-fund')).toEqual([]);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('still flags when .npmrc sets fund=true', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-fund-'));
      try {
        fs.writeFileSync(path.join(dir, '.npmrc'), 'fund=true\n');
        const report = runAudit({
          lockfile: lockfileWithFunding(),
          packageJson: cleanPackageJson(),
          filePath: path.join(dir, 'package-lock.json')
        });
        expect(report.findings.filter((f) => f.ruleId === 'no-fund')).toHaveLength(1);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  describe('severity and pass semantics', () => {
    it('skips rules set to off', () => {
      const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
      const report = runAudit(
        { lockfile, packageJson: cleanPackageJson() },
        { rules: { 'lockfile-version': 'off' } }
      );
      expect(report.findings.filter((f) => f.ruleId === 'lockfile-version')).toEqual([]);
      expect(report.pass).toBe(true);
    });

    it('downgraded rules produce warnings that pass by default', () => {
      const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
      const report = runAudit(
        { lockfile, packageJson: cleanPackageJson(), filePath: projLockfilePath },
        { rules: { 'lockfile-version': 'warn' } }
      );
      expect(report.summary.errors).toBe(0);
      expect(report.summary.warnings).toBe(1);
      expect(report.pass).toBe(true);
    });

    it('maxWarnings turns excess warnings into failure', () => {
      const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
      const report = runAudit(
        { lockfile, packageJson: cleanPackageJson() },
        { maxWarnings: 0, rules: { 'lockfile-version': 'warn' } }
      );
      expect(report.pass).toBe(false);
    });

    it('counts findings per rule in the summary', () => {
      const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
      const report = runAudit({ lockfile, packageJson: cleanPackageJson() });
      expect(report.summary.byRule['lockfile-version']).toEqual({ errors: 1, warnings: 0 });
    });
  });
});

describe('formatAuditReport', () => {
  it('formats a clean report', () => {
    const report = runAudit({
      lockfile: cleanLockfile(),
      packageJson: cleanPackageJson(),
      filePath: projLockfilePath
    });
    const output = formatAuditReport(report);
    expect(output).toContain('package-lock.json');
    expect(output).toContain('no problems found');
  });

  it('formats findings in stylish layout with a summary line', () => {
    const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
    const packageJson = cleanPackageJson();
    packageJson.dependencies['good-pkg'] = '^1.0.0';

    const report = runAudit({ lockfile, packageJson });
    const output = formatAuditReport(report);

    expect(output).toContain('error');
    expect(output).toContain('lockfile-version');
    expect(output).toContain('pinned-versions');
    expect(output).toMatch(/✖ \d+ problems \(\d+ errors?, \d+ warnings?\)/);
  });

  it('emits machine-readable JSON', () => {
    const lockfile = { ...cleanLockfile(), lockfileVersion: 2 };
    const report = runAudit({ lockfile, packageJson: cleanPackageJson() });
    const parsed = JSON.parse(formatAuditReport(report, { format: 'json' }));

    expect(parsed.pass).toBe(false);
    expect(parsed.summary.errors).toBeGreaterThan(0);
    expect(Array.isArray(parsed.findings)).toBe(true);
  });

  it('throws on unknown formats', () => {
    const report = runAudit({ lockfile: cleanLockfile(), packageJson: cleanPackageJson() });
    expect(() => formatAuditReport(report, { format: 'xml' })).toThrow(AuditError);
  });
});

describe('rules registry', () => {
  it('exposes all fourteen rules with ids and check functions', () => {
    expect(rules.map((r) => r.id)).toEqual([
      'lockfile-version',
      'valid-structure',
      'valid-package-json',
      'integrity-hygiene',
      'secure-resolved',
      'install-scripts',
      'no-git-deps',
      'no-remote-deps',
      'pinned-versions',
      'lockfile-sync',
      'no-orphan-packages',
      'unused-dependencies',
      'no-fund',
      'valid-npmrc'
    ]);
    rules.forEach((rule) => expect(typeof rule.check).toBe('function'));
  });
});

describe('valid-package-json rule', () => {
  it('emits error findings for a broken manifest', () => {
    const packageJson = { name: 'BAD NAME', version: 'nope' };
    const report = runAudit({ lockfile: cleanLockfile(), packageJson, filePath: projLockfilePath });
    const findings = report.findings.filter((f) => f.ruleId === 'valid-package-json');
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.every((f) => f.packagePath === 'package.json')).toBe(true);
    expect(findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it('emits a single warn skip finding when package.json is absent', () => {
    const report = runAudit({ lockfile: cleanLockfile(), packageJson: null, filePath: projLockfilePath });
    const findings = report.findings.filter((f) => f.ruleId === 'valid-package-json');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('warn');
    expect(findings[0].message).toMatch(/not found/);
  });
});

describe('valid-npmrc rule', () => {
  let npmrcDir;
  let npmrcLockPath;

  beforeEach(() => {
    npmrcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-npmrc-'));
    npmrcLockPath = path.join(npmrcDir, 'package-lock.json');
  });
  afterEach(() => {
    fs.rmSync(npmrcDir, { recursive: true, force: true });
  });

  it('produces no findings when .npmrc is absent', () => {
    const report = runAudit({ lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: npmrcLockPath });
    expect(report.findings.filter((f) => f.ruleId === 'valid-npmrc')).toEqual([]);
  });

  it('flags issues in a project .npmrc next to the lockfile', () => {
    fs.writeFileSync(path.join(npmrcDir, '.npmrc'), 'made-up-key=1\n');
    const report = runAudit({ lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: npmrcLockPath });
    const findings = report.findings.filter((f) => f.ruleId === 'valid-npmrc');
    expect(findings.length).toBe(1);
    expect(findings[0].packagePath).toBe('.npmrc');
  });

  it('honours the npmrcPath option override', () => {
    const custom = path.join(npmrcDir, 'custom-npmrc');
    fs.writeFileSync(custom, 'made-up-key=1\n');
    const report = runAudit(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: npmrcLockPath },
      { rules: { 'valid-npmrc': ['warn', { npmrcPath: custom }] } }
    );
    expect(report.findings.filter((f) => f.ruleId === 'valid-npmrc').length).toBe(1);
  });

  it('forces security findings to error even when the rule is configured warn', () => {
    fs.writeFileSync(path.join(npmrcDir, '.npmrc'), 'strict-ssl=false\n');
    const report = runAudit(
      { lockfile: cleanLockfile(), packageJson: cleanPackageJson(), filePath: npmrcLockPath },
      { rules: { 'valid-npmrc': 'warn' } }
    );
    const findings = report.findings.filter((f) => f.ruleId === 'valid-npmrc');
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(report.pass).toBe(false);
  });
});

describe('install-scripts allowScripts reconciliation (npm v12)', () => {
  function lockfileWithScripts() {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/good-pkg'].hasInstallScript = true;
    lockfile.packages['node_modules/sneaky'] = {
      name: 'sneaky', version: '2.0.0', integrity: GOOD_HASH,
      resolved: 'https://registry.npmjs.org/sneaky/-/sneaky-2.0.0.tgz',
      hasInstallScript: true
    };
    return lockfile;
  }

  it('treats pinned and name-only allowScripts entries as approved', () => {
    const packageJson = cleanPackageJson();
    packageJson.allowScripts = { 'good-pkg@1.0.0': true, 'sneaky': true };
    const report = runAudit({ lockfile: lockfileWithScripts(), packageJson });
    expect(report.findings.filter((f) => f.ruleId === 'install-scripts')).toEqual([]);
  });

  it('flags packages not approved (pending) and explicitly denied under v12', () => {
    const packageJson = cleanPackageJson();
    packageJson.allowScripts = { 'good-pkg@1.0.0': true, 'sneaky': false };
    const report = runAudit({ lockfile: lockfileWithScripts(), packageJson });
    const scripts = report.findings.filter((f) => f.ruleId === 'install-scripts');
    expect(scripts).toHaveLength(1);
    expect(scripts[0].packagePath).toBe('node_modules/sneaky');
    expect(scripts[0].message).toMatch(/denied/);
  });

  it('without allowScripts, flags every install-script package (pre-v12)', () => {
    const report = runAudit({ lockfile: lockfileWithScripts(), packageJson: cleanPackageJson() });
    expect(report.findings.filter((f) => f.ruleId === 'install-scripts')).toHaveLength(2);
  });
});

describe('no-git-deps and no-remote-deps rules (npm v12 opt-ins)', () => {
  it('flags git and remote-URL deps, leaving registry deps alone', () => {
    const lockfile = cleanLockfile();
    lockfile.packages['node_modules/fromgit'] = { name: 'fromgit', version: '1.0.0', resolved: 'git+https://github.com/a/b.git#abc' };
    lockfile.packages['node_modules/fromurl'] = { name: 'fromurl', version: '1.0.0', resolved: 'https://example.com/fromurl-1.0.0.tgz', integrity: GOOD_HASH };
    const report = runAudit({ lockfile, packageJson: cleanPackageJson() });

    const git = report.findings.filter((f) => f.ruleId === 'no-git-deps');
    expect(git).toHaveLength(1);
    expect(git[0].packagePath).toBe('node_modules/fromgit');
    expect(git[0].message).toMatch(/--allow-git/);

    const remote = report.findings.filter((f) => f.ruleId === 'no-remote-deps');
    expect(remote).toHaveLength(1);
    expect(remote[0].packagePath).toBe('node_modules/fromurl');
    expect(remote[0].message).toMatch(/--allow-remote/);
  });

  it('does not flag normal registry tarballs as remote', () => {
    const report = runAudit({ lockfile: cleanLockfile(), packageJson: cleanPackageJson() });
    expect(report.findings.filter((f) => f.ruleId === 'no-remote-deps')).toEqual([]);
    expect(report.findings.filter((f) => f.ruleId === 'no-git-deps')).toEqual([]);
  });
});
