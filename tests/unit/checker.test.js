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

  it('should throw error when node_modules does not exist', async () => {
    const lockfile = { packages: {} };

    await expect(checkIntegrity(lockfile, {
      nodeModulesPath: '/nonexistent/node_modules'
    })).rejects.toThrow(CheckError);
  });

  it('should skip root package', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });

    const lockfile = {
      packages: {
        '': {
          name: 'root-package',
          version: '1.0.0'
        }
      }
    };

    const result = await checkIntegrity(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH
    });

    expect(result.skipped).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.valid).toBe(true);
  });

  it('should skip packages without integrity field', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    createTestPackage(TEST_DIR, 'lodash');

    const lockfile = {
      packages: {
        'node_modules/lodash': {
          name: 'lodash',
          version: '4.17.21'
          // no integrity field
        }
      }
    };

    const result = await checkIntegrity(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH
    });

    expect(result.skipped).toBe(1);
    expect(result.checked).toBe(1);
    expect(result.valid).toBe(true);
  });

  it('should detect missing package in node_modules', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });

    const lockfile = {
      packages: {
        'node_modules/missing-package': {
          name: 'missing-package',
          version: '1.0.0',
          integrity: 'sha512-test'
        }
      }
    };

    const result = await checkIntegrity(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH
    });

    expect(result.valid).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0].error).toContain('not found');
  });

  it('should verify package integrity', async () => {
    fs.mkdirSync(NODE_MODULES_PATH, { recursive: true });
    const pkgDir = createTestPackage(TEST_DIR, 'test-pkg');

    // Generate actual hash by reading files (matching checker algorithm)
    const crypto = await import('crypto');
    const files = ['index.js', 'package.json'].sort();
    const hash = crypto.createHash('sha512');

    for (const file of files) {
      const content = fs.readFileSync(path.join(pkgDir, file));
      hash.update(file);
      hash.update(content);
    }

    const expectedIntegrity = `sha512-${hash.digest('base64')}`;

    const lockfile = {
      packages: {
        'node_modules/test-pkg': {
          name: 'test-pkg',
          version: '1.0.0',
          integrity: expectedIntegrity
        }
      }
    };

    const result = await checkIntegrity(lockfile, {
      nodeModulesPath: NODE_MODULES_PATH
    });

    expect(result.valid).toBe(true);
    expect(result.passed).toBe(1);
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
