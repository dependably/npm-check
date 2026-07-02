// tests/unit/npmrc-validator.test.js
import { parseNpmrc, validateNpmrc, NpmrcValidationError, NPMRC_SECURITY_CODES } from '../../src/npmrc-validator.js';

function codes(result) {
  return [...result.errors, ...result.warnings].map((e) => e.code);
}

describe('parseNpmrc', () => {
  it('parses key=value with line numbers', () => {
    const entries = parseNpmrc('registry=https://registry.npmjs.org/\nfund=false');
    expect(entries).toEqual([
      { key: 'registry', value: 'https://registry.npmjs.org/', line: 1 },
      { key: 'fund', value: 'false', line: 2 }
    ]);
  });

  it('strips inline/whole-line comments and surrounding quotes', () => {
    const entries = parseNpmrc('# a comment\nregistry="https://r.test/" ; trailing\n');
    expect(entries).toEqual([{ key: 'registry', value: 'https://r.test/', line: 2 }]);
  });

  it('parses a bare key as key=true (ini semantics), not malformed', () => {
    // regression #7: npm's `ini` reads `engine-strict` as `engine-strict=true`.
    const entries = parseNpmrc('engine-strict');
    expect(entries[0]).toEqual({ key: 'engine-strict', value: 'true', line: 1 });
    expect(entries[0].malformed).toBeUndefined();
  });

  it('treats empty content as no entries', () => {
    expect(parseNpmrc('')).toEqual([]);
    expect(parseNpmrc(null)).toEqual([]);
  });
});

describe('validateNpmrc', () => {
  it('passes empty/clean config', () => {
    expect(validateNpmrc('').valid).toBe(true);
    const result = validateNpmrc('registry=https://registry.npmjs.org/\nfund=false');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  describe('credentials', () => {
    it('accepts an env-var token reference', () => {
      const result = validateNpmrc('//registry.npmjs.org/:_authToken=${NPM_TOKEN}');
      expect(result.valid).toBe(true);
      expect(codes(result)).not.toContain('NPMRC_PLAINTEXT_SECRET');
    });

    it('errors on a plaintext scoped token', () => {
      const result = validateNpmrc('//registry.npmjs.org/:_authToken=abc123secret');
      expect(result.valid).toBe(false);
      expect(codes(result)).toContain('NPMRC_PLAINTEXT_SECRET');
      expect(result.errors[0]).toBeInstanceOf(NpmrcValidationError);
    });

    it('errors on a plaintext _password and _auth', () => {
      expect(codes(validateNpmrc('_password=hunter2'))).toContain('NPMRC_PLAINTEXT_SECRET');
      expect(codes(validateNpmrc('_auth=base64string'))).toContain('NPMRC_PLAINTEXT_SECRET');
    });

    it('errors on a plaintext _authBase64 (legacy npm key)', () => {
      expect(codes(validateNpmrc('//r.test/:_authBase64=Zm9vOmJhcg=='))).toContain('NPMRC_PLAINTEXT_SECRET');
    });

    it('accepts an env-var password', () => {
      expect(validateNpmrc('_password=${PW}').valid).toBe(true);
    });

    it('flags a PARTIAL env-ref that smuggles a plaintext secret', () => {
      // regression: `realsecret${X}` must NOT exempt the line
      expect(codes(validateNpmrc('//r.test/:_authToken=realsecret${X}'))).toContain('NPMRC_PLAINTEXT_SECRET');
      expect(codes(validateNpmrc('_password=${PW}extra'))).toContain('NPMRC_PLAINTEXT_SECRET');
    });

    it('does not let an inline-# comment truncate a secret out of detection', () => {
      // regression: `pa#ss` is a literal value, not `pa` + comment
      const result = validateNpmrc('_password=pa#ssword');
      expect(codes(result)).toContain('NPMRC_PLAINTEXT_SECRET');
    });
  });

  describe('TLS weakening', () => {
    it('errors on strict-ssl=false', () => {
      expect(codes(validateNpmrc('strict-ssl=false'))).toContain('NPMRC_STRICT_SSL_OFF');
    });
    it('accepts strict-ssl=true', () => {
      expect(validateNpmrc('strict-ssl=true').valid).toBe(true);
    });
    it('errors on rejectUnauthorized disabled', () => {
      expect(codes(validateNpmrc('//r.test/:rejectUnauthorized=false'))).toContain('NPMRC_REJECT_UNAUTHORIZED_OFF');
    });
    it('errors on strict-ssl=0 (numeric false)', () => {
      expect(codes(validateNpmrc('strict-ssl=0'))).toContain('NPMRC_STRICT_SSL_OFF');
    });
    it('warns on unsafe-perm enabled', () => {
      expect(codes(validateNpmrc('unsafe-perm=true'))).toContain('NPMRC_UNSAFE_PERM');
    });
  });

  describe('registry URLs', () => {
    it('warns on an http registry', () => {
      const result = validateNpmrc('registry=http://internal.test/');
      expect(codes(result)).toContain('NPMRC_INSECURE_REGISTRY');
      expect(result.valid).toBe(true); // warning only
    });
    it('errors on an unparseable registry URL', () => {
      expect(codes(validateNpmrc('registry=not a url'))).toContain('NPMRC_INVALID_REGISTRY');
    });
    it('accepts an https scoped registry', () => {
      expect(validateNpmrc('@scope:registry=https://npm.corp.test/').valid).toBe(true);
    });
    it('accepts an env-interpolated registry URL without flagging it invalid', () => {
      const result = validateNpmrc('registry=${NPM_REGISTRY}');
      expect(codes(result)).not.toContain('NPMRC_INVALID_REGISTRY');
      expect(result.valid).toBe(true);
    });
  });

  describe('unknown keys', () => {
    it('warns on an unrecognized key', () => {
      expect(codes(validateNpmrc('made-up-key=1'))).toContain('NPMRC_UNKNOWN_KEY');
    });
    it('does not warn on a known key', () => {
      expect(codes(validateNpmrc('save-exact=true'))).not.toContain('NPMRC_UNKNOWN_KEY');
    });
    it('does not warn on prefer-online (regression #5: was a `prefer-dline` typo)', () => {
      const result = validateNpmrc('prefer-online=true');
      expect(codes(result)).not.toContain('NPMRC_UNKNOWN_KEY');
      expect(result.valid).toBe(true);
      // sibling key still recognized
      expect(codes(validateNpmrc('prefer-offline=true'))).not.toContain('NPMRC_UNKNOWN_KEY');
    });
  });

  describe('bare boolean keys (#7)', () => {
    it('accepts a bare known key without a syntax error', () => {
      const result = validateNpmrc('engine-strict');
      expect(result.valid).toBe(true);
      expect(codes(result)).not.toContain('NPMRC_SYNTAX');
      expect(codes(result)).not.toContain('NPMRC_UNKNOWN_KEY');
    });
    it('still warns (not errors) on a bare unknown/typo key', () => {
      const result = validateNpmrc('made-up-flag');
      expect(codes(result)).not.toContain('NPMRC_SYNTAX');
      expect(codes(result)).toContain('NPMRC_UNKNOWN_KEY');
    });
    it('still detects a bare security-weakening key as true', () => {
      // `unsafe-perm` bare === `unsafe-perm=true`
      expect(codes(validateNpmrc('unsafe-perm'))).toContain('NPMRC_UNSAFE_PERM');
    });
  });

  describe('pnpm flavor (#6)', () => {
    const pnpm = (content) => validateNpmrc(content, { flavor: 'pnpm' });

    it('does not flag hoisting / node-linker / peer / proxy / TLS settings pnpm honors', () => {
      const content = [
        'shamefully-hoist=true',
        'node-linker=hoisted',
        'hoist-pattern[]=*eslint*',
        'strict-peer-dependencies=false',
        'https-proxy=http://proxy.corp.test:8080/',
        'strict-ssl=true'
      ].join('\n');
      const result = pnpm(content);
      expect(codes(result)).not.toContain('NPMRC_PNPM_IGNORED');
      expect(result.valid).toBe(true);
    });

    it('does not flag registry/auth lines', () => {
      const content = [
        'registry=https://npm.corp.test/',
        '@scope:registry=https://npm.corp.test/',
        '//npm.corp.test/:_authToken=${NPM_TOKEN}',
        'always-auth=true'
      ].join('\n');
      expect(codes(pnpm(content))).not.toContain('NPMRC_PNPM_IGNORED');
    });

    it('still flags npm-only keys pnpm genuinely ignores', () => {
      expect(codes(pnpm('package-lock=false'))).toContain('NPMRC_PNPM_IGNORED');
      expect(codes(pnpm('package-lock-only=true'))).toContain('NPMRC_PNPM_IGNORED');
      expect(codes(pnpm('legacy-peer-deps=true'))).toContain('NPMRC_PNPM_IGNORED');
    });

    it('keeps security codes as hard errors under the pnpm flavor', () => {
      expect(codes(pnpm('strict-ssl=false'))).toContain('NPMRC_STRICT_SSL_OFF');
      expect(codes(pnpm('_authToken=plaintextsecret'))).toContain('NPMRC_PLAINTEXT_SECRET');
    });
  });

  it('exposes the security codes that must always fail', () => {
    expect(NPMRC_SECURITY_CODES.has('NPMRC_PLAINTEXT_SECRET')).toBe(true);
    expect(NPMRC_SECURITY_CODES.has('NPMRC_STRICT_SSL_OFF')).toBe(true);
    expect(NPMRC_SECURITY_CODES.has('NPMRC_REJECT_UNAUTHORIZED_OFF')).toBe(true);
  });
});
