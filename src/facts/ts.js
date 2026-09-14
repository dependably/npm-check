// src/facts/ts.js
// `typescript` is an OPTIONAL peer dependency: the lockfile commands never need
// it, and a consumer of the package root must not pay for a 10 MB compiler it
// never loads. It is therefore resolved lazily and synchronously (createRequire,
// the same pattern `parser.js` uses for `yaml`), the first time a facts module
// actually parses something, and its absence is a coded error — the CLI maps
// `TYPESCRIPT_MISSING` to a usage error (exit 2) with an install hint rather
// than a stack trace.
//
// NOTHING here runs at module load. `createRequire` is built inside
// `loadTypeScript()`, from `__filename` when a CJS bundle defines it and from
// `import.meta.url` otherwise: esbuild rewrites `import.meta.url` to
// `undefined` in a CJS bundle, and `createRequire(undefined)` throws
// `ERR_INVALID_ARG_VALUE` — at import time, as a plain Error no
// `TYPESCRIPT_MISSING` handler would ever see (adversarial review). Importing
// the barrel must never throw; only a parse can.
import { createRequire } from 'node:module';
import { FactsError } from './errors.js';

/** @type {typeof import('typescript') | undefined} */
let cached;

/**
 * The TypeScript compiler API, loaded once.
 * @returns {typeof import('typescript')}
 * @throws {FactsError} `TYPESCRIPT_MISSING` when the peer is not installed.
 */
export function loadTypeScript() {
  if (cached) return cached;
  // `__filename` is only defined in a CommonJS context (a bundle); in ESM the
  // `typeof` guard keeps the reference from throwing.
  const anchor = typeof __filename !== 'undefined' ? __filename : import.meta.url;
  const require = createRequire(anchor);
  try {
    cached = /** @type {typeof import('typescript')} */ (require('typescript'));
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined;
    if (code !== 'MODULE_NOT_FOUND' && code !== 'ERR_MODULE_NOT_FOUND') throw err;
    throw new FactsError(
      'TYPESCRIPT_MISSING',
      'import facts need the `typescript` package (an optional peer dependency of @dependably/npm-check), ' +
        'which is not installed. Install it alongside npm-check: `npm install --save-dev typescript` ' +
        '(any 5.6+ release).'
    );
  }
  return cached;
}
