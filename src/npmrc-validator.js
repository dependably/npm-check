// src/npmrc-validator.js
// Parse and validate an ini-style project `.npmrc`, mirroring validator.js's
// contract: validateNpmrc(contentOrParsed, options) => { valid, errors, warnings, info }.
// We only ever inspect the project-level `.npmrc` (the committed, reproducible
// artifact) — not the machine's ~/.npmrc — so results match between local and CI.

export class NpmrcValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'NpmrcValidationError';
    this.code = code;
  }
}

/**
 * Parse ini-style .npmrc content into entries, recording 1-based line numbers.
 * Tolerant and comment-aware (`;` and `#` start comments, inline too); strips
 * surrounding quotes from values. A non-comment, non-blank line without `=` is
 * flagged `malformed` so the validator can report a syntax error.
 *
 * @returns {{ key: string|null, value: string|null, line: number, raw?: string, malformed?: boolean }[]}
 */
export function parseNpmrc(content) {
  const entries = [];
  const lines = (content || '').split(/\r?\n/);
  lines.forEach((raw, i) => {
    // Strip comments: a `;`/`#` starts a comment only at line-start or when
    // preceded by whitespace (npm/ini semantics) — so `_password=pa#ss` keeps
    // its literal value and a secret can't be truncated out of detection.
    const line = raw.replace(/(^|\s)[;#].*$/, '$1').trim();
    if (!line) return;
    const eq = line.indexOf('=');
    if (eq === -1) {
      entries.push({ key: null, value: null, line: i + 1, raw: raw.trim(), malformed: true });
      return;
    }
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    entries.push({
      key: line.slice(0, eq).trim().toLowerCase(),
      value,
      line: i + 1
    });
  });
  return entries;
}

// Common, recognized npm config keys — used only to *warn* on unknowns, so this
// is intentionally a generous subset rather than an exhaustive list.
const KNOWN_KEYS = new Set([
  'registry', 'fund', 'audit', 'audit-level', 'save', 'save-exact', 'save-prefix',
  'package-lock', 'package-lock-only', 'engine-strict', 'strict-ssl', 'ca', 'cafile',
  'cert', 'key', 'proxy', 'https-proxy', 'noproxy', 'always-auth', 'init-author-name',
  'init-author-email', 'init-author-url', 'init-license', 'init-version', 'loglevel',
  'prefix', 'cache', 'legacy-peer-deps', 'fetch-retries', 'fetch-retry-mintimeout',
  'fetch-retry-maxtimeout', 'fetch-timeout', 'access', 'tag', 'lockfile-version',
  'omit', 'include', 'ignore-scripts', 'foreground-scripts', 'node-options',
  'progress', 'prefer-offline', 'prefer-dline', 'offline', 'global', 'unsafe-perm',
  'user-agent', 'maxsockets', 'before', 'workspaces', 'workspace'
]);

// Plaintext-credential keys: bare `_auth`/`_authtoken`/`_password`, or the
// scoped `//host/:_authToken` form npm uses for per-registry auth.
const SECRET_KEY_RE = /(^|\/|:)_(auth|authtoken|password)$/i;
const ENV_REF_RE = /\$\{[^}]+\}/;
// A value that is ENTIRELY an env reference is safe; a partial one
// (`realsecret${X}`) must NOT exempt the line, or a plaintext secret slips by.
const ENV_REF_ONLY_RE = /^\$\{[^}]+\}$/;

const ALWAYS_ERROR_CODES = new Set([
  'NPMRC_PLAINTEXT_SECRET',
  'NPMRC_STRICT_SSL_OFF',
  'NPMRC_REJECT_UNAUTHORIZED_OFF'
]);

/**
 * Security-critical codes that should fail a run regardless of how the audit
 * rule's severity is configured. Exported so the audit rule can force them.
 */
export const NPMRC_SECURITY_CODES = ALWAYS_ERROR_CODES;

export function validateNpmrc(input, options = {}) {
  const entries = typeof input === 'string' ? parseNpmrc(input) : (input || []);
  const errors = [];
  const warnings = [];
  const info = { keys: entries.filter((e) => e.key).map((e) => e.key) };

  for (const e of entries) {
    if (e.malformed) {
      errors.push(new NpmrcValidationError(`malformed line ${e.line}: "${e.raw}" (expected key=value)`, 'NPMRC_SYNTAX'));
      continue;
    }
    const { key, value, line } = e;

    // --- plaintext credentials ---
    if (SECRET_KEY_RE.test(key)) {
      if (!ENV_REF_ONLY_RE.test(value)) {
        errors.push(new NpmrcValidationError(
          `plaintext credential at line ${line} ("${key}") — use an env var reference like \${NPM_TOKEN}`,
          'NPMRC_PLAINTEXT_SECRET'));
      }
      continue; // auth lines aren't subject to the unknown-key warning
    }

    // --- TLS / verification weakening ---
    if (key === 'strict-ssl' && /^(false|0)$/i.test(value)) {
      errors.push(new NpmrcValidationError(`strict-ssl=${value} at line ${line} disables TLS verification`, 'NPMRC_STRICT_SSL_OFF'));
      continue;
    }
    if (key.endsWith('rejectunauthorized') && /^(false|0)$/i.test(value)) {
      errors.push(new NpmrcValidationError(`rejectUnauthorized disabled at line ${line}`, 'NPMRC_REJECT_UNAUTHORIZED_OFF'));
      continue;
    }

    // --- privilege escalation ---
    if (key === 'unsafe-perm' && /^(true|1)$/i.test(value)) {
      warnings.push({ code: 'NPMRC_UNSAFE_PERM', message: `unsafe-perm enabled at line ${line} — lifecycle scripts run with elevated privileges` });
      continue;
    }

    // --- registry URL validity / scheme ---
    if (key === 'registry' || key.endsWith(':registry')) {
      if (ENV_REF_RE.test(value)) continue; // env-interpolated URL — can't statically parse
      let url = null;
      try {
        url = new URL(value);
      } catch {
        errors.push(new NpmrcValidationError(`invalid registry URL at line ${line}: "${value}"`, 'NPMRC_INVALID_REGISTRY'));
      }
      if (url && url.protocol === 'http:') {
        warnings.push({ code: 'NPMRC_INSECURE_REGISTRY', message: `registry over http:// at line ${line} (${value}) — prefer https://` });
      }
      continue;
    }

    // --- unknown key (warn only) ---
    if (key.startsWith('//')) continue; // per-registry auth/config line
    const bareKey = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
    if (!KNOWN_KEYS.has(key) && !KNOWN_KEYS.has(bareKey)) {
      warnings.push({ code: 'NPMRC_UNKNOWN_KEY', message: `unrecognized npm config key "${key}" at line ${line}` });
    }
  }

  const valid = errors.length === 0 && !(options.strictMode && warnings.length > 0);
  return { valid, errors, warnings, info };
}
