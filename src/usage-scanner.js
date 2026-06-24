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
// Build/tooling output dirs that DEFAULT_IGNORE_DIRS skips during the app scan.
// `findUnusedDependencies` scans these separately so a dependency imported only
// by a hand-written build toolkit (e.g. a `build/` shipped as source) is not
// mistaken for unused. Conservative by design: it can only rescue deps from a
// removal suggestion, never add one.
export const DEFAULT_BUILD_DIRS = ['build', 'dist', 'out'];

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
  return (
    ignore.includes(name) ||
    used.has(name) ||
    // CLI tools invoked from npm scripts (eslint, jest, …) are used even
    // though nothing imports them
    scriptsText.includes(name) ||
    // @types/foo is "used" when foo itself is
    (name.startsWith('@types/') && used.has(name.slice('@types/'.length)))
  );
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
 * Scan each build/tooling dir that exists under `dir`, as its own pass. Returns
 * the union of packages imported there plus a per-dir file/usage breakdown.
 */
function scanBuildDirs(dir, buildDirs, options) {
  const used = new Set();
  let scannedFiles = 0;
  const dirsScanned = [];
  for (const name of buildDirs) {
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) continue;
    const res = scanUsedPackages(full, options);
    for (const pkg of res.used) used.add(pkg);
    scannedFiles += res.scannedFiles;
    dirsScanned.push(name);
  }
  return { used, scannedFiles, dirsScanned };
}

/**
 * Find dependencies declared in package.json that the application never
 * imports. Heuristic — results are flagged for removal, never auto-removed:
 * packages used only via CLI, config files, or runtime magic can appear
 * unused. Mentions in npm scripts count as used to reduce CLI-tool noise.
 *
 * Runs two passes: the application (with build/output dirs ignored), and the
 * build/tooling dirs (`buildDirs`) separately. A dependency counts as used if
 * either pass imports it, so a `build/` shipped as source no longer produces
 * false "unused" flags; deps imported ONLY by the build pass are surfaced as
 * `buildOnly` for visibility. Pass `buildDirs: []` to disable the second pass.
 *
 * @param {object} packageJson - Parsed package.json
 * @param {string} dir - Project root to scan
 * @param {object} options - { includeDev = false, ignore = [], buildDirs, extensions, ignoreDirs }
 * @returns {{unused: Array<{name, section, version}>, used: Set<string>, usedByApp: Set<string>, usedByBuild: Set<string>, buildOnly: string[], scannedFiles: number, appFiles: number, buildFiles: number, buildDirsScanned: string[], sectionsChecked: string[]}}
 */
export function findUnusedDependencies(packageJson, dir, options = {}) {
  const { includeDev = false, ignore = [], buildDirs = DEFAULT_BUILD_DIRS } = options;

  if (!packageJson || typeof packageJson !== 'object') {
    throw new UsageScannerError('package.json data is required', 'MISSING_PACKAGE_JSON');
  }

  // Pass 1: the application, with build/output dirs ignored (default behavior).
  const app = scanUsedPackages(dir, options);
  const usedByApp = app.used;

  // Pass 2: the build/tooling dirs, scanned separately.
  const build = scanBuildDirs(dir, buildDirs, options);
  const usedByBuild = build.used;

  const used = new Set([...usedByApp, ...usedByBuild]);
  const scriptsText = Object.values(packageJson.scripts || {}).join('\n');
  const context = { used, scriptsText, ignore };

  const sectionsChecked = includeDev ? ['dependencies', 'devDependencies'] : ['dependencies'];
  const unused = [];

  for (const section of sectionsChecked) {
    unused.push(...collectUnusedInSection(packageJson[section], section, context));
  }

  const buildOnly = [...usedByBuild].filter((name) => !usedByApp.has(name)).sort();

  return {
    unused,
    used,
    usedByApp,
    usedByBuild,
    buildOnly,
    scannedFiles: app.scannedFiles + build.scannedFiles,
    appFiles: app.scannedFiles,
    buildFiles: build.scannedFiles,
    buildDirsScanned: build.dirsScanned,
    sectionsChecked
  };
}
