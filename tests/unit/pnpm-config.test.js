// tests/unit/pnpm-config.test.js
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { validateNpmrc } from '../../src/npmrc-validator.js';
import { validatePackageJson } from '../../src/package-json-validator.js';
import { validatePnpmWorkspace } from '../../src/pnpm-workspace-validator.js';
import { runAudit } from '../../src/audit.js';
import { runReport } from '../../src/report.js';
import { parseLockfile } from '../../src/parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, '../fixtures/pnpm-basic');
const LOCK_PATH = path.join(FIXTURE, 'pnpm-lock.yaml');

const codes = (arr) => arr.map((x) => x.code);

describe('validateNpmrc (pnpm flavor)', () => {
  test('flags an npm-only setting pnpm genuinely ignores in .npmrc', () => {
    // `package-lock` is npm's lockfile toggle; pnpm uses `lockfile` and drops it.
    const r = validateNpmrc('package-lock=false\n', { flavor: 'pnpm' });
    expect(r.valid).toBe(true); // warning, not error
    expect(codes(r.warnings)).toContain('NPMRC_PNPM_IGNORED');
  });

  test('does NOT flag install settings pnpm honors (node-linker, hoisting, peer)', () => {
    // regression #6: pnpm 7-10 read these from .npmrc — they must not be flagged.
    const r = validateNpmrc('node-linker=hoisted\nshamefully-hoist=true\nstrict-peer-dependencies=false\n', { flavor: 'pnpm' });
    expect(codes(r.warnings)).not.toContain('NPMRC_PNPM_IGNORED');
  });

  test('does NOT flag registry/auth keys pnpm honors', () => {
    const content = 'registry=https://registry.npmjs.org/\n@scope:registry=https://x.example/\n//x.example/:_authToken=${TOKEN}\nca=./ca.pem\n';
    const r = validateNpmrc(content, { flavor: 'pnpm' });
    expect(codes(r.warnings)).not.toContain('NPMRC_PNPM_IGNORED');
  });

  test('keeps security settings as hard errors under pnpm flavor', () => {
    const r = validateNpmrc('strict-ssl=false\n', { flavor: 'pnpm' });
    expect(r.valid).toBe(false);
    expect(codes(r.errors)).toContain('NPMRC_STRICT_SSL_OFF');
  });

  test('npm flavor is unchanged (unknown-key warning, not pnpm-ignored)', () => {
    const r = validateNpmrc('node-linker=hoisted\n');
    expect(codes(r.warnings)).toContain('NPMRC_UNKNOWN_KEY');
    expect(codes(r.warnings)).not.toContain('NPMRC_PNPM_IGNORED');
  });
});

describe('validatePackageJson (pnpm field)', () => {
  const base = { name: 'x', version: '1.0.0', private: true };

  test('accepts a well-typed pnpm field', () => {
    const r = validatePackageJson({ ...base, pnpm: { overrides: { foo: '1.0.0' }, onlyBuiltDependencies: ['esbuild'] } });
    expect(r.valid).toBe(true);
  });

  test('errors when pnpm is not an object', () => {
    const r = validatePackageJson({ ...base, pnpm: 'nope' });
    expect(codes(r.errors)).toContain('PJ_INVALID_PNPM');
  });

  test('errors on a mistyped sub-key', () => {
    const r = validatePackageJson({ ...base, pnpm: { onlyBuiltDependencies: 'esbuild' } });
    expect(codes(r.errors)).toContain('PJ_INVALID_PNPM_FIELD');
  });

  test('warns on an unknown pnpm sub-key', () => {
    const r = validatePackageJson({ ...base, pnpm: { notARealKey: {} } });
    expect(codes(r.warnings)).toContain('PJ_UNKNOWN_PNPM_KEY');
  });
});

describe('validatePnpmWorkspace', () => {
  test('accepts a valid workspace doc', () => {
    const r = validatePnpmWorkspace('packages:\n  - "packages/*"\nonlyBuiltDependencies:\n  - esbuild\n');
    expect(r.valid).toBe(true);
    expect(r.info.hasPackages).toBe(true);
  });

  test('errors when packages is not a string array', () => {
    const r = validatePnpmWorkspace('packages: not-a-list\n');
    expect(codes(r.errors)).toContain('PNPM_WS_INVALID_TYPE');
  });

  test('warns on an unknown top-level key', () => {
    const r = validatePnpmWorkspace('totallyUnknownKey: 1\n');
    expect(codes(r.warnings)).toContain('PNPM_WS_UNKNOWN_KEY');
  });

  test('reports a YAML syntax error', () => {
    const r = validatePnpmWorkspace('packages:\n  - "unterminated\n: : :\n');
    expect(r.valid).toBe(false);
    expect(codes(r.errors)).toContain('PNPM_WS_SYNTAX');
  });
});

describe('runAudit flavor gating', () => {
  test('pnpm lockfile runs only the pnpm-applicable rules', () => {
    const lockfile = parseLockfile(LOCK_PATH);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8')
    );
    const report = runAudit({ lockfile, packageJson, filePath: LOCK_PATH });
    const ruleIds = new Set(report.findings.map((f) => f.ruleId));
    // npm-shape rules must NOT fire on pnpm
    expect(ruleIds.has('lockfile-version')).toBe(false);
    expect(ruleIds.has('secure-resolved')).toBe(false);
    expect(ruleIds.has('no-orphan-packages')).toBe(false);
    // .npmrc has package-lock=false → pnpm-ignored warning surfaces via valid-npmrc
    const npmrcFinding = report.findings.find((f) => f.ruleId === 'valid-npmrc');
    expect(npmrcFinding).toBeTruthy();
    expect(npmrcFinding.message).toMatch(/not honored by pnpm/);
  });

  test('npm lockfile does NOT run pnpm rules', () => {
    const npmLock = { lockfileVersion: 3, packages: { '': { name: 'r', version: '1.0.0' } } };
    const report = runAudit({ lockfile: npmLock, packageJson: { name: 'r', version: '1.0.0', private: true }, filePath: 'package-lock.json' });
    const ruleIds = new Set(report.findings.map((f) => f.ruleId));
    expect(ruleIds.has('valid-pnpm-workspace')).toBe(false);
    expect(ruleIds.has('valid-pnpm-field')).toBe(false);
  });
});

describe('runReport (pnpm Phase 2 sections)', () => {
  test('config sections are live, lockfile-shape sections N/A', async () => {
    const lockfile = parseLockfile(LOCK_PATH);
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(FIXTURE, 'package.json'), 'utf8')
    );
    const report = await runReport(
      { lockfile, packageJson, filePath: LOCK_PATH, dir: FIXTURE },
      { integrity: false, vuln: false, deprecated: false, license: false }
    );
    const byId = Object.fromEntries(report.sections.map((s) => [s.id, s]));
    // pnpm config section present and live
    expect(byId['pnpm-config']).toBeTruthy();
    expect(byId['pnpm-config'].summary).not.toMatch(/N\/A/);
    expect(byId['package-json'].summary).toBe('valid');
    // .npmrc shows the pnpm-ignored warning
    expect(byId.npmrc.status).toBe('warn');
    // npm lockfile-shape section is N/A
    expect(byId.structure.summary).toBe('N/A (pnpm)');
    expect(byId.resolved.summary).toBe('N/A (pnpm)');
  });
});
