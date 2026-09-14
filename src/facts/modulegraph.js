// src/facts/modulegraph.js
// The statically resolved module graph THROUGH node_modules. Every first-party
// file's imports are resolved to the installed file they load, that file is
// parsed with the same parse-only scanner, its imports are resolved in turn,
// and so on until the graph is exhausted or a budget runs out. The result is,
// per installed package copy, the import sites that load it and the chain of
// packages between first-party code and it.
//
// It is a MODULE graph, not a call graph: an edge means "evaluating this
// module evaluates that one" (top-level `import` / `require`), which is what
// makes a package's code present and executable in the process. Whether a
// specific function is then CALLED is a question for the consumer's symbol
// layer, fed by the importers this walker collects — including the ones
// inside node_modules.
//
// Honesty rules, all reported on the result so the consumer can weaken any
// negative it draws (a fact this walk could not establish is reported as a
// gap, never silently dropped):
//  - a non-literal `require()`/`import()` inside a package marks that
//    package `dynamic`: it can load things this walk cannot see;
//  - a file skipped for size (bundled 5 MB `dist/` files are common) or a
//    file that resolved but could not be read marks its package `incomplete`
//    — some of its own edges are unknown — AND is listed in `unanalyzable`;
//    a RELATIVE import inside a package that does not resolve marks the
//    package `incomplete` too, but there is no file to list for it (nothing
//    was found to skip), so it appears nowhere else;
//  - an unresolvable BARE specifier is recorded under the package name it
//    asked for (`unresolvedByName`), so the gap is attributable precisely;
//    the walk stopping on the file budget sets `truncated` and counts the
//    files past the frontier (`filesPastBudget`).
//
// Ported from sbom-reach's `packages/analyzer-npm/src/modulegraph.ts`;
// `unanalyzable` and `filesPastBudget` are additive.
import { readFileSync, statSync } from 'node:fs';
import { relative, sep } from 'node:path';

/** @typedef {import('./types.d.ts').ImportKind} ImportKind */
/** @typedef {import('./types.d.ts').ImportSite} ImportSite */
/** @typedef {import('./types.d.ts').PackageInfo} PackageInfo */
/** @typedef {import('./types.d.ts').ResolveMode} ResolveMode */
/** @typedef {import('./types.d.ts').GraphImporter} GraphImporter */
/** @typedef {import('./types.d.ts').ReachedPackage} ReachedPackage */
/** @typedef {import('./types.d.ts').ModuleGraph} ModuleGraph */
/** @typedef {import('./types.d.ts').WalkOptions} WalkOptions */

export const DEFAULT_MAX_FILES = 25_000;
export const DEFAULT_MAX_FILE_BYTES = 1_500_000;

/**
 * `${name}@${version}\0${root}` — one key per INSTALLED COPY, since two copies
 * of one version can differ only by location and one lockfile can hold
 * several versions. The `\0` separator cannot occur in a name, a version or a
 * path, so the key splits back unambiguously.
 * @param {PackageInfo} pkg
 * @returns {string}
 */
export function packageKey(pkg) {
  return `${pkg.name.toLowerCase()}@${pkg.version}\0${pkg.root}`;
}

/**
 * @param {ImportKind} kind
 * @returns {ResolveMode}
 */
function modeFor(kind) {
  return kind === 'require' ? 'require' : 'import';
}

/**
 * @param {WalkOptions} opts
 * @returns {ModuleGraph}
 */
export function walkModuleGraph(opts) {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  /** @type {Map<string, ReachedPackage>} */
  const reached = new Map();
  /** @type {Set<string>} */
  const visited = new Set();
  let filesParsed = 0;
  let filesSkippedForSize = 0;
  let filesPastBudget = 0;
  let unresolved = 0;
  let truncated = false;
  /** @type {Map<string, { file: string; reason: string }[]>} */
  const unresolvedByName = new Map();
  /** @type {{ file: string; reason: string }[]} */
  const unanalyzable = [];
  /** Package key of `item` → its entry, to flag `incomplete` from inside the loop.
   * @param {string | undefined} key
   * @returns {ReachedPackage | undefined} */
  const entryOf = (key) => (key === undefined ? undefined : reached.get(key));

  /**
   * @typedef {object} QueueItem
   * @property {string} file
   * @property {ImportSite[]} sites
   * @property {string | undefined} fromPackage
   * @property {string[]} chain
   */
  /** @type {QueueItem[]} */
  const queue = [];

  for (const root of opts.roots) {
    queue.push({ file: root.file, sites: root.scan.sites, fromPackage: undefined, chain: [] });
  }

  /**
   * @param {PackageInfo} pkg
   * @param {GraphImporter} importer
   * @param {string[]} chain
   * @returns {ReachedPackage}
   */
  const reach = (pkg, importer, chain) => {
    const key = packageKey(pkg);
    let entry = reached.get(key);
    if (entry === undefined) {
      entry = {
        key,
        name: pkg.name,
        dirName: pkg.dirName,
        version: pkg.version,
        root: pkg.root,
        importers: [],
        chain: [...chain, key],
        dynamic: false,
        incomplete: false
      };
      reached.set(key, entry);
    }
    // A package's own internal wiring (`require('./processor')`) is how the
    // walk gets THROUGH it, not evidence that anything loads it: recording
    // it inflated evidence ~70× on a real tree, pushed the one external
    // importer past a consumer's evidence cap, and made a package's own
    // `import { danger } from './x.js'` count as the vulnerable symbol being
    // used by a consumer.
    if (importer.fromPackage !== key) entry.importers.push(importer);
    return entry;
  };

  while (queue.length > 0) {
    const item = /** @type {QueueItem} */ (queue.shift());
    for (const site of item.sites) {
      // A type-only import never loads code at runtime; it is first-party
      // evidence (kept by the caller) but not an edge of this graph.
      if (site.kind === 'type-only-import') continue;
      const resolution = opts.resolver.resolve(item.file, site.specifier, modeFor(site.kind));
      if (resolution.kind === 'unresolved') {
        unresolved++;
        const bare = bareNameOf(site.specifier);
        if (bare !== undefined) {
          const list = unresolvedByName.get(bare) ?? [];
          if (list.length < 5) list.push({ file: item.file, reason: resolution.reason });
          unresolvedByName.set(bare, list);
        } else {
          // A relative/`#` import inside a package that goes nowhere: that
          // package's own edges are not all known.
          const owner = entryOf(item.fromPackage);
          if (owner !== undefined) owner.incomplete = true;
        }
        continue;
      }
      if (resolution.kind !== 'file' && resolution.kind !== 'asset') continue;
      const pkg = resolution.pkg;
      // Resolved into first-party code (a relative import, a hoisted
      // workspace package): first-party files are roots already, and a
      // first-party file the caller chose not to scan (gitignored build
      // output) is not something to start parsing here.
      if (pkg === undefined) continue;
      /** @type {GraphImporter} */
      const importer = {
        file: item.file,
        line: site.line,
        snippet: site.snippet,
        kind: site.kind,
        ...(site.bindings ? { bindings: site.bindings } : {}),
        ...(site.referenced ? { referenced: site.referenced } : {}),
        ...(site.opaque ? { opaque: true } : {}),
        ...(item.fromPackage !== undefined ? { fromPackage: item.fromPackage } : {})
      };
      const entry = reach(pkg, importer, item.chain);
      if (resolution.kind === 'asset') continue;
      if (visited.has(resolution.path)) continue;
      visited.add(resolution.path);
      if (filesParsed >= maxFiles) {
        truncated = true;
        filesPastBudget++;
        continue;
      }
      /** @type {number} */
      let size;
      try {
        size = statSync(resolution.path).size;
      } catch (err) {
        entry.incomplete = true;
        unanalyzable.push({ file: resolution.path, reason: `unreadable: ${errorCode(err)}` });
        continue;
      }
      if (size > maxFileBytes) {
        filesSkippedForSize++;
        entry.incomplete = true;
        unanalyzable.push({ file: resolution.path, reason: `too large to parse: ${size} bytes exceeds the ${maxFileBytes}-byte limit` });
        continue;
      }
      /** @type {string} */
      let content;
      try {
        content = readFileSync(resolution.path, 'utf8');
      } catch (err) {
        entry.incomplete = true;
        unanalyzable.push({ file: resolution.path, reason: `unreadable: ${errorCode(err)}` });
        continue;
      }
      filesParsed++;
      const rel = relative(opts.srcDir, resolution.path).split(sep).join('/');
      const scan = opts.scan(rel, content);
      if (scan.dynamicUnknown > 0) entry.dynamic = true;
      queue.push({ file: resolution.path, sites: scan.sites, fromPackage: entry.key, chain: entry.chain });
    }
  }

  /** @type {Map<string, ReachedPackage[]>} */
  const byNameVersion = new Map();
  /** @type {Map<string, ReachedPackage[]>} */
  const byName = new Map();
  /** @type {Set<string>} */
  const weak = new Set();
  for (const entry of reached.values()) {
    // Indexed under both spellings when they differ (aliased installs), so a
    // lockfile-named component and a package.json-named one both hit.
    const names = new Set([entry.name.toLowerCase(), entry.dirName.toLowerCase()]);
    for (const name of names) {
      push(byNameVersion, `${name}@${entry.version}`, entry);
      push(byName, name, entry);
    }
    if (entry.dynamic || entry.incomplete) weak.add(`${entry.name}@${entry.version}`);
  }
  return {
    reached,
    byNameVersion,
    byName,
    filesParsed,
    filesSkippedForSize,
    filesPastBudget,
    unresolved,
    unresolvedByName,
    truncated,
    weakPackages: [...weak].sort(),
    unanalyzable
  };
}

/**
 * The package name a bare specifier asks for (lower-cased), or undefined for
 * a relative/absolute/`#` one.
 * @param {string} specifier
 * @returns {string | undefined}
 */
function bareNameOf(specifier) {
  if (specifier.length === 0 || specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('#')) return undefined;
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined;
  const parts = specifier.split('/');
  if (specifier.startsWith('@')) return parts.length >= 2 ? `${parts[0]}/${parts[1]}`.toLowerCase() : undefined;
  return parts[0].toLowerCase();
}

/**
 * @template K, V
 * @param {Map<K, V[]>} map
 * @param {K} key
 * @param {V} value
 */
function push(map, key, value) {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/**
 * A path-free spelling of an I/O failure (Node's message embeds the absolute
 * path, and `unanalyzable[].reason` must compare across machines): the
 * `code` when there is one, else the constructor name.
 * @param {unknown} err
 * @returns {string}
 */
function errorCode(err) {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return err instanceof Error ? err.name : 'error';
}
