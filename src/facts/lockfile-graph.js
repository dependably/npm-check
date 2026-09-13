// src/facts/lockfile-graph.js
// The resolved dependency graph a lockfile records: every name@version in
// the closure, which of them the project's own package.json depends on
// directly, and the edges among them — with dev/runtime and `optional` read
// straight from what the lockfile asserts, never inferred.
//
// This is a separate reader from `parser.js`/`format-library.js` on purpose
// (and deliberately NOT merged with them in the change that introduced it):
// those parse a lockfile to validate, fix and migrate it, and couple to every
// field it has; this one answers one question — "what does the lockfile say
// is installed, and what depends on what" — and is what the import-facts
// consumer walks when node_modules is absent. `yaml` is imported statically
// here rather than through `parser.js`'s lazy `createRequire`: a consumer that
// bundles this subpath (sbom-reach does, with esbuild) would otherwise be left
// with an unbundled runtime `require('yaml')`. The lockfile commands never
// load this module, so the npm path still never loads `yaml` for a
// package-lock.json.
//
// Ported from sbom-reach's `packages/analyzer-npm/src/lockfile.ts` plus its
// `discoverInstalledPackages` (index.ts), here `discoverLockfileGraphs`.
import { readFileSync } from 'node:fs';
import { relative } from 'node:path';
import fg from 'fast-glob';
import { parse as parseYaml } from 'yaml';

/** @typedef {import('./types.d.ts').DiscoveredPackage} DiscoveredPackage */
/** @typedef {import('./types.d.ts').DependencyEdge} DependencyEdge */
/** @typedef {import('./types.d.ts').LockfileGraph} LockfileGraph */
/** @typedef {import('./types.d.ts').LockfileDiscovery} LockfileDiscovery */

/**
 * Folds a second sighting of the same name@version into the first — two
 * paths in one lockfile, or two lockfiles in one workspace. dev/runtime:
 * `false` (ships somewhere) beats `true` (dev-only somewhere) beats absent —
 * "runtime anywhere wins". `optional` is a claim of EXCLUSIVITY ("reachable
 * only through optionalDependencies"), so one sighting that needs the package
 * outright revokes it. First license seen is kept. Order-independent.
 * @param {DiscoveredPackage} into
 * @param {DiscoveredPackage} other
 */
export function mergeDiscovered(into, other) {
  if (other.devDeclared === false) into.devDeclared = false;
  else if (other.devDeclared === true && into.devDeclared === undefined) into.devDeclared = true;
  if (into.scope === 'optional' && other.scope !== 'optional') delete into.scope;
  if (into.license === undefined && other.license !== undefined) into.license = other.license;
}

/**
 * @typedef {object} NpmLockEntry
 * @property {string} [version]
 * @property {boolean} [link]
 * @property {string} [license]
 * @property {boolean} [dev]
 * @property {boolean} [optional]
 * @property {boolean} [devOptional]
 * @property {boolean} [peer]
 * @property {boolean} [extraneous]
 * @property {Record<string, string>} [dependencies]
 * @property {Record<string, string>} [devDependencies]
 * @property {Record<string, string>} [optionalDependencies]
 */

/**
 * npm's per-entry dependency flags are a COMPUTED verdict over the whole
 * tree, not a hint. `@npmcli/arborist`'s `calcDepFlags` (re-run on every
 * lockfile save) starts every node flagged `dev`, `optional`, `devOptional`
 * and `peer`, then walks from the root and CLEARS a flag the moment a path
 * reaches the node without an edge of that type. Only `true` flags are
 * written, so for an entry the walk reached at all:
 *
 *   dev: true          every path from the root crosses a devDependencies
 *                      edge — dev-only, it does not ship.
 *   (no dev flag)      some path reaches it with no dev edge — it ships.
 *                      `devOptional: true` narrows that path to "goes through
 *                      an optionalDependencies edge", which is still "may
 *                      ship", so it stays `false` here.
 *   extraneous: true   the walk never reached it (installed, depended on by
 *                      nothing in the tree) — no claim either way.
 *
 * Reading an absent `dev` flag as `false` is therefore reading what npm
 * asserted, not guessing — and it is the only per-package signal the
 * transitive closure has (package.json names direct dependencies only).
 * @param {NpmLockEntry} entry
 * @returns {{ devDeclared?: boolean }}
 */
function devDeclaredFromNpmFlags(entry) {
  if (entry.extraneous === true) return {};
  return { devDeclared: entry.dev === true };
}

/**
 * package-lock.json (npm, lockfileVersion 2/3): `packages` is a flat object
 * keyed by node_modules path ("node_modules/foo", "node_modules/@scope/bar",
 * or a nested override like "node_modules/foo/node_modules/bar"). The name is
 * whatever follows the LAST "node_modules/" segment — that also recovers
 * scoped names correctly, since "@scope/bar" is kept whole.
 *
 * Building edges needs npm's own hoisting resolution: a package's own
 * `dependencies` field names only the dependency's NAME (a version range,
 * not a resolved version), and which physical install satisfies it depends
 * on where in the node_modules tree Node's resolution algorithm finds it
 * first — the requiring package's own node_modules, then each ancestor's,
 * up to the root. `resolve()` below is exactly that walk over lockfile
 * paths (each "node_modules/A/node_modules/B" segment is one directory
 * level). A workspace-local (`link: true`) hit along that walk isn't
 * resolvable to an external package, so the edge is silently dropped
 * rather than guessed.
 * @param {string} path
 * @returns {LockfileGraph}
 */
export function parsePackageLockJsonGraph(path) {
  const raw = /** @type {{ packages?: Record<string, NpmLockEntry> }} */ (JSON.parse(readFileSync(path, 'utf8')));
  const rawPackages = raw.packages;
  if (!rawPackages) return { packages: [], rootDependencies: [], edges: [] };

  /** @type {Map<string, DiscoveredPackage>} */
  const nameVersionByPath = new Map();
  const marker = 'node_modules/';
  for (const [key, entry] of Object.entries(rawPackages)) {
    if (key === '' || entry.link || !entry.version) continue;
    const idx = key.lastIndexOf(marker);
    if (idx === -1) continue;
    const name = key.slice(idx + marker.length);
    if (!name) continue;
    nameVersionByPath.set(key, {
      name,
      version: entry.version,
      ...(entry.license ? { license: entry.license } : {}),
      ...devDeclaredFromNpmFlags(entry),
      ...(entry.optional === true ? { scope: 'optional' } : {})
    });
  }

  /** @param {string} fromPath @param {string} name @returns {string | undefined} */
  const resolve = (fromPath, name) => {
    let prefix = fromPath;
    for (;;) {
      const candidate = prefix === '' ? `${marker}${name}` : `${prefix}/${marker}${name}`;
      if (nameVersionByPath.has(candidate)) return candidate;
      if (prefix === '') return undefined;
      const cut = prefix.lastIndexOf(`/${marker}`);
      prefix = cut === -1 ? '' : prefix.slice(0, cut);
    }
  };
  /** @param {DiscoveredPackage} nv */
  const keyOf = (nv) => `${nv.name}@${nv.version}`;

  // The same name@version can sit at several paths (hoisted at the root AND
  // nested under a package that pinned it). One component, so the paths'
  // flags are FOLDED, "runtime anywhere wins" — first-path-wins would let a
  // nested `dev: true` copy label a shipping hoisted copy dev-only.
  /** @type {Map<string, DiscoveredPackage>} */
  const byKey = new Map();
  /** @type {DiscoveredPackage[]} */
  const packages = [];
  for (const nv of nameVersionByPath.values()) {
    const key = keyOf(nv);
    const existing = byKey.get(key);
    if (existing === undefined) {
      const record = { ...nv };
      byKey.set(key, record);
      packages.push(record);
    } else {
      mergeDiscovered(existing, nv);
    }
  }

  /** @param {NpmLockEntry} entry @returns {Record<string, string>} */
  const depsOf = (entry) => ({
    ...entry.dependencies,
    ...entry.optionalDependencies
  });

  const rootEntry = rawPackages[''];
  /** @type {string[]} */
  const rootDependencies = [];
  if (rootEntry) {
    // Tracked per-section (not one merged spread) so a root-direct dependency
    // is asserted from package.json's own sections below. A runtime section
    // asserts `false` outright — "runtime anywhere wins" even at the root: a
    // name in BOTH a runtime section and `devDependencies` is not dev-only,
    // and a hand-edited lockfile whose flags drifted from package.json cannot
    // make the root's own runtime dependency dev. `devDependencies` only
    // FILLS a gap: npm's flags already know whether that package also ships
    // through some other path, and a root section listing is one edge, not
    // proof that every path is dev.
    const rootRuntimeNames = new Set(Object.keys(depsOf(rootEntry)));
    const rootDevOnlyNames = new Set(Object.keys(rootEntry.devDependencies ?? {}));
    for (const name of rootRuntimeNames) rootDevOnlyNames.delete(name);

    const rootDeps = { ...depsOf(rootEntry), ...rootEntry.devDependencies };
    for (const name of Object.keys(rootDeps)) {
      const resolved = resolve('', name);
      if (!resolved) continue;
      const key = keyOf(/** @type {DiscoveredPackage} */ (nameVersionByPath.get(resolved)));
      rootDependencies.push(key);
      const record = /** @type {DiscoveredPackage} */ (byKey.get(key));
      if (rootRuntimeNames.has(name)) record.devDeclared = false;
      else if (rootDevOnlyNames.has(name) && record.devDeclared === undefined) record.devDeclared = true;
    }
  }

  /** @type {DependencyEdge[]} */
  const edges = [];
  const edgeSeen = new Set();
  for (const [path, nv] of nameVersionByPath) {
    const entry = rawPackages[path];
    const fromKey = keyOf(nv);
    for (const name of Object.keys(depsOf(entry))) {
      const resolved = resolve(path, name);
      if (!resolved) continue;
      const toKey = keyOf(/** @type {DiscoveredPackage} */ (nameVersionByPath.get(resolved)));
      const edgeKey = `${fromKey} ${toKey}`;
      if (edgeSeen.has(edgeKey)) continue;
      edgeSeen.add(edgeKey);
      edges.push({ from: fromKey, to: toKey });
    }
  }

  return { packages, rootDependencies: [...new Set(rootDependencies)], edges };
}

/**
 * @param {string} path
 * @returns {DiscoveredPackage[]}
 */
export function parsePackageLockJson(path) {
  return parsePackageLockJsonGraph(path).packages;
}

/**
 * Strips a pnpm peer-dependency-hash suffix: "8.5.1(postcss@8.5.16)(yaml@2.9.0)" -> "8.5.1".
 * @param {string} version
 * @returns {string}
 */
function stripPeerSuffix(version) {
  const idx = version.indexOf('(');
  return idx === -1 ? version : version.slice(0, idx);
}

/**
 * Splits "name@version" / "@scope/name@version" into its two parts.
 * @param {string} key
 * @returns {DiscoveredPackage | undefined}
 */
function splitNameVersion(key) {
  let rest = key;
  let scopePrefix = '';
  if (rest.startsWith('@')) {
    const slash = rest.indexOf('/');
    if (slash === -1) return undefined;
    scopePrefix = rest.slice(0, slash + 1);
    rest = rest.slice(slash + 1);
  }
  const at = rest.indexOf('@');
  if (at === -1) return undefined;
  const name = scopePrefix + rest.slice(0, at);
  const version = rest.slice(at + 1);
  if (!name || !version) return undefined;
  return { name, version };
}

/**
 * @typedef {Partial<Record<'dependencies' | 'devDependencies' | 'optionalDependencies', Record<string, { version?: string }>>>} PnpmImporter
 */

/**
 * pnpm-lock.yaml (lockfileVersion 9): the `packages` top-level map is already
 * keyed by bare "name@version" — no peer-dependency-hash suffix, that suffix
 * only appears in `snapshots` (the resolved dependency graph) and in
 * `importers`' per-dependency `version` field. Unlike npm, pnpm's snapshot
 * dependency values are ALREADY fully resolved versions (no hoisting
 * ambiguity to walk) — just peer-suffixed, so `stripPeerSuffix` is the only
 * normalization edges need. EVERY importer is read, not just `.`: in a pnpm
 * workspace the root importer is often empty (`.: {}`) and the real
 * dependencies hang off `packages/*` importers, so reading the root alone
 * yields no graph at all. Each importer's direct dependencies become root
 * dependencies of the one workspace, and dev/runtime is "runtime anywhere
 * wins" across importers — a package one importer ships is runtime even if
 * another lists it under devDependencies. (Which importers themselves ship
 * is not something the lockfile can say, so this is the loud direction.)
 * @param {string} path
 * @returns {LockfileGraph}
 */
export function parsePnpmLockYamlGraph(path) {
  const raw = /** @type {{
    importers?: Record<string, PnpmImporter>;
    packages?: Record<string, unknown>;
    snapshots?: Record<string, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }>;
  }} */ (parseYaml(readFileSync(path, 'utf8')));

  /** @type {DiscoveredPackage[]} */
  const packages = [];
  const validKeys = new Set();
  for (const key of Object.keys(raw.packages ?? {})) {
    const parsed = splitNameVersion(key);
    if (!parsed) continue;
    packages.push(parsed);
    validKeys.add(`${parsed.name}@${parsed.version}`);
  }

  /** @type {DependencyEdge[]} */
  const edges = [];
  const edgeSeen = new Set();
  /** @param {string} from @param {string} to */
  const addEdge = (from, to) => {
    // A dependency this closure never resolved to an installed package
    // (peer-only, optional-and-skipped) — dropped, not guessed.
    if (!validKeys.has(to)) return;
    const edgeKey = `${from} ${to}`;
    if (edgeSeen.has(edgeKey)) return;
    edgeSeen.add(edgeKey);
    edges.push({ from, to });
  };

  for (const [snapshotKey, snapshot] of Object.entries(raw.snapshots ?? {})) {
    const nv = splitNameVersion(snapshotKey);
    if (!nv) continue;
    const fromKey = `${nv.name}@${stripPeerSuffix(nv.version)}`;
    const deps = { ...snapshot.dependencies, ...snapshot.optionalDependencies };
    for (const [depName, depVersion] of Object.entries(deps)) {
      addEdge(fromKey, `${depName}@${stripPeerSuffix(depVersion)}`);
    }
  }

  /** @type {string[]} */
  const rootDependencies = [];
  // Tracked per-section across ALL importers (not one merged spread) so a
  // directly-named package can be marked `devDeclared: true`/`false` below —
  // "runtime anywhere wins": a name in ANY importer's dependencies/
  // optionalDependencies is not dev-only, whatever another importer says.
  const runtimeKeys = new Set();
  const devOnlyKeys = new Set();
  for (const importer of Object.values(raw.importers ?? {})) {
    /** @param {Record<string, { version?: string }> | undefined} section @param {boolean} isDev */
    const collect = (section, isDev) => {
      for (const [name, info] of Object.entries(section ?? {})) {
        const version = info?.version;
        // A `link:` is another importer of this same workspace — its own
        // dependencies are read from its own importer entry, not through
        // the link, so nothing is lost by skipping it here.
        if (!version || version.startsWith('link:')) continue;
        const key = `${name}@${stripPeerSuffix(version)}`;
        if (!validKeys.has(key)) continue;
        rootDependencies.push(key);
        (isDev ? devOnlyKeys : runtimeKeys).add(key);
      }
    };
    collect(importer.dependencies, false);
    collect(importer.optionalDependencies, false);
    collect(importer.devDependencies, true);
  }
  for (const key of runtimeKeys) devOnlyKeys.delete(key);

  // Transitive-only pnpm packages stay unmarked — pnpm-lock.yaml carries no
  // per-package dev flag the way package-lock.json does (see
  // DiscoveredPackage.devDeclared); a consumer's graph walk fills them in.
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (devOnlyKeys.has(key)) pkg.devDeclared = true;
    else if (runtimeKeys.has(key)) pkg.devDeclared = false;
  }

  return { packages, rootDependencies: [...new Set(rootDependencies)], edges };
}

/**
 * @param {string} path
 * @returns {DiscoveredPackage[]}
 */
export function parsePnpmLockYaml(path) {
  return parsePnpmLockYamlGraph(path).packages;
}

const LOCKFILE_IGNORE_DIRS = ['**/node_modules/**', '**/.git/**'];

/**
 * Enumerates every npm package the lockfiles under `srcDir` resolve, plus the
 * dependency graph among them. EVERY lockfile found (outside node_modules)
 * feeds the graph, not just one at the root: a backend+frontend repo with
 * `web/package-lock.json`, or a repo with a tooling lockfile beside the app's,
 * is one workspace with several importers, and each lockfile's own root
 * dependencies become root dependencies of that workspace. Edges are keyed
 * "name@version", so the same package resolved by two lockfiles is one node
 * with the union of both lockfiles' edges — an over-approximation that can
 * only ADD paths, which is the loud direction.
 *
 * A package listed by more than one lockfile merges the same way: "runtime
 * anywhere wins" for dev/runtime (one lockfile shipping it makes it runtime),
 * `scope: optional` survives only if every lockfile says optional, and the
 * first license seen is kept.
 *
 * A lockfile that does not parse is a diagnostic, not an exception — the
 * rest of the tree is still described. No lockfile at all is `NO_LOCKFILE`.
 * @param {string} srcDir absolute path
 * @returns {LockfileDiscovery}
 */
export function discoverLockfileGraphs(srcDir) {
  /** @type {string[]} */
  const diagnostics = [];
  /** @type {Map<string, DiscoveredPackage>} */
  const byKey = new Map();
  /** @type {DiscoveredPackage[]} */
  const packages = [];
  const rootDependencies = new Set();
  /** @type {DependencyEdge[]} */
  const edges = [];
  const edgeSeen = new Set();
  /** @type {string[]} */
  const files = [];

  /** @param {LockfileGraph} graph */
  const addGraph = (graph) => {
    for (const pkg of graph.packages) {
      const key = `${pkg.name}@${pkg.version}`;
      const existing = byKey.get(key);
      if (existing === undefined) {
        const copy = { ...pkg };
        byKey.set(key, copy);
        packages.push(copy);
        continue;
      }
      mergeDiscovered(existing, pkg);
    }
    for (const key of graph.rootDependencies) rootDependencies.add(key);
    for (const edge of graph.edges) {
      const edgeKey = `${edge.from} ${edge.to}`;
      if (edgeSeen.has(edgeKey)) continue;
      edgeSeen.add(edgeKey);
      edges.push(edge);
    }
  };

  const npmLockPaths = fg
    .sync('**/package-lock.json', { cwd: srcDir, absolute: true, ignore: LOCKFILE_IGNORE_DIRS, dot: false })
    .sort();
  const pnpmLockPaths = fg
    .sync('**/pnpm-lock.yaml', { cwd: srcDir, absolute: true, ignore: LOCKFILE_IGNORE_DIRS, dot: false })
    .sort();

  /** @type {[string[], (path: string) => LockfileGraph, string][]} */
  const sources = [
    [npmLockPaths, parsePackageLockJsonGraph, 'package-lock.json'],
    [pnpmLockPaths, parsePnpmLockYamlGraph, 'pnpm-lock.yaml']
  ];
  for (const [paths, parse, what] of sources) {
    for (const path of paths) {
      try {
        addGraph(parse(path));
        files.push(path);
      } catch (err) {
        diagnostics.push(
          `unparseable ${what} at ${relative(srcDir, path)}: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  if (npmLockPaths.length === 0 && pnpmLockPaths.length === 0) {
    diagnostics.push(
      'NO_LOCKFILE: no package-lock.json or pnpm-lock.yaml found under srcDir; no npm packages could be enumerated'
    );
  }

  packages.sort((a, b) => (a.name === b.name ? a.version.localeCompare(b.version) : a.name.localeCompare(b.name)));
  return { packages, rootDependencies: [...rootDependencies], edges, files, diagnostics };
}
