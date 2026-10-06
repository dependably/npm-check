// src/facts/document.js
// The JSON shape of an import-facts document: the in-memory `ImportFacts`
// (Maps, Sets, absolute paths) rendered as plain data a consumer can parse
// on any machine — Maps and Sets become sorted arrays, every absolute path
// becomes a target-relative POSIX path, and the module-graph keys keep their
// `\0` separator with the path half relativized the same way, so a key in
// `chain`/`fromPackage` still matches its `reached` entry.
//
// Language facts only: no purls, no verdicts, no severities. The envelope
// identity (`tool`, `toolVersion`, `schemaVersion`, `documentType`, `target`)
// is added by `schema.js`'s `buildFactsEnvelope`; this module produces the
// `summary` and the body sections.
import { makeRelOf } from './collect.js';

/** @typedef {import('./types.d.ts').ImportFacts} ImportFacts */
/** @typedef {import('./types.d.ts').FactsDocumentBody} FactsDocumentBody */
/** @typedef {import('./types.d.ts').FactsSummary} FactsSummary */
/** @typedef {import('./types.d.ts').ReachedPackage} ReachedPackage */
/** @typedef {import('./types.d.ts').DocumentReachedPackage} DocumentReachedPackage */
/** @typedef {import('./types.d.ts').ModuleGraph} ModuleGraph */
/** @typedef {(file: string) => string} RelOf */

/**
 * A comparator ordering items by a string key, by code unit.
 * @template T
 * @param {(item: T) => string} keyOf
 * @returns {(a: T, b: T) => number}
 */
function byKey(keyOf) {
  return (a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    if (ka < kb) return -1;
    return ka > kb ? 1 : 0;
  };
}

/**
 * @param {ImportFacts} facts
 * @param {RelOf} relOf
 * @returns {FactsDocumentBody['imports']}
 */
function documentImports(facts, relOf) {
  return facts.files.map((f) => ({
    file: f.rel,
    dynamicUnknown: f.scan.dynamicUnknown,
    parseErrors: f.scan.parseErrors ?? [],
    sites: f.sites.map((s) => ({
      specifier: s.specifier,
      package: s.package ?? null,
      line: s.line,
      snippet: s.snippet,
      kind: s.kind,
      bindings: s.bindings ?? [],
      referenced: s.referenced ?? [],
      opaque: s.opaque === true,
      ...(s.installed ? { installed: { ...s.installed, root: relOf(s.installed.root) } } : {})
    }))
  }));
}

/**
 * @param {ModuleGraph} graph
 * @param {RelOf} relOf
 * @returns {DocumentReachedPackage[]}
 */
function documentReached(graph, relOf) {
  /** @param {string} key */
  const relKey = (key) => {
    const nul = key.indexOf('\0');
    return nul === -1 ? key : `${key.slice(0, nul)}\0${relOf(key.slice(nul + 1))}`;
  };
  return [...graph.reached.values()]
    .map((entry) => ({
      key: relKey(entry.key),
      name: entry.name,
      dirName: entry.dirName,
      version: entry.version,
      root: relOf(entry.root),
      chain: entry.chain.map(relKey),
      dynamic: entry.dynamic,
      incomplete: entry.incomplete,
      importers: entry.importers.map((imp) => ({
        file: relOf(imp.file),
        line: imp.line,
        snippet: imp.snippet,
        kind: imp.kind,
        bindings: imp.bindings ?? [],
        referenced: imp.referenced ?? [],
        opaque: imp.opaque === true,
        fromPackage: imp.fromPackage === undefined ? null : relKey(imp.fromPackage)
      }))
    }))
    .sort(byKey((entry) => entry.key));
}

/**
 * @param {ImportFacts} facts
 * @param {RelOf} relOf
 * @returns {FactsDocumentBody['moduleGraph']}
 */
function documentModuleGraph(facts, relOf) {
  const graph = facts.graph;
  if (graph === undefined) {
    return {
      enabled: false,
      filesParsed: 0,
      filesSkippedForSize: 0,
      unresolved: 0,
      truncated: false,
      nodeModulesMissing: facts.nodeModulesMissing,
      weakPackages: [],
      reached: [],
      unresolvedByName: []
    };
  }
  return {
    enabled: true,
    filesParsed: graph.filesParsed,
    filesSkippedForSize: graph.filesSkippedForSize,
    unresolved: graph.unresolved,
    truncated: graph.truncated,
    nodeModulesMissing: facts.nodeModulesMissing,
    weakPackages: graph.weakPackages,
    reached: documentReached(graph, relOf),
    unresolvedByName: [...graph.unresolvedByName]
      .map(([pkg, sites]) => ({
        package: pkg,
        sites: sites.map((s) => ({ file: relOf(s.file), reason: s.reason }))
      }))
      .sort(byKey((entry) => entry.package))
  };
}

/**
 * @param {ImportFacts['workspace']} ws
 * @param {RelOf} relOf
 * @returns {FactsDocumentBody['workspace']}
 */
function documentWorkspace(ws, relOf) {
  return {
    firstPartyNames: [...ws.firstPartyNames].sort(),
    depScopes: [...ws.depScopes]
      .map(([name, scope]) => ({ name, scope }))
      .sort(byKey((entry) => entry.name)),
    aliasPrefixes: [...ws.aliasPrefixes].sort(),
    // `aliasScope` itself is a closure (`.for(file)`) and cannot be
    // serialized; this projects the same per-config information it answers
    // from, the way `reached`/`unresolvedByName` project the module graph's
    // Maps -- one entry per tsconfig/jsconfig that declared `paths`,
    // `dir` made target-relative and POSIX like every other path here.
    aliasScope: ws.aliasLayers
      .map((layer) => ({ dir: relOf(layer.dir), prefixes: [...layer.prefixes].sort() }))
      .sort(byKey((entry) => entry.dir)),
    devDeclaredBy: [...ws.devDeclaredBy]
      .map(([name, manifests]) => ({ name, manifests: [...manifests].sort() }))
      .sort(byKey((entry) => entry.name)),
    sourceFiles: ws.sourceFiles.length,
    diagnostics: ws.diagnostics
  };
}

/**
 * Render collected facts as the document body: `summary` plus every section.
 * `target` is recorded by the envelope, not here; paths are relative to the
 * facts' own `srcDir` (which is the target the CLI scanned).
 *
 * @param {ImportFacts} facts
 * @param {{ exitCode?: number }} [options] `exitCode` lands in `summary.exitCode`
 *   and MUST equal the process exit code the run will return (0 here — a
 *   successful scan never gates).
 * @returns {FactsDocumentBody}
 */
export function factsDocument(facts, options = {}) {
  const exitCode = options.exitCode ?? 0;
  const relOf = makeRelOf(facts.srcDir, facts.realSrcDir);

  const imports = documentImports(facts, relOf);
  const moduleGraph = documentModuleGraph(facts, relOf);
  const ws = facts.workspace;
  const workspace = documentWorkspace(ws, relOf);

  const lockfile = {
    files: facts.lockfile.files.map(relOf),
    packages: facts.lockfile.packages,
    rootDependencies: facts.lockfile.rootDependencies,
    edges: facts.lockfile.edges,
    diagnostics: facts.lockfile.diagnostics
  };

  /** @type {FactsSummary} */
  const summary = {
    scanned: ws.sourceFiles.length,
    analyzed: facts.files.length,
    unanalyzable: facts.unanalyzable.length,
    imports: facts.files.reduce((n, f) => n + f.sites.length, 0),
    moduleGraph: {
      filesParsed: moduleGraph.filesParsed,
      reached: moduleGraph.reached.length,
      unresolved: moduleGraph.unresolved,
      truncated: moduleGraph.truncated
    },
    exitCode
  };

  return { summary, workspace, imports, moduleGraph, lockfile, unanalyzable: facts.unanalyzable };
}
