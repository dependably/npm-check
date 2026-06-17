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

  it('marks unresolved (not failed) when the registry has no hash', async () => {
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
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.failed).toBe(0);
    expect(result.unresolvedItems[0].package).toBe('ghost');
  });

  it('fails closed on unresolved when failOnUnresolved is set', async () => {
    const lockfile = {
      lockfileVersion: 3,
      packages: {
        'node_modules/ghost': {
          name: 'ghost', version: '9.9.9', integrity: HASH_A,
          resolved: 'https://registry.npmjs.org/ghost/-/ghost-9.9.9.tgz'
        }
      }
    };
    const result = await checkIntegrity(lockfile, { fetchIntegrity: fakeRegistry({}), failOnUnresolved: true });
    expect(result.valid).toBe(false);
    expect(result.failed).toBe(1);
  });

  it('treats a registry network error as unresolved by default', async () => {
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
    expect(result.valid).toBe(true);
    expect(result.unresolved).toBe(1);
    expect(result.unresolvedItems[0].reason).toMatch(/unreachable/);
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
