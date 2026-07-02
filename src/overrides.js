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
 * Derive the overridden package name from an override key, stripping a trailing
 * `@version` selector (npm allows `"foo@2"`, `"@scope/foo@^1.0.0"` to scope an
 * override to matching versions). The leading `@` of a scope is preserved.
 * @param {string} key
 * @returns {string}
 */
function overrideName(key) {
  const at = key.lastIndexOf('@');
  return at > 0 ? key.slice(0, at) : key;
}

/**
 * Walk an overrides object, yielding every value leaf (each non-object entry).
 * `$name` references are skipped (they point at a direct dep's version, not a
 * range). A leaf's `range` is usually a string but MAY be a non-string for a
 * malformed manifest — consumers classify/validate it (classifyRange and
 * isValidRange both handle non-strings), so the validator can flag bad values.
 *
 * @param {object} overrides - The overrides object (npm `overrides` or `pnpm.overrides`)
 * @param {object} [opts] - Internal recursion state: { parentName, path }
 * @yields {{ path: string, name: string, range: *, container: object, key: string }}
 *   path      - human-readable location ("foo", "bar > baz", "bar > .")
 *   name      - the effective package name overridden (the parent for a "." key,
 *               with any `@version` selector stripped)
 *   range     - the leaf value (a range string, or a non-string if malformed)
 *   container - the object holding the leaf (so a caller can rewrite in place)
 *   key       - the leaf's key within `container`
 */
export function* walkOverrides(overrides, opts = {}) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) return;
  const { parentName = null, path = '' } = opts;

  for (const [key, value] of Object.entries(overrides)) {
    const here = path ? `${path} > ${key}` : key;
    // "." refers to the parent package itself (npm nested form).
    const name = key === '.' ? parentName : overrideName(key);

    if (value && typeof value === 'object' && !Array.isArray(value)) {
      // Nested override object: the "." inside it refers to THIS key's package.
      yield* walkOverrides(value, { parentName: name, path: here });
    } else {
      // Leaf value: a range string, or a malformed non-string (number/null/array).
      // "$name" is a reference to a direct dep's version, not a range — skip it.
      if (typeof value === 'string' && value.startsWith('$')) continue;
      // A stray "." at the top level (no parent) is malformed — skip it.
      if (name == null) continue;
      yield { path: here, name, range: value, container: overrides, key };
    }
  }
}
