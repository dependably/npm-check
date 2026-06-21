// tests/unit/audit-config.test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  loadAuditConfig,
  loadSharedConfig,
  findSharedConfig,
  mergeConfig,
  normalizeRuleEntry,
  DEFAULT_CONFIG,
  CONFIG_FILENAMES,
  SHARED_CONFIG_FILENAME,
  AuditConfigError
} from '../../src/audit-config.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-audit-config-'));
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

  it('discovers .npm-checkrc.json first', () => {
    fs.writeFileSync(path.join(tmpDir, '.npm-checkrc.json'), JSON.stringify({ maxWarnings: 5 }));
    fs.writeFileSync(path.join(tmpDir, 'npm-check.config.json'), JSON.stringify({ maxWarnings: 9 }));

    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(5);
    expect(config.configPath).toBe(path.join(tmpDir, '.npm-checkrc.json'));
  });

  it('falls back to npm-check.config.json', () => {
    fs.writeFileSync(path.join(tmpDir, 'npm-check.config.json'), JSON.stringify({ maxWarnings: 9 }));
    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(9);
  });

  it('explicit path wins over discovery', () => {
    fs.writeFileSync(path.join(tmpDir, '.npm-checkrc.json'), JSON.stringify({ maxWarnings: 5 }));
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
    fs.writeFileSync(path.join(tmpDir, '.npm-checkrc.json'), '{ not json');
    try {
      loadAuditConfig(tmpDir);
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuditConfigError);
      expect(e.code).toBe('CONFIG_PARSE');
    }
  });
});

describe('shared .dependably-check config', () => {
  it('discovers .dependably-check by walking up and adds its hosts to defaults', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), ''); // bound the walk-up at this dir
    fs.writeFileSync(
      path.join(tmpDir, SHARED_CONFIG_FILENAME),
      JSON.stringify({ common: { allowedRegistryHosts: ['dependably.northwardlabs.ca'] } })
    );

    const config = loadAuditConfig(tmpDir);
    const hosts = config.rules['secure-resolved'].options.allowedHosts;
    expect(hosts).toContain('registry.npmjs.org'); // public npm stays trusted
    expect(hosts).toContain('dependably.northwardlabs.ca');
    expect(config.sharedConfigPath).toBe(path.join(tmpDir, SHARED_CONFIG_FILENAME));
  });

  it('walks up from a nested cwd to find .dependably-check at the repo root', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), '');
    fs.writeFileSync(
      path.join(tmpDir, SHARED_CONFIG_FILENAME),
      JSON.stringify({ npm: { allowedRegistryHosts: ['npm.corp.example.com'] } })
    );
    const nested = path.join(tmpDir, 'a', 'b', 'c');
    fs.mkdirSync(nested, { recursive: true });

    expect(findSharedConfig(nested)).toBe(path.join(tmpDir, SHARED_CONFIG_FILENAME));
    const config = loadAuditConfig(nested);
    expect(config.rules['secure-resolved'].options.allowedHosts).toContain('npm.corp.example.com');
  });

  it('unions common.allowedRegistryHosts and npm.allowedRegistryHosts (deduped)', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), '');
    fs.writeFileSync(
      path.join(tmpDir, SHARED_CONFIG_FILENAME),
      JSON.stringify({
        common: { allowedRegistryHosts: ['shared.example.com', 'dup.example.com'] },
        npm: { allowedRegistryHosts: ['npm-only.example.com', 'dup.example.com'] },
        nuget: { allowedRegistryHosts: ['ignored.example.com'] }
      })
    );

    const { allowedRegistryHosts } = loadSharedConfig(tmpDir);
    expect(allowedRegistryHosts).toEqual(['shared.example.com', 'dup.example.com', 'npm-only.example.com']);
    expect(allowedRegistryHosts).not.toContain('ignored.example.com');
  });

  it('returns empty hosts when no .dependably-check exists', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), '');
    const { allowedRegistryHosts, sharedPath } = loadSharedConfig(tmpDir);
    expect(allowedRegistryHosts).toEqual([]);
    expect(sharedPath).toBeNull();
  });

  it('stops the walk-up at a .git directory (does not escape the repo)', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), '');
    const nested = path.join(tmpDir, 'sub');
    fs.mkdirSync(nested);
    // .dependably-check lives ABOVE the .git boundary — must not be found.
    expect(findSharedConfig(nested)).toBeNull();
  });

  it('precedence: explicit .npm-checkrc.json allowedHosts replaces, but shared hosts still extend it', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), '');
    fs.writeFileSync(
      path.join(tmpDir, '.npm-checkrc.json'),
      JSON.stringify({ rules: { 'secure-resolved': ['error', { allowedHosts: ['tool.example.com'] }] } })
    );
    fs.writeFileSync(
      path.join(tmpDir, SHARED_CONFIG_FILENAME),
      JSON.stringify({ common: { allowedRegistryHosts: ['shared.example.com'] } })
    );

    const config = loadAuditConfig(tmpDir);
    const hosts = config.rules['secure-resolved'].options.allowedHosts;
    // The tool config replaced the default (registry.npmjs.org gone),
    // and the shared host is added additively on top.
    expect(hosts).toEqual(['tool.example.com', 'shared.example.com']);
  });

  it('precedence: an explicit maxWarnings in .npm-checkrc.json wins over shared config', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), '');
    fs.writeFileSync(path.join(tmpDir, '.npm-checkrc.json'), JSON.stringify({ maxWarnings: 7 }));
    fs.writeFileSync(
      path.join(tmpDir, SHARED_CONFIG_FILENAME),
      JSON.stringify({ common: { allowedRegistryHosts: ['shared.example.com'] } })
    );

    const config = loadAuditConfig(tmpDir);
    expect(config.maxWarnings).toBe(7);
    expect(config.rules['secure-resolved'].options.allowedHosts).toContain('shared.example.com');
  });

  it('throws AuditConfigError with the path on malformed .dependably-check JSON', () => {
    fs.writeFileSync(path.join(tmpDir, '.git'), '');
    fs.writeFileSync(path.join(tmpDir, SHARED_CONFIG_FILENAME), '{ not valid json');
    try {
      loadAuditConfig(tmpDir);
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(AuditConfigError);
      expect(e.code).toBe('SHARED_CONFIG_PARSE');
      expect(e.context.sharedPath).toBe(path.join(tmpDir, SHARED_CONFIG_FILENAME));
    }
  });
});

describe('constants', () => {
  it('exposes the documented filenames and defaults', () => {
    expect(CONFIG_FILENAMES).toEqual(['.npm-checkrc.json', 'npm-check.config.json']);
    expect(Object.keys(DEFAULT_CONFIG.rules)).toHaveLength(14);
    expect(DEFAULT_CONFIG.rules['valid-package-json']).toBe('error');
    expect(DEFAULT_CONFIG.rules['valid-npmrc']).toEqual(['warn', {}]);
  });
});
