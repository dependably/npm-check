// src/facts/workspace.js
// What the tree under `srcDir` declares about itself: the first-party package
// names (every package.json's `name`), the dev/runtime scope each manifest
// gives its dependencies ("runtime anywhere wins" across manifests, with
// `devDeclaredBy` tracking WHICH manifest made a dev claim), the
// tsconfig/jsconfig `paths` alias bases scoped to the subtree of the config
// that declares them, and the first-party source files themselves -- bounded
// by `.gitignore`, never by a directory name -- everything the scan and the
// module-graph walk take as their starting point.
//
// Ported from sbom-reach's `packages/analyzer-npm/src/workspace.ts` as it
// existed after commit 95f2b94 ("fix(npm,pypi): bound the source scan by
// .gitignore, never by a directory name", GitLab #31).
import { readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import fg from 'fast-glob';
import { aliasBaseFromPathsKey } from './specifier.js';
import { filterGitignored, loadGitignores, outputDirScannedDiagnostic } from './sourcescan.js';
import { loadTypeScript } from './ts.js';

/** @typedef {import('./types.d.ts').DepScope} DepScope */
/** @typedef {import('./types.d.ts').Workspace} Workspace */
/** @typedef {import('./types.d.ts').AliasScope} AliasScope */
/** @typedef {import('./types.d.ts').AliasLayer} AliasLayer */

/**
 * The only directories excluded from the source scan BY NAME.
 *
 * Both are universal rather than conventional. `.git` holds no source. And
 * `node_modules` is not a naming convention at all -- it is the location the
 * Node resolver defines, and its contents are a DEPENDENCY's own imports,
 * not first-party code; counting them would make every transitive
 * dependency look first-party-imported. The module graph walks it
 * deliberately (`modulegraph.js`), which is a different pass with a
 * different question.
 *
 * Everything else that used to live here -- `dist`, `build`, `out`,
 * `coverage`, `.next`, `.turbo`, `vendor` -- was a GUESS from a directory
 * name that the file it excluded was generated output. In a real tree those
 * names are often source. `.gitignore`, loaded below, is the real authority
 * on what is generated: a project that builds into `dist/` gitignores
 * `dist/`.
 *
 * Note that dot-directories stay excluded regardless, via the globber's
 * `dot: false` -- a hidden-directory convention, not a guess about content.
 */
const IGNORE_DIRS = ['**/node_modules/**', '**/.git/**'];

const SOURCE_GLOB = '**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,svelte}';

/**
 * @param {string} srcDir absolute path of the tree to describe
 * @returns {Workspace}
 */
export function discoverWorkspace(srcDir) {
  const ts = loadTypeScript();
  /** @type {string[]} */
  const diagnostics = [];

  const gitignores = loadGitignores(srcDir, IGNORE_DIRS);
  /** @param {string[]} paths @returns {string[]} */
  const filterIgnored = (paths) => filterGitignored(srcDir, gitignores, paths);

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
  /** name -> manifests declaring it dev; pruned below for anything declared runtime. */
  /** @type {Map<string, string[]>} */
  const devDeclaredBy = new Map();

  for (const path of manifestPaths) {
    /** @type {Record<string, unknown>} */
    let json;
    try {
      json = /** @type {Record<string, unknown>} */ (JSON.parse(readFileSync(path, 'utf8')));
    } catch {
      diagnostics.push(`NPM_MANIFEST_UNPARSEABLE: unparseable package.json at ${relative(srcDir, path)}; skipped`);
      continue;
    }
    if (typeof json.name === 'string') firstPartyNames.add(json.name.toLowerCase());

    const runtimeSections = ['dependencies', 'optionalDependencies', 'peerDependencies'];
    for (const section of runtimeSections) {
      for (const name of depNames(json[section])) depScopes.set(name, 'runtime');
    }
    for (const name of depNames(json.devDependencies)) {
      if (depScopes.get(name) !== 'runtime') depScopes.set(name, 'dev');
      devDeclaredBy.set(name, [...(devDeclaredBy.get(name) ?? []), relative(srcDir, path).split(sep).join('/')]);
    }
  }
  // "Runtime anywhere wins" already decided `depScopes`; drop the dev trail
  // for anything that ended up runtime, so the map only ever describes a
  // live claim.
  const runtimeDeclared = [...devDeclaredBy.keys()].filter((n) => depScopes.get(n) !== 'dev');
  for (const name of runtimeDeclared) devDeclaredBy.delete(name);

  /** @type {Set<string>} */
  const aliasPrefixes = new Set();
  /** One entry per config file: the directory it governs, and what it declares. */
  /** @type {AliasLayer[]} */
  const aliasLayers = [];
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
      diagnostics.push(
        `NPM_TSCONFIG_UNPARSEABLE: unparseable tsconfig/jsconfig at ${relative(srcDir, path)}; aliases from it ignored`
      );
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
        extends: /** @type {{extends?: unknown}} */ (parentConfig).extends
      };
      current = parentPath;
    }
    const compilerOptions = /** @type {{ paths?: Record<string, unknown> } | undefined} */ (config.compilerOptions);
    const paths = compilerOptions?.paths;
    if (paths) {
      /** @type {Set<string>} */
      const prefixes = new Set();
      for (const key of Object.keys(paths)) {
        const base = aliasBaseFromPathsKey(key);
        prefixes.add(base);
        aliasPrefixes.add(base);
      }
      // Scoped to the directory of the config that was FOUND, not of
      // whatever it `extends`: a base config supplies the paths, the
      // project that extends it supplies the files they apply to -- as tsc
      // does.
      //
      // The approximation is CONTAINMENT, and tsc's real answer is
      // `include` / `files` / `rootDir`. A config that reaches outside its
      // own directory governs those files in tsc and not here, so their
      // imports keep naming packages and a legitimate alias is dropped.
      // That over-reports use -- the loud direction (invariant 1), and the
      // opposite of the silent suppression this scoping exists to stop.
      if (prefixes.size > 0) aliasLayers.push({ dir: dirname(path), prefixes: [...prefixes] });
    }
  }
  const aliasScope = buildAliasScope(aliasLayers);

  const sourceFiles = filterIgnored(
    fg.sync(SOURCE_GLOB, {
      cwd: srcDir,
      absolute: true,
      ignore: IGNORE_DIRS,
      dot: false,
      followSymbolicLinks: false
    })
  ).sort();

  // Say it out loud when a directory whose NAME suggests generated output
  // was scanned anyway, because nothing ignored it. A note, not a warning --
  // see `outputDirScannedDiagnostic` for why.
  const outputDirs = outputDirScannedDiagnostic(sourceFiles.map((f) => relative(srcDir, f).split(sep).join('/')));
  if (outputDirs) diagnostics.push(outputDirs);

  return {
    firstPartyNames,
    depScopes,
    aliasPrefixes,
    aliasScope,
    aliasLayers,
    devDeclaredBy,
    sourceFiles,
    diagnostics
  };
}

/**
 * A file is governed by every config at or above its own directory. Nothing
 * is matched by NAME here: a `vendor/lib/tsconfig.json` is not
 * special-cased, it simply governs `vendor/lib/`, and the file in `src/`
 * that a global set used to silence is outside it.
 *
 * Memoized per directory -- a tree with one root tsconfig (the common case)
 * does one prefix walk per directory and then answers from the cache.
 *
 * @param {AliasLayer[]} layers directories are ABSOLUTE paths
 * @returns {AliasScope}
 */
function buildAliasScope(layers) {
  /** @type {ReadonlySet<string>} */
  const empty = new Set();
  if (layers.length === 0) return { for: () => empty };
  /** @type {Map<string, ReadonlySet<string>>} */
  const cache = new Map();
  return {
    for(file) {
      const dir = dirname(file);
      const cached = cache.get(dir);
      if (cached !== undefined) return cached;
      /** @type {Set<string> | undefined} */
      let hits;
      for (const layer of layers) {
        if (dir !== layer.dir && !dir.startsWith(layer.dir.endsWith(sep) ? layer.dir : `${layer.dir}${sep}`)) {
          continue;
        }
        hits ??= new Set();
        for (const prefix of layer.prefixes) hits.add(prefix);
      }
      const result = hits ?? empty;
      cache.set(dir, result);
      return result;
    }
  };
}

/**
 * Is `rel` (a `/`-joined path) inside the directory of the manifest at `manifestRel`?
 * @param {string} manifestRel
 * @param {string} rel
 * @returns {boolean}
 */
export function governedByManifest(manifestRel, rel) {
  const slash = manifestRel.lastIndexOf('/');
  if (slash === -1) return true; // root manifest governs the whole tree
  return rel.startsWith(`${manifestRel.slice(0, slash)}/`);
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
