// src/facts/ts.js
// `typescript` is an OPTIONAL peer dependency: the lockfile commands never need
// it, and a consumer of the package root must not pay for a 10 MB compiler it
// never loads. It is therefore resolved lazily and synchronously (createRequire,
// the same pattern `parser.js` uses for `yaml`), the first time a facts module
// actually parses something, and its absence is a coded error — the CLI maps
// `TYPESCRIPT_MISSING` to a usage error (exit 2) with an install hint rather
// than a stack trace.
import { createRequire } from 'node:module';
import { FactsError } from './errors.js';

const require = createRequire(import.meta.url);

/** @type {typeof import('typescript') | undefined} */
let cached;

/**
 * The TypeScript compiler API, loaded once.
 * @returns {typeof import('typescript')}
 * @throws {FactsError} `TYPESCRIPT_MISSING` when the peer is not installed.
 */
export function loadTypeScript() {
  if (cached) return cached;
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
