// tests/unit/facts-specifier.test.js
import { specifierToPackage, aliasBaseFromPathsKey } from '../../src/facts/index.js';

describe('specifierToPackage', () => {
  const noAliases = new Set();
  test('maps subpaths to the parent package', () => {
    expect(specifierToPackage('lodash/get', noAliases)).toBe('lodash');
    expect(specifierToPackage('dayjs/plugin/utc', noAliases)).toBe('dayjs');
  });
  test('handles scoped packages', () => {
    expect(specifierToPackage('@scope/pkg/sub', noAliases)).toBe('@scope/pkg');
    expect(specifierToPackage('@scope', noAliases)).toBeUndefined();
  });
  test('lower-cases the name (npm names are case-insensitively unique)', () => {
    expect(specifierToPackage('Lodash', noAliases)).toBe('lodash');
  });
  test('skips relative, absolute, builtin, node:, data:, file: and # specifiers', () => {
    expect(specifierToPackage('./local', noAliases)).toBeUndefined();
    expect(specifierToPackage('/abs', noAliases)).toBeUndefined();
    expect(specifierToPackage('node:fs', noAliases)).toBeUndefined();
    expect(specifierToPackage('fs', noAliases)).toBeUndefined();
    expect(specifierToPackage('path/posix', noAliases)).toBeUndefined();
    expect(specifierToPackage('#internal/thing', noAliases)).toBeUndefined();
    expect(specifierToPackage('data:text/javascript,1', noAliases)).toBeUndefined();
    expect(specifierToPackage('file:///x.js', noAliases)).toBeUndefined();
    expect(specifierToPackage('', noAliases)).toBeUndefined();
  });
  test('skips tsconfig alias prefixes', () => {
    const aliases = new Set(['@app', 'left-pad']);
    expect(specifierToPackage('@app/helper', aliases)).toBeUndefined();
    expect(specifierToPackage('left-pad', aliases)).toBeUndefined();
    expect(specifierToPackage('left-pad-extra', aliases)).toBe('left-pad-extra');
  });
});

describe('aliasBaseFromPathsKey', () => {
  test('strips a trailing /* and leaves an exact key alone', () => {
    expect(aliasBaseFromPathsKey('@app/*')).toBe('@app');
    expect(aliasBaseFromPathsKey('utils')).toBe('utils');
  });
});
