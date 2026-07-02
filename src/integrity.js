// src/integrity.js
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';

/**
 * Generate SHA512 integrity hash for raw data
 * @param {string} data - Content to hash
 * @returns {string} Integrity hash in 'sha512-<base64>' format
 */
export function generateIntegrityFromData(data) {
  const hash = crypto.createHash('sha512');
  hash.update(data);
  const digest = hash.digest('base64');
  return `sha512-${digest}`;
}

/**
 * Generate SHA512 integrity hash from a file
 * @param {string} filePath - Path to the file
 * @returns {string} Integrity hash in 'sha512-<base64>' format
 */
export function generateIntegrityFromFile(filePath) {
  try {
    // Read raw bytes — hashing decoded utf8 corrupts binary content (e.g. tarballs)
    const data = fs.readFileSync(filePath);
    return generateIntegrityFromData(data);
  } catch (e) {
    console.error(`Failed to read file ${filePath}: ${e.message}`);
    return null;
  }
}

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/**
 * Return true when `url`'s host is acceptable to query. The lockfile's `resolved`
 * URL is attacker-controlled, so a caller that wants to pin the trusted registry
 * set (SSRF / self-attesting-host defense, issue #12) passes an `allowedHosts`
 * allowlist; with no allowlist the historical "trust whatever the lockfile says"
 * behavior is preserved so existing callers are unaffected.
 * @param {URL} url - Parsed resolved URL
 * @param {string[]|Set<string>} [allowedHosts] - Permitted host (or host:port) values
 * @returns {boolean}
 */
function isAllowedRegistryHost(url, allowedHosts) {
  if (!allowedHosts) return true;
  const list = Array.isArray(allowedHosts) ? allowedHosts : Array.from(allowedHosts);
  if (list.length === 0) return true;
  const host = url.host.toLowerCase();
  const hostname = url.hostname.toLowerCase();
  return list.some((h) => {
    if (typeof h !== 'string') return false;
    const allowed = h.toLowerCase();
    return allowed === host || allowed === hostname;
  });
}

/**
 * Derive the registry base URL from a package's resolved tarball URL.
 * npm tarball URLs follow <registryBase>/<name>/-/<file>.tgz, where scoped
 * names may appear as '@scope/name' or '@scope%2fname' in the path.
 * @param {string} resolvedUrl - The entry's resolved URL
 * @param {string} packageName - The real package name
 * @param {object} [options] - { allowedHosts } to pin the trusted registry set
 * @returns {string|null} Registry base or null if not derivable / not allowed
 */
export function deriveRegistryBase(resolvedUrl, packageName, options = {}) {
  if (!resolvedUrl || !packageName) return null;
  let url;
  try {
    url = new URL(resolvedUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  // Refuse to derive a base from a host outside the caller's allowlist. Without
  // this, a hostile lockfile steers integrity/vuln/deprecation fetches to an
  // arbitrary (internal) host of its choosing and can self-attest a tampered
  // `integrity` by also pointing `resolved` at a server it controls.
  if (!isAllowedRegistryHost(url, options.allowedHosts)) return null;

  const markerIdx = url.pathname.indexOf('/-/');
  if (markerIdx === -1) return null;

  let beforeMarker = url.pathname.slice(0, markerIdx);
  // Strip the package name (possibly %2f-encoded for scopes) off the tail
  const encodedName = packageName.replace('/', '%2f');
  for (const candidate of [`/${packageName}`, `/${encodedName}`]) {
    if (beforeMarker.toLowerCase().endsWith(candidate.toLowerCase())) {
      beforeMarker = beforeMarker.slice(0, beforeMarker.length - candidate.length);
      return `${url.origin}${beforeMarker}`;
    }
  }
  return null;
}

// Hard ceiling on a single registry response body. The `resolved` host is
// attacker-controlled, so a hostile/broken registry could otherwise stream an
// unbounded body and exhaust memory (issue #12). Overridable per call for tests.
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Pick the transport module for a URL by scheme. npm itself supports plaintext
 * `http://` registries (Verdaccio/Nexus on a LAN); the old https-only transport
 * threw ERR_INVALID_PROTOCOL on them (issue #16).
 * @param {string} url
 * @returns {typeof http | typeof https}
 */
function transportFor(url) {
  return new URL(url).protocol === 'http:' ? http : https;
}

/**
 * Wrap resolve/reject so the promise settles exactly once. Many independent
 * events (size cap, response error, timeout, deadline, end) race to settle a
 * single request; without a guard a later one throws "already settled".
 */
function onceSettlers(resolve, reject) {
  let done = false;
  return {
    resolve: (v) => { if (!done) { done = true; resolve(v); } },
    reject: (e) => { if (!done) { done = true; reject(e); } }
  };
}

/**
 * Attach body handlers to a response: enforce the size cap, parse JSON on end,
 * and — critically — handle a mid-body stream `error`. Once headers arrive a
 * socket reset (ECONNRESET / premature close, routine under high concurrency) is
 * emitted on the IncomingMessage, not the request; without this listener it is an
 * uncaught exception that crashes the whole run (issue #16).
 */
function collectJsonBody(res, url, maxBytes, settle) {
  let data = '';
  let bytes = 0;
  res.on('data', (chunk) => {
    bytes += chunk.length;
    if (bytes > maxBytes) {
      settle.reject(new Error(`Registry response exceeded ${maxBytes} bytes for ${url}`));
      res.destroy();
      return;
    }
    data += chunk;
  });
  res.on('end', () => {
    try {
      settle.resolve(JSON.parse(data));
    } catch {
      settle.reject(new Error(`Invalid JSON from registry for ${url}`));
    }
  });
  res.on('error', (e) => settle.reject(e));
}

/**
 * Shared GET/POST core: protocol-aware transport, single-host redirect, size cap,
 * an idle (socket-inactivity) timeout AND a wall-clock deadline (a byte-trickle
 * can keep resetting the idle timer forever — issue #12), plus a response-stream
 * error handler.
 */
function requestJson({ url, method, payload, timeoutMs, redirectsLeft, maxBytes, deadlineMs, followRedirect }) {
  return new Promise((resolve, reject) => {
    const settle = onceSettlers(resolve, reject);
    const requestOptions = { method };
    if (payload !== null) {
      requestOptions.headers = {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      };
    }
    const handleResponse = (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        let target;
        try {
          target = new URL(res.headers.location, url);
        } catch {
          settle.reject(new Error(`Invalid redirect location "${res.headers.location}" for ${url}`));
          return;
        }
        // Only follow a redirect to the SAME host — a security check must not be
        // bounced to an arbitrary attacker-controlled origin for its answer.
        if (target.host !== new URL(url).host) {
          settle.reject(new Error(`refusing cross-host redirect to ${target.host} for ${url}`));
          return;
        }
        followRedirect(target.toString(), redirectsLeft - 1).then(settle.resolve, settle.reject);
        return;
      }
      if (res.statusCode === 404) {
        res.resume();
        settle.resolve(null);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        settle.reject(new Error(`Registry responded with status ${res.statusCode} for ${url}`));
        return;
      }
      collectJsonBody(res, url, maxBytes, settle);
    };

    let req;
    try {
      req = transportFor(url).request(url, requestOptions, handleResponse);
    } catch (e) {
      settle.reject(e);
      return;
    }
    req.on('error', settle.reject);
    // Idle timeout: fires after `timeoutMs` of socket inactivity.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Registry request timed out after ${timeoutMs}ms: ${url}`));
    });
    // Wall-clock deadline: a hard ceiling on total request duration regardless of
    // activity, so a slow trickle cannot hang the run indefinitely.
    const deadline = setTimeout(() => {
      req.destroy(new Error(`Registry request exceeded ${deadlineMs}ms deadline: ${url}`));
    }, deadlineMs);
    if (typeof deadline.unref === 'function') deadline.unref();
    const clearDeadline = () => clearTimeout(deadline);
    req.on('close', clearDeadline);
    req.on('error', clearDeadline);

    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * GET and parse JSON from a registry URL.
 * @param {string} url - Full URL
 * @param {number} timeoutMs - Per-request idle timeout (also the default deadline)
 * @param {number} [redirectsLeft] - Remaining same-host redirect hops
 * @param {object} [options] - { maxBytes, deadlineMs } (deadlineMs defaults to timeoutMs)
 * @returns {Promise<object|null>} Parsed JSON, or null on 404
 */
export function getJson(url, timeoutMs, redirectsLeft = 1, options = {}) {
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const deadlineMs = options.deadlineMs ?? timeoutMs;
  return requestJson({
    url,
    method: 'GET',
    payload: null,
    timeoutMs,
    redirectsLeft,
    maxBytes,
    deadlineMs,
    followRedirect: (target, left) => getJson(target, timeoutMs, left, options)
  });
}

/**
 * POST a JSON body to a registry endpoint and resolve the parsed JSON response.
 * Modeled on the GET helper above; used for the bulk advisory endpoint.
 * Resolves null on 404 (endpoint not supported by this registry); rejects on
 * network errors/timeouts/non-200 so callers can distinguish "offline" from
 * "unsupported".
 * @param {string} url - Full endpoint URL
 * @param {object} bodyObject - JSON-serializable request body
 * @param {number} timeoutMs - Per-request idle timeout (also the default deadline)
 * @param {number} [redirectsLeft] - Remaining redirect hops
 * @param {object} [options] - { maxBytes, deadlineMs }
 * @returns {Promise<object|null>} Parsed JSON, or null on 404
 */
export function postJson(url, bodyObject, timeoutMs, redirectsLeft = 1, options = {}) {
  const payload = JSON.stringify(bodyObject);
  const maxBytes = options.maxBytes ?? MAX_RESPONSE_BYTES;
  const deadlineMs = options.deadlineMs ?? timeoutMs;
  return requestJson({
    url,
    method: 'POST',
    payload,
    timeoutMs,
    redirectsLeft,
    maxBytes,
    deadlineMs,
    followRedirect: (target, left) => postJson(target, bodyObject, timeoutMs, left, options)
  });
}

// npm package-name grammar (case-insensitive to tolerate legacy mixed-case names
// such as `JSONStream`). A valid name is an optional single `@scope/` segment
// plus a name segment, with a restricted charset — so it can contain no extra
// `/`, no `?`/`#`, and can't start with `.`/`_`. This is the primary defense.
const NPM_NAME_RE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/i;

/**
 * Validate a package name against npm's naming grammar, then percent-encode it
 * for a registry URL path. A lockfile-controlled name (an entry's `name` field,
 * an `npm:` alias, or a pnpm depPath) is untrusted; the old `replace('/', '%2f')`
 * only touched the first slash and encoded nothing else, so a scoped name could
 * smuggle extra path segments or a query string onto the target (issue #30).
 * Scoped names keep the literal '@' and encode the '/' separator as '%2f'; every
 * other segment is fully `encodeURIComponent`d as defense-in-depth.
 * @param {string} packageName - Name of the package
 * @returns {string} URL-safe name path
 * @throws {Error} when the name is not a valid npm package name
 */
function encodePackageNamePath(packageName) {
  if (typeof packageName !== 'string' || packageName.length > 214 || !NPM_NAME_RE.test(packageName)) {
    throw new Error(`Invalid package name for registry URL: ${JSON.stringify(packageName)}`);
  }
  return packageName
    .split('/')
    .map((segment) => (segment.startsWith('@')
      ? `@${encodeURIComponent(segment.slice(1))}`
      : encodeURIComponent(segment)))
    .join('%2f');
}

/**
 * Build the registry URL for a single package version manifest.
 * Scoped names keep the literal '/' encoded as %2f per registry convention.
 * @param {string} registryBase - Registry base URL
 * @param {string} packageName - Name of the package
 * @param {string} version - Exact version
 * @returns {string} Full manifest URL
 */
function packumentVersionUrl(registryBase, packageName, version) {
  let base = registryBase;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return `${base}/${encodePackageNamePath(packageName)}/${encodeURIComponent(version)}`;
}

/**
 * Fetch a package's full packument (all versions + dist-tags) from a registry.
 * Resolves the parsed packument, null on 404, rejects on network errors/timeouts.
 * @param {string} packageName - Name of the package
 * @param {object} options - { registryBase, timeoutMs, fetchJson (injectable transport for tests) }
 * @returns {Promise<object|null>} Packument or null
 */
export async function fetchPackument(packageName, options = {}) {
  const { registryBase = DEFAULT_REGISTRY, timeoutMs = 10000, fetchJson = getJson } = options;
  let base = registryBase;
  while (base.endsWith('/')) base = base.slice(0, -1);
  return fetchJson(`${base}/${encodePackageNamePath(packageName)}`, timeoutMs);
}

/**
 * Fetch a package's "latest" dist-tag version from a registry.
 * Resolves the version string, or null if the package/tag is unavailable.
 * @param {string} packageName - Name of the package
 * @param {object} options - { registryBase, timeoutMs, fetchJson }
 * @returns {Promise<string|null>} Latest version or null
 */
export async function fetchLatestVersion(packageName, options = {}) {
  const packument = await fetchPackument(packageName, options);
  const latest = packument && packument['dist-tags'] && packument['dist-tags'].latest;
  return typeof latest === 'string' ? latest : null;
}

/**
 * Fetch a single package version's manifest from a registry.
 * Resolves the parsed manifest object, null when the package/version is not
 * found (404), and rejects on network errors/timeouts so callers can
 * distinguish "offline" from "not on npm".
 * @param {string} packageName - Name of the package
 * @param {string} version - Exact version
 * @param {object} options - { registryBase, timeoutMs, fetchJson (injectable transport for tests) }
 * @returns {Promise<object|null>} Version manifest or null
 */
export async function fetchPackumentManifest(packageName, version, options = {}) {
  const { registryBase = DEFAULT_REGISTRY, timeoutMs = 10000, fetchJson = getJson } = options;
  const url = packumentVersionUrl(registryBase, packageName, version);
  return fetchJson(url, timeoutMs);
}

/**
 * Fetch a package version's integrity hash from a registry packument.
 * Resolves null when the package/version is not found (404 or no dist.integrity);
 * rejects on network errors/timeouts so callers can distinguish "offline" from "not on npm".
 * @param {string} packageName - Name of the package
 * @param {string} version - Exact version
 * @param {object} options - { registryBase, timeoutMs, fetchJson (injectable transport for tests) }
 * @returns {Promise<string|null>} Integrity hash or null
 */
export async function fetchPackumentIntegrity(packageName, version, options = {}) {
  const { registryBase = DEFAULT_REGISTRY, timeoutMs = 10000, fetchJson = getJson } = options;
  const url = packumentVersionUrl(registryBase, packageName, version);

  const pkg = await fetchJson(url, timeoutMs);
  if (pkg && pkg.dist && pkg.dist.integrity) {
    return pkg.dist.integrity;
  }
  return null;
}

/**
 * Fetch a package from npm registry and generate its integrity hash
 * (back-compat wrapper around fetchPackumentIntegrity; swallows errors)
 * @param {string} packageName - Name of the package
 * @param {string} version - Version of the package
 * @returns {Promise<string>} Integrity hash or null if fetch fails
 */
export async function generateIntegrityFromRegistry(packageName, version) {
  try {
    return await fetchPackumentIntegrity(packageName, version);
  } catch {
    return null;
  }
}

/**
 * Attempt to generate real integrity hash for a package
 * Falls back to placeholder if generation fails
 * @param {object} pkg - Package object with name and version
 * @param {object} options - Options { tryRegistry: boolean }
 * @returns {string} Integrity hash or placeholder
 */
export async function generateOrPlaceholderIntegrity(pkg, options = {}) {
  const { tryRegistry = false } = options;

  if (!pkg || typeof pkg !== 'object') {
    return 'sha512-PLACEHOLDER';
  }

  // If package already has integrity, return it
  if (pkg.integrity) {
    return pkg.integrity;
  }

  // Try registry if enabled and package has name/version
  if (tryRegistry && pkg.name && pkg.version) {
    try {
      const hash = await generateIntegrityFromRegistry(pkg.name, pkg.version);
      if (hash) {
        return hash;
      }
    } catch {
      // Silently fall through to placeholder
    }
  }

  // Return placeholder
  return 'sha512-PLACEHOLDER';
}

/**
 * Check if an integrity string looks valid
 * @param {string} integrity - Integrity string
 * @returns {boolean} True if valid format
 */
export function isValidIntegrity(integrity) {
  if (!integrity || typeof integrity !== 'string') {
    return false;
  }
  // Match 'sha512-<base64>' or 'sha256-<base64>' format
  return /^sha(256|512)-[A-Za-z0-9+/]+={0,2}$/.test(integrity);
}

/**
 * Check if integrity is a placeholder
 * @param {string} integrity - Integrity string
 * @returns {boolean} True if placeholder
 */
export function isPlaceholder(integrity) {
  return integrity && (
    integrity.includes('PLACEHOLDER') ||
    integrity === 'sha512-PLACEHOLDER' ||
    integrity === 'sha256-PLACEHOLDER'
  );
}
