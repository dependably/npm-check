// src/integrity.js
import crypto from 'crypto';
import fs from 'fs';
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
 * Derive the registry base URL from a package's resolved tarball URL.
 * npm tarball URLs follow <registryBase>/<name>/-/<file>.tgz, where scoped
 * names may appear as '@scope/name' or '@scope%2fname' in the path.
 * @param {string} resolvedUrl - The entry's resolved URL
 * @param {string} packageName - The real package name
 * @returns {string|null} Registry base or null if not derivable
 */
export function deriveRegistryBase(resolvedUrl, packageName) {
  if (!resolvedUrl || !packageName) return null;
  let url;
  try {
    url = new URL(resolvedUrl);
  } catch (e) {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

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

function getJson(url, timeoutMs, redirectsLeft = 1) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && redirectsLeft > 0) {
        res.resume();
        resolve(getJson(new URL(res.headers.location, url).toString(), timeoutMs, redirectsLeft - 1));
        return;
      }
      if (res.statusCode === 404) {
        res.resume();
        resolve(null);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Registry responded with status ${res.statusCode} for ${url}`));
        return;
      }
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON from registry for ${url}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Registry request timed out after ${timeoutMs}ms: ${url}`));
    });
  });
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
  const base = registryBase.replace(/\/+$/, '');
  // Scoped names keep the literal '/' encoded as %2f per registry convention
  const namePath = packageName.startsWith('@')
    ? packageName.replace('/', '%2f')
    : encodeURIComponent(packageName);
  const url = `${base}/${namePath}/${encodeURIComponent(version)}`;

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
  } catch (e) {
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
    } catch (e) {
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
