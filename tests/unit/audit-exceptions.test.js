// tests/unit/audit-exceptions.test.js
// runAudit + formatAuditReport honoring `.dependably` exceptions (suppression).
import { runAudit, formatAuditReport } from '../../src/audit.js';
import { mergeConfig } from '../../src/audit-config.js';
import { parseExceptions } from '../../src/exceptions.js';

// A minimal v3 lockfile with one package that declares an install script.
function lockfileWithScript() {
  return {
    lockfileVersion: 3,
    name: 'proj',
    version: '1.0.0',
    packages: {
      '': { name: 'proj', version: '1.0.0' },
      'node_modules/sneaky-pkg': {
        version: '2.0.0',
        resolved: 'https://registry.npmjs.org/sneaky-pkg/-/sneaky-pkg-2.0.0.tgz',
        integrity: `sha512-${'a'.repeat(86)}==`,
        hasInstallScript: true
      }
    }
  };
}

// Isolate the install-scripts rule so suppression math is unambiguous: every
// other rule is off, so the only possible finding is the install script.
function isolatedConfig() {
  const config = mergeConfig({ rules: { 'install-scripts': 'warn' } });
  for (const id of Object.keys(config.rules)) {
    if (id !== 'install-scripts') config.rules[id].severity = 'off';
  }
  return config;
}

function configWith(exceptionEntries) {
  const config = isolatedConfig();
  config.exceptions = parseExceptions(exceptionEntries, {
    source: 'own', applicableSelectors: ['package', 'id']
  });
  return config;
}

const scriptFindings = (report) => report.findings.filter((f) => f.ruleId === 'install-scripts');

describe('runAudit suppression', () => {
  it('without an exception, the install-script finding is present and gates', () => {
    const config = isolatedConfig();
    config.maxWarnings = 0;
    const report = runAudit({ lockfile: lockfileWithScript() }, config);
    expect(scriptFindings(report)).toHaveLength(1);
    expect(report.summary.suppressed).toBe(0);
    expect(report.pass).toBe(false); // maxWarnings:0 and a warning present
  });

  it('a matching package exception suppresses the finding (no gate)', () => {
    const config = configWith([{ rule: 'install-scripts', package: 'sneaky-pkg', reason: 'vendored build tool' }]);
    config.maxWarnings = 0;
    const report = runAudit({ lockfile: lockfileWithScript() }, config);
    expect(scriptFindings(report)).toHaveLength(0);
    expect(report.suppressed).toHaveLength(1);
    expect(report.suppressed[0].ruleId).toBe('install-scripts');
    expect(report.suppressed[0].suppressed).toBe(true);
    expect(report.suppressed[0].suppressedBy).toBe('vendored build tool');
    expect(report.summary.suppressed).toBe(1);
    expect(report.pass).toBe(true); // the only warning was suppressed
  });

  it('a non-matching package exception is reported as unused', () => {
    const config = configWith([{ rule: 'install-scripts', package: 'other-pkg', reason: 'stale' }]);
    const report = runAudit({ lockfile: lockfileWithScript() }, config);
    expect(scriptFindings(report)).toHaveLength(1);
    expect(report.exceptionsMeta.unused).toHaveLength(1);
  });

  it('an expired exception does not suppress', () => {
    const config = configWith([{ rule: 'install-scripts', package: 'sneaky-pkg', reason: 'temp', expires: '2000-01-01' }]);
    const report = runAudit({ lockfile: lockfileWithScript() }, config);
    expect(scriptFindings(report)).toHaveLength(1);
    expect(report.exceptionsMeta.expired).toHaveLength(1);
  });
});

describe('formatAuditReport suppression output', () => {
  const suppressedReport = () => {
    const config = configWith([{ rule: 'install-scripts', package: 'sneaky-pkg', reason: 'vendored build tool' }]);
    return runAudit({ lockfile: lockfileWithScript() }, config);
  };

  it('stylish notes the suppressed count', () => {
    const out = formatAuditReport(suppressedReport(), { format: 'stylish' });
    expect(out).toMatch(/suppressed by \.dependably/);
  });

  it('--show-suppressed lists the suppressed finding and its reason', () => {
    const out = formatAuditReport(suppressedReport(), { format: 'stylish', showSuppressed: true });
    expect(out).toMatch(/suppressed by \.dependably:/);
    expect(out).toMatch(/vendored build tool/);
    expect(out).toMatch(/install-scripts/);
  });

  it('json carries the suppressed array', () => {
    const parsed = JSON.parse(formatAuditReport(suppressedReport(), { format: 'json' }));
    expect(parsed.suppressed).toHaveLength(1);
    expect(parsed.suppressed[0].suppressedBy).toBe('vendored build tool');
    expect(parsed.summary.suppressed).toBe(1);
  });
});
