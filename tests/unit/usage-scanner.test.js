// tests/unit/usage-scanner.test.js
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  specifierToPackageName,
  scanUsedPackages,
  findUnusedDependencies,
  UsageScannerError
} from '../../src/usage-scanner.js';

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-usage-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(relPath, content) {
  const full = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

describe('specifierToPackageName', () => {
  const cases = [
    ['lodash', 'lodash'],
    ['lodash/fp', 'lodash'],
    ['@scope/pkg', '@scope/pkg'],
    ['@scope/pkg/sub/path', '@scope/pkg'],
    ['./relative', null],
    ['../up', null],
    ['/absolute', null],
    ['#internal-alias', null],
    ['node:fs', null],
    ['https://example.com/mod.js', null],
    ['@incomplete', null],
    ['', null],
    [null, null]
  ];

  it.each(cases)('maps %p to %p', (specifier, expected) => {
    expect(specifierToPackageName(specifier)).toBe(expected);
  });
});

describe('scanUsedPackages', () => {
  it('collects packages from require, import, dynamic import, and re-exports', () => {
    write('src/a.js', `
      const lodash = require('lodash');
      import chalk from 'chalk';
      import '@scope/styles';
      export { thing } from 'commander';
      const lazy = await import('semver');
      import sub from '@scope/pkg/deep/file';
    `);

    const { used } = scanUsedPackages(tmpDir);
    expect([...used].sort()).toEqual([
      '@scope/pkg', '@scope/styles', 'chalk', 'commander', 'lodash', 'semver'
    ]);
  });

  it('ignores relative imports and node builtins', () => {
    write('src/a.js', `
      import fs from 'node:fs';
      import helper from './helper.js';
      const sibling = require('../sibling');
    `);

    const { used } = scanUsedPackages(tmpDir);
    expect(used.size).toBe(0);
  });

  it('skips node_modules and other ignored directories', () => {
    write('node_modules/dep/index.js', `require('hidden-transitive');`);
    write('dist/bundle.js', `require('bundled-pkg');`);
    write('src/a.js', `require('real-pkg');`);

    const { used } = scanUsedPackages(tmpDir);
    expect([...used]).toEqual(['real-pkg']);
  });

  it('reports the number of scanned files', () => {
    write('a.js', `require('x');`);
    write('b.ts', `import y from 'y';`);
    write('c.txt', `require('not-scanned');`);

    const { used, scannedFiles } = scanUsedPackages(tmpDir);
    expect(scannedFiles).toBe(2);
    expect(used.has('not-scanned')).toBe(false);
  });

  it('throws for a missing directory', () => {
    expect(() => scanUsedPackages(path.join(tmpDir, 'nope'))).toThrow(UsageScannerError);
  });
});

describe('findUnusedDependencies', () => {
  it('flags dependencies never imported', () => {
    write('src/app.js', `import lodash from 'lodash';`);
    const packageJson = {
      name: 'app',
      dependencies: { lodash: '^4.0.0', 'never-used': '^1.0.0' }
    };

    const result = findUnusedDependencies(packageJson, tmpDir);
    expect(result.unused).toEqual([
      { name: 'never-used', section: 'dependencies', version: '^1.0.0' }
    ]);
  });

  it('checks devDependencies only with includeDev', () => {
    write('src/app.js', `import lodash from 'lodash';`);
    const packageJson = {
      name: 'app',
      dependencies: { lodash: '^4.0.0' },
      devDependencies: { 'unused-dev-tool': '^1.0.0' }
    };

    const without = findUnusedDependencies(packageJson, tmpDir);
    expect(without.unused).toEqual([]);
    expect(without.sectionsChecked).toEqual(['dependencies']);

    const withDev = findUnusedDependencies(packageJson, tmpDir, { includeDev: true });
    expect(withDev.unused).toEqual([
      { name: 'unused-dev-tool', section: 'devDependencies', version: '^1.0.0' }
    ]);
  });

  it('treats packages mentioned in npm scripts as used', () => {
    write('src/app.js', `// no imports`);
    const packageJson = {
      name: 'app',
      scripts: { lint: 'eslint .', test: 'jest --coverage' },
      dependencies: { eslint: '^8.0.0', jest: '^29.0.0', 'truly-unused': '^1.0.0' }
    };

    const result = findUnusedDependencies(packageJson, tmpDir);
    expect(result.unused.map((u) => u.name)).toEqual(['truly-unused']);
  });

  it('treats @types/foo as used when foo is imported', () => {
    write('src/app.ts', `import express from 'express';`);
    const packageJson = {
      name: 'app',
      dependencies: { express: '^4.0.0' },
      devDependencies: { '@types/express': '^4.0.0', '@types/unused-lib': '^1.0.0' }
    };

    const result = findUnusedDependencies(packageJson, tmpDir, { includeDev: true });
    expect(result.unused.map((u) => u.name)).toEqual(['@types/unused-lib']);
  });

  it('honors the ignore list', () => {
    write('src/app.js', `// nothing`);
    const packageJson = {
      name: 'app',
      dependencies: { 'config-loaded-plugin': '^1.0.0' }
    };

    const result = findUnusedDependencies(packageJson, tmpDir, { ignore: ['config-loaded-plugin'] });
    expect(result.unused).toEqual([]);
  });

  it('throws without package.json data', () => {
    expect(() => findUnusedDependencies(null, tmpDir)).toThrow(UsageScannerError);
  });
});
