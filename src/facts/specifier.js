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
