// src/usage-scanner.js
// Heuristic detection of dependencies declared in package.json but never
// imported by the application's source code ("flag for removal").
import fs from 'fs';
import path from 'path';

export class UsageScannerError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'UsageScannerError';
    this.code = code;
    this.context = context;
  }
}

export const DEFAULT_EXTENSIONS = ['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx', '.vue', '.svelte'];
export const DEFAULT_IGNORE_DIRS = [
  'node_modules', '.git', '.backups', 'dist', 'build', 'out', 'coverage', '.next', '.nuxt', 'vendor'
];

// require('x') / require("x") / import('x') / import "x" / from 'x' / export ... from 'x'
const IMPORT_PATTERNS = [
  /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  /\bimport\s+['"]([^'"]+)['"]/g,
  /\bfrom\s+['"]([^'"]+)['"]/g
];

/**
 * Reduce an import specifier to its package name.
 * 'lodash/fp' → 'lodash'; '@scope/pkg/sub' → '@scope/pkg';
 * relative paths and node: builtins → null.
 */
export function specifierToPackageName(specifier) {
  if (!specifier || typeof specifier !== 'string') return null;
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return null;
  if (specifier.startsWith('node:')) return null;
  if (specifier.includes('://')) return null; // URLs (e.g. https: imports)

  const parts = specifier.split('/');
  if (specifier.startsWith('@')) {
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : null;
  }
  return parts[0];
}

function walkFiles(dir, extensions, ignoreDirs, files = []) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!ignoreDirs.includes(entry.name) && !entry.name.startsWith('.')) {
        walkFiles(path.join(dir, entry.name), extensions, ignoreDirs, files);
      }
    } else if (entry.isFile() && extensions.includes(path.extname(entry.name))) {
      files.push(path.join(dir, entry.name));
    }
  }
  return files;
}

/**
 * Scan a project's source files and collect the set of imported package names.
 * @param {string} dir - Project root
 * @param {object} options - { extensions, ignoreDirs }
 * @returns {{used: Set<string>, scannedFiles: number}}
 */
export function scanUsedPackages(dir, options = {}) {
  const { extensions = DEFAULT_EXTENSIONS, ignoreDirs = DEFAULT_IGNORE_DIRS } = options;

  if (!fs.existsSync(dir)) {
    throw new UsageScannerError(`Directory not found: ${dir}`, 'DIR_NOT_FOUND');
  }

  const files = walkFiles(dir, extensions, ignoreDirs);
  const used = new Set();

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const pattern of IMPORT_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const name = specifierToPackageName(match[1]);
        if (name) used.add(name);
      }
    }
  }

  return { used, scannedFiles: files.length };
}

/**
 * Decide whether a declared dependency counts as "used" — by an explicit
 * ignore-list entry, a real import, an npm-script mention, or the
 * @types/foo-follows-foo heuristic.
 */
function isDependencyUsed(name, { used, scriptsText, ignore }) {
  if (ignore.includes(name)) return true;
  if (used.has(name)) return true;
  // CLI tools invoked from npm scripts (eslint, jest, …) are used even
  // though nothing imports them
  if (scriptsText.includes(name)) return true;
  // @types/foo is "used" when foo itself is
  if (name.startsWith('@types/') && used.has(name.slice('@types/'.length))) return true;
  return false;
}

/**
 * Collect the unused entries from a single package.json dependency section.
 */
function collectUnusedInSection(deps, section, context) {
  const unused = [];
  if (!deps || typeof deps !== 'object') return unused;

  for (const [name, version] of Object.entries(deps)) {
    if (isDependencyUsed(name, context)) continue;
    unused.push({ name, section, version });
  }
  return unused;
}

/**
 * Find dependencies declared in package.json that the application never
 * imports. Heuristic — results are flagged for removal, never auto-removed:
 * packages used only via CLI, config files, or runtime magic can appear
 * unused. Mentions in npm scripts count as used to reduce CLI-tool noise.
 *
 * @param {object} packageJson - Parsed package.json
 * @param {string} dir - Project root to scan
 * @param {object} options - { includeDev = false, ignore = [], extensions, ignoreDirs }
 * @returns {{unused: Array<{name, section, version}>, used: Set<string>, scannedFiles: number, sectionsChecked: string[]}}
 */
export function findUnusedDependencies(packageJson, dir, options = {}) {
  const { includeDev = false, ignore = [] } = options;

  if (!packageJson || typeof packageJson !== 'object') {
    throw new UsageScannerError('package.json data is required', 'MISSING_PACKAGE_JSON');
  }

  const { used, scannedFiles } = scanUsedPackages(dir, options);

  const scriptsText = Object.values(packageJson.scripts || {}).join('\n');
  const context = { used, scriptsText, ignore };

  const sectionsChecked = includeDev ? ['dependencies', 'devDependencies'] : ['dependencies'];
  const unused = [];

  for (const section of sectionsChecked) {
    unused.push(...collectUnusedInSection(packageJson[section], section, context));
  }

  return { unused, used, scannedFiles, sectionsChecked };
}
