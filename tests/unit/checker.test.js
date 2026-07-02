// tests/unit/checker.test.js
import {
  checkIntegrity,
  checkLicenses,
  checkAll,
  parseLicensesCsv,
  CheckError
} from '../../src/checker.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DIR = path.join(__dirname, '../../.test-checker');
const NODE_MODULES_PATH = path.join(TEST_DIR, 'node_modules');
const PACKAGE_DIR = path.join(NODE_MODULES_PATH, 'test-package');
const CSV_PATH = path.join(TEST_DIR, 'licenses.csv');

// Test fixtures
function setupTestEnvironment() {
  // Clean up and create fresh directories
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(PACKAGE_DIR, { recursive: true });
}

function cleanupTestEnvironment() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  }
}

function createTestPackage(dir, name, license = 'MIT') {
  const pkgDir = path.join(dir, 'node_modules', name);
  fs.mkdirSync(pkgDir, { recursive: true });

  const packageJson = {
    name,
    version: '1.0.0',
    license
  };

  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify(packageJson));
  fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};\n');

  return pkgDir;
}

function createLicensesCsv(path, licenses = ['MIT', 'Apache-2.0', 'ISC']) {
  let content = 'license,category,notes\n';
  licenses.forEach(lic => {
    content += `${lic},permissive,\n`;
  });
  fs.writeFileSync(path, content);
}

describe('CheckError', () => {
  it('should create error with message, code, and context', () => {
    const error = new CheckError('Test error', 'TEST_CODE', { key: 'value' });

    expect(error.message).toBe('Test error');
    expect(error.code).toBe('TEST_CODE');
    expect(error.context).toEqual({ key: 'value' });
    expect(error.name).toBe('CheckError');
  });
});

describe('parseLicensesCsv', () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  it('should parse valid CSV file', async () => {
    const licenses = ['MIT', 'Apache-2.0', 'ISC'];
    createLicensesCsv(CSV_PATH, licenses);

    const result = await parseLicensesCsv(CSV_PATH);

    expect(result).toBeInstanceOf(Set);
    expect(result.size).toBe(3);
    expect(result.has('MIT')).toBe(true);
    expect(result.has('Apache-2.0')).toBe(true);
    expect(result.has('ISC')).toBe(true);
  });

  it('should skip header and empty lines', async () => {
    const csvContent = `license,category,notes
MIT,permissive,

Apache-2.0,permissive,

`;
    fs.writeFileSync(CSV_PATH, csvContent);

    const result = await parseLicensesCsv(CSV_PATH);

    expect(result.size).toBe(2);
    expect(result.has('MIT')).toBe(true);
    expect(result.has('Apache-2.0')).toBe(true);
  });

  it('should skip comment lines', async () => {
    const csvContent = `license,category,notes
# This is a comment
MIT,permissive,
# Another comment
Apache-2.0,permissive,
`;
    fs.writeFileSync(CSV_PATH, csvContent);

    const result = await parseLicensesCsv(CSV_PATH);

    expect(result.size).toBe(2);
  });

  it('should keep all licenses when headerless CSV provided', async () => {
    const csvContent = `MIT,permissive,
Apache-2.0,permissive,
ISC,permissive,
`;
    fs.writeFileSync(CSV_PATH, csvContent);

    const result = await parseLicensesCsv(CSV_PATH);

    expect(result.size).toBe(3);
    expect(result.has('MIT')).toBe(true);
    expect(result.has('Apache-2.0')).toBe(true);
    expect(result.has('ISC')).toBe(true);
  });

  it('should throw error for missing file', async () => {
    await expect(parseLicensesCsv('/nonexistent/path.csv'))
      .rejects
      .toThrow(CheckError);
  });

  it('should throw error with LICENSES_CSV_NOT_FOUND code', async () => {
    try {
      await parseLicensesCsv('/nonexistent/path.csv');
      throw new Error('Should have thrown CheckError');
    } catch (e) {
      expect(e.code).toBe('LICENSES_CSV_NOT_FOUND');
    }
  });
});

describe('checkIntegrity', () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  const HASH_A = 'sha512-' + 'A'.repeat(86) + '==';
  const HASH_B = 'sha512-' + 'B'.repeat(86) + '==';

  // Injectable registry transport: resolves each package to a hash from `table`
  const fakeRegistry = (table) => (name) => Promise.resolve(table[name] || null);

  it('throws on a v1 lockfile', async () => {
    await expect(checkIntegrity({ lockfileVersion: 1, packages: {} }))
      .rejects.toThrow(CheckError);
  });

  it('skips root, workspace, link, git, file, and integrity-less entries (no network)', async () => {
    let calls = 0;
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        '': { name: 'root', version: '1.0.0' },
        'packages/app': { name: 'app', version: '1.0.0' }, // workspace source
        'node_modules/linked': { link: true, resolved: 'packages/app' },
        'node_modules/no-integ': { version: '1.0.0' }, // nothing locked
        'node_modules/from-git': { version: '1.0.0', integrity: HASH_A, resolved: 'git+https://github.com/x/y.git' },
        'node_modules/from-file': { version: '1.0.0', integrity: HASH_A, resolved: 'file:../local' }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: () => { calls++; return Promise.resolve(HASH_A); } });
    expect(calls).toBe(0);
    expect(result.skipped).toBe(6);
    expect(result.checked).toBe(0);
    expect(result.valid).toBe(true);
  });

  it('skips legacy sha1 hashes (cannot compare to registry sha512)', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/old': {
          name: 'old', version: '1.0.0', integrity: 'sha1-abcdef',
          resolved: 'https://registry.npmjs.org/old/-/old-1.0.0.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({ old: HASH_A }) });
    expect(result.skipped).toBe(1);
    expect(result.checked).toBe(0);
  });

  it('passes when the locked hash matches the registry', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': {
          name: 'lodash', version: '4.17.21', integrity: HASH_A,
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({ lodash: HASH_A }) });
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(1);
    expect(result.checked).toBe(1);
  });

  it('fails an entry resolving from a host not in allowedHosts (no fetch)', async () => {
    let fetched = 0;
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': {
          name: 'lodash', version: '4.17.21', integrity: HASH_A,
          resolved: 'https://evil.example.com/lodash/-/lodash-4.17.21.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, {
      allowedHosts: ['registry.npmjs.org'],
      fetchIntegrity: () => { fetched++; return Promise.resolve(HASH_A); }
    });
    expect(result.valid).toBe(false);
    expect(result.failed).toBe(1);
    expect(fetched).toBe(0); // never asked the untrusted host for its "authoritative" hash
    expect(result.errors[0].reason).toMatch(/untrusted registry host/);
  });

  it('still verifies normally when the resolved host IS in allowedHosts', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': {
          name: 'lodash', version: '4.17.21', integrity: HASH_A,
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, {
      allowedHosts: ['registry.npmjs.org'],
      fetchIntegrity: fakeRegistry({ lodash: HASH_A })
    });
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(1);
  });

  it('fails when the locked hash differs from the registry', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': {
          name: 'lodash', version: '4.17.21', integrity: HASH_A,
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({ lodash: HASH_B }) });
    expect(result.valid).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.errors[0].expected).toBe(HASH_B); // registry
    expect(result.errors[0].actual).toBe(HASH_A);   // lockfile
  });

  // P0 fail-closed: the registry has no authoritative hash → integrity could not be
  // verified, so by default the run FAILS (an unverifiable entry is not "verified").
  it('fails closed by default when the registry has no hash', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/ghost': {
          name: 'ghost', version: '9.9.9', integrity: HASH_A,
          resolved: 'https://registry.npmjs.org/ghost/-/ghost-9.9.9.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({}) });
    expect(result.valid).toBe(false);
    expect(result.unresolved).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.unresolvedItems[0].package).toBe('ghost');
  });

  // Explicit opt-out (CLI: --allow-unresolved) keeps unresolved entries non-fatal.
  it('keeps unresolved non-fatal when failOnUnresolved is opted out', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/ghost': {
          name: 'ghost', version: '9.9.9', integrity: HASH_A,
          resolved: 'https://registry.npmjs.org/ghost/-/ghost-9.9.9.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({}), failOnUnresolved: false });
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('fails closed by default when a registry network error aborts verification', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/lodash': {
          name: 'lodash', version: '4.17.21', integrity: HASH_A,
          resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: () => Promise.reject(new Error('ETIMEDOUT')) });
    expect(result.valid).toBe(false);
    expect(result.unresolved).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.unresolvedItems[0].reason).toMatch(/unreachable/);
  });

  // --- #15: SSRI-aware integrity compare ---

  // sha256-only: the registry only publishes sha512; a sha256-only lockfile entry
  // cannot be compared and must be skipped — not failed as tampered.
  // OLD code: entry.integrity.startsWith('sha1-') → false for sha256; reaches
  // comparison; sha256-X !== sha512-Y → FAIL (false tamper alarm).
  it('#15 skips sha256-only integrity — not falsely flagged as tampered', async () => {
    const SHA256_HASH = 'sha256-' + 'A'.repeat(43) + '=';
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/modern': {
          name: 'modern', version: '1.0.0', integrity: SHA256_HASH,
          resolved: 'https://registry.npmjs.org/modern/-/modern-1.0.0.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({ modern: HASH_A }) });
    // sha256-only → skipped (not enough to verify against registry sha512)
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.valid).toBe(true);
  });

  // Multi-hash (sha512+sha256): the lockfile carries 'sha512-A sha256-B'.
  // OLD code: 'sha512-A sha256-B' !== 'sha512-A' (full string != sha512 alone) → FAIL.
  // NEW code: extracts sha512-A from both sides, compares → PASS.
  it('#15 passes when lockfile has a multi-hash string and the sha512 component matches the registry', async () => {
    const MULTI_HASH = HASH_A + ' sha256-' + 'B'.repeat(43) + '=';
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/multi': {
          name: 'multi', version: '1.0.0', integrity: MULTI_HASH,
          resolved: 'https://registry.npmjs.org/multi/-/multi-1.0.0.tgz'
        }
      }
    };
    // Registry returns just the sha512 token (normal registry behaviour)
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({ multi: HASH_A }) });
    expect(result.valid).toBe(true);
    expect(result.passed).toBe(1);
    expect(result.failed).toBe(0);
  });

  // Multi-hash where the sha512 component does NOT match — should still be a real tamper fail.
  it('#15 still detects a real tamper when the sha512 component of a multi-hash differs', async () => {
    const MULTI_HASH = HASH_B + ' sha256-' + 'C'.repeat(43) + '='; // sha512=B, but registry has A
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/tampered': {
          name: 'tampered', version: '1.0.0', integrity: MULTI_HASH,
          resolved: 'https://registry.npmjs.org/tampered/-/tampered-1.0.0.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({ tampered: HASH_A }) });
    expect(result.valid).toBe(false);
    expect(result.failed).toBe(1);
  });

  // Two sha512 tokens where only the FIRST matches the registry. npm/ssri accepts
  // a tarball matching EITHER sha512, so 'sha512-GOOD sha512-EVIL' would let npm
  // install a tarball hashing to EVIL. A checker that only compared the first
  // token reported this lockfile clean (a tamper-detection bypass). Every sha512
  // token must equal the registry's.
  it('fails a lockfile carrying a second, non-registry sha512 token (multi-sha512 tamper)', async () => {
    const EVIL = 'sha512-' + 'E'.repeat(86) + '==';
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/twosha': {
          name: 'twosha', version: '1.0.0', integrity: HASH_A + ' ' + EVIL,
          resolved: 'https://registry.npmjs.org/twosha/-/twosha-1.0.0.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({ twosha: HASH_A }) });
    expect(result.valid).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.passed).toBe(0);
  });
});

describe('checkLicenses', () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  it('should throw error when node_modules does not exist', async () => {
    createLicensesCsv(CSV_PATH);
    const lockfile = { packages: {} };

    await expect(checkLicenses(lockfile, {
      nodeModulesPath: '/nonexistent/node_modules',
      csvPath: CSV_PATH
    })).rejects.toThrow(CheckError);
  });

  it('should throw error when CSV file does not exist', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    const lockfile = { packages: {} };

    await expect(checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: '/nonexistent/licenses.csv'
    })).rejects.toThrow(CheckError);
  });

  it('should skip root package', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createLicensesCsv(CSV_PATH);

    const lockfile = {
      packages: {
        '': {
          name: 'root',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.checked).toBe(1);
    expect(result.valid).toBe(true);
  });

  it('should approve licenses in the approved list', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'lodash', 'MIT');
    createLicensesCsv(CSV_PATH, ['MIT', 'Apache-2.0']);

    const lockfile = {
      packages: {
        'node_modules/lodash': {
          name: 'lodash',
          version: '4.17.21'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(true);
    expect(result.approved).toBe(1);
  });

  it('should reject licenses not in the approved list', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', 'GPL-3.0');
    createLicensesCsv(CSV_PATH, ['MIT', 'Apache-2.0']);

    const lockfile = {
      packages: {
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(false);
    expect(result.rejected).toBe(1);
    expect(result.errors.length).toBe(1);
  });

  // A malformed SPDX expression that leaves unconsumed trailing input (here a
  // stray ')') must NOT be approved just because a prefix parsed to an approved
  // id — the unevaluated remainder ('AND GPL-3.0-only') could hide a rejected
  // license. The parser must fail closed unless the whole expression is consumed.
  it('rejects a malformed SPDX expression with trailing unconsumed input (#18)', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', 'MIT ) AND GPL-3.0-only');
    createLicensesCsv(CSV_PATH, ['MIT', 'Apache-2.0']);

    const lockfile = {
      packages: { 'node_modules/pkg': { name: 'pkg', version: '1.0.0' } }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(false);
    expect(result.approved).toBe(0);
  });

  it('should warn on unknown license in non-strict mode', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    // Create package without license field
    const pkgDir = path.join(NODE_MODULES_PATH, 'pkg');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: 'pkg', version: '1.0.0' }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'module.exports = {};\n');

    createLicensesCsv(CSV_PATH);

    const lockfile = {
      packages: {
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH,
      strict: false
    });

    expect(result.valid).toBe(true);
    expect(result.unknown).toBe(1);
    expect(result.warnings.length).toBe(1);
  });

  it('should fail on unknown license in strict mode', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg');
    fs.writeFileSync(
      path.join(NODE_MODULES_PATH, 'pkg', 'package.json'),
      JSON.stringify({ name: 'pkg', version: '1.0.0' })
    );
    createLicensesCsv(CSV_PATH);

    const lockfile = {
      packages: {
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH,
      strict: true
    });

    expect(result.valid).toBe(false);
    expect(result.unknown).toBe(1);
    expect(result.errors.length).toBe(1);
  });

  it('should handle SPDX OR expressions', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', 'MIT OR Apache-2.0');
    createLicensesCsv(CSV_PATH, ['MIT', 'Apache-2.0']);

    const lockfile = {
      packages: {
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(true);
    expect(result.approved).toBe(1);
  });

  it('should handle SPDX AND expressions', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', 'MIT AND Apache-2.0');
    createLicensesCsv(CSV_PATH, ['MIT', 'Apache-2.0']);

    const lockfile = {
      packages: {
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(true);
    expect(result.approved).toBe(1);
  });

  it('should reject AND expressions with unapproved license', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', 'MIT AND GPL-3.0');
    createLicensesCsv(CSV_PATH, ['MIT', 'Apache-2.0']);

    const lockfile = {
      packages: {
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(false);
    expect(result.rejected).toBe(1);
  });

  it('should skip workspace packages (link: true)', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createLicensesCsv(CSV_PATH);

    const lockfile = {
      packages: {
        'packages/app': {
          name: '@monorepo/app',
          version: '1.0.0',
          link: true
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.checked).toBe(1);
    expect(result.valid).toBe(true);
  });

  it('should treat missing package.json as unknown license (not rejected)', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    // Create a package directory without package.json
    fs.mkdirSync(path.join(NODE_MODULES_PATH, 'no-pkg-json'), { recursive: true });
    createLicensesCsv(CSV_PATH);

    const lockfile = {
      packages: {
        'node_modules/no-pkg-json': {
          name: 'no-pkg-json',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH,
      strict: false
    });

    expect(result.valid).toBe(true);
    expect(result.unknown).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0].reason).toBe('package-json-not-found');
  });

  it('falls back to the lockfile license when the package is not installed', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    // Note: no package directory is created on disk for `uninstalled` — only the
    // lockfile carries its license, as happens with a partial node_modules.
    createLicensesCsv(CSV_PATH, ['ISC']);

    const lockfile = {
      packages: {
        'node_modules/uninstalled': {
          name: 'uninstalled',
          version: '1.0.0',
          license: 'ISC'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH,
      strict: false
    });

    expect(result.valid).toBe(true);
    expect(result.unknown).toBe(0);
    expect(result.approved).toBe(1);
  });

  it('should handle parenthesized SPDX expressions', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', '(MIT OR Apache-2.0)');
    createLicensesCsv(CSV_PATH, ['MIT', 'Apache-2.0']);

    const lockfile = {
      packages: {
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
        }
      }
    };

    const result = await checkLicenses(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(true);
    expect(result.approved).toBe(1);
  });

  // --- #18 sub-issue 1: object-form license field ---

  // OLD code: pkgJson.license = { type: "MIT" } (object, truthy) → passes !license guard
  // → isLicenseApproved({ type: "MIT" }, ...) → licenseExpr.trim() → TypeError (CRASH).
  // NEW code: normalizeLicenseField converts { type: "MIT" } → "MIT" → approved correctly.
  it('#18 handles object-form license { type: "MIT" } without crashing and approves it', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    const pkgDir = path.join(NODE_MODULES_PATH, 'obj-license');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'obj-license', version: '1.0.0', license: { type: 'MIT' } })
    );
    createLicensesCsv(CSV_PATH, ['MIT']);

    const lockfile = {
      packages: { 'node_modules/obj-license': { name: 'obj-license', version: '1.0.0' } }
    };
    const result = await checkLicenses(lockfile, { nodeModulesPath: NODE_MODULES_PATH, csvPath: CSV_PATH });
    expect(result.valid).toBe(true);
    expect(result.approved).toBe(1);
  });

  // Legacy "licenses" array form: [{ type: "MIT" }, { type: "ISC" }]
  // OLD code: pkgJson.license is undefined; pkgJson.licenses is an array (not read) → UNKNOWN.
  // NEW code: normalizeLicenseField joins types as "MIT OR ISC" → approved when any is in list.
  it('#18 handles legacy "licenses" array form and approves when any entry is in the list', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    const pkgDir = path.join(NODE_MODULES_PATH, 'arr-license');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(
      path.join(pkgDir, 'package.json'),
      JSON.stringify({ name: 'arr-license', version: '1.0.0', licenses: [{ type: 'MIT' }, { type: 'ISC' }] })
    );
    createLicensesCsv(CSV_PATH, ['MIT']);

    const lockfile = {
      packages: { 'node_modules/arr-license': { name: 'arr-license', version: '1.0.0' } }
    };
    const result = await checkLicenses(lockfile, { nodeModulesPath: NODE_MODULES_PATH, csvPath: CSV_PATH });
    expect(result.valid).toBe(true);
    expect(result.approved).toBe(1);
  });

  // --- #18 sub-issue 2: SPDX OR/AND fail-open fix ---

  // Simple parenthesized (MIT OR GPL-3.0): regression — should still approve when MIT is in list.
  // Both old and new code handle this correctly; test guards against regression.
  it('#18 approves (MIT OR GPL-3.0) when MIT is in the approved list', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', '(MIT OR GPL-3.0)');
    createLicensesCsv(CSV_PATH, ['MIT']);

    const lockfile = {
      packages: { 'node_modules/pkg': { name: 'pkg', version: '1.0.0' } }
    };
    const result = await checkLicenses(lockfile, { nodeModulesPath: NODE_MODULES_PATH, csvPath: CSV_PATH });
    expect(result.valid).toBe(true);
    expect(result.approved).toBe(1);
  });

  // Complex mixed AND+OR: (MIT OR LGPL-2.1) AND (GPL-3.0-only OR ISC) with only MIT approved.
  // OLD code: strips outer parens → 'MIT OR LGPL-2.1) AND (GPL-3.0-only OR ISC'
  //           → OR fires first → MIT is approved → returns true (FAIL OPEN).
  // NEW code: recursive descent evaluates (true OR false) AND (false OR false) → false (CORRECT).
  it('#18 correctly rejects (A OR B) AND (C OR D) when the AND side is fully unapproved — no fail-open', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', '(MIT OR LGPL-2.1) AND (GPL-3.0-only OR ISC)');
    // Only MIT is approved; GPL-3.0-only and ISC are not
    createLicensesCsv(CSV_PATH, ['MIT']);

    const lockfile = {
      packages: { 'node_modules/pkg': { name: 'pkg', version: '1.0.0' } }
    };
    const result = await checkLicenses(lockfile, { nodeModulesPath: NODE_MODULES_PATH, csvPath: CSV_PATH });
    expect(result.valid).toBe(false);
    expect(result.rejected).toBe(1);
  });

  // --- #18 sub-issue 3: v1 lockfile silent pass ---

  // OLD code: lockfileData.packages || {} → {} (v1 has no packages map) → entries empty
  //           → returns { valid: true, checked: 0 } (silently verified nothing).
  // NEW code: throws UNSUPPORTED_VERSION, mirroring checkIntegrity.
  it('#18 throws UNSUPPORTED_VERSION for v1 lockfiles instead of silently passing', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createLicensesCsv(CSV_PATH);

    const v1lockfile = {
      lockfileVersion: 1,
      dependencies: { lodash: { version: '4.17.21', resolved: 'https://registry.npmjs.org/lodash/-/lodash-4.17.21.tgz' } }
    };

    let caught;
    try {
      await checkLicenses(v1lockfile, { nodeModulesPath: NODE_MODULES_PATH, csvPath: CSV_PATH });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CheckError);
    expect(caught.code).toBe('UNSUPPORTED_VERSION');
  });
});

describe('checkAll', () => {
  beforeEach(() => {
    setupTestEnvironment();
  });

  afterEach(() => {
    cleanupTestEnvironment();
  });

  it('should run both integrity and license checks', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg', 'MIT');
    createLicensesCsv(CSV_PATH, ['MIT']);

    const lockfile = {
      packages: {
        '': {
          name: 'root',
          version: '1.0.0'
        },
        'node_modules/pkg': {
          name: 'pkg',
          version: '1.0.0'
          // no integrity
        }
      }
    };

    const result = await checkAll(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result).toHaveProperty('integrity');
    expect(result).toHaveProperty('licenses');
    expect(result).toHaveProperty('valid');
    expect(result.integrity).toHaveProperty('checked');
    expect(result.licenses).toHaveProperty('checked');
  });

  it('should fail if either check fails', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'pkg1', 'MIT');
    createTestPackage(TEST_DIR, 'pkg2', 'GPL-3.0');
    createLicensesCsv(CSV_PATH, ['MIT']);

    const lockfile = {
      packages: {
        'node_modules/pkg1': {
          name: 'pkg1',
          version: '1.0.0'
        },
        'node_modules/pkg2': {
          name: 'pkg2',
          version: '1.0.0'
        }
      }
    };

    const result = await checkAll(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH,
      csvPath: CSV_PATH
    });

    expect(result.valid).toBe(false);
    expect(result.licenses.valid).toBe(false);
  });
});
