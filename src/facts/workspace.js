// src/facts/workspace.js
// What the tree under `srcDir` declares about itself: the first-party package
// names (every package.json's `name`), the dev/runtime scope each manifest
// gives its dependencies ("runtime anywhere wins" across manifests), the
// tsconfig/jsconfig `paths` alias bases (specifiers under one are never a
// package import), and the first-party source files themselves — everything
// the scan and the module-graph walk take as their starting point.
//
// Ported from sbom-reach's `packages/analyzer-npm/src/workspace.ts`.
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import fg from 'fast-glob';
import ignoreFactory from 'ignore';
import { aliasBaseFromPathsKey } from './specifier.js';
import { loadTypeScript } from './ts.js';

/** @typedef {import('./types.d.ts').DepScope} DepScope */
/** @typedef {import('./types.d.ts').Workspace} Workspace */

const IGNORE_DIRS = [
  '**/node_modules/**',
  '**/.git/**',
  '**/dist/**',
  '**/build/**',
  '**/out/**',
  '**/coverage/**',
  '**/.next/**',
  '**/.turbo/**',
  '**/vendor/**'
];

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,svelte}';

/**
 * @param {string} srcDir absolute path of the tree to describe
 * @returns {Workspace}
 */
export function discoverWorkspace(srcDir) {
  const ts = loadTypeScript();
  /** @type {string[]} */
  const diagnostics = [];

  const gitignore = loadGitignore(srcDir);
  /** @param {string[]} paths @returns {string[]} */
  const filterIgnored = (paths) => {
    if (!gitignore) return paths;
    return paths.filter((p) => {
      const rel = relative(srcDir, p).split(sep).join('/');
      return rel === '' || !gitignore.ignores(rel);
    });
  };

  const manifestPaths = filterIgnored(
    fg.sync('**/package.json', {
      cwd: srcDir,
      absolute: true,
      ignore: IGNORE_DIRS,
      dot: false,
      followSymbolicLinks: false
    })
  ).sort();

  /** @type {Set<string>} */
  const firstPartyNames = new Set();
  /** @type {Map<string, DepScope>} */
  const depScopes = new Map();

  for (const path of manifestPaths) {
    /** @type {Record<string, unknown>} */
    let json;
    try {
      json = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      diagnostics.push(`unparseable package.json at ${relative(srcDir, path)}; skipped`);
      continue;
    }
    if (typeof json.name === 'string') firstPartyNames.add(json.name.toLowerCase());

    const runtimeSections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
    for (const section of runtimeSections) {
      for (const name of depNames(json[section])) depScopes.set(name, 'runtime');
    }
    for (const name of depNames(json.devDependencies)) {
      if (depScopes.get(name) !== 'runtime') depScopes.set(name, 'dev');
    }
  }

  /** @type {Set<string>} */
  const aliasPrefixes = new Set();
  const aliasConfigPaths = filterIgnored(
    fg.sync(['**/tsconfig*.json', '**/jsconfig*.json'], {
      cwd: srcDir,
      absolute: true,
      ignore: IGNORE_DIRS,
      dot: false,
      followSymbolicLinks: false
    })
  ).sort();
  for (const path of aliasConfigPaths) {
    const read = ts.readConfigFile(path, (p) => readFileSync(p, 'utf8'));
    if (read.error) {
      diagnostics.push(`unparseable tsconfig/jsconfig at ${relative(srcDir, path)}; aliases from it ignored`);
      continue;
    }
    // Resolve `extends` so inherited paths are honored too.
    /** @type {Record<string, unknown>} */
    let config = /** @type {Record<string, unknown>} */ (read.config);
    const visited = new Set([path]);
    let current = path;
    while (typeof config.extends === 'string') {
      const parentPath = resolveExtends(config.extends, dirname(current));
      if (!parentPath || visited.has(parentPath)) break;
      visited.add(parentPath);
      const parent = ts.readConfigFile(parentPath, (p) => readFileSync(p, 'utf8'));
      if (parent.error) break;
      const parentConfig = /** @type {Record<string, unknown>} */ (parent.config);
      config = {
        ...parentConfig,
        ...config,
        compilerOptions: {
          .../** @type {object | undefined} */ (parentConfig.compilerOptions),
          .../** @type {object | undefined} */ (config.compilerOptions)
        },
        extends: parentConfig.extends
      };
      current = parentPath;
    }
    const compilerOptions = /** @type {{ paths?: Record<string, unknown> } | undefined} */ (config.compilerOptions);
    const paths = compilerOptions?.paths;
    if (paths) {
      for (const key of Object.keys(paths)) aliasPrefixes.add(aliasBaseFromPathsKey(key));
    }
  }

  const sourceFiles = filterIgnored(
    fg.sync(SOURCE_GLOB, {
      cwd: srcDir,
      absolute: true,
      ignore: IGNORE_DIRS,
      dot: false,
      followSymbolicLinks: false
    })
  ).sort();

  return { firstPartyNames, depScopes, aliasPrefixes, sourceFiles, diagnostics };
}

/**
 * @param {unknown} section
 * @returns {string[]}
 */
function depNames(section) {
  if (section === null || typeof section !== 'object') return [];
  return Object.keys(/** @type {Record<string, unknown>} */ (section)).map((n) => n.toLowerCase());
}

/**
 * @param {string} srcDir
 * @returns {ReturnType<typeof ignoreFactory> | undefined}
 */
function loadGitignore(srcDir) {
  try {
    const content = readFileSync(join(srcDir, '.gitignore'), 'utf8');
    return ignoreFactory().add(content);
  } catch {
    return undefined;
  }
}

/**
 * @param {string} spec
 * @param {string} fromDir
 * @returns {string | undefined}
 */
function resolveExtends(spec, fromDir) {
  if (spec.startsWith('.') || spec.startsWith('/')) {
    const p = join(fromDir, spec);
    return p.endsWith('.json') ? p : `${p}.json`;
  }
  // Package-based extends (e.g. @tsconfig/node20) would need module resolution;
  // out of scope for alias collection.
  return undefined;
}
