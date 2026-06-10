// tests/unit/audit-config.test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadAuditConfig,
  mergeConfig,
  normalizeRuleEntry,
  DEFAULT_CONFIG,
  CONFIG_FILENAMES,
  AuditConfigError
} from '../../src/audit-config.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npfix-audit-config-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('normalizeRuleEntry', () => {
  it('normalizes a bare severity string', () => {
    expect(normalizeRuleEntry('error')).toEqual({ severity: 'error', options: {} });
    expect(normalizeRuleEntry('off')).toEqual({ severity: 'off', options: {} });
  });

  it('normalizes [severity, options] tuples', () => {
    expect(normalizeRuleEntry(['warn', { minVersion: 2 }]))
      .toEqual({ severity: 'warn', options: { minVersion: 2 } });
  });

  it('rejects invalid severities and shapes', () => {
    expect(() => normalizeRuleEntry('fatal')).toThrow(AuditConfigError);
    expect(() => normalizeRuleEntry(42)).toThrow(AuditConfigError);
    expect(() => normalizeRuleEntry(['error', 'not-an-object'])).toThrow(AuditConfigError);
  });
});

describe('mergeConfig', () => {
  it('returns defaults for an empty user config', () => {
    const config = mergeConfig({});
    expect(config.maxWarnings).toBe(-1);
    expect(config.rules['lockfile-version']).toEqual({ severity: 'error', options: { minVersion: 3 } });
    expect(config.rules['pinned-versions'].severity).toBe('warn');
  });

  it('merges user options over rule defaults', () => {
    const config = mergeConfig({
      rules: { 'secure-resolved': ['error', { allowedHosts: ['npm.corp.example.com'] }] }
    });
    expect(config.rules['secure-resolved'].options.allowedHosts).toEqual(['npm.corp.example.com']);
    // untouched defaults survive the merge
    expect(config.rules['secure-resolved'].options.allowHttp).toBe(false);
    expect(config.rules['secure-resolved'].options.allowGit).toBe(true);
  });

  it('replaces severity without options', () => {
    const config = mergeConfig({ rules: { 'pinned-versions': 'error' } });
    expect(config.rules['pinned-versions'].severity).toBe('error');
    // default options preserved
    expect(config.rules['pinned-versions'].options.sections).toContain('dependencies');
  });

  it('rejects unknown rules', () => {
    expect(() => mergeConfig({ rules: { 'made-up-rule': 'error' } }))
      .toThrow(/Unknown rule "made-up-rule"/);
  });

  it('rejects non-integer maxWarnings', () => {
    expect(() => mergeConfig({ maxWarnings: 'lots' })).toThrow(AuditConfigError);
    expect(() => mergeConfig({ maxWarnings: 1.5 })).toThrow(AuditConfigError);
    expect(mergeConfig({ maxWarnings: 0 }).maxWarnings).toBe(0);
  });
});

describe('loadAuditConfig', () => {
  it('returns defaults when no config file exists', () => {
    const config = loadAuditConfig(tmpDir);
    expect(config.configPath).toBeNull();
    expect(config.rules['lockfile-version'].severity).toBe('error');
  });

  it('discovers .npfixrc.json first', () => {
    fs.writeFileSync(path.join(tmpDir, '.npfixrc.json'), JSON.stringify({ maxWarnings: 5 }));
    fs.writeFileSync(path.join(tmpDir, 'npfix.config.json'), JSON.stringify({ maxWarnings: 9 }));

    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(5);
    expect(config.configPath).toBe(path.join(tmpDir, '.npfixrc.json'));
  });

  it('falls back to npfix.config.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'npfix.config.json'), JSON.stringify({ maxWarnings: 9 }));
    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(9);
  });

  it('explicit path wins over discovery', () => {
    fs.writeFileSync(path.join(tmpDir, '.npfixrc.json'), JSON.stringify({ maxWarnings: 5 }));
    const explicit = path.join(tmpDir, 'custom.json');
    fs.writeFileSync(explicit, JSON.stringify({ maxWarnings: 2 }));

    const config = loadAuditConfig(tmpDir, explicit);
    expect(config.maxWarnings).toBe(2);
    expect(config.configPath).toBe(explicit);
  });

  it('throws CONFIG_NOT_FOUND for a missing explicit path', () => {
    expect(() => loadAuditConfig(tmpDir, path.join(tmpDir, 'nope.json')))
      .toThrow(AuditConfigError);
    try {
      loadAuditConfig(tmpDir, path.join(tmpDir, 'nope.json'));
    } catch (e) {
      expect(e.code).toBe('CONFIG_NOT_FOUND');
    }
  });

  it('throws CONFIG_PARSE on malformed JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.npfixrc.json'), '{ not json');
    try {
      loadAuditConfig(tmpDir);
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuditConfigError);
      expect(e.code).toBe('CONFIG_PARSE');
    }
  });
});

describe('constants', () => {
  it('exposes the documented filenames and defaults', () => {
    expect(CONFIG_FILENAMES).toEqual(['.npfixrc.json', 'npfix.config.json']);
    expect(Object.keys(DEFAULT_CONFIG.rules)).toHaveLength(8);
  });
});
