// Registry credentials from .npmrc, resolved the way npm resolves them.
//
// The registry-backed checks (integrity / vuln / deprecation / fix-checksums /
// remediate) used to send no credentials, so a private registry that requires
// auth — Dependably among them — answered every request with 401 and the whole
// scan landed in "Unresolved". This module reads the same files npm and pnpm do
// (project `.npmrc` over the user-level one) and answers one question per
// request: which Authorization header, if any, belongs to this URL.
//
// Credential scoping follows npm-registry-fetch: a credential is keyed by a
// "nerf dart" (`//host[:port]/path/`) and applies only to URLs under that
// prefix, longest prefix winning. Nothing is ever sent to a host the user did
// not configure a credential for, so a lockfile that steers a `resolved` URL to
// another host cannot collect a token. Unscoped legacy `_authToken`/`_auth`
// keys are ignored for the same reason — they name no host.

import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseNpmrc } from './npmrc-validator.js';

// Credential fields npm reads under a nerf-dart prefix. Keys arrive lowercased
// from parseNpmrc, so `_authToken` is matched as `_authtoken`.
const AUTH_FIELDS = new Set(['_authtoken', '_auth', 'username', '_password']);

/**
 * Expand `${VAR}` references against the environment, as npm does for every
 * .npmrc value. Committed .npmrc files carry tokens this way (`${NPM_TOKEN}`),
 * so without expansion the header would be the literal placeholder. Returns
 * null when a referenced variable is unset or empty — a credential that could
 * not be resolved is no credential, never a half-expanded string.
 * @param {string} value
 * @param {object} env
 * @returns {string|null}
 */
export function expandEnvRefs(value, env) {
  let missing = false;
  const out = value.replace(/\$\{([^}]+)\}/g, (_, name) => {
    const v = env[name];
    if (v === undefined || v === '') missing = true;
    return v ?? '';
  });
  return missing ? null : out;
}

// Split `//host/path/:field` into its nerf dart and field, or null when the key
// isn't a scoped credential.
function splitScopedKey(key) {
  if (!key.startsWith('//')) return null;
  const colon = key.lastIndexOf(':');
  if (colon <= 2) return null;
  const field = key.slice(colon + 1);
  if (!AUTH_FIELDS.has(field)) return null;
  let dart = key.slice(0, colon);
  if (!dart.endsWith('/')) dart += '/';
  return { dart, field };
}

// Turn one nerf dart's collected fields into an Authorization header value.
function headerFor(fields) {
  if (fields._authtoken) return `Bearer ${fields._authtoken}`;
  if (fields._auth) return `Basic ${fields._auth}`;
  if (fields.username && fields._password) {
    // npm stores `_password` base64-encoded.
    const password = Buffer.from(fields._password, 'base64').toString('utf8');
    return `Basic ${Buffer.from(`${fields.username}:${password}`).toString('base64')}`;
  }
  return null;
}

/**
 * Build a credential resolver from .npmrc layers, lowest precedence first (so a
 * project file listed after the user file overrides it per nerf dart + field).
 * @param {Array<Array<{key: string, value: string}>>} layers - parseNpmrc outputs
 * @param {object} [env] - Environment for `${VAR}` expansion
 * @returns {{ authFor: (url: string) => string|null, hosts: string[] }}
 */
export function createRegistryAuth(layers, env = process.env) {
  const byDart = new Map();
  for (const entries of layers) {
    for (const { key, value } of entries) {
      const scoped = splitScopedKey(key);
      if (!scoped) continue;
      const expanded = expandEnvRefs(value, env);
      const fields = byDart.get(scoped.dart) || {};
      if (expanded) fields[scoped.field] = expanded;
      else delete fields[scoped.field];
      byDart.set(scoped.dart, fields);
    }
  }

  const headers = new Map();
  for (const [dart, fields] of byDart) {
    const header = headerFor(fields);
    if (header) headers.set(dart, header);
  }

  return {
    authFor(url) {
      if (headers.size === 0) return null;
      let parsed;
      try {
        parsed = new URL(url);
      } catch {
        return null;
      }
      // Never put a credential on a plaintext connection.
      if (parsed.protocol !== 'https:') return null;
      // Walk `//host/a/b/` → `//host/a/` → `//host/`, longest prefix first.
      const segments = parsed.pathname.split('/').filter(Boolean);
      for (let n = segments.length; n >= 0; n--) {
        const dart = `//${parsed.host.toLowerCase()}/${segments.slice(0, n).map((s) => `${s.toLowerCase()}/`).join('')}`;
        const header = headers.get(dart);
        if (header) return header;
      }
      return null;
    },
    // Hosts that have a credential, for diagnostics. Never the credentials.
    hosts: [...new Set([...headers.keys()].map((d) => d.slice(2, d.indexOf('/', 2))))]
  };
}

/**
 * The user-level .npmrc path, honouring npm's `userconfig` override.
 * @param {object} env
 * @param {string} homeDir
 * @returns {string}
 */
export function userNpmrcPath(env = process.env, homeDir = os.homedir()) {
  return env.NPM_CONFIG_USERCONFIG || env.npm_config_userconfig || path.join(homeDir, '.npmrc');
}

/**
 * Read the .npmrc layers that govern an install of `projectDir`, lowest
 * precedence first: the user-level file, then the project file. A missing or
 * unreadable file contributes nothing.
 * @param {object} options
 * @param {string} [options.projectDir] - Directory holding the lockfile
 * @param {object} [options.env]
 * @param {string} [options.homeDir]
 * @returns {Array<Array<{key: string, value: string, line: number}>>}
 */
export function readNpmrcLayers({ projectDir, env = process.env, homeDir = os.homedir() } = {}) {
  const files = [userNpmrcPath(env, homeDir)];
  if (projectDir) files.push(path.join(projectDir, '.npmrc'));
  const layers = [];
  for (const file of new Set(files.map((f) => path.resolve(f)))) {
    try {
      layers.push(parseNpmrc(fs.readFileSync(file, 'utf8')));
    } catch {
      // Absent or unreadable — no credentials from this layer.
    }
  }
  return layers;
}

/**
 * Load the credential resolver for a project: user .npmrc, overridden by the
 * project .npmrc next to the lockfile.
 * @param {object} [options] - { projectDir, env, homeDir }
 * @returns {{ authFor: (url: string) => string|null, hosts: string[] }}
 */
export function loadRegistryAuth(options = {}) {
  return createRegistryAuth(readNpmrcLayers(options), options.env || process.env);
}
