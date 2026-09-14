// src/facts/resolve.js
// A Node-style module resolver — enough of the algorithm to follow real import
// statements INTO and THROUGH node_modules, so a consumer can see which
// packages are loaded by the packages first-party code loads. Parse-level and
// filesystem-level only: no bundler config, no loaders, no `NODE_PATH`.
//
// What it implements:
//  - symlink-aware resolution: every resolved file is realpath'd, the way
//    Node does it (`--preserve-symlinks` off). This is what makes pnpm's
//    layout work — `node_modules/<name>` is a symlink into
//    `.pnpm/<name>@<version>/node_modules/<name>`, and a package's own
//    dependencies are SIBLINGS inside that `.pnpm` directory, so the
//    node_modules walk-up for the next hop has to start from the real path;
//  - relative / absolute specifiers with extension probing (and the
//    TypeScript convention of writing `./x.js` for a `./x.ts` source);
//  - bare specifiers via the node_modules walk-up from the importing file;
//  - package.json `exports` (string / array / conditions / subpath maps /
//    `*` patterns, with `import`-vs-`require` conditions), `main`, `module`,
//    `index.*`;
//  - package.json `imports` (`#internal` specifiers);
//  - builtins (`fs`, `node:fs`).
//
// What it deliberately reports as unresolved rather than guessing: bundler
// aliases (the caller's tsconfig-paths prefixes), anything that only resolves
// to a `.d.ts`, `exports` maps that block the subpath, and specifiers that
// simply are not installed. Every unresolved edge is COUNTED by the graph
// walker and reported — an edge the resolver could not follow is a place a
// runtime path could hide, and the document must say so.
//
// Ported from sbom-reach's `packages/analyzer-npm/src/resolve.ts`.
import { readFileSync, realpathSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve as pathResolve, sep } from 'node:path';

/** @typedef {import('./types.d.ts').PackageInfo} PackageInfo */
/** @typedef {import('./types.d.ts').Resolution} Resolution */
/** @typedef {import('./types.d.ts').ResolveMode} ResolveMode */

/**
 * @typedef {object} PackageJson
 * @property {unknown} [name]
 * @property {unknown} [version]
 * @property {unknown} [main]
 * @property {unknown} [module]
 * @property {unknown} [exports]
 * @property {unknown} [imports]
 */

const BUILTINS = new Set(builtinModules);
const CODE_EXTS = ['.js', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts', '.jsx', '.svelte'];
const CODE_EXT_SET = new Set(CODE_EXTS);
/** `import './x.js'` in a TypeScript source resolves to `./x.ts` under most setups.
 * @type {Record<string, string[]>} */
const TS_FOR_JS = {
  '.js': ['.ts', '.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
  '.jsx': ['.tsx']
};
const NODE_MODULES = 'node_modules';

export class ModuleResolver {
  /**
   * @param {ReadonlySet<string>} [aliasPrefixes] tsconfig/jsconfig path-alias
   *   bases; a specifier under one resolves to `{ kind: 'alias' }`.
   */
  constructor(aliasPrefixes = new Set()) {
    /** @type {ReadonlySet<string>} */
    this.aliasPrefixes = aliasPrefixes;
    /** @type {Map<string, 'file' | 'dir' | null>} */
    this.statCache = new Map();
    /** @type {Map<string, PackageJson | null>} */
    this.packageJsonCache = new Map();
    /** @type {Map<string, PackageInfo | undefined>} */
    this.packageInfoCache = new Map();
    /** @type {Map<string, string>} */
    this.realpathCache = new Map();
  }

  /**
   * @param {string} fromFile absolute path of the importing file
   * @param {string} specifier
   * @param {ResolveMode} mode
   * @returns {Resolution}
   */
  resolve(fromFile, specifier, mode) {
    if (specifier.length === 0) return { kind: 'unresolved', reason: 'empty specifier' };
    if (specifier.startsWith('node:')) return { kind: 'builtin' };
    if (/^(data:|file:|[a-z][a-z0-9+.-]*:\/\/)/i.test(specifier)) {
      return { kind: 'unresolved', reason: 'URL specifier' };
    }
    const bareName = specifier.split('/')[0];
    if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('#') && BUILTINS.has(bareName)) {
      return { kind: 'builtin' };
    }
    // Strip a query/fragment (`./x.svg?raw`, bundler conventions); nothing
    // real resolves through them. A leading `#` is a package `imports` key,
    // not a fragment.
    const cleaned = specifier.startsWith('#') ? specifier : specifier.replace(/[?#].*$/, '');

    if (cleaned.startsWith('.') || isAbsolute(cleaned)) {
      const target = pathResolve(dirname(fromFile), cleaned);
      return this.loadAsFile(target) ?? this.loadAsDirectory(target) ?? unresolved(`not found: ${cleaned}`);
    }
    if (cleaned.startsWith('#')) return this.resolveImportsField(fromFile, cleaned, mode);

    for (const alias of this.aliasPrefixes) {
      if (cleaned === alias || cleaned.startsWith(`${alias}/`)) return { kind: 'alias' };
    }
    return this.resolveBare(fromFile, cleaned, mode);
  }

  /**
   * The package a file belongs to, from its path alone: the directory right
   * after the LAST `node_modules/` segment (two segments for a scope). A file
   * with no node_modules segment is first-party. Subdirectory package.json
   * markers (`{ "type": "module" }` shims, nested `esm/package.json`) never
   * fool this, which a nearest-package.json walk would.
   * @param {string} file
   * @returns {PackageInfo | undefined}
   */
  packageOf(file) {
    const root = packageRootOf(file);
    if (root === undefined) return undefined;
    if (this.packageInfoCache.has(root)) return this.packageInfoCache.get(root);
    const pj = this.readPackageJson(root);
    const dirName = basename(root);
    const scopeDir = basename(dirname(root));
    const fallbackName = scopeDir.startsWith('@') ? `${scopeDir}/${dirName}` : dirName;
    /** @type {PackageInfo | undefined} */
    const info =
      pj === null
        ? undefined
        : {
            name: typeof pj.name === 'string' && pj.name.length > 0 ? pj.name : fallbackName,
            dirName: fallbackName,
            version: typeof pj.version === 'string' ? pj.version : '',
            root
          };
    this.packageInfoCache.set(root, info);
    return info;
  }

  // --- bare specifiers -----------------------------------------------------

  /**
   * @param {string} fromFile
   * @param {string} specifier
   * @param {ResolveMode} mode
   * @returns {Resolution}
   */
  resolveBare(fromFile, specifier, mode) {
    const parts = specifier.split('/');
    const scoped = specifier.startsWith('@');
    if (scoped && parts.length < 2) return unresolved(`malformed scoped specifier: ${specifier}`);
    const name = scoped ? `${parts[0]}/${parts[1]}` : parts[0];
    const subpath = parts.slice(scoped ? 2 : 1).join('/');

    let dir = dirname(fromFile);
    for (;;) {
      // Never look inside a node_modules directory's own node_modules
      // sibling twice: `a/node_modules/b/node_modules/c` is one level.
      if (basename(dir) !== NODE_MODULES) {
        const candidate = join(dir, NODE_MODULES, name);
        if (this.kindOf(candidate) === 'dir') return this.resolvePackage(candidate, subpath, mode);
      }
      const parent = dirname(dir);
      if (parent === dir) return unresolved(`package not installed: ${name}`);
      dir = parent;
    }
  }

  /**
   * @param {string} root
   * @param {string} subpath
   * @param {ResolveMode} mode
   * @returns {Resolution}
   */
  resolvePackage(root, subpath, mode) {
    const pj = this.readPackageJson(root);
    if (pj !== null && pj.exports !== undefined && pj.exports !== null) {
      const target = resolveExports(pj.exports, subpath === '' ? '.' : `./${subpath}`, conditionsFor(mode));
      if (target === undefined) return unresolved(`exports map does not expose "${subpath || '.'}" of ${basename(root)}`);
      if (target === null) return unresolved(`exports map blocks "${subpath || '.'}" of ${basename(root)}`);
      if (target.includes('..') || !target.startsWith('./')) return unresolved(`invalid exports target ${target}`);
      return this.loadAsFile(join(root, target)) ?? this.loadAsDirectory(join(root, target)) ?? unresolved(`exports target missing: ${target}`);
    }
    if (subpath !== '') {
      const p = join(root, subpath);
      return this.loadAsFile(p) ?? this.loadAsDirectory(p) ?? unresolved(`not found in package: ${subpath}`);
    }
    return this.loadAsDirectory(root) ?? unresolved(`no entry point in ${basename(root)}`);
  }

  /**
   * @param {string} fromFile
   * @param {string} specifier
   * @param {ResolveMode} mode
   * @returns {Resolution}
   */
  resolveImportsField(fromFile, specifier, mode) {
    // Nearest package.json that has an `imports` field, walking up from the file.
    let dir = dirname(fromFile);
    for (;;) {
      const pj = this.readPackageJson(dir);
      if (pj !== null && pj.imports !== undefined && pj.imports !== null) {
        const target = resolveExports(pj.imports, specifier, conditionsFor(mode));
        if (target === undefined || target === null) return unresolved(`imports map does not map ${specifier}`);
        if (target.startsWith('./')) {
          return this.loadAsFile(join(dir, target)) ?? this.loadAsDirectory(join(dir, target)) ?? unresolved(`imports target missing: ${target}`);
        }
        return this.resolve(fromFile, target, mode); // a bare specifier alias
      }
      const parent = dirname(dir);
      if (parent === dir) return unresolved(`no package.json imports field for ${specifier}`);
      dir = parent;
    }
  }

  // --- files and directories ----------------------------------------------

  /**
   * @param {string} p
   * @returns {Resolution | undefined}
   */
  loadAsFile(p) {
    const candidates = [p];
    const ext = extOf(p);
    if (ext !== undefined && TS_FOR_JS[ext]) {
      for (const tsExt of TS_FOR_JS[ext]) candidates.push(p.slice(0, -ext.length) + tsExt);
    }
    for (const e of CODE_EXTS) candidates.push(p + e);
    candidates.push(`${p}.json`);
    for (const c of candidates) {
      if (this.kindOf(c) !== 'file') continue;
      return this.fileResolution(c);
    }
    return undefined;
  }

  /**
   * @param {string} p
   * @returns {Resolution | undefined}
   */
  loadAsDirectory(p) {
    if (this.kindOf(p) !== 'dir') return undefined;
    const pj = this.readPackageJson(p);
    if (pj !== null) {
      for (const field of /** @type {const} */ (['main', 'module'])) {
        const entry = pj[field];
        if (typeof entry !== 'string' || entry.length === 0) continue;
        const target = join(p, entry);
        const r = this.loadAsFile(target) ?? this.loadAsIndex(target);
        if (r !== undefined) return r;
      }
    }
    return this.loadAsIndex(p);
  }

  /**
   * @param {string} dir
   * @returns {Resolution | undefined}
   */
  loadAsIndex(dir) {
    if (this.kindOf(dir) !== 'dir') return undefined;
    for (const e of CODE_EXTS) {
      const c = join(dir, `index${e}`);
      if (this.kindOf(c) === 'file') return this.fileResolution(c);
    }
    return undefined;
  }

  /**
   * @param {string} found
   * @returns {Resolution}
   */
  fileResolution(found) {
    if (found.endsWith('.d.ts') || found.endsWith('.d.mts') || found.endsWith('.d.cts')) {
      return unresolved(`types only: ${basename(found)}`);
    }
    const path = this.realpath(found);
    const pkg = this.packageOf(path);
    const ext = extOf(path);
    return CODE_EXT_SET.has(ext ?? '') ? { kind: 'file', path, pkg } : { kind: 'asset', path, pkg };
  }

  /**
   * @param {string} p
   * @returns {string}
   */
  realpath(p) {
    const cached = this.realpathCache.get(p);
    if (cached !== undefined) return cached;
    /** @type {string} */
    let real;
    try {
      real = realpathSync(p);
    } catch {
      real = p;
    }
    this.realpathCache.set(p, real);
    return real;
  }

  // --- caches --------------------------------------------------------------

  /**
   * @param {string} p
   * @returns {'file' | 'dir' | null}
   */
  kindOf(p) {
    const cached = this.statCache.get(p);
    if (cached !== undefined) return cached;
    /** @type {'file' | 'dir' | null} */
    let kind;
    try {
      const st = statSync(p);
      kind = st.isFile() ? 'file' : st.isDirectory() ? 'dir' : null;
    } catch {
      kind = null;
    }
    this.statCache.set(p, kind);
    return kind;
  }

  /**
   * @param {string} dir
   * @returns {PackageJson | null}
   */
  readPackageJson(dir) {
    const cached = this.packageJsonCache.get(dir);
    if (cached !== undefined) return cached;
    /** @type {PackageJson | null} */
    let parsed = null;
    const p = join(dir, 'package.json');
    if (this.kindOf(p) === 'file') {
      try {
        const raw = /** @type {unknown} */ (JSON.parse(readFileSync(p, 'utf8')));
        if (raw !== null && typeof raw === 'object') parsed = /** @type {PackageJson} */ (raw);
      } catch {
        parsed = null;
      }
    }
    this.packageJsonCache.set(dir, parsed);
    return parsed;
  }
}

/**
 * @param {string} reason
 * @returns {Resolution}
 */
function unresolved(reason) {
  return { kind: 'unresolved', reason };
}

/**
 * @param {string} p
 * @returns {string | undefined}
 */
function extOf(p) {
  const base = basename(p);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? undefined : base.slice(dot);
}

/**
 * @param {ResolveMode} mode
 * @returns {ReadonlySet<string>}
 */
function conditionsFor(mode) {
  return mode === 'import'
    ? new Set(['import', 'module-sync', 'node', 'default'])
    : new Set(['require', 'module-sync', 'node', 'default']);
}

/**
 * The package root (directory directly under node_modules, scope included)
 * for a path inside node_modules; undefined for a first-party path.
 * @param {string} file
 * @returns {string | undefined}
 */
export function packageRootOf(file) {
  const parts = file.split(sep);
  const idx = parts.lastIndexOf(NODE_MODULES);
  if (idx === -1 || idx + 1 >= parts.length) return undefined;
  const first = parts[idx + 1];
  const take = first.startsWith('@') ? 2 : 1;
  if (idx + take >= parts.length) return undefined;
  return parts.slice(0, idx + 1 + take).join(sep);
}

/**
 * Resolves a subpath (or `#import` key) against a package.json `exports` /
 * `imports` value. Returns the target string (`./lib/x.js`), `null` when the
 * map explicitly blocks it, or `undefined` when nothing matched.
 * @param {unknown} map
 * @param {string} subpath
 * @param {ReadonlySet<string>} conditions
 * @returns {string | null | undefined}
 */
export function resolveExports(map, subpath, conditions) {
  if (typeof map === 'string') return subpath === '.' ? map : undefined;
  if (Array.isArray(map)) {
    for (const entry of map) {
      const r = resolveExports(entry, subpath, conditions);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (map === null || typeof map !== 'object') return undefined;
  const obj = /** @type {Record<string, unknown>} */ (map);
  const keys = Object.keys(obj);
  const isSubpathMap = keys.some((k) => k.startsWith('.') || k.startsWith('#'));
  if (!isSubpathMap) {
    // A conditions object for the requested subpath.
    if (subpath !== '.') return undefined;
    return resolveConditions(obj, conditions);
  }
  // Exact key first.
  if (Object.prototype.hasOwnProperty.call(obj, subpath)) {
    return resolveTarget(obj[subpath], conditions, undefined);
  }
  // Pattern keys, ranked like Node's PATTERN_KEY_COMPARE: the longest prefix
  // before `*` wins, and on a tie the longer key overall (`./*.css` beats
  // `./*` for `./400.css` — with prefix-only ranking the first key won and
  // produced `./400.css.css`).
  /** @type {{ key: string; prefixLength: number; captured: string } | undefined} */
  let best;
  for (const key of keys) {
    const star = key.indexOf('*');
    if (star === -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix) || subpath.length < prefix.length + suffix.length) continue;
    const better =
      best === undefined ||
      prefix.length > best.prefixLength ||
      (prefix.length === best.prefixLength && key.length > best.key.length);
    if (better) {
      best = { key, prefixLength: prefix.length, captured: subpath.slice(prefix.length, subpath.length - suffix.length) };
    }
  }
  if (best === undefined) return undefined;
  return resolveTarget(obj[best.key], conditions, best.captured);
}

/**
 * @param {Record<string, unknown>} obj
 * @param {ReadonlySet<string>} conditions
 * @returns {string | null | undefined}
 */
function resolveConditions(obj, conditions) {
  for (const [key, value] of Object.entries(obj)) {
    if (!conditions.has(key)) continue;
    const r = resolveTarget(value, conditions, undefined);
    if (r !== undefined) return r;
  }
  return undefined;
}

/**
 * @param {unknown} value
 * @param {ReadonlySet<string>} conditions
 * @param {string | undefined} captured
 * @returns {string | null | undefined}
 */
function resolveTarget(value, conditions, captured) {
  if (value === null) return null;
  if (typeof value === 'string') return captured === undefined ? value : value.replace(/\*/g, captured);
  if (Array.isArray(value)) {
    for (const entry of value) {
      const r = resolveTarget(entry, conditions, captured);
      if (r !== undefined) return r;
    }
    return undefined;
  }
  if (typeof value === 'object') {
    for (const [key, inner] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (!conditions.has(key)) continue;
      const r = resolveTarget(inner, conditions, captured);
      if (r !== undefined) return r;
    }
  }
  return undefined;
}
