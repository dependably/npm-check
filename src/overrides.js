// src/overrides.js
// Shared walker for npm `overrides` and the pnpm `pnpm.overrides` manifest field.
//
// npm `overrides` is NESTED: a value is either a range string or a nested object
// whose "." key overrides the parent package itself and whose other keys override
// that package's own children. A string value beginning with "$" is a REFERENCE
// to a direct dependency's version, not a range, and must be skipped.
//
// pnpm `pnpm.overrides` is a FLAT map whose keys are selectors (`foo`, `foo@1`,
// `parent>child`) and whose values are range strings (also possibly "$ref"); the
// flat form is just the non-nested base case of the same walk.
//
// Zero dependencies — a pure structural generator. Consumers (pinner, audit
// pinned-versions rule, package.json validator) classify/validate the ranges.

/**
 * Walk an overrides object, yielding each concrete range leaf.
 *
 * @param {object} overrides - The overrides object (npm `overrides` or `pnpm.overrides`)
 * @param {object} [opts] - Internal recursion state: { parentName, path }
 * @yields {{ path: string, name: string, range: string, container: object, key: string }}
 *   path      - human-readable location ("foo", "bar > baz", "bar > .")
 *   name      - the effective package name overridden (the parent for a "." key)
 *   range     - the range string
 *   container - the object holding the leaf (so a caller can rewrite in place)
 *   key       - the leaf's key within `container`
 */
export function* walkOverrides(overrides, opts = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
  const { parentName = null, path = '' } = opts;

  for (const [key, value] of Object.entries(overrides)) {
    const here = path ? `${path} > ${key}` : key;
    // "." refers to the parent package itself (npm nested form).
    const name = key === '.' ? parentName : key;

    if (typeof value === 'string') {
      // "$name" is a reference to a direct dependency's version, not a range.
      if (value.startsWith('$')) continue;
      // A stray "." at the top level (no parent) is malformed — skip it.
      if (name == null) continue;
      yield { path: here, name, range: value, container: overrides, key };
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Nested override object: the "." inside it refers to THIS key's package.
      yield* walkOverrides(value, { parentName: key, path: here });
    }
  }
}
