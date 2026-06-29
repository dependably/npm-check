// src/schema.js
// The Dependably suite's shared finding JSON schema (v1). Every tool's
// `--format json` emits the SAME top-level envelope so an AI or CI consumer can
// parse any of the five tools identically; tool-specific data only ever rides
// under `extra` (never as a new top-level key). See the suite schema spec.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const TOOL_NAME = 'npm-check';
export const SCHEMA_VERSION = '1.0';

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
