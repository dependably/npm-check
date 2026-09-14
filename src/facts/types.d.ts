// src/facts/types.d.ts
// Hand-written declarations for `@dependably/npm-check/facts`. The JS
// modules under src/facts/ reference these through JSDoc
// (`@typedef {import('./types.d.ts').X} X`) and are type-checked against
// them with `npm run typecheck`; consumers get them through the subpath
// export's `types` condition. Keep every exported runtime symbol declared
// here too — this file IS the public surface.

// ---------------------------------------------------------------- scan ----

/**
 * How a source file references a module. The string values are the same
 * ones sbom-reach's `EvidenceKind` uses for its npm evidence, so a consumer
 * can carry them through unchanged.
 */
export type ImportKind = 'import' | 'require' | 'dynamic-import' | 'export-from' | 'type-only-import';

/** One module reference found in a source file. */
export interface ImportSite {
  specifier: string;
  /** 1-based. */
  line: number;
  /** The statement's text, whitespace-collapsed, capped at 200 chars. */
  snippet: string;
  kind: ImportKind;
  /**
   * Imported/required binding names visible at this site: named-import /
   * named-export-from ORIGINAL names (`import { a, b as c }` → "a", "b" —
   * never the local alias), `require()`/dynamic-`import()` destructured
   * names, and exactly ONE level of property access on a default/namespace
   * import's local identifier (`_.template(x)` → "template"). Parse-level
   * only: no type checker, no cross-file aliasing, no chasing past one
   * property-access level. Absent/empty means "no binding names observed at
   * this site" — NOT proof nothing was used; see `opaque`.
   */
  bindings?: string[];
  /**
   * The subset of `bindings` whose local identifier is actually REFERENCED
   * somewhere in the module body after the declaration. A property-access
   * binding is a reference by construction. Any occurrence counts (call,
   * argument, spread, re-export, shorthand property): this is "referenced",
   * not "called" — over-reporting use is the safe direction. A shadowing
   * local is deliberately NOT excluded for the same reason. Absent when
   * nothing was referenced.
   */
  referenced?: string[];
  /**
   * True when this site's default/namespace binding (or a bare
   * `export * from` / `export * as ns from`) is used in a way a parse-level
   * scan cannot resolve to specific property names — assigned, passed as an
   * argument, spread, exported, returned, computed access, OR called /
   * constructed / tagged / rendered directly. An opaque site "could use
   * anything": a consumer must never read it as evidence that some symbol
   * was NOT used.
   */
  opaque?: boolean;
}

export interface ScanResult {
  sites: ImportSite[];
  /** Count of require()/import() calls with non-literal arguments. */
  dynamicUnknown: number;
  /**
   * Set only for `.svelte` files where `<script>` extraction is suspected of
   * having gone wrong — the extracted text failed to parse, or a
   * `<script`/`</script>` tag was found outside every span the extraction
   * accounted for. Sites collected before/around the problem are still
   * present; their absence for some package is not a clean negative.
   */
  parseErrors?: string[];
}

/**
 * Parse-only scan of one source file with the TypeScript compiler API.
 * `fileName` decides the script kind (`.tsx`, `.svelte`, …) and nothing else.
 * Throws `FactsError` (`TYPESCRIPT_MISSING`) when `typescript` is not installed.
 */
export function scanSource(fileName: string, content: string): ScanResult;

// ------------------------------------------------------------- resolve ----

export interface PackageInfo {
  /** The name from the package's own package.json (falls back to the directory name). */
  name: string;
  /**
   * The node_modules directory name (scope included). Differs from `name`
   * for an aliased install (`"string-width-cjs": "npm:string-width@^4"`).
   */
  dirName: string;
  version: string;
  /** Absolute path of the package root — the directory directly under node_modules. */
  root: string;
}

export type Resolution =
  /** A source file the walker should parse. */
  | { kind: 'file'; path: string; pkg: PackageInfo | undefined }
  /** A non-code file (JSON, WASM, CSS, native addon…) — a real edge, nothing to parse. */
  | { kind: 'asset'; path: string; pkg: PackageInfo | undefined }
  | { kind: 'builtin' }
  /** A first-party path alias (tsconfig paths). */
  | { kind: 'alias' }
  | { kind: 'unresolved'; reason: string };

export type ResolveMode = 'import' | 'require';

/**
 * A Node-style module resolver: symlink-aware (pnpm's `.pnpm` layout),
 * `exports`/`imports` maps with import-vs-require conditions, `main`,
 * `module`, `index.*`, `.js`→`.ts` probing, builtins. Reports rather than
 * guesses: aliases, `.d.ts`-only targets, blocked exports and uninstalled
 * packages come back as their own `Resolution` kinds.
 */
export class ModuleResolver {
  /**
   * `aliases` is per-FILE (`AliasScope`), because a tsconfig's `paths`
   * governs its own project rather than the whole tree. A plain set is still
   * accepted and means "these everywhere".
   */
  constructor(aliases?: ReadonlySet<string> | AliasScope);
  resolve(fromFile: string, specifier: string, mode: ResolveMode): Resolution;
  /**
   * The package a file belongs to, from its path alone: the directory right
   * after the LAST `node_modules/` segment (two for a scope); undefined for
   * a first-party path.
   */
  packageOf(file: string): PackageInfo | undefined;
}

/** The package root for a path inside node_modules; undefined for a first-party path. */
export function packageRootOf(file: string): string | undefined;

/**
 * Resolves a subpath (or `#import` key) against a package.json `exports` /
 * `imports` value. Returns the target string, `null` when the map explicitly
 * blocks it, or `undefined` when nothing matched.
 */
export function resolveExports(map: unknown, subpath: string, conditions: ReadonlySet<string>): string | null | undefined;

// --------------------------------------------------------- modulegraph ----

export interface GraphImporter {
  /** Absolute path of the importing file. */
  file: string;
  line: number;
  snippet: string;
  kind: ImportKind;
  bindings?: string[];
  referenced?: string[];
  opaque?: boolean;
  /** Key of the package the importing file belongs to; undefined for first-party code. */
  fromPackage?: string;
}

export interface ReachedPackage {
  /**
   * `${name}@${version}\0${root}` — one entry per INSTALLED COPY, since two
   * copies of one version can differ only by location.
   */
  key: string;
  name: string;
  /** See `PackageInfo.dirName`. */
  dirName: string;
  version: string;
  root: string;
  /**
   * Every import site from OUTSIDE this package that resolved into it —
   * first-party and other packages' files alike; a package's own internal
   * relative imports are traversed but never listed here.
   */
  importers: GraphImporter[];
  /**
   * The chain of package keys along which this package was FIRST reached
   * (breadth-first over files from the roots, so short in practice, not a
   * proven shortest package chain), this package last.
   */
  chain: string[];
  /** A file in this package has a non-literal require()/import(). */
  dynamic: boolean;
  /** A file in this package was not parsed (size cap, unreadable) or has a dangling relative import; its edges are unknown. */
  incomplete: boolean;
}

export interface ModuleGraph {
  reached: Map<string, ReachedPackage>;
  /** `${name}@${version}` (lower-cased name, both `name` and `dirName` spellings) → every reached copy of it. */
  byNameVersion: Map<string, ReachedPackage[]>;
  /** lower-cased name (both spellings) → every reached copy, any version. */
  byName: Map<string, ReachedPackage[]>;
  filesParsed: number;
  filesSkippedForSize: number;
  /** Files that resolved after the budget was hit and were therefore not parsed. */
  filesPastBudget: number;
  unresolved: number;
  /**
   * Bare specifiers the resolver could not follow, by the PACKAGE NAME they
   * name (lower-cased) → where and why (at most five sites per name).
   */
  unresolvedByName: Map<string, { file: string; reason: string }[]>;
  /** The file budget stopped the walk; packages past the frontier are unknown, not absent. */
  truncated: boolean;
  /** `name@version` of packages flagged dynamic or incomplete (deduplicated, sorted). */
  weakPackages: string[];
  /** node_modules files that resolved but were not parsed (unreadable, oversized), absolute paths. */
  unanalyzable: { file: string; reason: string }[];
}

export interface WalkOptions {
  /** Absolute path; used to relativize file names handed to `scan`. */
  srcDir: string;
  resolver: ModuleResolver;
  /** First-party files with their already-computed scans — the roots. */
  roots: Iterable<{ file: string; scan: ScanResult }>;
  /** Parses a node_modules file. Injected so the caller's scanner (and any caching) is reused. */
  scan: (relFile: string, content: string) => ScanResult;
  /** Stop after this many node_modules files have been parsed. Default `DEFAULT_MAX_FILES`. */
  maxFiles?: number;
  /** Skip (and flag) files larger than this many bytes. Default `DEFAULT_MAX_FILE_BYTES`. */
  maxFileBytes?: number;
}

export const DEFAULT_MAX_FILES: number;
export const DEFAULT_MAX_FILE_BYTES: number;
export function packageKey(pkg: PackageInfo): string;
export function walkModuleGraph(opts: WalkOptions): ModuleGraph;

// ------------------------------------------------------ lockfile-graph ----

export interface DiscoveredPackage {
  name: string;
  version: string;
  /**
   * SPDX license expression verbatim from the lockfile entry (npm mirrors
   * the package's own `license` field). Absent when the entry never carried
   * one; never guessed. pnpm-lock.yaml carries no license data at all.
   */
  license?: string;
  /**
   * Whole-tree dev/runtime declaration, tri-state: `true` — reachable ONLY
   * through devDependencies edges; `false` — some path reaches it without a
   * dev edge ("runtime anywhere wins"); absent — the lockfile says nothing.
   * package-lock.json states this for EVERY entry (npm's per-entry flags are
   * a computed answer); pnpm-lock.yaml only for importer-direct packages.
   */
  devDeclared?: boolean;
  /**
   * "optional" only, when npm asserts the package is reachable EXCLUSIVELY
   * through optionalDependencies. Absent otherwise — never asserted.
   */
  scope?: 'optional';
}

/** One dependency edge; both ends are "name@version" keys matching a `DiscoveredPackage`. */
export interface DependencyEdge {
  from: string;
  to: string;
}

export interface LockfileGraph {
  packages: DiscoveredPackage[];
  /** "name@version" keys the project's own package.json directly depends on. */
  rootDependencies: string[];
  /** Edges among the resolved closure; does not include root-level edges. */
  edges: DependencyEdge[];
}

/** `discoverLockfileGraphs`' result: every lockfile under the tree merged into one graph. */
export interface LockfileDiscovery extends LockfileGraph {
  /** Absolute paths of the lockfiles that parsed, in the order they were merged. */
  files: string[];
  /** `unparseable … at <rel>: <why>` per lockfile that failed; `NO_LOCKFILE: …` when none was found. */
  diagnostics: string[];
}

export function mergeDiscovered(into: DiscoveredPackage, other: DiscoveredPackage): void;
export function parsePackageLockJsonGraph(path: string): LockfileGraph;
export function parsePackageLockJson(path: string): DiscoveredPackage[];
export function parsePnpmLockYamlGraph(path: string): LockfileGraph;
export function parsePnpmLockYaml(path: string): DiscoveredPackage[];
export function discoverLockfileGraphs(srcDir: string): LockfileDiscovery;

// ----------------------------------------------------------- specifier ----

/**
 * The npm package a specifier names (lower-cased), or undefined for a
 * relative/absolute path, a builtin, a `#imports` key, a data:/file: URL, or
 * a tsconfig/jsconfig path alias.
 */
export function specifierToPackage(spec: string, aliasPrefixes: ReadonlySet<string>): string | undefined;
/** tsconfig/jsconfig `paths` keys ("@app/*", "utils") → alias bases ("@app", "utils"). */
export function aliasBaseFromPathsKey(key: string): string;

/**
 * Which path aliases are in scope for a given file.
 *
 * A `paths` map belongs to the tsconfig/jsconfig that declares it and governs
 * that project's own files -- which is what `tsc` does. One flat
 * workspace-wide set would let ANY config anywhere under the scanned tree
 * delete a package's evidence in EVERY file.
 */
export interface AliasScope {
  /** Alias bases in scope for `file`, an absolute path. */
  for(file: string): ReadonlySet<string>;
}

/** An `AliasScope` that answers the same set everywhere -- tests, and the empty default. */
export function fixedAliasScope(prefixes?: ReadonlySet<string>): AliasScope;
/** Accept either shape at an API boundary without making every caller care. */
export function asAliasScope(aliases: ReadonlySet<string> | AliasScope): AliasScope;

// ---------------------------------------------------------- sourcescan ----

/**
 * What an in-process analyzer is allowed to exclude from its first-party
 * source scan, and how it says so. See `sourcescan.js` for the full
 * rationale: a directory's NAME is not evidence that the code inside it is
 * generated -- `.gitignore` is the authority instead.
 */
export interface GitignoreLayer {
  /** Directory the file sits in, relative to srcDir, `/`-joined; `''` for the root one. */
  dir: string;
  /** An `ignore` package matcher built from that directory's `.gitignore` content. */
  matcher: { test(path: string): { ignored: boolean; unignored: boolean } };
}

/** Every `.gitignore` under `srcDir`, deepest first -- not just the root one. */
export function loadGitignores(srcDir: string, ignoreDirs: readonly string[]): GitignoreLayer[];
/** Is `rel` (relative to srcDir, `/`-joined) ignored, by git's own rules? */
export function isGitignored(layers: readonly GitignoreLayer[], rel: string): boolean;
/** Drop the absolute paths under `srcDir` that a `.gitignore` in the tree ignores. */
export function filterGitignored(srcDir: string, layers: readonly GitignoreLayer[], paths: string[]): string[];
/** Directory names that usually DO hold generated or vendored output; nothing is excluded for being on this list. */
export const OUTPUT_SHAPED_DIRS: readonly string[];
/** `OUTPUT_DIR_SCANNED`, or undefined when no such directory was scanned. A NOTE, not a warning. */
export function outputDirScannedDiagnostic(relPaths: readonly string[], names?: readonly string[]): string | undefined;

// ----------------------------------------------------------- workspace ----

export type DepScope = 'runtime' | 'dev';

/** One tsconfig/jsconfig's own `paths` alias bases and the directory it governs (absolute path). */
export interface AliasLayer {
  dir: string;
  prefixes: string[];
}

export interface Workspace {
  /** Names of package.json manifests found in the tree = first-party packages (lower-cased). */
  firstPartyNames: Set<string>;
  /** name → runtime|dev; "runtime anywhere wins" across all manifests. */
  depScopes: Map<string, DepScope>;
  /**
   * Every tsconfig/jsconfig paths alias base found anywhere in the tree.
   *
   * FOR REPORTING ONLY -- never decide a specifier with this. A `paths` map
   * governs the project that declares it, so use `aliasScope`, which answers
   * per file.
   */
  aliasPrefixes: Set<string>;
  /** Which alias bases apply to a given file -- see `AliasScope`. */
  aliasScope: AliasScope;
  /** The raw per-config layers `aliasScope` is built from (absolute directories); carried for JSON serialization. */
  aliasLayers: AliasLayer[];
  /**
   * name -> the manifests that declared it a DEV dependency, `/`-joined and
   * relative to srcDir, for names no manifest declares runtime.
   *
   * A dev claim is one manifest's view, and a manifest's view covers its own
   * subtree. Recording WHERE the claim came from is what lets a consumer
   * refuse a vendored tool's `devDependencies` as the reason a package
   * imported from `src/` is exempt from a build gate.
   */
  devDeclaredBy: Map<string, string[]>;
  /** First-party source files, absolute paths, sorted. */
  sourceFiles: string[];
  diagnostics: string[];
}

export function discoverWorkspace(srcDir: string): Workspace;
/** Is `rel` (a `/`-joined path) inside the directory of the manifest at `manifestRel`? */
export function governedByManifest(manifestRel: string, rel: string): boolean;

// ------------------------------------------------------------- collect ----

/** An `ImportSite` with what it names and what it loads. */
export interface ResolvedSite extends ImportSite {
  /** The package the specifier names (see `specifierToPackage`); undefined for a non-package import. */
  package: string | undefined;
  /**
   * The installed package copy the specifier resolved INTO, when it did.
   * A fact, not a match: compare `name`/`dirName` against `package` before
   * treating it as "the installed copy of the package this site names".
   */
  installed?: { name: string; dirName: string; version: string; root: string };
}

export interface FirstPartyFile {
  /** Absolute path. */
  file: string;
  /** `srcDir`-relative POSIX path (realpath-aware). */
  rel: string;
  scan: ScanResult;
  sites: ResolvedSite[];
}

export type UnanalyzableKind =
  /** A first-party source file that could not be read; its imports are unknown. */
  | 'file'
  /** A first-party `.svelte` file whose `<script>` extraction reported a problem; sites are still present. */
  | 'file-partial'
  /** A node_modules file the walk resolved but did not parse (unreadable, oversized). */
  | 'node-modules-file'
  /** The walk stopped on its file budget; everything past the frontier is unobserved. */
  | 'walk';

export interface UnanalyzableEntry {
  /** `srcDir`-relative POSIX path (or `node_modules` for a `walk` entry). */
  file: string;
  kind: UnanalyzableKind;
  reason: string;
}

export interface CollectOptions {
  /** Follow imports through node_modules. Default true. */
  moduleGraph?: boolean;
  maxFiles?: number;
  maxFileBytes?: number;
  /** The scanner to use for first-party AND node_modules files. Default `scanSource`. */
  scan?: (relFile: string, content: string) => ScanResult;
}

export interface ImportFacts {
  /** Absolute. */
  srcDir: string;
  /** `realpath(srcDir)`, or `srcDir` when that fails. */
  realSrcDir: string;
  workspace: Workspace;
  files: FirstPartyFile[];
  /** Undefined when `moduleGraph: false`. */
  graph: ModuleGraph | undefined;
  /** The walk reached nothing, something was unresolved, and there is no `node_modules` directory. */
  nodeModulesMissing: boolean;
  lockfile: LockfileDiscovery;
  /** ALWAYS present (empty when nothing was skipped). Non-empty means the search was incomplete. */
  unanalyzable: UnanalyzableEntry[];
  /** Sum of `dynamicUnknown` over first-party files. */
  dynamicUnknownTotal: number;
}

export function collectImportFacts(srcDir: string, options?: CollectOptions): ImportFacts;
/**
 * Realpath-aware relativizer producing POSIX paths: of the two spellings of
 * `srcDir` (as given, realpath), the one the file sits under with fewer `..`
 * segments wins. `srcDir` itself relativizes to `''`, as sbom-reach's `relOf`.
 */
export function makeRelOf(srcDir: string, realSrcDir: string): (file: string) => string;

// ------------------------------------------------------------ document ----

export interface FactsSummary {
  /** First-party source files the workspace discovery found. */
  scanned: number;
  /** Of those, files read and parsed — the length of `imports`. */
  analyzed: number;
  /** Entries in `unanalyzable`, of every kind. Non-zero means the search was incomplete. */
  unanalyzable: number;
  /** Import sites summed over every first-party file. */
  imports: number;
  moduleGraph: { filesParsed: number; reached: number; unresolved: number; truncated: boolean };
  /** The process exit code, `0` for every successful scan. */
  exitCode: number;
}

export interface DocumentSite {
  specifier: string;
  package: string | null;
  line: number;
  snippet: string;
  kind: ImportKind;
  bindings: string[];
  referenced: string[];
  opaque: boolean;
  installed?: { name: string; dirName: string; version: string; root: string };
}

export interface DocumentFile {
  file: string;
  dynamicUnknown: number;
  parseErrors: string[];
  sites: DocumentSite[];
}

export interface DocumentImporter {
  file: string;
  line: number;
  snippet: string;
  kind: ImportKind;
  bindings: string[];
  referenced: string[];
  opaque: boolean;
  fromPackage: string | null;
}

export interface DocumentReachedPackage {
  /** `${name}@${version}\0${relative root}`. */
  key: string;
  name: string;
  dirName: string;
  version: string;
  root: string;
  chain: string[];
  dynamic: boolean;
  incomplete: boolean;
  importers: DocumentImporter[];
}

export interface FactsDocumentBody {
  summary: FactsSummary;
  workspace: {
    firstPartyNames: string[];
    depScopes: { name: string; scope: DepScope }[];
    aliasPrefixes: string[];
    /**
     * `aliasScope`'s raw per-config layers, JSON-safe: `aliasScope` itself is
     * a closure and cannot be serialized, so this projects the same
     * information the live `AliasScope` answers `.for(file)` from -- one
     * entry per tsconfig/jsconfig that declared `paths`, `dir` relative to
     * the target and `/`-joined.
     */
    aliasScope: { dir: string; prefixes: string[] }[];
    /** `devDeclaredBy`, JSON-safe: one entry per name with an unresolved dev claim. */
    devDeclaredBy: { name: string; manifests: string[] }[];
    sourceFiles: number;
    diagnostics: string[];
  };
  imports: DocumentFile[];
  moduleGraph: {
    enabled: boolean;
    filesParsed: number;
    filesSkippedForSize: number;
    unresolved: number;
    truncated: boolean;
    nodeModulesMissing: boolean;
    weakPackages: string[];
    reached: DocumentReachedPackage[];
    unresolvedByName: { package: string; sites: { file: string; reason: string }[] }[];
  };
  lockfile: {
    files: string[];
    packages: DiscoveredPackage[];
    rootDependencies: string[];
    edges: DependencyEdge[];
    diagnostics: string[];
  };
  unanalyzable: UnanalyzableEntry[];
}

/** The full document as `npm-check imports --format json` prints it. */
export interface FactsDocument extends FactsDocumentBody {
  tool: 'npm-check';
  toolVersion: string;
  schemaVersion: string;
  documentType: 'imports';
  target: string;
}

export function factsDocument(facts: ImportFacts, options?: { exitCode?: number }): FactsDocumentBody;

// --------------------------------------------------------------- misc ----

export const FACTS_SCHEMA_VERSION: '1.1';

export class FactsError extends Error {
  constructor(code: string, message: string);
  code: string;
}

/** The TypeScript compiler API, loaded once; throws `FactsError` (`TYPESCRIPT_MISSING`) when absent. */
export function loadTypeScript(): typeof import('typescript');
