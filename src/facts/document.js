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
  /** @param {string} key */
  const relKey = (key) => {
    const nul = key.indexOf('\0');
    return nul === -1 ? key : `${key.slice(0, nul)}\0${relOf(key.slice(nul + 1))}`;
  };

  const imports = facts.files.map((f) => ({
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

  const graph = facts.graph;
  /** @type {DocumentReachedPackage[]} */
  const reached = graph
    ? [...graph.reached.values()]
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
        .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    : [];
  const unresolvedByName = graph
    ? [...graph.unresolvedByName]
        .map(([pkg, sites]) => ({
          package: pkg,
          sites: sites.map((s) => ({ file: relOf(s.file), reason: s.reason }))
        }))
        .sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0))
    : [];

  const moduleGraph = {
    enabled: graph !== undefined,
    filesParsed: graph ? graph.filesParsed : 0,
    filesSkippedForSize: graph ? graph.filesSkippedForSize : 0,
    unresolved: graph ? graph.unresolved : 0,
    truncated: graph ? graph.truncated : false,
    nodeModulesMissing: facts.nodeModulesMissing,
    weakPackages: graph ? graph.weakPackages : [],
    reached,
    unresolvedByName
  };

  const ws = facts.workspace;
  const workspace = {
    firstPartyNames: [...ws.firstPartyNames].sort(),
    depScopes: [...ws.depScopes]
      .map(([name, scope]) => ({ name, scope }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    aliasPrefixes: [...ws.aliasPrefixes].sort(),
    // `aliasScope` itself is a closure (`.for(file)`) and cannot be
    // serialized; this projects the same per-config information it answers
    // from, the way `reached`/`unresolvedByName` project the module graph's
    // Maps above -- one entry per tsconfig/jsconfig that declared `paths`,
    // `dir` made target-relative and POSIX like every other path here.
    aliasScope: ws.aliasLayers
      .map((layer) => ({ dir: relOf(layer.dir), prefixes: [...layer.prefixes].sort() }))
      .sort((a, b) => (a.dir < b.dir ? -1 : a.dir > b.dir ? 1 : 0)),
    devDeclaredBy: [...ws.devDeclaredBy]
      .map(([name, manifests]) => ({ name, manifests: [...manifests].sort() }))
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
    sourceFiles: ws.sourceFiles.length,
    diagnostics: ws.diagnostics
  };

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
      reached: reached.length,
      unresolved: moduleGraph.unresolved,
      truncated: moduleGraph.truncated
    },
    exitCode
  };

  return { summary, workspace, imports, moduleGraph, lockfile, unanalyzable: facts.unanalyzable };
}
