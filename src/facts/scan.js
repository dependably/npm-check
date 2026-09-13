// src/facts/scan.js
// Parse-only import scan of ONE source file with the TypeScript compiler API:
// every module reference (import / export-from / import-equals / require() /
// dynamic import()) with its line and snippet, the binding names each site
// introduces, which of those the module body actually references, and whether
// the site's binding escapes in a way a parse-level scan cannot follow
// (`opaque`). Language facts only — nothing here knows what a package IS.
//
// Ported verbatim from sbom-reach's `packages/analyzer-npm/src/scan.ts`; the
// invariants that travel with it (see CLAUDE.md, "Import facts"):
//   - over-report USE, never under-report it: any occurrence of a binding
//     counts as "referenced" (call, argument, spread, shorthand property), and
//     shadowing locals are deliberately NOT excluded;
//   - `opaque` is fail-safe: a binding this scan cannot follow "could use
//     anything", so a consumer must never read an opaque site as evidence that
//     some symbol was NOT used;
//   - a `.svelte` file's extraction problems are REPORTED (`parseErrors`), so
//     the absence of evidence from that file is never silently read as absence.
import { loadTypeScript } from './ts.js';

/** @typedef {import('./types.d.ts').ImportKind} ImportKind */
/** @typedef {import('./types.d.ts').ImportSite} ImportSite */
/** @typedef {import('./types.d.ts').ScanResult} ScanResult */
/** @typedef {import('typescript').Node} TsNode */
/** @typedef {import('typescript').SourceFile} TsSourceFile */
/** @typedef {import('typescript').Identifier} TsIdentifier */

// `export` is in the prefilter on purpose: a pure re-export barrel
// (`export * from './main.js'`) has no `import`/`require` substring, and the
// module-graph walk must follow it or the whole package behind it goes dark —
// svelte-eslint-parser's entry is exactly two `export … from` lines.
const PREFILTER = /import|require|export/;

/**
 * Parse-only scan of one source file with the TypeScript compiler: collects
 * import declarations, `export … from`, `import x = require()`, and
 * string-literal `require()` / dynamic `import()` calls. No type checker,
 * no ts.Program — this is the fast path.
 *
 * Binding collection runs as two extra passes over the same already-parsed
 * tree, both still parse-only:
 *  - Pass 1 (folded into the declaration walk): records bindings visible
 *    directly at the declaration (named imports/exports, require()/import()
 *    destructuring) and registers the local identifier of every
 *    default/namespace-style binding for pass 2 to resolve.
 *  - Pass 2: walks the whole tree again looking for uses of those tracked
 *    identifiers, resolving one level of property access to a binding name
 *    and flagging anything else that escapes this scan's visibility as
 *    `opaque` on that import site (fail-safe: opaque usage "could use
 *    anything").
 *
 * @param {string} fileName - used for the script kind (`.tsx`, `.svelte`, …) and nothing else
 * @param {string} content
 * @returns {ScanResult}
 */
export function scanSource(fileName, content) {
  const ts = loadTypeScript();
  /** @type {ImportSite[]} */
  const sites = [];
  let dynamicUnknown = 0;

  const isSvelte = fileName.endsWith('.svelte');
  const svelteExtraction = isSvelte ? extractSvelteScript(content) : undefined;
  const parseText = svelteExtraction ? svelteExtraction.code : content;

  // `.svelte` files must never take the prefilter fast path: a mis-detected
  // script boundary can extract text with no `import`/`require` substring
  // left in it at all (the failure mode this prefilter exists to skip past
  // quickly is indistinguishable, at the text level, from "extraction ate
  // the whole script"). Skipping `ts.createSourceFile` here would also skip
  // `collectSvelteParseErrors` below, silencing the one signal that catches
  // that failure. `.svelte` files are source components, not bundles, so the
  // performance case for the fast path doesn't apply the same way it does
  // for large plain `.ts`/`.js` files.
  if (!isSvelte && !PREFILTER.test(parseText)) return { sites, dynamicUnknown };

  const sourceFile = ts.createSourceFile(
    fileName,
    parseText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    svelteExtraction ? (svelteExtraction.hasTs ? ts.ScriptKind.TS : ts.ScriptKind.JS) : scriptKindOf(ts, fileName)
  );

  // `.svelte` script extraction is regex-based, not a real HTML parser: a
  // mis-detected script boundary feeds the TS parser text it can't make
  // sense of (e.g. leftover markup), and that shows up here as syntax
  // errors even though `scanSource` itself never throws. `parseDiagnostics`
  // isn't part of the public `ts.SourceFile` typings, but TypeScript always
  // populates it during `createSourceFile` -- it's the standard way to get
  // syntactic-only diagnostics without building a full `ts.Program`.
  const tsParseErrors = isSvelte ? collectSvelteParseErrors(ts, sourceFile) : undefined;

  // Second, independent backstop: a script swallowed whole by a false
  // comment match (or left dangling by an unterminated `<script>`/`<!--`)
  // leaves nothing malformed behind for `tsParseErrors` to catch -- the
  // extracted text for that stretch is just whitespace, which is valid
  // (empty) TypeScript. `extractSvelteScript` tracks every span of the raw
  // file it genuinely accounted for as it runs, and reports any
  // `<script`/`</script>`-shaped text left outside every one of those spans
  // -- that is exactly the silent-loss shape this backstop exists to catch.
  const parseErrors = [...(svelteExtraction ? svelteExtraction.lostScriptWarnings : []), ...(tsParseErrors ?? [])];

  /** @param {number} pos */
  const lineOf = (pos) => sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
  /** @param {TsNode} node */
  const snippetOf = (node) => {
    const text = node.getText(sourceFile).replace(/\s+/g, ' ').trim();
    return text.length > 200 ? `${text.slice(0, 199)}…` : text;
  };

  // --- binding-collection bookkeeping (site index -> discovered state) ---
  /** Local identifier (default/namespace import, import-equals, or a
   *  `const x = require(...)`-style single-identifier binding) -> the site
   *  index pass 2 should attribute its property-access/opaque findings to.
   *  @type {Map<string, number>} */
  const trackedIdentifiers = new Map();
  /** The exact declaration-occurrence node for each tracked identifier, so
   *  pass 2 never mistakes the declaration itself for a "use".
   *  @type {Set<TsNode>} */
  const declarationNodes = new Set();
  /** @type {Map<number, Set<string>>} */
  const bindingSets = new Map();
  /** @type {Map<number, Set<string>>} */
  const referencedSets = new Map();
  /** @type {Set<number>} */
  const opaqueSiteIdx = new Set();
  /** Local identifier of a named import / destructured require -> EVERY site
   *  (and original export name) that binds that local, so pass 2 can record
   *  references to it. A list, not one entry: two function bodies can each
   *  destructure the same name from different packages, and a reference is
   *  then credited to both (over-counting, the loud direction) rather than
   *  to whichever declaration came last.
   *  @type {Map<string, { idx: number; original: string }[]>} */
  const namedLocals = new Map();

  /** @param {number} idx @param {string} name */
  const addBinding = (idx, name) => {
    const set = bindingSets.get(idx) ?? new Set();
    set.add(name);
    bindingSets.set(idx, set);
  };
  /** @param {number} idx @param {string} name */
  const addReferenced = (idx, name) => {
    const set = referencedSets.get(idx) ?? new Set();
    set.add(name);
    referencedSets.set(idx, set);
  };
  /** A named binding: recorded as imported now, and as referenced by pass 2
   *  if its local identifier shows up anywhere in the body.
   *  @param {number} idx @param {string} original @param {TsNode} local */
  const addNamedBinding = (idx, original, local) => {
    addBinding(idx, original);
    if (ts.isIdentifier(local)) {
      const list = namedLocals.get(local.text) ?? [];
      list.push({ idx, original });
      namedLocals.set(local.text, list);
      declarationNodes.add(local);
    }
  };

  /**
   * @param {import('typescript').Expression | undefined} specNode
   * @param {TsNode} node
   * @param {ImportKind} kind
   * @returns {number | undefined}
   */
  const add = (specNode, node, kind) => {
    if (!specNode || !ts.isStringLiteralLike(specNode)) return undefined;
    const idx = sites.length;
    sites.push({
      specifier: specNode.text,
      line: lineOf(node.getStart(sourceFile)),
      snippet: snippetOf(node),
      kind
    });
    return idx;
  };

  /**
   * @param {{ propertyName?: TsNode; name: TsNode }} el
   * @returns {string | undefined}
   */
  const originalName = (el) => {
    const n = el.propertyName ?? el.name;
    return ts.isIdentifier(n) ? n.text : undefined;
  };

  /** Registers destructuring/property-chaining off a `require()`/awaited
   *  `import()` call result: `const { a, b: c } = require('x')`,
   *  `const pkg = require('x')`, `require('x').foo()`. Anything else the
   *  call result feeds into (an argument, a larger expression, a bare
   *  expression statement) is left alone rather than guessed at.
   *  @param {number} idx @param {TsNode} callNode @param {TsNode | undefined} parent */
  const trackCallResult = (idx, callNode, parent) => {
    if (parent && ts.isVariableDeclaration(parent) && parent.initializer === callNode) {
      if (ts.isIdentifier(parent.name)) {
        trackedIdentifiers.set(parent.name.text, idx);
        declarationNodes.add(parent.name);
        return;
      }
      if (ts.isObjectBindingPattern(parent.name)) {
        for (const el of parent.name.elements) {
          if (el.dotDotDotToken) {
            opaqueSiteIdx.add(idx); // rest destructure: could grab anything.
            continue;
          }
          const name = originalName(el);
          if (name !== undefined) addNamedBinding(idx, name, el.name);
        }
        return;
      }
      // Array binding pattern or another shape we don't resolve.
      opaqueSiteIdx.add(idx);
      return;
    }
    if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === callNode && !parent.questionDotToken) {
      addBinding(idx, parent.name.text);
      return;
    }
    if (parent && ts.isExpressionStatement(parent)) {
      return; // side-effect-only require('x'); nothing consumed.
    }
    // Any other shape (argument to a call, part of a larger expression,
    // etc.) is unresolvable at parse level — fail-safe opaque.
    opaqueSiteIdx.add(idx);
  };

  /**
   * @param {TsNode} node
   * @param {TsNode | undefined} parent
   * @param {TsNode | undefined} grandparent
   */
  const visit = (node, parent, grandparent) => {
    if (ts.isImportDeclaration(node)) {
      const typeOnly = node.importClause?.isTypeOnly === true;
      const idx = add(node.moduleSpecifier, node, typeOnly ? 'type-only-import' : 'import');
      // Type-only imports never bind a runtime value; nothing here can be
      // "called", so binding collection is skipped for them.
      if (idx !== undefined && node.importClause && !typeOnly) {
        const clause = node.importClause;
        if (clause.name) {
          trackedIdentifiers.set(clause.name.text, idx);
          declarationNodes.add(clause.name);
        }
        if (clause.namedBindings) {
          if (ts.isNamespaceImport(clause.namedBindings)) {
            trackedIdentifiers.set(clause.namedBindings.name.text, idx);
            declarationNodes.add(clause.namedBindings.name);
          } else if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              const name = originalName(el);
              if (name !== undefined) addNamedBinding(idx, name, el.name);
            }
          }
        }
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      const idx = add(node.moduleSpecifier, node, node.isTypeOnly ? 'type-only-import' : 'export-from');
      if (idx !== undefined && !node.isTypeOnly) {
        if (!node.exportClause) {
          // `export * from 'mod'`: a bare namespace re-export — opaque, no
          // local binding name is even syntactically available.
          opaqueSiteIdx.add(idx);
        } else if (ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            const name = originalName(el);
            if (name !== undefined) {
              addBinding(idx, name);
              addReferenced(idx, name); // handed straight to this module's importers
            }
          }
        } else {
          // `export * as ns from 'mod'`: still a namespace merge with no
          // property-access evidence available at the declaration itself.
          opaqueSiteIdx.add(idx);
        }
      }
    } else if (ts.isImportEqualsDeclaration(node)) {
      if (ts.isExternalModuleReference(node.moduleReference)) {
        const idx = add(node.moduleReference.expression, node, 'require');
        if (idx !== undefined) {
          trackedIdentifiers.set(node.name.text, idx);
          declarationNodes.add(node.name);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const isRequire = ts.isIdentifier(callee) && callee.text === 'require';
      const isDynamicImport = callee.kind === ts.SyntaxKind.ImportKeyword;
      if (isRequire || isDynamicImport) {
        const arg = node.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) {
          const idx = add(arg, node, isRequire ? 'require' : 'dynamic-import');
          if (idx !== undefined) {
            if (isRequire) {
              trackCallResult(idx, node, parent);
            } else {
              // Dynamic import() returns a Promise; the only statically
              // visible destructuring shape is `await import('x')`, so
              // unwrap exactly one AwaitExpression before applying the same
              // destructure/property-chain resolution.
              const effectiveParent = parent && ts.isAwaitExpression(parent) ? grandparent : parent;
              trackCallResult(idx, parent && ts.isAwaitExpression(parent) ? parent : node, effectiveParent);
            }
          }
        } else {
          dynamicUnknown++;
        }
      }
    }
    ts.forEachChild(node, (child) => visit(child, node, parent));
  };
  visit(sourceFile, undefined, undefined);

  // Pass 2: resolve one level of property access (or flag opaque escape)
  // for every tracked default/namespace-style identifier, over the whole
  // tree. A second pass (rather than folding into the walk above) is
  // deliberate: a use can textually precede its declaration's processing
  // order in edge cases, and this keeps the two concerns simple to reason
  // about independently.
  if (trackedIdentifiers.size > 0 || namedLocals.size > 0) {
    // A property-access binding is a reference by construction.
    /** @param {number} idx @param {string} name */
    const addUsedBinding = (idx, name) => {
      addBinding(idx, name);
      addReferenced(idx, name);
    };
    /** @param {TsNode} node @param {TsNode | undefined} parent */
    const visitUses = (node, parent) => {
      if (ts.isIdentifier(node) && !declarationNodes.has(node)) {
        const idx = trackedIdentifiers.get(node.text);
        if (idx !== undefined) {
          classifyUse(ts, node, parent, idx, addUsedBinding, opaqueSiteIdx);
        }
        const named = namedLocals.get(node.text);
        if (named !== undefined && parent !== undefined && isValueReference(ts, node, parent)) {
          for (const { idx: siteIdx, original } of named) addReferenced(siteIdx, original);
        }
      }
      ts.forEachChild(node, (child) => visitUses(child, node));
    };
    visitUses(sourceFile, undefined);
  }

  for (let i = 0; i < sites.length; i++) {
    const bindings = bindingSets.get(i);
    if (bindings && bindings.size > 0) sites[i].bindings = [...bindings];
    const referenced = referencedSets.get(i);
    if (referenced && referenced.size > 0) sites[i].referenced = [...referenced];
    if (opaqueSiteIdx.has(i)) sites[i].opaque = true;
  }

  return { sites, dynamicUnknown, ...(parseErrors.length > 0 ? { parseErrors } : {}) };
}

/**
 * Renders a `.svelte` file's TS syntax-error diagnostics as plain strings,
 * or `undefined` when there were none.
 * @param {typeof import('typescript')} ts
 * @param {TsSourceFile} sourceFile
 * @returns {string[] | undefined}
 */
function collectSvelteParseErrors(ts, sourceFile) {
  const diags = /** @type {{ parseDiagnostics?: import('typescript').Diagnostic[] }} */ (
    /** @type {unknown} */ (sourceFile)
  ).parseDiagnostics;
  if (!diags || diags.length === 0) return undefined;
  return diags.map((d) => {
    const message = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const line = d.start !== undefined ? sourceFile.getLineAndCharacterOfPosition(d.start).line + 1 : undefined;
    return line !== undefined ? `line ${line}: ${message}` : message;
  });
}

/**
 * Whether an identifier occurrence that happens to spell a named-import
 * local is a use of that local, as opposed to a property NAME that merely
 * shares the spelling (`obj.template`, `{ template: 1 }`, `class { template() {} }`,
 * a type position). Shadowing declarations (a nested `const template = …`)
 * are NOT excluded — that over-counts references, which is the safe
 * direction for a "was the vulnerable symbol used" question.
 * @param {typeof import('typescript')} ts
 * @param {TsIdentifier} node
 * @param {TsNode} parent
 * @returns {boolean}
 */
function isValueReference(ts, node, parent) {
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if ((ts.isMethodDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertySignature(parent) || ts.isMethodSignature(parent)) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return false;
  if (ts.isTypeReferenceNode(parent) || ts.isQualifiedName(parent)) return false;
  return true;
}

/**
 * Classifies one reference to a tracked default/namespace-style identifier:
 * resolves exactly one level of (non-computed, non-chained) property access
 * to a binding name, recognizes a small set of usage shapes that plainly
 * don't touch any named property ("safe, no binding" — `void`/`typeof`/
 * `delete`, a bare expression statement, `instanceof`/`in`/equality
 * comparisons), and treats everything else — assignment, being passed as an
 * argument, spread, export, return, computed access, AND calling/
 * constructing/tagging/rendering the identifier itself — as an opaque
 * escape this parse-level scan cannot rule out (fail-safe: "could use
 * anything").
 *
 * **Calling the identifier itself is deliberately opaque, not safe**
 * (adversarial-review finding): `axios(...)`, `new X(...)`, `` tag`...` ``,
 * and `<X/>` all execute the module's **default/namespace identity** —
 * package code no member-name intersection can reason about. A manifest
 * naming that identity (e.g. `"name": "axios"` or `"name": "default"`)
 * would otherwise be structurally unmatchable (the local identifier is
 * user-chosen, not the export name), so a direct call/construct/tag/render
 * is never treated as "no binding" the way `void x`/`x;`/`typeof x` are —
 * those inspect the reference without invoking anything, while calling it
 * runs it.
 *
 * @param {typeof import('typescript')} ts
 * @param {TsIdentifier} node
 * @param {TsNode | undefined} parent
 * @param {number} idx
 * @param {(idx: number, name: string) => void} addBinding
 * @param {Set<number>} opaqueSiteIdx
 */
function classifyUse(ts, node, parent, idx, addBinding, opaqueSiteIdx) {
  if (!parent) return;

  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && !parent.questionDotToken) {
    addBinding(idx, parent.name.text);
    return;
  }
  // Optional-chained property access (`local?.foo`) is the same one-level
  // resolution as plain property access.
  if (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.questionDotToken) {
    addBinding(idx, parent.name.text);
    return;
  }
  if (isSafeNonEscapingUse(ts, node, parent)) return;

  opaqueSiteIdx.add(idx);
}

/**
 * @param {typeof import('typescript')} ts
 * @param {TsIdentifier} node
 * @param {TsNode} parent
 * @returns {boolean}
 */
function isSafeNonEscapingUse(ts, node, parent) {
  if (ts.isExpressionStatement(parent)) return true; // bare `local;`
  if (ts.isVoidExpression(parent) || ts.isTypeOfExpression(parent) || ts.isDeleteExpression(parent)) return true;
  if (ts.isPrefixUnaryExpression(parent) && parent.operand === node) return true; // !local, -local, +local, ~local
  // NOTE: calling the identifier itself (`local(...)`) is INTENTIONALLY NOT
  // here — see the doc comment above classifyUse. It falls through to
  // opaque below, same as `new local(...)`, tagged templates, and JSX.
  if (ts.isBinaryExpression(parent)) {
    const SAFE_OPS = new Set([
      ts.SyntaxKind.InstanceOfKeyword,
      ts.SyntaxKind.InKeyword,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken
    ]);
    if (SAFE_OPS.has(parent.operatorToken.kind)) return true;
  }
  return false;
}

// Matches a `<script ...>` tag's attribute text, treating a double- or
// single-quoted run as opaque so a `>` inside a quoted attribute value (e.g.
// `generics="T extends Record<string, unknown>"`, or `data-x="/>"`) does not
// terminate the match early. Shared by every place in this file that needs
// to find where a `<script` opening tag actually ends.
//
// Each quoted-run alternative is capped at a newline (`[^"\n]*`, `[^'\n]*`)
// rather than left unbounded. An unbounded run is a bug, not just a
// narrower heuristic: a malformed tag with a quote that never closes on its
// own line (`<script lang="ts>`) would otherwise pair with the next quote
// of the same kind ANYWHERE later in the file -- unrelated prose, a
// different attribute, whatever comes first -- and the "opening tag" match
// would balloon to swallow every real `<script>` block in between,
// including its own `</script>`. Because that inflated span is then
// recorded as consumed, the range-tracking backstop below is blind to it
// too: the exact silent-loss failure this whole extraction/backstop design
// exists to prevent. Capping at a newline does cost real (if unusual)
// coverage -- a legally multi-line attribute value containing a stray `>`
// is no longer matched as part of the tag -- but that narrower case still
// surfaces as a backstop warning rather than silent loss; see the trace in
// the doc comment above `extractSvelteScript`.
const SCRIPT_OPEN_ATTRS = `(?:[^>"']|"[^"\\n]*"|'[^'\\n]*')*`;

// Finds the next thing that matters while scanning markup: either a comment
// opener, or a genuine `<script...>` opening tag (group 1 captures its
// attributes; undefined means the match was the comment opener instead).
const SVELTE_MARKUP_TOKEN_RE = new RegExp(`<!--|<script\\b(${SCRIPT_OPEN_ATTRS})>`, 'gi');
const SVELTE_SCRIPT_CLOSE_RE = /<\/script\s*>/gi;
const SVELTE_TS_LANG_RE = /lang\s*=\s*(["'])(?:ts|typescript)\1/i;

/**
 * A `.svelte` file's markup and `<style>` block are not TS/JS and would
 * abort `ts.createSourceFile`; only the `<script>` (module and/or instance,
 * Svelte 4's `context="module"` or Svelte 5's `module`) tag bodies are.
 * Rather than slice those bodies out (which would shift every subsequent
 * line number relative to the real file — the evidence a consumer reports
 * must point at the `.svelte` file's actual lines), this replaces everything
 * *outside* script tags with spaces while preserving every newline, so the
 * returned string has exactly the same line layout as `content` and can be
 * fed straight to `ts.createSourceFile` with line numbers already correct.
 *
 * This is a single left-to-right pass with an explicit "scanning markup" vs
 * "inside an open `<script>` element" state, not two independently-composed
 * regex passes (a global comment mask, then a separate script-tag pass) over
 * the whole file. That composition was tried and is wrong: a real `<script>`
 * element's content is raw text per HTML/Svelte parsing rules, not markup, so
 * `<!--` appearing literally in a script body (a string literal, a template
 * literal building HTML, a JS Annex-B line comment) is not a comment opener
 * at all -- masking it as one lets it pair with an unrelated `-->` anywhere
 * later in the file, swallowing straight through the script's own
 * `</script>` tag and losing every import in it. Comment syntax is therefore
 * only ever recognized while the cursor is in "markup" state; once a genuine
 * script opening is found, everything up to its own first `</script>` is
 * copied verbatim with no comment handling of any kind.
 *
 * Known residual gaps (regex-based extraction, not a real HTML parser):
 * a `<script>`-shaped string sitting inside a markup attribute value (e.g.
 * `<div title="<script>...</script>">`) is not distinguished from a real
 * tag, because this scan finds `<script` by raw substring search and has no
 * notion of already being inside another tag's attribute when it does. The
 * opening-tag match itself, though, is quote-aware: a `"..."`- or
 * `'...'`-quoted run in a `<script>` tag's own attributes is treated as an
 * opaque unit, so a `>` inside one (`generics="T extends Record<string,
 * unknown>"`, `data-x="/>"`) never terminates the match early the way an
 * unquoted `>` does. That quoted-run is itself capped at a newline (see the
 * doc comment on `SCRIPT_OPEN_ATTRS`) so a quote left open by a malformed
 * tag can never pair with an unrelated quote elsewhere in the file and
 * swallow everything in between; the cap trades away one narrower thing in
 * return, described next.
 *
 * A quote that fails to find a same-line closing counterpart makes the
 * attribute-capturing repetition unable to advance past it at all, so this
 * scan recognizes NO `<script` opening tag at that position -- not the main
 * loop, and not the backstop's open-tag scan below, which is byte-for-byte
 * the same pattern by construction. This is usually still safe: an orphaned
 * `</script>` left over from that same malformed tag is a separate,
 * quote-oblivious pattern (`SVELTE_SCRIPT_CLOSE_RE`), and the backstop's
 * independent close-tag scan flags it exactly as it would any other
 * unaccounted-for closing tag -- which is why `<script lang="ts>` followed
 * later by a real `</script>` still produces a warning. The gap is the
 * combination of both: a `<script` tag whose attributes contain a
 * same-line-unterminated quote AND that has no `</script>` anywhere else in
 * the file for that independent scan to catch either. In that specific
 * combination nothing in the file is left looking unaccounted-for, so
 * extraction masks the malformed tag through end of file with zero
 * diagnostics -- the same silent-loss shape as the `<!--`/prose-`-->` gap
 * described next, and, like it, deliberately accepted rather than chased
 * further here.
 *
 * `<!--` recognition has an analogous gap, by a different mechanism:
 * HTML/Svelte does not treat `<!--` as a comment-opener when it appears
 * inside a quoted attribute value (`<div title="...<!--...">`) or inside a
 * `{...}` expression (`{'<!--'}`), but this scan does, purely lexically --
 * so a `<!--`-looking substring in either position, if it later pairs with a
 * real `-->` anywhere else in the file (or never closes at all), can mask
 * real markup, or even a whole real `<script>` block, as if it were
 * commentary. A false `<!--` match is caught whenever the real `-->` it
 * pairs with turns out to belong to a later, genuinely separate comment (the
 * common shape in practice). The accepted trade-off is a false `<!--` match
 * whose found `-->` is neither part of a subsequent real comment nor absent
 * -- e.g. a `-->`-shaped substring sitting in later markup PROSE
 * (`<p>a --> b</p>`), with no second `<!--` anywhere in between. This is
 * structurally indistinguishable, by this scan, from a deliberately-authored
 * comment that happens to wrap real code, so it is trusted the same way, and
 * the script(s) after it are masked as commentary with nothing left behind
 * to flag.
 *
 * Rather than re-derive a second, independently-heuristic "expected count"
 * to compare against, this loop tracks its OWN work: every span of the file
 * it genuinely accounted for -- a real script's open-tag-through-close-tag,
 * a self-closing tag, or a comment that closed on its own `-->` with
 * nothing suspicious in its interior -- is recorded as it goes. Once the
 * loop finishes, `findLostScriptWarnings` below asks a much narrower
 * question of the raw file: does a `<script` opening or `</script>` closing
 * tag appear ANYWHERE the loop never recorded as accounted for? If so,
 * something that should have been paired up during the pass above never
 * was, which is exactly the shape a swallowed-whole script leaves behind.
 *
 * A comment is trusted enough to record as accounted-for only when it
 * actually closes AND its own interior contains no second `<!--` -- real
 * HTML/Svelte comments never nest, so a second `<!--` inside one means the
 * `-->` this scan paired it with almost certainly belongs to a later,
 * unrelated comment instead, and nothing in between should be trusted. An
 * unterminated comment or an unterminated `<script>` tag is never trusted
 * either, for the same reason: there is no way to know what, if anything,
 * was swallowed past the point where the file ran out.
 *
 * @param {string} content
 * @returns {{ code: string; hasTs: boolean; lostScriptWarnings: string[] }}
 */
function extractSvelteScript(content) {
  // Index by UTF-16 code unit (not code point) to stay aligned with
  // RegExp#exec's `match.index`, which is itself UTF-16-code-unit-based.
  // `new Array(n)` is the LENGTH form, and the loop fills every slot.
  /** @type {string[]} */
  const out = new Array(content.length);
  for (let i = 0; i < content.length; i++) out[i] = content[i] === '\n' ? '\n' : ' ';
  let hasTs = false;

  // [start, end) spans of `content` this loop genuinely recognized and
  // accounted for -- see the doc comment above for exactly what qualifies.
  // Ranges are pushed in strictly increasing order (the cursor only ever
  // moves forward), so no sorting is needed before `findLostScriptWarnings`
  // consults this list.
  /** @type {Array<[number, number]>} */
  const consumedRanges = [];

  let cursor = 0;
  for (;;) {
    SVELTE_MARKUP_TOKEN_RE.lastIndex = cursor;
    const match = SVELTE_MARKUP_TOKEN_RE.exec(content);
    if (!match) break;

    const attrs = match[1];
    if (attrs === undefined) {
      // Matched a literal `<!--`: a markup comment. Only reachable while
      // scanning markup -- a script's own body is consumed whole below,
      // without ever passing back through this branch, so a `<!--` inside
      // a script never lands here.
      const openIdx = match.index;
      const closeIdx = content.indexOf('-->', openIdx + 4);
      if (closeIdx === -1) {
        // Unterminated comment: mask to end of file rather than erroring
        // (an unclosed `<!--` still isn't code, whatever's after it in the
        // file), but don't trust any of it as accounted-for -- there is no
        // way to know what was in there.
        cursor = content.length;
        continue;
      }
      const nestedOpenIdx = content.indexOf('<!--', openIdx + 4);
      if (nestedOpenIdx === -1 || nestedOpenIdx >= closeIdx) {
        consumedRanges.push([openIdx, closeIdx + 3]);
      }
      cursor = closeIdx + 3;
      continue;
    }

    // A self-closing opening tag (`<script src="..." />`, valid e.g. inside
    // <svelte:head> to load a third-party script by URL) has no body and no
    // closing tag of its own -- treat it as ordinary markup (already
    // masked) and keep scanning after it, rather than pairing it with the
    // next `</script>` in the file and swallowing everything in between.
    if (attrs.trimEnd().endsWith('/')) {
      const tagEnd = match.index + match[0].length;
      consumedRanges.push([match.index, tagEnd]);
      cursor = tagEnd;
      continue;
    }

    if (SVELTE_TS_LANG_RE.test(attrs)) hasTs = true;

    const bodyStart = match.index + match[0].length;
    SVELTE_SCRIPT_CLOSE_RE.lastIndex = bodyStart;
    const closeMatch = SVELTE_SCRIPT_CLOSE_RE.exec(content);
    if (!closeMatch) {
      // No closing tag for this opening -- malformed input. Leave this
      // block unextracted (masked) rather than guessing where it ends, and
      // keep scanning after the opening tag for any further script blocks.
      // The open tag itself is not recorded as accounted-for either, so the
      // backstop below still sees it.
      cursor = bodyStart;
      continue;
    }

    // Script content is raw text: copy it verbatim, with no comment
    // handling applied even if it contains `<!--` or `-->` (see the doc
    // comment above).
    for (let i = bodyStart; i < closeMatch.index; i++) out[i] = content[i];
    const closeEnd = closeMatch.index + closeMatch[0].length;
    consumedRanges.push([match.index, closeEnd]);
    cursor = closeEnd;
  }
  return { code: out.join(''), hasTs, lostScriptWarnings: findLostScriptWarnings(content, consumedRanges) };
}

// Backstop tokens: any `<script` opening (self-closing or not -- a genuinely
// self-closing tag the loop recognized is always recorded as its own
// consumed range, so it never shows up as "outside" anything) or `</script>`
// closing tag, scanned across the whole raw file. Deliberately kept
// byte-for-byte the same quote-aware open-tag pattern as
// `SVELTE_MARKUP_TOKEN_RE`'s `<script...>` alternative above, so this
// backstop's notion of where a `<script>` tag ends always agrees with what
// the main loop recognized.
const SVELTE_SCRIPT_OPEN_TOKEN_RE = new RegExp(`<script\\b${SCRIPT_OPEN_ATTRS}>`, 'gi');

/**
 * Finds every `<script` opening or `</script>` closing tag in the raw file
 * that `extractSvelteScript`'s main loop did not record as part of a
 * consumed range -- i.e. text that looks like it belongs to a script tag
 * the loop never recognized as one.
 * @param {string} content
 * @param {Array<[number, number]>} consumedRanges
 * @returns {string[]}
 */
function findLostScriptWarnings(content, consumedRanges) {
  /** @param {number} start @param {number} end */
  const isAccountedFor = (start, end) =>
    consumedRanges.some(([rangeStart, rangeEnd]) => rangeStart <= start && end <= rangeEnd);

  /** @param {number} pos */
  const lineOf = (pos) => {
    let line = 1;
    for (let i = 0; i < pos; i++) if (content[i] === '\n') line++;
    return line;
  };

  /** @type {string[]} */
  const warnings = [];
  /** @param {RegExp} re @param {string} tokenLabel */
  const scanFor = (re, tokenLabel) => {
    re.lastIndex = 0;
    /** @type {RegExpExecArray | null} */
    let match;
    while ((match = re.exec(content))) {
      const start = match.index;
      const end = start + match[0].length;
      if (!isAccountedFor(start, end)) {
        warnings.push(
          `line ${lineOf(start)}: found a ${tokenLabel} outside every <script> element or comment this scan ` +
            'recognized; a script block may have been lost during extraction'
        );
      }
    }
  };

  scanFor(SVELTE_SCRIPT_OPEN_TOKEN_RE, "'<script' opening tag");
  scanFor(SVELTE_SCRIPT_CLOSE_RE, "'</script>' closing tag");
  return warnings;
}

/**
 * @param {typeof import('typescript')} ts
 * @param {string} fileName
 * @returns {import('typescript').ScriptKind}
 */
function scriptKindOf(ts, fileName) {
  if (fileName.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (fileName.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (fileName.endsWith('.ts') || fileName.endsWith('.mts') || fileName.endsWith('.cts')) {
    return ts.ScriptKind.TS;
  }
  return ts.ScriptKind.JS;
}
