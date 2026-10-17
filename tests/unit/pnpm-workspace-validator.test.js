// tests/unit/pnpm-workspace-validator.test.js
// Per-key type checks of pnpm-workspace.yaml settings, non-mapping documents
// and strict mode.
import { validatePnpmWorkspace } from '../../src/pnpm-workspace-validator.js';

const codes = (list) => list.map((e) => e.code);

const VALID_SETTINGS = {
  packages: ['packages/*'],
  onlyBuiltDependenciesFile: 'allowed-builds.json',
  allowBuilds: { esbuild: true },
  nodeLinker: 'hoisted',
  shamefullyHoist: false,
  hoistPattern: ['*'],
  publicHoistPattern: ['*eslint*'],
  autoInstallPeers: true,
  dedupePeerDependents: true,
  strictPeerDependencies: false,
  excludeLinksFromLockfile: false,
  enablePrePostScripts: true,
  virtualStoreDir: 'node_modules/.pnpm',
  preferWorkspacePackages: true,
  linkWorkspacePackages: 'deep',
  saveWorkspaceProtocol: 'rolling',
  minimumReleaseAge: 1440,
  minimumReleaseAgeExclude: ['@scope/*'],
  catalog: { react: '^19.0.0' },
  overrides: { lodash: '4.17.21' }
};

describe('validatePnpmWorkspace settings', () => {
  test('accepts an already parsed document with every setting correctly typed', () => {
    const r = validatePnpmWorkspace(VALID_SETTINGS);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.valid).toBe(true);
    expect(r.info.hasPackages).toBe(true);
    expect(r.info.keys).toEqual(Object.keys(VALID_SETTINGS));
  });

  test('linkWorkspacePackages and saveWorkspaceProtocol also accept booleans', () => {
    const r = validatePnpmWorkspace({ linkWorkspacePackages: true, saveWorkspaceProtocol: false });
    expect(r.valid).toBe(true);
  });

  test.each([
    ['onlyBuiltDependenciesFile', 1, 'the correct type'],
    ['nodeLinker', true, 'the correct type'],
    ['shamefullyHoist', 'yes', 'the correct type'],
    ['autoInstallPeers', 'yes', 'the correct type'],
    ['dedupePeerDependents', 1, 'the correct type'],
    ['strictPeerDependencies', 'no', 'the correct type'],
    ['excludeLinksFromLockfile', 0, 'the correct type'],
    ['enablePrePostScripts', 'true', 'the correct type'],
    ['virtualStoreDir', ['x'], 'the correct type'],
    ['preferWorkspacePackages', 'true', 'the correct type'],
    ['linkWorkspacePackages', 3, 'the correct type'],
    ['saveWorkspaceProtocol', {}, 'the correct type'],
    ['hoistPattern', '*', 'an array of strings'],
    ['publicHoistPattern', [1], 'an array of strings'],
    ['catalog', ['react'], 'an object'],
    ['allowBuilds', ['esbuild'], 'an object'],
    ['minimumReleaseAge', '1440', 'a number'],
    ['minimumReleaseAge', Number.POSITIVE_INFINITY, 'a number']
  ])('rejects %s = %p and names the expected type', (key, value, label) => {
    const r = validatePnpmWorkspace({ [key]: value });
    expect(r.valid).toBe(false);
    expect(codes(r.errors)).toEqual(['PNPM_WS_INVALID_TYPE']);
    expect(r.errors[0].message).toBe(`"${key}" must be ${label}`);
    expect(r.errors[0].name).toBe('PnpmWorkspaceValidationError');
  });

  test('treats a missing document and an empty file as an empty mapping', () => {
    for (const input of [null, undefined, '']) {
      const r = validatePnpmWorkspace(input);
      expect(r.valid).toBe(true);
      expect(r.info).toEqual({ hasPackages: false, keys: [] });
    }
  });

  test('rejects a document that is not a mapping', () => {
    for (const input of ['- a\n- b\n', ['a', 'b'], 'just a string']) {
      const r = validatePnpmWorkspace(input);
      expect(r.valid).toBe(false);
      expect(codes(r.errors)).toEqual(['PNPM_WS_NOT_OBJECT']);
    }
  });

  test('an unknown key only fails the run in strict mode', () => {
    const lenient = validatePnpmWorkspace({ packages: ['a'], futureSetting: 1 });
    expect(lenient.valid).toBe(true);
    expect(codes(lenient.warnings)).toEqual(['PNPM_WS_UNKNOWN_KEY']);
    const strict = validatePnpmWorkspace({ packages: ['a'], futureSetting: 1 }, { strictMode: true });
    expect(strict.valid).toBe(false);
    expect(strict.errors).toEqual([]);
    expect(validatePnpmWorkspace({ packages: ['a'] }, { strictMode: true }).valid).toBe(true);
  });
});
