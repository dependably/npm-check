// src/facts/specifier.js
// Module specifier → npm package name. This coexists with usage-scanner.js's
// `specifierToPackageName` on purpose: that one answers "which declared
// dependency does this mention count towards" for the unused-dependency
// heuristic (and so treats `@types/foo` specially); this one is the language
// fact — the package a specifier names, or nothing when it names no package.
import { builtinModules } from 'node:module';

const BUILTINS = new Set(builtinModules);

/**
 * Map a module specifier to the npm package it belongs to (lower-cased, since
 * npm names are case-insensitively unique), or undefined when the specifier is
 * not a package import: a relative/absolute path, a builtin, a `#imports`
 * key, a data:/file: URL, or a tsconfig/jsconfig path alias.
 *
 * @param {string} spec
 * @param {ReadonlySet<string>} aliasPrefixes
 * @returns {string | undefined}
 */
export function specifierToPackage(spec, aliasPrefixes) {
  if (spec.length === 0) return undefined;
  if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('#')) return undefined;
  if (spec.startsWith('node:') || spec.startsWith('data:') || spec.startsWith('file:')) {
    return undefined;
  }
  if (BUILTINS.has(spec.split('/')[0])) return undefined;

  for (const alias of aliasPrefixes) {
    if (spec === alias || spec.startsWith(`${alias}/`)) return undefined;
  }

  const parts = spec.split('/');
  if (spec.startsWith('@')) {
    if (parts.length < 2) return undefined;
    return `${parts[0]}/${parts[1]}`.toLowerCase();
  }
  return parts[0].toLowerCase();
}

/**
 * tsconfig/jsconfig `paths` keys ("@app/*", "utils") → alias bases ("@app", "utils").
 * @param {string} key
 * @returns {string}
 */
export function aliasBaseFromPathsKey(key) {
  return key.endsWith('/*') ? key.slice(0, -2) : key;
}

/** @typedef {import('./types.d.ts').AliasScope} AliasScope */

/**
 * Which path aliases are in scope for a given file.
 *
 * A `paths` map belongs to the tsconfig/jsconfig that declares it and governs
 * that project's own files -- which is what `tsc` does, and what this
 * models. One flat workspace-wide set was the earlier shape, and it let ANY
 * config anywhere under the scanned tree delete a package's evidence in
 * EVERY file: with output-shaped directory names no longer excluded by name,
 * a committed `vendor/lib/tsconfig.json` mapping `js-yaml` turned a live
 * import in `src/` into `not-observed` at high confidence with no evidence
 * and no diagnostic (sbom-reach commit 95f2b94, round-3 adversarial review).
 * Narrowing by subtree, rather than by a skip-list of directory names, is the
 * fix that does not reintroduce name-based reasoning one layer up.
 *
 * @type {ReadonlySet<string>}
 */
const NO_ALIASES = new Set();

/**
 * An `AliasScope` that answers the same set everywhere -- tests, and the
 * empty default.
 * @param {ReadonlySet<string>} [prefixes]
 * @returns {AliasScope}
 */
export function fixedAliasScope(prefixes = NO_ALIASES) {
  return { for: () => prefixes };
}

/**
 * Accept either shape at an API boundary without making every caller care.
 * @param {ReadonlySet<string> | AliasScope} aliases
 * @returns {AliasScope}
 */
export function asAliasScope(aliases) {
  return typeof (/** @type {AliasScope} */ (aliases).for) === 'function'
    ? /** @type {AliasScope} */ (aliases)
    : fixedAliasScope(/** @type {ReadonlySet<string>} */ (aliases));
}
