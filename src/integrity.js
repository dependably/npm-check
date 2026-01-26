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
    const data = fs.readFileSync(filePath, 'utf8');
    return generateIntegrityFromData(data);
  } catch (e) {
    console.error(`Failed to read file ${filePath}: ${e.message}`);
    return null;
  }
}

/**
 * Fetch a package from npm registry and generate its integrity hash
 * @param {string} packageName - Name of the package
 * @param {string} version - Version of the package
 * @returns {Promise<string>} Integrity hash or null if fetch fails
 */
export async function generateIntegrityFromRegistry(packageName, version) {
  return new Promise((resolve) => {
    const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;

    https.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        try {
          const pkg = JSON.parse(data);
          if (pkg.dist && pkg.dist.tarball) {
            // Extract integrity from registry response
            if (pkg.dist.integrity) {
              resolve(pkg.dist.integrity);
            } else {
              resolve(null);
            }
          } else {
            resolve(null);
          }
        } catch (e) {
          resolve(null);
        }
      });
    }).on('error', () => {
      resolve(null);
    });
  });
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
