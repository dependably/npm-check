// src/facts/errors.js
// The one error type the import-facts modules throw for a condition the caller
// is expected to handle by code rather than by message: `TYPESCRIPT_MISSING`
// (the optional `typescript` peer is not installed). Everything else — an
// unreadable file, an unparseable lockfile — is reported IN the facts, never
// thrown, because a facts document that aborts on one bad file has told the
// consumer nothing about the rest of the tree.

export class FactsError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.name = 'FactsError';
    this.code = code;
  }
}
