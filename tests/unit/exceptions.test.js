// tests/unit/exceptions.test.js
import {
  parseExceptions,
  matchException,
  matchGlob,
  isExpired,
  applyExceptions,
  SELECTORS
} from '../../src/exceptions.js';

const NPM_SELECTORS = ['package', 'id'];

describe('matchGlob (portable subset)', () => {
  it('matches ** across path separators', () => {
    expect(matchGlob('src/**', 'src/a/b.js')).toBe(true);
    expect(matchGlob('src/**', 'src')).toBe(true);
    expect(matchGlob('src/**', 'lib/a.js')).toBe(false);
  });
  it('* stays within a segment, ? is one char', () => {
    expect(matchGlob('src/*.js', 'src/a.js')).toBe(true);
    expect(matchGlob('src/*.js', 'src/a/b.js')).toBe(false);
    expect(matchGlob('a?.js', 'ab.js')).toBe(true);
    expect(matchGlob('a?.js', 'abc.js')).toBe(false);
  });
  it('normalizes backslashes to forward slashes', () => {
    expect(matchGlob('src/**', 'src\\a\\b.cs')).toBe(true);
  });
});

describe('parseExceptions validation', () => {
  it('accepts a well-formed entry', () => {
    const out = parseExceptions(
      [{ rule: 'install-scripts', package: 'esbuild', reason: 'vendored' }],
      { applicableSelectors: NPM_SELECTORS }
    );
    expect(out).toHaveLength(1);
    expect(out[0].rule).toBe('install-scripts');
    expect(out[0].selectors.package).toEqual({ name: 'esbuild', version: null });
  });

  it('undefined exceptions yields []', () => {
    expect(parseExceptions(undefined, { applicableSelectors: NPM_SELECTORS })).toEqual([]);
  });

  it('non-array throws INVALID_EXCEPTIONS', () => {
    expect(() => parseExceptions({}, { applicableSelectors: NPM_SELECTORS }))
      .toThrow(expect.objectContaining({ code: 'INVALID_EXCEPTIONS' }));
  });

  it('missing reason throws EXCEPTION_MISSING_REASON', () => {
    expect(() => parseExceptions(
      [{ rule: 'install-scripts', package: 'esbuild' }],
      { applicableSelectors: NPM_SELECTORS }
    )).toThrow(expect.objectContaining({ code: 'EXCEPTION_MISSING_REASON' }));
  });

  it('empty reason throws EXCEPTION_MISSING_REASON', () => {
    expect(() => parseExceptions(
      [{ rule: 'install-scripts', package: 'esbuild', reason: '   ' }],
      { applicableSelectors: NPM_SELECTORS }
    )).toThrow(expect.objectContaining({ code: 'EXCEPTION_MISSING_REASON' }));
  });

  it('no selector throws EXCEPTION_NO_SELECTOR', () => {
    expect(() => parseExceptions(
      [{ rule: 'install-scripts', reason: 'why' }],
      { applicableSelectors: NPM_SELECTORS }
    )).toThrow(expect.objectContaining({ code: 'EXCEPTION_NO_SELECTOR' }));
  });

  it('bad expires throws EXCEPTION_BAD_EXPIRES', () => {
    expect(() => parseExceptions(
      [{ rule: 'install-scripts', package: 'esbuild', reason: 'x', expires: '31-12-2026' }],
      { applicableSelectors: NPM_SELECTORS }
    )).toThrow(expect.objectContaining({ code: 'EXCEPTION_BAD_EXPIRES' }));
  });

  it('inapplicable selector in OWN section throws EXCEPTION_BAD_SELECTOR', () => {
    expect(() => parseExceptions(
      [{ rule: 'install-scripts', symbol: 'Foo.Bar', reason: 'x' }],
      { source: 'own', applicableSelectors: NPM_SELECTORS }
    )).toThrow(expect.objectContaining({ code: 'EXCEPTION_BAD_SELECTOR' }));
  });

  it('inapplicable selector in COMMON section is tolerated (never matches)', () => {
    const out = parseExceptions(
      [{ rule: 'install-scripts', symbol: 'Foo.Bar', reason: 'x' }],
      { source: 'common', applicableSelectors: NPM_SELECTORS }
    );
    expect(out).toHaveLength(1);
    expect(matchException(out[0], { ruleId: 'install-scripts', package: 'esbuild' })).toBe(false);
  });

  it('unknown rule in OWN section throws UNKNOWN_RULE when knownRules given', () => {
    expect(() => parseExceptions(
      [{ rule: 'no-such', package: 'x', reason: 'y' }],
      { source: 'own', applicableSelectors: SELECTORS, knownRules: ['install-scripts'] }
    )).toThrow(expect.objectContaining({ code: 'UNKNOWN_RULE' }));
  });

  it('unknown rule in COMMON section is tolerated (sibling tool id)', () => {
    const out = parseExceptions(
      [{ rule: 'cyclomatic', path: 'src/**', reason: 'y' }],
      { source: 'common', applicableSelectors: SELECTORS, knownRules: ['install-scripts'] }
    );
    expect(out).toHaveLength(1);
  });
});

describe('matchException', () => {
  const parse = (e) => parseExceptions([e], { source: 'common', applicableSelectors: SELECTORS })[0];

  it('package name matches case-insensitively', () => {
    const ex = parse({ rule: 'r', package: 'ESBuild', reason: 'x' });
    expect(matchException(ex, { ruleId: 'r', package: 'esbuild' })).toBe(true);
  });

  it('@version pin matches only the exact version', () => {
    const ex = parse({ rule: 'r', package: 'log4net@2.0.8', reason: 'x' });
    expect(matchException(ex, { ruleId: 'r', package: 'log4net', version: '2.0.8' })).toBe(true);
    expect(matchException(ex, { ruleId: 'r', package: 'log4net', version: '2.0.15' })).toBe(false);
  });

  it('selectors within an entry are AND', () => {
    const ex = parse({ rule: 'r', path: 'src/Parser/**', symbol: 'Parser.Parse', reason: 'x' });
    expect(matchException(ex, { ruleId: 'r', path: 'src/Parser/P.cs', symbol: 'Parser.Parse' })).toBe(true);
    expect(matchException(ex, { ruleId: 'r', path: 'src/Parser/P.cs', symbol: 'Parser.Other' })).toBe(false);
  });

  it('symbol Type matches Type.Member', () => {
    const ex = parse({ rule: 'r', symbol: 'Parser', reason: 'x' });
    expect(matchException(ex, { ruleId: 'r', symbol: 'Parser.Parse' })).toBe(true);
    expect(matchException(ex, { ruleId: 'r', symbol: 'Other.Parse' })).toBe(false);
  });

  it('id matches exactly', () => {
    const ex = parse({ rule: 'r', id: 'GHSA-x', reason: 'x' });
    expect(matchException(ex, { ruleId: 'r', id: 'GHSA-x' })).toBe(true);
    expect(matchException(ex, { ruleId: 'r', id: 'GHSA-y' })).toBe(false);
  });

  it('rule must match', () => {
    const ex = parse({ rule: 'r', package: 'x', reason: 'x' });
    expect(matchException(ex, { ruleId: 'other', package: 'x' })).toBe(false);
  });
});

describe('isExpired', () => {
  const parse = (e) => parseExceptions([e], { source: 'common', applicableSelectors: SELECTORS })[0];
  it('past date is expired', () => {
    expect(isExpired(parse({ rule: 'r', package: 'x', reason: 'x', expires: '2026-01-01' }), '2026-07-03')).toBe(true);
  });
  it('future date is not expired', () => {
    expect(isExpired(parse({ rule: 'r', package: 'x', reason: 'x', expires: '2027-01-01' }), '2026-07-03')).toBe(false);
  });
  it('no expires is never expired', () => {
    expect(isExpired(parse({ rule: 'r', package: 'x', reason: 'x' }), '2999-01-01')).toBe(false);
  });
});

describe('applyExceptions', () => {
  const P = (arr) => parseExceptions(arr, { source: 'own', applicableSelectors: SELECTORS });

  it('suppresses matched findings, keeps the rest', () => {
    const findings = [
      { ruleId: 'install-scripts', package: 'esbuild' },
      { ruleId: 'install-scripts', package: 'sharp' }
    ];
    const ex = P([{ rule: 'install-scripts', package: 'esbuild', reason: 'vendored' }]);
    const r = applyExceptions(findings, ex);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].package).toBe('sharp');
    expect(r.suppressed).toHaveLength(1);
    expect(r.suppressed[0].suppressed).toBe(true);
    expect(r.suppressed[0].suppressedBy).toBe('vendored');
    expect(r.unused).toHaveLength(0);
  });

  it('reports exceptions that matched nothing as unused', () => {
    const ex = P([{ rule: 'install-scripts', package: 'never', reason: 'stale' }]);
    const r = applyExceptions([], ex);
    expect(r.unused).toHaveLength(1);
    expect(r.suppressed).toHaveLength(0);
  });

  it('expired exceptions do not suppress and are reported', () => {
    const findings = [{ ruleId: 'install-scripts', package: 'esbuild' }];
    const ex = P([{ rule: 'install-scripts', package: 'esbuild', reason: 'temp', expires: '2026-01-01' }]);
    const r = applyExceptions(findings, ex, { today: '2026-07-03' });
    expect(r.kept).toHaveLength(1);
    expect(r.suppressed).toHaveLength(0);
    expect(r.expired).toHaveLength(1);
  });
});
