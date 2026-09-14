// tests/unit/facts-scan-bindings.test.js
// Binding-collection coverage for src/facts/scan.js: every import form the
// scanner is expected to resolve to binding names, one form per test, plus
// the depth-1 limit and the opaque-usage fail-safe. See `ImportSite.bindings`
// / `ImportSite.opaque` in src/facts/types.d.ts for the exact rules pinned
// here. Ported from sbom-reach's analyzer-npm `scan-bindings.test.ts`.
import { scanSource } from '../../src/facts/index.js';

function siteFor(code, specifier = 'pkg') {
  const { sites } = scanSource('x.ts', code);
  const site = sites.find((s) => s.specifier === specifier);
  if (!site) throw new Error(`no site found for specifier "${specifier}" in:\n${code}`);
  return { ...(site.bindings ? { bindings: [...site.bindings].sort() } : {}), ...(site.opaque ? { opaque: true } : {}) };
}

describe('scanSource binding collection: named imports', () => {
  test('collects the original name, not the local alias, for `import { a, b as c }`', () => {
    expect(siteFor(`import { a, b as c } from 'pkg';\nvoid a; void c;`)).toEqual({
      bindings: ['a', 'b']
    });
  });

  test('named export-from collects the original (source-module) name too', () => {
    expect(siteFor(`import 'anchor';\nexport { a, b as c } from 'pkg';`)).toEqual({
      bindings: ['a', 'b']
    });
  });
});

describe('scanSource binding collection: default import + one level of property access', () => {
  test('`import _ from "pkg"; _.template(x)` -> "template"', () => {
    expect(siteFor(`import _ from 'pkg';\n_.template(1);`)).toEqual({ bindings: ['template'] });
  });

  test('optional chaining resolves the same one level: `_?.template(x)`', () => {
    expect(siteFor(`import _ from 'pkg';\n_?.template(1);`)).toEqual({ bindings: ['template'] });
  });

  test('does not chase past one level: `_.a.b` only yields "a"', () => {
    expect(siteFor(`import _ from 'pkg';\n_.a.b();`)).toEqual({ bindings: ['a'] });
  });

  test('multiple distinct property accesses across the file are all collected', () => {
    expect(siteFor(`import _ from 'pkg';\n_.foo();\nfunction g() { _.bar(); }`)).toEqual({
      bindings: ['bar', 'foo']
    });
  });
});

describe('scanSource binding collection: namespace import + one level of property access', () => {
  test('`import * as ns from "pkg"; ns.foo()` -> "foo"', () => {
    expect(siteFor(`import * as ns from 'pkg';\nns.foo();`)).toEqual({ bindings: ['foo'] });
  });

  test('a default AND namespace import together both feed the same site', () => {
    expect(siteFor(`import def, * as ns from 'pkg';\ndef.a();\nns.b();`)).toEqual({
      bindings: ['a', 'b']
    });
  });

  test('a default import alongside named imports: default gets property-access tracking, named are direct', () => {
    expect(siteFor(`import def, { a, b as c } from 'pkg';\ndef.x();`)).toEqual({
      bindings: ['a', 'b', 'x']
    });
  });
});

describe('scanSource binding collection: require()/import() destructuring', () => {
  test('`const { a, b: c } = require("pkg")` -> "a", "b" (original names)', () => {
    expect(siteFor(`const { a, b: c } = require('pkg');\nvoid a; void c;`)).toEqual({
      bindings: ['a', 'b']
    });
  });

  test('`const pkg = require("pkg"); pkg.foo()` -> "foo" (default-style require binding)', () => {
    expect(siteFor(`const pkg = require('pkg');\npkg.foo();`)).toEqual({ bindings: ['foo'] });
  });

  test('`require("pkg").foo()` -> "foo" (chained directly off the call, no intermediate variable)', () => {
    expect(siteFor(`require('pkg').foo();`)).toEqual({ bindings: ['foo'] });
  });

  test('`const { a } = await import("pkg")` -> "a" (await-unwrapped dynamic import destructuring)', () => {
    expect(siteFor(`async function f() { const { a } = await import('pkg'); void a; }`)).toEqual({
      bindings: ['a']
    });
  });

  test('a bare `require("pkg");` (side-effect only) yields no bindings and is not opaque', () => {
    expect(siteFor(`require('pkg');`)).toEqual({});
  });
});

describe('scanSource binding collection: import-equals', () => {
  test('`import x = require("pkg"); x.foo()` -> "foo"', () => {
    expect(siteFor(`import x = require('pkg');\nx.foo();`)).toEqual({ bindings: ['foo'] });
  });
});

describe('scanSource binding collection: type-only imports are excluded', () => {
  test('a fully type-only import declaration collects no bindings even with apparent property access', () => {
    expect(siteFor(`import type { T } from 'pkg';\ntype U = T['foo'];`)).toEqual({});
  });
});

describe('scanSource: re-export opaqueness (fail-safe)', () => {
  test('`export * from "pkg"` is opaque: a bare namespace re-export names no binding', () => {
    expect(siteFor(`import 'anchor';\nexport * from 'pkg';`)).toEqual({ opaque: true });
  });

  test('`export * as ns from "pkg"` is opaque too (still a namespace merge)', () => {
    expect(siteFor(`import 'anchor';\nexport * as ns from 'pkg';`)).toEqual({ opaque: true });
  });
});

describe('scanSource: opaque default/namespace usage (fail-safe: "could use anything")', () => {
  test('passing the namespace binding to another function is opaque', () => {
    expect(siteFor(`import * as ns from 'pkg';\nuseElsewhere(ns);`)).toEqual({ opaque: true });
  });

  test('aliasing the default import to another variable is opaque', () => {
    expect(siteFor(`import d from 'pkg';\nconst other = d;`)).toEqual({ opaque: true });
  });

  test('exporting the identifier directly is opaque', () => {
    expect(siteFor(`import d from 'pkg';\nexport { d };`)).toEqual({ opaque: true });
  });

  test('computed (bracket) access is opaque — the property name is not statically resolved', () => {
    expect(siteFor(`import d from 'pkg';\nd['template']();`)).toEqual({ opaque: true });
  });

  test('rest-destructuring off a require() result is opaque', () => {
    expect(siteFor(`const { a, ...rest } = require('pkg');\nvoid a; void rest;`)).toEqual({
      opaque: true,
      bindings: ['a']
    });
  });

  test('array-binding-pattern destructuring off require() is opaque (unresolvable shape)', () => {
    expect(siteFor(`const [a] = require('pkg');\nvoid a;`)).toEqual({ opaque: true });
  });

  test('an unresolved shape at the require() call site itself (e.g. passed as an argument) is opaque', () => {
    expect(siteFor(`useElsewhere(require('pkg'));`)).toEqual({ opaque: true });
  });

  // Calling/constructing/tagging/rendering the default/namespace identifier
  // itself executes the module's callable identity, which no member-name
  // intersection can reason about — and a manifest naming that identity
  // (e.g. "axios", "default") can't be reliably matched anyway, since the
  // local identifier is user-chosen. These must be opaque, never "safe, no
  // binding" — see the doc comment above classifyUse in scan.js.

  test('calling the default export directly (`d()`) is opaque — the module identity itself was invoked', () => {
    expect(siteFor(`import d from 'pkg';\nd();`)).toEqual({ opaque: true });
  });

  test('calling a namespace import directly (`ns()`) is opaque, same as a default import', () => {
    expect(siteFor(`import * as ns from 'pkg';\nns();`)).toEqual({ opaque: true });
  });

  test('calling a require()-bound identifier directly (`pkg()`) is opaque', () => {
    expect(siteFor(`const pkg = require('pkg');\npkg();`)).toEqual({ opaque: true });
  });

  test('calling require(...) directly with no intermediate variable (`require("pkg")()`) is opaque', () => {
    expect(siteFor(`require('pkg')();`)).toEqual({ opaque: true });
  });

  test('constructing the default export (`new d()`) is opaque', () => {
    expect(siteFor(`import d from 'pkg';\nnew d();`)).toEqual({ opaque: true });
  });

  test('using the default export as a tagged template is opaque', () => {
    expect(siteFor(`import d from 'pkg';\nd\`hello\`;`)).toEqual({ opaque: true });
  });

  test('rendering the default export as a JSX component (`<D/>`) is opaque', () => {
    const { sites } = scanSource('x.tsx', `import D from 'pkg';\nfunction App() { return <D/>; }`);
    const site = sites.find((s) => s.specifier === 'pkg');
    expect(site.opaque).toBe(true);
  });

  test('await-called default export (`await d()`) is opaque, not just the bare call', () => {
    expect(siteFor(`import d from 'pkg';\nasync function f() { await d(); }`)).toEqual({ opaque: true });
  });
});

describe('scanSource: a called default export never yields a matchable "module identity" binding', () => {
  test('a called default import collects no bindings that could spuriously match its own local name or "default"', () => {
    const result = siteFor(`import axios from 'axios';\nawait axios({ url: '/x' });`, 'axios');
    expect(result).toEqual({ opaque: true });
    expect(result.bindings).toBeUndefined();
  });
});

describe('scanSource: safe non-escaping default/namespace usage — no binding, not opaque', () => {
  test('void <identifier> touches no property and is not opaque', () => {
    expect(siteFor(`import d from 'pkg';\nvoid d;`)).toEqual({});
  });

  test('typeof/instanceof/equality checks on the identifier are not opaque', () => {
    expect(
      siteFor(`import d from 'pkg';\nif (typeof d === 'function' && d instanceof Object) { /* noop */ }`)
    ).toEqual({});
  });

  test('a bare reference as an expression statement is not opaque', () => {
    expect(siteFor(`import d from 'pkg';\nd;`)).toEqual({});
  });
});

describe('scanSource: referenced (not merely imported) bindings', () => {
  test('`import { a, b } from "p"; a();` references only a', () => {
    const { sites } = scanSource('x.ts', `import { a, b } from 'p';\na();`);
    expect(sites[0].bindings.sort()).toEqual(['a', 'b']);
    expect(sites[0].referenced).toEqual(['a']);
  });

  test('a re-exported name is referenced (it is handed to whoever imports this module)', () => {
    const { sites } = scanSource('x.ts', `import 'anchor';\nexport { a } from 'p';`);
    const site = sites.find((s) => s.specifier === 'p');
    expect(site.referenced).toEqual(['a']);
  });

  test('a property NAME that merely spells a local is not a reference to it', () => {
    const { sites } = scanSource('x.ts', `import { template } from 'p';\nconst o = { template: 1 };\nobj.template();`);
    expect(sites[0].referenced).toBeUndefined();
  });

  test('two sites destructuring the same local name from different packages each keep their own references (loud direction)', () => {
    const scan = scanSource(
      'x.js',
      ["function a(){ const { danger } = require('p1'); return danger(); }", "function b(){ const { danger } = require('p2'); return 1; }"].join('\n')
    );
    const p1 = scan.sites.find((s) => s.specifier === 'p1');
    const p2 = scan.sites.find((s) => s.specifier === 'p2');
    expect(p1.referenced).toEqual(['danger']);
    // p2's `danger` is not called, but a per-file name walk cannot tell the two
    // locals apart; it is credited too, which over-counts use — never under-counts it.
    expect(p2.referenced).toEqual(['danger']);
  });
});

describe('scanSource: import kinds and the prefilter', () => {
  test('classifies import kinds', () => {
    const code = [
      `import a from 'pkg-a';`,
      `import type { T } from 'pkg-b';`,
      `export { x } from 'pkg-c';`,
      `import d = require('pkg-d');`,
      `const e = require('pkg-e');`,
      `const f = await import('pkg-f');`,
      `const g = require(dynamicName);`
    ].join('\n');
    const { sites, dynamicUnknown } = scanSource('x.ts', code);
    const byPkg = Object.fromEntries(sites.map((s) => [s.specifier, s.kind]));
    expect(byPkg).toEqual({
      'pkg-a': 'import',
      'pkg-b': 'type-only-import',
      'pkg-c': 'export-from',
      'pkg-d': 'require',
      'pkg-e': 'require',
      'pkg-f': 'dynamic-import'
    });
    expect(dynamicUnknown).toBe(1);
    expect(sites.find((s) => s.specifier === 'pkg-a').line).toBe(1);
  });

  test('a file with no import/require/export substring is skipped without parsing', () => {
    expect(scanSource('x.js', 'const a = 1;\nconsole.log(a);\n')).toEqual({ sites: [], dynamicUnknown: 0 });
  });

  test('a pure re-export barrel (no import/require substring) is still parsed', () => {
    const { sites } = scanSource('index.js', 'export * from "./main.js";\nexport * as x from "./other.js";\n');
    expect(sites.map((s) => s.specifier)).toEqual(['./main.js', './other.js']);
  });

  test('snippets are whitespace-collapsed and capped', () => {
    const long = `import {\n  ${'a'.repeat(300)}\n} from 'pkg';`;
    const { sites } = scanSource('x.ts', long);
    expect(sites[0].snippet.length).toBeLessThanOrEqual(200);
    expect(sites[0].snippet.startsWith('import { aaa')).toBe(true);
  });
});
