// tests/unit/audit-config-dependably.test.js
// Coverage for the unified `.dependably` config behavior (rename, section
// aliasing, single merge rule, failOn, version, exceptions, warnings).
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadAuditConfig,
  loadSharedConfig,
  findSharedConfig,
  SHARED_CONFIG_FILENAME,
  DEPRECATED_SHARED_CONFIG_FILENAME,
  AuditConfigError
} from '../../src/audit-config.js';

let tmpDir;
const write = (name, obj) => fs.writeFileSync(path.join(tmpDir, name), typeof obj === 'string' ? obj : JSON.stringify(obj));
const git = () => fs.writeFileSync(path.join(tmpDir, '.git'), '');
const codes = (config) => (config.warnings || []).map((w) => w.code);

beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-dependably-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe('filename rename + discovery', () => {
  it('discovers .dependably (canonical, no warning)', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { maxWarnings: 4 } });
    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(4);
    expect(codes(config)).not.toContain('DEPRECATED_FILENAME');
  });

  it('discovers .dependably-check with a DEPRECATED_FILENAME warning', () => {
    git();
    write(DEPRECATED_SHARED_CONFIG_FILENAME, { 'npm-check': { maxWarnings: 4 } });
    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(4);
    expect(codes(config)).toContain('DEPRECATED_FILENAME');
  });

  it('prefers .dependably over .dependably-check and warns BOTH_FILES_PRESENT', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { maxWarnings: 1 } });
    write(DEPRECATED_SHARED_CONFIG_FILENAME, { 'npm-check': { maxWarnings: 99 } });
    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(1);
    expect(codes(config)).toContain('BOTH_FILES_PRESENT');
    expect(findSharedConfig(tmpDir)).toBe(path.join(tmpDir, SHARED_CONFIG_FILENAME));
  });
});

describe('section aliasing', () => {
  it('reads the canonical npm-check section without warning', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { rules: { 'no-fund': 'off' } } });
    const config = loadAuditConfig(tmpDir);
    expect(config.rules['no-fund'].severity).toBe('off');
    expect(codes(config)).not.toContain('DEPRECATED_ALIAS_SECTION');
  });

  it('reads the npm alias section with DEPRECATED_ALIAS_SECTION', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { npm: { rules: { 'no-fund': 'off' } } });
    const config = loadAuditConfig(tmpDir);
    expect(config.rules['no-fund'].severity).toBe('off');
    expect(codes(config)).toContain('DEPRECATED_ALIAS_SECTION');
  });

  it('canonical wins when both npm-check and npm are present', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      'npm-check': { maxWarnings: 2 },
      npm: { maxWarnings: 99 }
    });
    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(2);
    expect(codes(config)).toContain('DEPRECATED_ALIAS_SECTION');
  });
});

describe('single merge rule (common <-> tool)', () => {
  it('drops a sibling tool\'s rule id from common rather than erroring on it', () => {
    // `common` is shared, so a rule id npm-check does not know there belongs to another tool.
    // Before this was handled, common.rules was merged into the tool map and then validated
    // against npm-check's registry, so any sibling configuring one of its own rules made the
    // shared config unloadable for npm-check.
    write(SHARED_CONFIG_FILENAME, {
      common: { rules: { cyclomatic: ['error', { max: 25 }] } },
      'npm-check': { rules: { 'no-git-deps': 'error' } }
    });

    const config = loadAuditConfig(tmpDir);

    expect(config.rules['no-git-deps'].severity).toBe('error');
    expect(config.rules.cyclomatic).toBeUndefined();
  });

  it('still rejects an unknown rule id in npm-check\'s own section', () => {
    // The other half of the rule: an id npm-check does not know in its OWN section is a typo,
    // not a sibling's, and must keep erroring. Without this the fix above could overshoot.
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { rules: { 'no-such-rule': 'error' } } });

    expect(() => loadAuditConfig(tmpDir)).toThrow(/no-such-rule/);
  });

  it('merges rules per id: distinct ids union, shared id replaced by tool', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { rules: { 'no-git-deps': 'error', 'install-scripts': 'warn' } },
      'npm-check': { rules: { 'install-scripts': 'off' } }
    });
    const config = loadAuditConfig(tmpDir);
    expect(config.rules['no-git-deps'].severity).toBe('error');   // from common
    expect(config.rules['install-scripts'].severity).toBe('off'); // tool wins
  });

  it('unions exclude across common and tool', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { exclude: ['dist/**'] },
      'npm-check': { exclude: ['dist/**', 'vendor/**'] }
    });
    const config = loadAuditConfig(tmpDir);
    expect(config.exclude).toEqual(['dist/**', 'vendor/**']);
  });
});

describe('failOn', () => {
  it('failOn.count maps to maxWarnings', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { failOn: { count: 3 } } });
    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(3);
  });

  it('failOn.severity is exposed as failOnSeverity', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { failOn: { severity: 'high' } } });
    const config = loadAuditConfig(tmpDir);
    expect(config.failOnSeverity).toBe('high');
  });

  it('failOn merges per key: tool severity over common, common count kept', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { failOn: { severity: 'high', count: 5 } },
      'npm-check': { failOn: { severity: 'moderate' } }
    });
    const config = loadAuditConfig(tmpDir);
    expect(config.failOnSeverity).toBe('moderate');
    expect(config.maxWarnings).toBe(5);
  });

  it('rejects a negative failOn.count', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { failOn: { count: -2 } } });
    expect(() => loadAuditConfig(tmpDir)).toThrow(expect.objectContaining({ code: 'INVALID_FAIL_ON' }));
  });
});

describe('version + shape validation', () => {
  it('accepts version 1', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { version: 1, 'npm-check': { maxWarnings: 0 } });
    expect(loadAuditConfig(tmpDir).maxWarnings).toBe(0);
  });

  it('rejects a version above supported with CONFIG_VERSION', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { version: 99, 'npm-check': {} });
    expect(() => loadAuditConfig(tmpDir)).toThrow(expect.objectContaining({ code: 'CONFIG_VERSION' }));
  });

  it('rejects a non-object root with CONFIG_SHAPE', () => {
    git();
    write(SHARED_CONFIG_FILENAME, '["not","an","object"]');
    expect(() => loadAuditConfig(tmpDir)).toThrow(expect.objectContaining({ code: 'CONFIG_SHAPE' }));
  });
});

describe('exceptions', () => {
  it('parses common + own exceptions onto config.exceptions', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { exceptions: [{ rule: 'install-scripts', package: 'a', reason: 'x' }] },
      'npm-check': { exceptions: [{ rule: 'unused-dependencies', package: 'b', reason: 'y' }] }
    });
    const config = loadAuditConfig(tmpDir);
    expect(config.exceptions).toHaveLength(2);
    expect(config.exceptions.map((e) => e.source).sort()).toEqual(['common', 'own']);
  });

  it('rejects an inapplicable selector (symbol) in the own section', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      'npm-check': { exceptions: [{ rule: 'install-scripts', symbol: 'Foo.Bar', reason: 'x' }] }
    });
    expect(() => loadAuditConfig(tmpDir)).toThrow(expect.objectContaining({ code: 'EXCEPTION_BAD_SELECTOR' }));
  });

  it('tolerates an unknown rule id in common (sibling tool)', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { exceptions: [{ rule: 'cyclomatic', path: 'src/**', reason: 'x' }] },
      'npm-check': {}
    });
    expect(loadAuditConfig(tmpDir).exceptions).toHaveLength(1);
  });

  it('rejects an unknown rule id in the own section', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      'npm-check': { exceptions: [{ rule: 'no-such-rule', package: 'a', reason: 'x' }] }
    });
    expect(() => loadAuditConfig(tmpDir)).toThrow(expect.objectContaining({ code: 'UNKNOWN_RULE' }));
  });
});

describe('unknown keys', () => {
  it('warns UNKNOWN_KEY for an unrecognized key in the own section', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { 'npm-check': { exclde: ['typo/**'], maxWarnings: 1 } });
    const config = loadAuditConfig(tmpDir);
    expect(codes(config)).toContain('UNKNOWN_KEY');
    expect(config.maxWarnings).toBe(1);
  });

  it('ignores an unrecognized key in common (belongs to a sibling tool)', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { allowedRegistryHosts: ['registry.example.com'], ignoreUnusedPackages: ['some-sibling-tool-key'] },
      'npm-check': { failOn: { count: 1 } }
    });
    const config = loadAuditConfig(tmpDir);
    expect(codes(config)).not.toContain('UNKNOWN_KEY');
    expect(config.maxWarnings).toBe(1);
  });

  it('still warns for the own section when common also carries a sibling key', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { terms: ['sibling-owned'] },
      'npm-check': { exclde: ['typo/**'] }
    });
    const messages = (loadAuditConfig(tmpDir).warnings || [])
      .filter((w) => w.code === 'UNKNOWN_KEY').map((w) => w.message);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain('npm-check.exclde');
  });
});

describe('loadSharedConfig extras', () => {
  it('lowercases and dedupes hosts across common + tool', () => {
    git();
    write(SHARED_CONFIG_FILENAME, {
      common: { allowedRegistryHosts: ['Corp.Example.COM'] },
      'npm-check': { allowedRegistryHosts: ['corp.example.com', 'other.example.com'] }
    });
    const { allowedRegistryHosts } = loadSharedConfig(tmpDir);
    expect(allowedRegistryHosts).toEqual(['corp.example.com', 'other.example.com']);
  });

  it('returns AuditConfigError instances for bad config', () => {
    git();
    write(SHARED_CONFIG_FILENAME, { version: 99, 'npm-check': {} });
    try {
      loadAuditConfig(tmpDir);
      throw new Error('expected throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuditConfigError);
    }
  });
});
