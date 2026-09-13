// src/schema.js
// The Dependably suite's shared finding JSON schema (v1). Every tool's
// `--format json` emits the SAME top-level envelope so an AI or CI consumer can
// parse any of the five tools identically; tool-specific data only ever rides
// under `extra` (never as a new top-level key). See the suite schema spec.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { FACTS_SCHEMA_VERSION } from './facts/version.js';

export { FACTS_SCHEMA_VERSION };

export const TOOL_NAME = 'npm-check';
export const SCHEMA_VERSION = '1.0';

// The `documentType` discriminator for the import-facts document (`npm-check
// imports`). A findings document has NO `documentType` — schema 1.0 predates
// the split and the findings envelope is unchanged — so a consumer reads
// "absent" as findings and "imports" as facts, and never has to guess the
// payload from whichever key happens to be present. Precedent: pycheck's
// `--imports` document.
export const DOCUMENT_TYPE_IMPORTS = 'imports';

// `FACTS_SCHEMA_VERSION` (re-exported above) is the facts document's OWN
// version line — see src/facts/version.js, a dependency-free leaf, so that
// this module (loaded by every lockfile command) never pulls the facts
// barrel in and the facts barrel never pulls this one into its type-check.

// The envelope-owned keys of a facts document; a body section may never
// spell one of these (see buildFactsEnvelope).
const FACTS_IDENTITY_KEYS = new Set(['tool', 'toolVersion', 'schemaVersion', 'documentType', 'target', 'summary']);

// The ONE severity ladder, most-severe first.
export const SEVERITY_LADDER = ['critical', 'high', 'moderate', 'low', 'info'];

let cachedVersion = null;

// Resolve the tool's own semver from package.json (cached). Mirrors bin/cli.js's
// getVersion so the envelope's toolVersion always matches `--version`.
export function toolVersion() {
  if (cachedVersion) return cachedVersion;
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(fs.readFileSync(path.join(here, '../package.json'), 'utf8'));
    cachedVersion = pkg.version || 'unknown';
  } catch {
    cachedVersion = 'unknown';
  }
  return cachedVersion;
}

// A zeroed bySeverity histogram with every ladder key present.
export function emptyBySeverity() {
  return { critical: 0, high: 0, moderate: 0, low: 0, info: 0 };
}

// Count findings into the ladder histogram (ignores any off-ladder severity).
export function tallyBySeverity(findings) {
  const by = emptyBySeverity();
  for (const f of findings) {
    if (f && Object.prototype.hasOwnProperty.call(by, f.severity)) by[f.severity]++;
  }
  return by;
}

/**
 * Assemble the shared envelope. `findings` MUST be the complete, schema-conformant
 * list (never truncated); `summary.findings` is derived from it and `summary.exitCode`
 * MUST equal the process exit code the run will return.
 *
 * @param {object} args
 * @param {string} args.target   - path/manifest scanned, as given
 * @param {number} args.scanned  - packages examined
 * @param {Array}  args.findings - schema Finding objects
 * @param {number} args.exitCode - the real process exit code (0/1/2)
 * @param {object} [args.extra]  - the ONE sanctioned tool-specific escape hatch
 * @returns {object} the envelope
 */
export function buildEnvelope({ target, scanned, findings, exitCode, extra }) {
  const list = Array.isArray(findings) ? findings : [];
  const envelope = {
    tool: TOOL_NAME,
    toolVersion: toolVersion(),
    schemaVersion: SCHEMA_VERSION,
    target,
    summary: {
      scanned,
      findings: list.length,
      bySeverity: tallyBySeverity(list),
      exitCode
    },
    findings: list
  };
  if (extra !== undefined) envelope.extra = extra;
  return envelope;
}

/**
 * Assemble the import-facts envelope: the SAME identity fields as the
 * findings envelope (`tool`, `toolVersion`, `schemaVersion` — the facts
 * document's OWN version line, `FACTS_SCHEMA_VERSION` — `target`,
 * `summary`) plus the `documentType` discriminator, and NO `findings` — an
 * import site has no severity, so it must never ride in the findings array
 * where `--fail-on` could gate on it. `body` is spread after the identity
 * fields: the facts sections (`workspace`, `imports`, `moduleGraph`,
 * `lockfile`, `unanalyzable`); a `summary` inside `body` is ignored in favour
 * of the one passed explicitly, and the identity fields always win.
 *
 * @param {object} args
 * @param {string} args.target  - path scanned, as given
 * @param {object} args.summary - the facts summary; `summary.exitCode` MUST equal the real process exit code
 * @param {object} args.body    - the document sections
 * @returns {object} the envelope
 */
export function buildFactsEnvelope({ target, summary, body }) {
  // Strip anything in `body` that spells an identity field, so the sections
  // can never overwrite the envelope's own claims about what it is.
  const sections = Object.fromEntries(
    Object.entries(body && typeof body === 'object' ? body : {}).filter(([key]) => !FACTS_IDENTITY_KEYS.has(key))
  );
  return {
    tool: TOOL_NAME,
    toolVersion: toolVersion(),
    schemaVersion: FACTS_SCHEMA_VERSION,
    documentType: DOCUMENT_TYPE_IMPORTS,
    target,
    summary,
    ...sections
  };
}
