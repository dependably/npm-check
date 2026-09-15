// tests/unit/facts-diagnostic-codes.test.js
// Every diagnostic the facts layer produces (`Workspace.diagnostics`,
// `LockfileDiscovery.diagnostics`) must start with a stable `CODE:` prefix,
// so a consumer (sbom-reach's `diagnosticLevel`) can classify it and, in
// particular, promote it to a warning. Two diagnostics already followed the
// convention (`NO_LOCKFILE:`, `OUTPUT_DIR_SCANNED:`); three others predated
// or missed it (checker-npm#36). This is a STATIC check over the source of
// `src/facts/` itself, not a behavioral one over some fixture's output —
// the whole point is that a new uncoded `diagnostics.push(...)` fails HERE,
// at the point it is written, rather than being silently demoted to a note
// by every downstream consumer that switches on the prefix.
//
// The static scan alone is BLIND to a renamed or aliased sink -- its regex
// is `/diagnostics\??\.push\(/`, so `const notes = []; notes.push('uncoded')`,
// `const d = diagnostics; d.push('uncoded')` and
// `Array.prototype.push.call(diagnostics, 'uncoded')` are all invisible to
// it, and `src/facts/scan.js` already has a sibling string-array sink named
// `warnings`, i.e. the exact shape that would slip through the day it starts
// feeding a diagnostics list. The `describe` at the bottom of this file is
// the BEHAVIOURAL complement: it runs the two producers over real trees and
// asserts every string they actually emit is coded, whatever the sink was
// called on the way out. Neither check subsumes the other -- the static one
// fails at the moment an uncoded push is WRITTEN (including on a code path
// no test exercises), the behavioural one covers every route to the array.
//
// This intentionally does not do a full AST parse (`typescript`, the facts
// layer's own optional peer, is not guaranteed to be installed for every
// consumer of this test file's logic, and a hand-rolled balanced-paren
// scanner is overkill for the finite, simple shapes below). Each
// `diagnostics.push(...)` call site in this codebase is a single string or
// template literal, or a bare identifier already proven coded by
// construction (see the allowlist below) -- if a future call site is more
// exotic than that, this test's extraction will need to grow with it, and
// failing loudly on an unrecognized shape (rather than silently passing) is
// the safe direction.
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverLockfileGraphs, discoverWorkspace } from '../../src/facts/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACTS_DIR = join(__dirname, '..', '..', 'src', 'facts');
const FIXTURES = join(__dirname, '..', 'fixtures', 'facts');

// A stable code prefix: all-caps/digits/underscore, then a colon.
const CODE_PREFIX = /^[A-Z][A-Z0-9_]*:/;

/**
 * Identifiers that are allowed as a bare `diagnostics.push(<ident>)`
 * argument because the value they hold is independently proven coded --
 * either by another assertion in this same file (see below) or by a
 * dedicated test elsewhere that pins the producing function's output.
 */
const ALLOWED_IDENTIFIERS = new Set([
  // `workspace.js`: `const outputDirs = outputDirScannedDiagnostic(...); if
  // (outputDirs) diagnostics.push(outputDirs);` -- `outputDirScannedDiagnostic`
  // itself is pinned to return an `OUTPUT_DIR_SCANNED:`-prefixed string (or
  // undefined) by `tests/unit/facts-sourcescan.test.js`, and the runtime
  // assertion at the bottom of this file re-checks it directly too.
  'outputDirs',
  // `lockfile-graph.js`'s `discoverLockfileGraphs`: `for (const
  // graphDiagnostic of graph.diagnostics) diagnostics.push(graphDiagnostic);`
  // -- forwards a `LockfileGraph.diagnostics` entry that was already pushed,
  // coded, by `mergeDiscovered` inside `parsePackageLockJsonGraph`/
  // `parsePnpmLockYamlGraph` (both scanned by this same test); this is a
  // relay, not a new construction site.
  'graphDiagnostic'
]);

/**
 * Splits a call's argument list on its TOP-LEVEL commas -- `push` is
 * variadic, and `diagnostics.push('OK: a', 'uncoded')` used to be read as
 * one argument, so only the first was ever inspected and everything after
 * it was invisible. Quote state (including template literals and escapes)
 * and bracket depth are tracked so a comma inside a string, an object, an
 * array or a nested call is not a separator.
 *
 * @param {string} argSource
 * @returns {string[]}
 */
function splitTopLevelArgs(argSource) {
  const args = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let i = 0; i < argSource.length; i++) {
    const ch = argSource[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '[' || ch === '{') depth++;
    else if (ch === ')' || ch === ']' || ch === '}') depth--;
    else if (ch === ',' && depth === 0) {
      args.push(argSource.slice(start, i).trim());
      start = i + 1;
    }
  }
  const last = argSource.slice(start).trim();
  if (last !== '' || args.length > 0) args.push(last);
  return args;
}

/**
 * Finds every `diagnostics.push(...)` call in `source` and extracts the
 * "leading literal text" of EACH of its arguments (`push` is variadic): for
 * a string/template literal, the literal text up to the first `${`
 * interpolation (if any); for a bare identifier, a sentinel object flagging
 * it as such so the caller can apply the identifier allowlist instead of the
 * code-prefix regex.
 *
 * @param {string} source
 * @returns {{ argSource: string, literalHead: string | undefined, identifier: string | undefined }[]}
 */
function extractDiagnosticPushArgs(source) {
  const results = [];
  // `\??` also catches `diagnostics?.push(...)` (used when the sink is an
  // optional third parameter, e.g. `mergeDiscovered`'s conflict report) --
  // without it, an optional-chained call site is invisible to this scan.
  const callRe = /diagnostics\??\.push\(/g;
  let match;
  while ((match = callRe.exec(source))) {
    const start = match.index + match[0].length;
    // Non-greedy up to the first ");" -- true for every call site in this
    // codebase today (verified: no call site's argument contains the
    // two-character substring ");" before its own closing paren). A future
    // call site that violates this will make the slice below wrong in an
    // obviously-visible way (the extracted text runs on past the real
    // call), not silently.
    const endRe = /\);/g;
    endRe.lastIndex = start;
    const end = endRe.exec(source);
    if (!end) throw new Error(`unterminated diagnostics.push( starting at offset ${start}`);
    const callArgs = source.slice(start, end.index).trim();

    // Every argument is inspected, not just the first: `push` is variadic.
    for (const argSource of splitTopLevelArgs(callArgs)) {
      const bareIdentifier = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(argSource) ? argSource : undefined;
      let literalHead;
      if (bareIdentifier === undefined) {
        const stringMatch = argSource.match(/^(['"`])((?:\\.|(?!\1)[^\\])*)/);
        if (stringMatch) {
          // For a template literal, stop at the first `${` interpolation --
          // that is the part guaranteed to be literal text regardless of what
          // the interpolated expression evaluates to.
          const literal = stringMatch[2];
          const interpIdx = literal.indexOf('${');
          literalHead = interpIdx === -1 ? literal : literal.slice(0, interpIdx);
        }
      }
      results.push({ argSource, literalHead, identifier: bareIdentifier });
    }
  }
  return results;
}

describe('every diagnostics.push(...) in src/facts/ emits a coded string', () => {
  const files = readdirSync(FACTS_DIR)
    .filter((f) => f.endsWith('.js'))
    .map((f) => join(FACTS_DIR, f));

  test('scanned at least the two known call sites (workspace.js, lockfile-graph.js)', () => {
    // A sanity floor so this test cannot silently pass by scanning zero
    // files (e.g. a path typo) -- it should find every call site this
    // repo had at the time it was written.
    const total = files.reduce((n, f) => n + extractDiagnosticPushArgs(readFileSync(f, 'utf8')).length, 0);
    expect(total).toBeGreaterThanOrEqual(5);
  });

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const calls = extractDiagnosticPushArgs(source);
    if (calls.length === 0) continue;

    test(`${file.split('/').pop()}: each diagnostics.push argument is coded`, () => {
      for (const call of calls) {
        if (call.identifier !== undefined) {
          expect(ALLOWED_IDENTIFIERS.has(call.identifier)).toBe(true);
          continue;
        }
        expect(call.literalHead).toBeDefined();
        expect(call.literalHead).toMatch(CODE_PREFIX);
      }
    });
  }
});

describe('the allowlisted identifier is itself coded', () => {
  test('outputDirScannedDiagnostic (the only value ever pushed by bare identifier) returns an OUTPUT_DIR_SCANNED: string', async () => {
    const { outputDirScannedDiagnostic } = await import('../../src/facts/sourcescan.js');
    const diag = outputDirScannedDiagnostic(['build/a.js']);
    expect(diag).toMatch(CODE_PREFIX);
  });
});

// ---------------------------------------------------------------------------
// The behavioural complement.
//
// The static scan above reads SOURCE, so it only ever sees a sink spelled
// `diagnostics.push(`. This one reads OUTPUT: whatever route a string took
// into `Workspace.diagnostics` / `LockfileDiscovery.diagnostics` -- a
// renamed local (`const notes = []; ... return { diagnostics: notes }`), an
// alias (`const d = diagnostics`), a helper that returns the array, a
// `push` applied indirectly -- it is asserted coded here, because this is
// the array a consumer (sbom-reach's `diagnosticLevel`) actually classifies.
//
// A floor of expected CODES, not just "everything I happened to see was
// coded", is what keeps it from passing vacuously: a producer that stops
// emitting, or one whose prefix is renamed, fails on the missing code
// rather than quietly asserting nothing.
const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tempDir() {
  const d = realpathSync(mkdtempSync(join(tmpdir(), 'npm-check-facts-codes-')));
  dirs.push(d);
  return d;
}
function write(dir, rel, content) {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
/** The code of a diagnostic: everything before its first colon. */
function codeOf(diagnostic) {
  return diagnostic.slice(0, diagnostic.indexOf(':'));
}

describe('every diagnostic a real run EMITS is coded, whatever the sink was called', () => {
  /**
   * One tree that triggers every workspace and lockfile diagnostic this
   * layer can produce except `NO_LOCKFILE` (which is the absence of the
   * lockfiles this tree has).
   */
  function troubledTree() {
    const dir = tempDir();
    write(dir, 'package.json', JSON.stringify({ name: 'app', version: '1.0.0', dependencies: { foo: '1.0.0' } }));
    // NPM_MANIFEST_UNPARSEABLE
    write(dir, 'pkgs/broken/package.json', '{ this is not json');
    // NPM_TSCONFIG_UNPARSEABLE
    write(dir, 'tsconfig.json', '{ "compilerOptions": ');
    // OUTPUT_DIR_SCANNED: a tracked, non-gitignored build/ really is scanned
    write(dir, 'build/pipeline.js', "import foo from 'foo';\nfoo();\n");
    write(dir, 'src/index.js', "import foo from 'foo';\nfoo();\n");
    // NPM_INTEGRITY_CONFLICT: one lockfile, two paths, two hashes
    write(
      dir,
      'a/package-lock.json',
      JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { foo: '1.0.0', bar: '2.0.0' } },
          'node_modules/foo': { version: '1.0.0', integrity: 'sha512-AAAAgood' },
          'node_modules/bar': { version: '2.0.0', dependencies: { foo: '1.0.0' } },
          'node_modules/bar/node_modules/foo': { version: '1.0.0', integrity: 'sha512-ZZZZevil' }
        }
      })
    );
    // NPM_LOCKFILE_UNPARSEABLE
    write(dir, 'b/package-lock.json', '{ truncated');
    return dir;
  }

  test('discoverWorkspace + discoverLockfileGraphs over a tree that trips every producer', () => {
    const dir = troubledTree();
    const workspace = discoverWorkspace(dir);
    const lockfile = discoverLockfileGraphs(dir);
    const empty = discoverLockfileGraphs(tempDir()); // NO_LOCKFILE

    const emitted = [...workspace.diagnostics, ...lockfile.diagnostics, ...empty.diagnostics];
    for (const diagnostic of emitted) expect(diagnostic).toMatch(CODE_PREFIX);

    // The floor: every code this layer can produce was actually exercised,
    // so "all coded" is a statement about real output and not about an
    // empty list.
    expect(new Set(emitted.map(codeOf))).toEqual(
      new Set([
        'NPM_MANIFEST_UNPARSEABLE',
        'NPM_TSCONFIG_UNPARSEABLE',
        'OUTPUT_DIR_SCANNED',
        'NPM_INTEGRITY_CONFLICT',
        'NPM_LOCKFILE_UNPARSEABLE',
        'NO_LOCKFILE'
      ])
    );
  });

  for (const fixture of ['npm-app', 'svelte-app']) {
    test(`the ${fixture} fixture tree emits only coded diagnostics`, () => {
      const dir = join(FIXTURES, fixture);
      for (const diagnostic of [...discoverWorkspace(dir).diagnostics, ...discoverLockfileGraphs(dir).diagnostics]) {
        expect(diagnostic).toMatch(CODE_PREFIX);
      }
    });
  }
});

describe('the static scan reads every argument of a variadic push', () => {
  test('a second, uncoded argument is not invisible', () => {
    // `push` is variadic; the extraction used to stop at the first argument,
    // so `diagnostics.push('OK: a', 'uncoded')` passed with the uncoded half
    // never looked at.
    const calls = extractDiagnosticPushArgs("diagnostics.push('OK: a', 'uncoded');");
    expect(calls).toHaveLength(2);
    expect(calls[0].literalHead).toMatch(CODE_PREFIX);
    expect(calls[1].literalHead).not.toMatch(CODE_PREFIX);
  });

  test('a comma inside a string, a template literal, a nested call or an object is not an argument separator', () => {
    const calls = extractDiagnosticPushArgs(
      'diagnostics.push(`CODE_A: ${fn(a, b)} x, y`, "CODE_B: one, two", makeIt({ a: 1, b: 2 }));'
    );
    expect(calls).toHaveLength(3);
    expect(calls[0].literalHead).toBe('CODE_A: ');
    expect(calls[1].literalHead).toBe('CODE_B: one, two');
    // A call expression is neither a literal nor a bare identifier, so it
    // fails the assertions in the scan above rather than passing silently.
    expect(calls[2].literalHead).toBeUndefined();
    expect(calls[2].identifier).toBeUndefined();
  });
});
