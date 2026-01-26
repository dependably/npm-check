// Simple lockfile parser and serializer

import fs from 'fs';
import path from 'path';

/**
 * Read and parse a package-lock.json file.
 * @param {string} filePath - Path to the lockfile.
 * @returns {object} Parsed JSON object.
 */
export function parseLockfile(filePath) {
  const absolute = path.resolve(filePath);
  const data = fs.readFileSync(absolute, 'utf-8');
  return JSON.parse(data);
}

/**
 * Serialize an object to JSON and write to disk.
 * @param {string} filePath - Target file path.
 * @param {object} data - Data to serialize.
 * @param {boolean} [pretty=false] - Pretty print JSON.
 */
export function serializeLockfile(filePath, data, pretty = false) {
  const absolute = path.resolve(filePath);
  const json = pretty ? JSON.stringify(data, null, 2) : JSON.stringify(data);
  fs.writeFileSync(absolute, json + '\n');
}

export default { parseLockfile, serializeLockfile };
