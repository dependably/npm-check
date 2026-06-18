// tests/unit/package-json-validator.test.js
import { validatePackageJson, PackageJsonValidationError } from '../../src/package-json-validator.js';

function codes(result) {
  return [...result.errors, ...result.warnings].map((e) => e.code);
}

describe('validatePackageJson', () => {
  it('accepts a well-formed manifest', () => {
    const result = validatePackageJson({
      name: '@scope/pkg',
      version: '1.2.3',
      license: 'MIT',
      dependencies: { lodash: '^4.17.21' },
      devDependencies: { jest: '29.0.0' },
      scripts: { test: 'jest' }
    });
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('rejects a non-object', () => {
    const result = validatePackageJson(null);
    expect(result.valid).toBe(false);
    expect(codes(result)).toContain('PJ_NOT_OBJECT');
    expect(result.errors[0]).toBeInstanceOf(PackageJsonValidationError);
  });

  describe('name and version', () => {
    it('errors on missing name/version for a public package', () => {
      const result = validatePackageJson({ license: 'MIT' });
      expect(result.valid).toBe(false);
      expect(codes(result)).toEqual(expect.arrayContaining(['PJ_MISSING_NAME', 'PJ_MISSING_VERSION']));
    });

    it('downgrades missing name/version to warnings for a private package', () => {
      const result = validatePackageJson({ private: true });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(codes(result)).toEqual(expect.arrayContaining(['PJ_MISSING_NAME', 'PJ_MISSING_VERSION']));
    });

    it('rejects malformed names', () => {
      for (const name of ['UPPER', 'has space', '.leadingdot', '_leadingunderscore']) {
        const result = validatePackageJson({ name, version: '1.0.0', license: 'MIT' });
        expect(result.valid).toBe(false);
        expect(codes(result)).toContain('PJ_INVALID_NAME');
      }
    });

    it('rejects names longer than 214 chars', () => {
      const result = validatePackageJson({ name: 'a'.repeat(215), version: '1.0.0', license: 'MIT' });
      expect(codes(result)).toContain('PJ_NAME_TOO_LONG');
    });

    it('rejects non-semver versions', () => {
      const result = validatePackageJson({ name: 'pkg', version: 'v1', license: 'MIT' });
      expect(codes(result)).toContain('PJ_INVALID_VERSION');
    });
  });

  describe('dependency ranges', () => {
    const base = { name: 'pkg', version: '1.0.0', license: 'MIT' };

    it('accepts protocol and shorthand ranges across all four sections', () => {
      const result = validatePackageJson({
        ...base,
        dependencies: { a: '^1.0.0', b: '*', c: 'latest' },
        devDependencies: { d: 'npm:other@^1.0.0', e: 'file:../local' },
        optionalDependencies: { f: 'github:owner/repo#v1', g: 'workspace:*' },
        peerDependencies: { h: '>=1.0.0 <2.0.0', i: 'https://x.test/a.tgz' }
      });
      expect(result.valid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts non-latest dist-tags (next/beta/canary)', () => {
      const result = validatePackageJson({
        ...base,
        dependencies: { a: 'next', b: 'beta', c: 'canary' }
      });
      expect(codes(result)).not.toContain('PJ_INVALID_DEP_RANGE');
      expect(result.valid).toBe(true);
    });

    it('flags an invalid range', () => {
      const result = validatePackageJson({ ...base, dependencies: { a: 'not a range!' } });
      expect(codes(result)).toContain('PJ_INVALID_DEP_RANGE');
    });

    it('flags an invalid dependency name', () => {
      const result = validatePackageJson({ ...base, dependencies: { 'BAD NAME': '1.0.0' } });
      expect(codes(result)).toContain('PJ_INVALID_DEP_NAME');
    });

    it('flags a non-object dependency section', () => {
      const result = validatePackageJson({ ...base, dependencies: ['lodash'] });
      expect(codes(result)).toContain('PJ_INVALID_DEP_SECTION');
    });
  });

  describe('scripts and field types', () => {
    const base = { name: 'pkg', version: '1.0.0', license: 'MIT' };

    it('flags a non-string script value', () => {
      const result = validatePackageJson({ ...base, scripts: { test: 123 } });
      expect(codes(result)).toContain('PJ_INVALID_SCRIPT_VALUE');
    });

    it('flags a non-object scripts field', () => {
      const result = validatePackageJson({ ...base, scripts: 'jest' });
      expect(codes(result)).toContain('PJ_INVALID_SCRIPTS');
    });

    it('flags a non-boolean private flag', () => {
      const result = validatePackageJson({ ...base, private: 'yes' });
      expect(codes(result)).toContain('PJ_INVALID_PRIVATE');
    });

    it('flags bad bin/main/exports/workspaces types', () => {
      expect(codes(validatePackageJson({ ...base, main: 5 }))).toContain('PJ_INVALID_MAIN');
      expect(codes(validatePackageJson({ ...base, bin: 5 }))).toContain('PJ_INVALID_BIN');
      expect(codes(validatePackageJson({ ...base, exports: 5 }))).toContain('PJ_INVALID_EXPORTS');
      expect(codes(validatePackageJson({ ...base, workspaces: 'pkgs/*' }))).toContain('PJ_INVALID_WORKSPACES');
      expect(codes(validatePackageJson({ ...base, workspaces: [1, 2] }))).toContain('PJ_INVALID_WORKSPACE_ENTRY');
    });

    it('accepts both workspaces array and { packages } forms', () => {
      expect(validatePackageJson({ ...base, workspaces: ['pkgs/*'] }).valid).toBe(true);
      expect(validatePackageJson({ ...base, workspaces: { packages: ['pkgs/*'] } }).valid).toBe(true);
    });
  });

  describe('license warnings', () => {
    it('warns when license is missing on a public package', () => {
      const result = validatePackageJson({ name: 'pkg', version: '1.0.0' });
      expect(result.valid).toBe(true);
      expect(codes(result)).toContain('PJ_MISSING_LICENSE');
    });

    it('does not warn about missing license on a private package', () => {
      const result = validatePackageJson({ name: 'pkg', version: '1.0.0', private: true });
      expect(codes(result)).not.toContain('PJ_MISSING_LICENSE');
    });

    it('warns on deprecated object-form license', () => {
      const result = validatePackageJson({ name: 'pkg', version: '1.0.0', license: { type: 'MIT' } });
      expect(codes(result)).toContain('PJ_INVALID_LICENSE');
    });

    it('warns on a SEE LICENSE non-SPDX string', () => {
      const result = validatePackageJson({ name: 'pkg', version: '1.0.0', license: 'SEE LICENSE IN LICENSE.txt' });
      expect(codes(result)).toContain('PJ_NONSTANDARD_LICENSE');
    });
  });

  it('strictMode turns warnings into invalid', () => {
    const result = validatePackageJson({ name: 'pkg', version: '1.0.0' }, { strictMode: true });
    expect(result.errors).toEqual([]);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.valid).toBe(false);
  });
});
