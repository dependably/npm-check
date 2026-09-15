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
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FACTS_DIR = join(__dirname, '..', '..', 'src', 'facts');

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
  'outputDirs'
]);

/**
 * Finds every `diagnostics.push(...)` call in `source` and extracts the
 * "leading literal text" of its argument: for a string/template literal,
 * the literal text up to the first `${` interpolation (if any); for a bare
 * identifier, a sentinel object flagging it as such so the caller can apply
 * the identifier allowlist instead of the code-prefix regex.
 *
 * @param {string} source
 * @returns {{ argSource: string, literalHead: string | undefined, identifier: string | undefined }[]}
 */
function extractDiagnosticPushArgs(source) {
  const results = [];
  const callRe = /diagnostics\.push\(/g;
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
    const argSource = source.slice(start, end.index).trim();

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
