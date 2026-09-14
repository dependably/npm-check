// src/facts/collect.js
// One call that gathers every import fact the modules under `src/facts/` can
// establish about a tree: the workspace (manifests, aliases, source files),
// every first-party file's scan with each site resolved to the installed
// copy it loads, the module graph through node_modules, the lockfile graph,
// and — load-bearing — the list of everything that was NOT read.
//
// It reports; it never judges. There is no "reachable" here, no verdict
// vocabulary at all: a consumer that owns those words (sbom-reach's npm
// analyzer) builds them from these facts. What this module guarantees is
// that the facts are complete OR say where they are not (`unanalyzable`):
// a file that could not be read used to be a silent `continue` in the
// consumer, and "nothing imports it" then rested on a file nobody read.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { discoverLockfileGraphs } from './lockfile-graph.js';
import { walkModuleGraph } from './modulegraph.js';
import { ModuleResolver } from './resolve.js';
import { scanSource } from './scan.js';
import { specifierToPackage } from './specifier.js';
import { loadTypeScript } from './ts.js';
import { discoverWorkspace } from './workspace.js';

/** @typedef {import('./types.d.ts').CollectOptions} CollectOptions */
/** @typedef {import('./types.d.ts').FirstPartyFile} FirstPartyFile */
/** @typedef {import('./types.d.ts').ImportFacts} ImportFacts */
/** @typedef {import('./types.d.ts').ModuleGraph} ModuleGraph */
/** @typedef {import('./types.d.ts').ResolvedSite} ResolvedSite */
/** @typedef {import('./types.d.ts').UnanalyzableEntry} UnanalyzableEntry */

/**
 * Relativizes paths against `srcDir` — realpath-aware. First-party files are
 * spelled under `srcDir` as given; resolved node_modules files are realpath'd
 * (pnpm symlinks, macOS `/var` → `/private/var`, `/tmp` → `/private/tmp`),
 * and `srcDir` as given may not be. Relativize against whichever spelling of
 * `srcDir` the file actually sits under: the one that needs FEWER `..`
 * segments. "Prefer the realpath only when it lands inside the tree" was the
 * first rule and it was wrong — with node_modules hoisted ABOVE the target
 * and a symlinked prefix on `srcDir`, both spellings start with `..`, and the
 * as-given one is a `../../../..`-to-root chain followed by the whole
 * absolute path (adversarial review), poisoning every path in the document.
 * Always POSIX separators: the document must compare across machines. The
 * tree itself relativizes to `''`, exactly as sbom-reach's `relOf` does — a
 * consumer emits that spelling verbatim, so it must not change.
 * @param {string} srcDir
 * @param {string} realSrcDir
 * @returns {(file: string) => string}
 */
export function makeRelOf(srcDir, realSrcDir) {
  return (file) => {
    const direct = relative(srcDir, file);
    if (realSrcDir === srcDir) return direct.split(sep).join('/');
    const viaReal = relative(realSrcDir, file);
    const chosen = parentSegments(viaReal) < parentSegments(direct) ? viaReal : direct;
    return chosen.split(sep).join('/');
  };
}

/**
 * How many leading `..` segments a relative path climbs through.
 * @param {string} rel
 * @returns {number}
 */
function parentSegments(rel) {
  let n = 0;
  for (const part of rel.split(sep)) {
    if (part !== '..') break;
    n++;
  }
  return n;
}

/**
 * Collect the import facts of the tree at `srcDir`.
 *
 * @param {string} srcDir - the tree to describe (relative paths resolve against cwd)
 * @param {CollectOptions} [options]
 * @returns {ImportFacts}
 * @throws {import('./errors.js').FactsError} `TYPESCRIPT_MISSING` before any
 *   work is done, when the optional `typescript` peer is not installed.
 */
export function collectImportFacts(srcDir, options = {}) {
  // Fail before touching the tree: every other module here parses with the
  // compiler, so there is nothing partial worth returning without it.
  loadTypeScript();
  const { moduleGraph = true, maxFiles, maxFileBytes, scan = scanSource } = options;

  const absSrcDir = resolve(srcDir);
  let realSrcDir = absSrcDir;
  try {
    realSrcDir = realpathSync(absSrcDir);
  } catch {
    // keep as given
  }
  const relOf = makeRelOf(absSrcDir, realSrcDir);

  const workspace = discoverWorkspace(absSrcDir);
  const resolver = new ModuleResolver(workspace.aliasPrefixes);

  /** @type {UnanalyzableEntry[]} */
  const unanalyzable = [];
  /** @type {FirstPartyFile[]} */
  const files = [];
  let dynamicUnknownTotal = 0;

  for (const file of workspace.sourceFiles) {
    const rel = relOf(file);
    /** @type {string} */
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch (err) {
      // The consumer used to `continue` here silently. A file nobody read is
      // a file whose imports are unknown, and it must be listed. The reason
      // is the error CODE, never Node's message — that carries the absolute
      // path, and reasons must stay machine-independent (`file` says where).
      unanalyzable.push({ file: rel, kind: 'file', reason: `unreadable: ${errorCode(err)}` });
      continue;
    }
    const result = scan(rel, content);
    dynamicUnknownTotal += result.dynamicUnknown;
    if (result.parseErrors && result.parseErrors.length > 0) {
      // Sites collected before/around the problem are still reported; what
      // this entry says is that their absence for some package is not a
      // clean negative.
      unanalyzable.push({ file: rel, kind: 'file-partial', reason: result.parseErrors.join('; ') });
    }
    /** @type {ResolvedSite[]} */
    const sites = result.sites.map((site) => {
      const pkg = specifierToPackage(site.specifier, workspace.aliasPrefixes);
      // Which installed copy does this statement load? Version-accurate
      // attribution is the consumer's, but the fact — the copy the resolver
      // lands in — is established here, once, with the same resolver the
      // graph walk uses.
      const resolution = resolver.resolve(file, site.specifier, site.kind === 'require' ? 'require' : 'import');
      const installed =
        (resolution.kind === 'file' || resolution.kind === 'asset') && resolution.pkg !== undefined
          ? {
              name: resolution.pkg.name,
              dirName: resolution.pkg.dirName,
              version: resolution.pkg.version,
              root: resolution.pkg.root
            }
          : undefined;
      return { ...site, package: pkg, ...(installed ? { installed } : {}) };
    });
    files.push({ file, rel, scan: result, sites });
  }

  /** @type {ModuleGraph | undefined} */
  let graph;
  let nodeModulesMissing = false;
  if (moduleGraph) {
    graph = walkModuleGraph({
      srcDir: absSrcDir,
      resolver,
      roots: files.map((f) => ({ file: f.file, scan: f.scan })),
      scan,
      ...(maxFiles !== undefined ? { maxFiles } : {}),
      ...(maxFileBytes !== undefined ? { maxFileBytes } : {})
    });
    nodeModulesMissing = graph.reached.size === 0 && graph.unresolved > 0 && !existsSync(join(absSrcDir, 'node_modules'));
    for (const entry of graph.unanalyzable) {
      unanalyzable.push({ file: relOf(entry.file), kind: 'node-modules-file', reason: entry.reason });
    }
    if (graph.truncated) {
      unanalyzable.push({
        file: 'node_modules',
        kind: 'walk',
        reason:
          `file budget ${graph.filesParsed} reached; ${graph.filesPastBudget} resolved file(s) past that frontier ` +
          'were not parsed, so packages they load are unobserved, not absent'
      });
    }
  }

  const lockfile = discoverLockfileGraphs(absSrcDir);

  return {
    srcDir: absSrcDir,
    realSrcDir,
    workspace,
    files,
    graph,
    nodeModulesMissing,
    lockfile,
    unanalyzable,
    dynamicUnknownTotal
  };
}

/**
 * A path-free spelling of an I/O failure: the `code` (`EACCES`, `EISDIR`,
 * `ENOENT`…) when there is one, else the constructor name.
 * @param {unknown} err
 * @returns {string}
 */
export function errorCode(err) {
  if (err && typeof err === 'object' && 'code' in err && typeof err.code === 'string') return err.code;
  return err instanceof Error ? err.name : 'error';
}
