// tests/unit/facts-svelte-scan.test.js
// `.svelte` <script> extraction in src/facts/scan.js: real line numbers,
// module + instance blocks, the comment/self-closing/quoted-attribute
// traps, and — load-bearing — that every DETECTED silent-loss shape surfaces
// as `parseErrors` rather than as a clean-looking empty result. Ported from
// sbom-reach's analyzer-npm `svelte-scan.test.ts`.
import { scanSource } from '../../src/facts/index.js';

const lostTag = (e) => e.includes("'<script' opening tag") || e.includes("'</script>' closing tag");

describe('scanSource on .svelte files', () => {
  test('extracts an import from a single <script> block at its real line number', () => {
    const code = ['<script>', "  import vulnLib from 'vuln-lib';", '', '  console.log(vulnLib);', '</script>', '', '<h1>hi</h1>'].join('\n');
    const { sites } = scanSource('Foo.svelte', code);
    expect(sites).toHaveLength(1);
    expect(sites[0].specifier).toBe('vuln-lib');
    expect(sites[0].line).toBe(2);
    expect(sites[0].snippet).toContain('vuln-lib');
  });

  test('scans both a module and an instance <script> block, each at its own line', () => {
    const code = [
      '<script module>',
      "  import { helper } from 'module-only-pkg';",
      '</script>',
      '',
      '<script>',
      "  import vulnLib from 'vuln-lib';",
      '  console.log(vulnLib, helper);',
      '</script>',
      '',
      '<p>markup</p>'
    ].join('\n');
    const { sites } = scanSource('Both.svelte', code);
    const byPkg = new Map(sites.map((s) => [s.specifier, s.line]));
    expect(byPkg.get('module-only-pkg')).toBe(2);
    expect(byPkg.get('vuln-lib')).toBe(6);
  });

  test('supports Svelte 4 <script context="module">', () => {
    const code = ['<script context="module">', "  import { helper } from 'module-only-pkg';", '</script>', '', '<p>markup</p>'].join('\n');
    const { sites } = scanSource('Legacy.svelte', code);
    expect(sites).toHaveLength(1);
    expect(sites[0].specifier).toBe('module-only-pkg');
    expect(sites[0].line).toBe(2);
  });

  test('scans cleanly to zero import sites for a markup-only component', () => {
    const code = ['<h1>No script block at all</h1>', '<p>Just markup.</p>'].join('\n');
    const { sites, dynamicUnknown, parseErrors } = scanSource('Markup.svelte', code);
    expect(sites).toHaveLength(0);
    expect(dynamicUnknown).toBe(0);
    expect(parseErrors).toBeUndefined();
  });

  test('does not let markup content bleed into the parsed script', () => {
    const code = ['<script>', "  import vulnLib from 'vuln-lib';", '</script>', '', "<p>import 'markup-pkg' looks like an import but is not code</p>"].join('\n');
    const { sites } = scanSource('NotCode.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['vuln-lib']);
  });

  test('classifies a lang="ts" script as TypeScript (type-only imports parse)', () => {
    const code = ['<script lang="ts">', "  import type { T } from 'ts-only-pkg';", '  export let x: T;', '</script>'].join('\n');
    const { sites } = scanSource('Typed.svelte', code);
    expect(sites).toHaveLength(1);
    expect(sites[0].specifier).toBe('ts-only-pkg');
    expect(sites[0].kind).toBe('type-only-import');
  });

  test('does not let a self-closing <script/> in markup swallow a later real <script> block', () => {
    const code = [
      '<svelte:head>',
      '  <script src="https://cdn.example/analytics.js" />',
      '</svelte:head>',
      '',
      '<script>',
      "  import lodash from 'lodash';",
      '  console.log(lodash);',
      '</script>'
    ].join('\n');
    const { sites, parseErrors } = scanSource('SelfClosing.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
    expect(sites[0].line).toBe(6);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('does not extract a <script> block that sits inside an HTML comment, and does not flag it either', () => {
    const code = ['<!-- old approach, kept for reference:', '<script>', "  import lodash from 'lodash';", '</script>', '-->', '<p>markup</p>'].join('\n');
    const { sites, parseErrors } = scanSource('Commented.svelte', code);
    expect(sites).toHaveLength(0);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('surfaces underlying TS syntax errors in a script block as parseErrors', () => {
    const code = ['<script>', "  import lodash from 'lodash';", '  const x = ;', '</script>'].join('\n');
    const { parseErrors } = scanSource('Malformed.svelte', code);
    expect(parseErrors).toBeDefined();
    expect(parseErrors.length).toBeGreaterThan(0);
    expect(parseErrors[0]).toMatch(/^line 3: /);
  });

  test('does not treat a literal "<!--" inside a script body as a comment opener, even with a real markup comment later in the file', () => {
    const code = [
      '<script>',
      "  import lodash from 'lodash';",
      '  export const OPEN_COMMENT = "<!--";',
      '  console.log(lodash.merge({}, {}));',
      '</script>',
      '',
      '<!-- svelte-ignore a11y-click-events-have-key-events -->',
      '<div>{OPEN_COMMENT}</div>'
    ].join('\n');
    const { sites, parseErrors } = scanSource('LiteralCommentMarker.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
    expect(sites[0].line).toBe(2);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('does not lose either script block when a literal "<!--" sits in one and a real comment follows both', () => {
    const code = [
      '<script module>',
      "  import { helper } from 'module-only-pkg';",
      '  export const MARKER = "<!--";',
      '</script>',
      '',
      '<script>',
      "  import vulnLib from 'vuln-lib';",
      '  console.log(vulnLib, helper);',
      '</script>',
      '',
      '<!-- svelte-ignore a11y-click-events-have-key-events -->'
    ].join('\n');
    const { sites } = scanSource('TwoScriptsBothMarked.svelte', code);
    expect(sites.map((s) => s.specifier).sort()).toEqual(['module-only-pkg', 'vuln-lib']);
  });

  test('does not treat a JS Annex-B HTML-style line comment inside a script as a markup comment', () => {
    const code = [
      '<script>',
      "  import lodash from 'lodash';",
      '  <!-- this line is a legal Annex-B comment in sloppy-mode JS',
      '  console.log(lodash);',
      '</script>',
      '',
      '<!-- unrelated markup comment -->'
    ].join('\n');
    const { sites } = scanSource('AnnexB.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
  });

  test('surfaces a parse error even when the broken script has no import/require text left for the PREFILTER fast path', () => {
    const code = ['<script>', '  const x = ;', '</script>'].join('\n');
    const { sites, parseErrors } = scanSource('NoImportKeyword.svelte', code);
    expect(sites).toHaveLength(0);
    expect(parseErrors).toBeDefined();
    expect(parseErrors.length).toBeGreaterThan(0);
  });

  test('does not lose a script whose literal "<!--" is preceded by a markup comment, with a further real comment after it too', () => {
    const code = [
      '<!-- svelte-ignore a11y-click-events-have-key-events -->',
      '<script>',
      "  import lodash from 'lodash';",
      '  export const OPEN_COMMENT = "<!--";',
      '  console.log(lodash);',
      '</script>',
      '',
      '<!-- another real comment, after the script -->'
    ].join('\n');
    const { sites } = scanSource('CommentBeforeScript.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
  });

  test('flags a real <script> block silently swallowed by a false "<!--" match inside a quoted attribute value', () => {
    const code = [
      '<div title="type <!-- to start an HTML comment"></div>',
      '',
      '<script>',
      "  import lodash from 'lodash';",
      '  export const merged = lodash.merge({}, {});',
      '</script>',
      '',
      '<!-- footer -->'
    ].join('\n');
    const { sites, parseErrors } = scanSource('AttrFalseComment.svelte', code);
    // The scan is not attribute-aware: the script really is lost. What
    // matters is that the loss is not silent.
    expect(sites).toHaveLength(0);
    expect(parseErrors).toBeDefined();
    expect(parseErrors.some(lostTag)).toBe(true);
  });

  test('flags a real <script> block silently swallowed by a false "<!--" match inside a Svelte expression', () => {
    const code = ["<p>{'<!--'}</p>", '', '<script>', "  import lodash from 'lodash';", '  export const merged = lodash.merge({}, {});', '</script>', '', '<!-- footer -->'].join('\n');
    const { sites, parseErrors } = scanSource('ExprFalseComment.svelte', code);
    expect(sites).toHaveLength(0);
    expect(parseErrors.some(lostTag)).toBe(true);
  });

  test('flags an unterminated "<!--" that consumes a real <script> block to end of file', () => {
    const code = ['<!-- this comment is never closed', '', '<script>', "  import lodash from 'lodash';", '  console.log(lodash);', '</script>'].join('\n');
    const { sites, parseErrors } = scanSource('UnterminatedComment.svelte', code);
    expect(sites).toHaveLength(0);
    expect(parseErrors.some(lostTag)).toBe(true);
  });

  test('flags an unterminated <script> tag with no closing </script> anywhere in the file', () => {
    const code = ['<h1>hi</h1>', '', '<script>', "  import lodash from 'lodash';", '  console.log(lodash);'].join('\n');
    const { sites, parseErrors } = scanSource('UnterminatedScript.svelte', code);
    expect(sites).toHaveLength(0);
    expect(parseErrors.some(lostTag)).toBe(true);
  });

  test('does not flag a file whose <script> blocks were all successfully extracted', () => {
    const code = ['<script>', "  import lodash from 'lodash';", '  console.log(lodash);', '</script>', '', '<!-- a real, unrelated comment -->'].join('\n');
    const { sites, parseErrors } = scanSource('Clean.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('correctly recognizes a non-self-closing <script> tag whose own attribute value contains a quoted ">"', () => {
    const code = ['<script data-x="/>" src="cdn.js">', "  import lodash from 'lodash';", '  export const merged = lodash.merge({}, {});', '</script>'].join('\n');
    const { sites, parseErrors } = scanSource('AttrGtSelfClosing.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
    expect(sites[0].line).toBe(2);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('extracts a <script> tag whose attribute value contains an unescaped ">" from real Svelte 5 generics syntax', () => {
    const code = [
      '<script lang="ts" generics="T extends Record<string, unknown>">',
      "  import { format } from 'date-fns';",
      '  export let items: T[] = [];',
      "  console.log(format(new Date(), 'yyyy-MM-dd'));",
      '</script>'
    ].join('\n');
    const { sites, parseErrors } = scanSource('Generics.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['date-fns']);
    expect(sites[0].line).toBe(2);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('does not flag a real <script> block whose body contains a string literal that looks like a script tag', () => {
    const code = ['<script>', "  import lodash from 'lodash';", '  const tag = "<script src=x>";', '  console.log(lodash, tag);', '</script>'].join('\n');
    const { sites, parseErrors } = scanSource('LiteralScriptTagInBody.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('silently loses a second <script> block masked by a false "<!--" match paired with a later prose "-->", the one accepted gap', () => {
    const code = ['<script>', "  import lodash from 'lodash';", '</script>', '<div title="<!--"></div>', '<script>', "  import axios from 'axios';", '</script>', '<p>a --> b</p>'].join('\n');
    const { sites, parseErrors } = scanSource('ProseArrowGap.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['lodash']);
    expect(parseErrors ?? []).toHaveLength(0);
  });

  test('does not let an unterminated quote in a malformed opening tag pair with an unrelated quote far later in the file', () => {
    const code = ['<script lang="ts>', "  import lodash from 'lodash';", '</script>', '<p>hi "there', '<script>', "  import axios from 'axios';", '</script>'].join('\n');
    const { sites, parseErrors } = scanSource('UnboundedQuote.svelte', code);
    expect(sites.map((s) => s.specifier)).toEqual(['axios']);
    expect(parseErrors.some(lostTag)).toBe(true);
  });

  test('silently loses a <script> block whose opening tag has a same-line-unterminated quote and no </script> anywhere else in the file, the second accepted gap', () => {
    const code = ['<h1>hi</h1>', '', '<script data-x="oops>', "  import lodash from 'lodash';"].join('\n');
    const { sites, parseErrors } = scanSource('UnterminatedQuoteNoClose.svelte', code);
    expect(sites).toHaveLength(0);
    expect(parseErrors ?? []).toHaveLength(0);
  });
});
