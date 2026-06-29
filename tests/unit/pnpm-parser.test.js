// tests/unit/pnpm-parser.test.js
import path from 'path';
import { fileURLToPath } from 'url';
import { parseLockfile } from '../../src/parser.js';
import { checkIntegrity } from '../../src/checker.js';
import { checkVulnerabilities } from '../../src/vuln.js';
import { checkDeprecations } from '../../src/deprecation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_PATH = path.join(__dirname, '../fixtures/pnpm-basic/pnpm-lock.yaml');

// Integrity strings as written in the fixture.
const INTEGRITY = {
  lodash: 'sha512-' + 'A'.repeat(86) + '==',
  '@scope/util': 'sha512-' + 'B'.repeat(86) + '==',
  'left-pad': 'sha512-' + 'C'.repeat(86) + '==',
  '@scope/peer-thing': 'sha512-' + 'D'.repeat(86) + '=='
};

describe('parseLockfile (pnpm)', () => {
  test('parses pnpm-lock.yaml and stamps non-enumerable __npmCheckMeta', () => {
    const lf = parseLockfile(LOCK_PATH);
    expect(lf.lockfileVersion).toBe('9.0');
    expect(lf.__npmCheckMeta.flavor).toBe('pnpm');
    // .npmrc next to the lockfile drives registry config
    expect(lf.__npmCheckMeta.registry).toBe('https://registry.npmjs.org/');
    expect(lf.__npmCheckMeta.scopedRegistries['@scope']).toBe('https://npm.mycorp.example/');
  });

  test('__npmCheckMeta is non-enumerable (never leaks into JSON output)', () => {
    const lf = parseLockfile(LOCK_PATH);
    expect(Object.keys(lf)).not.toContain('__npmCheckMeta');
    expect(JSON.stringify(lf)).not.toContain('__npmCheckMeta');
  });
});

describe('checkIntegrity (pnpm)', () => {
  test('verifies registry deps and skips importers/git/tarball', async () => {
    const lf = parseLockfile(LOCK_PATH);
    // Fetcher returns the locked hash → every registry dep passes.
    const fetchIntegrity = async (name) => INTEGRITY[name] || null;
    const result = await checkIntegrity(lf, { fetchIntegrity });

    expect(result.passed).toBe(4); // lodash, @scope/util, left-pad, @scope/peer-thing
    expect(result.failed).toBe(0);
    // 2 importers + git + tarball are not registry-verifiable
    expect(result.skipped).toBeGreaterThanOrEqual(4);
  });

  test('flags a hash that differs from the registry', async () => {
    const lf = parseLockfile(LOCK_PATH);
    const fetchIntegrity = async (name) =>
      name === 'lodash' ? 'sha512-' + 'Z'.repeat(86) + '==' : INTEGRITY[name] || null;
    const result = await checkIntegrity(lf, { fetchIntegrity });

    expect(result.failed).toBe(1);
    expect(result.valid).toBe(false);
    expect(result.errors[0].package).toBe('lodash');
  });

  test('honors the scoped registry base for a scoped dep', async () => {
    const lf = parseLockfile(LOCK_PATH);
    const seen = {};
    const fetchIntegrity = async (name, version, registryBase) => {
      seen[name] = registryBase;
      return INTEGRITY[name] || null;
    };
    await checkIntegrity(lf, { fetchIntegrity });
    expect(seen['@scope/util']).toBe('https://npm.mycorp.example');
    expect(seen.lodash).toBe('https://registry.npmjs.org');
  });
});

describe('checkDeprecations (pnpm)', () => {
  test('surfaces a deprecated registry dep', async () => {
    const lf = parseLockfile(LOCK_PATH);
    const fetchManifest = async (name) =>
      name === 'left-pad' ? { deprecated: 'use String.prototype.padStart()' } : {};
    const result = await checkDeprecations(lf, { fetchManifest });

    expect(result.deprecated).toBe(1);
    expect(result.warnings[0].package).toBe('left-pad');
    expect(result.scanned).toBe(4);
  });
});

describe('checkVulnerabilities (pnpm)', () => {
  test('flags an advisory against a locked version', async () => {
    const lf = parseLockfile(LOCK_PATH);
    const advisory = { id: 1, title: 'Prototype pollution', severity: 'high', url: 'https://x/1' };
    const fetchAdvisories = async (registryBase, body) =>
      body.lodash ? { lodash: [advisory] } : {};
    const result = await checkVulnerabilities(lf, { fetchAdvisories, minSeverity: 'high' });

    expect(result.vulnerable).toBeGreaterThanOrEqual(1);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.package === 'lodash')).toBe(true);
  });
});
