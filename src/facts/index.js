// src/facts/index.js
// Barrel for `@dependably/npm-check/facts` — the npm LANGUAGE-FACTS layer:
// per-file imports, bindings and referenced names; Node-style resolution;
// the walk through node_modules; lockfile graphs; workspace discovery.
// Facts, not findings: nothing exported here carries a severity, a verdict
// or a package identifier beyond the name and version on disk. The main
// barrel (`src/index.js`) deliberately does NOT re-export this — the
// lockfile commands must never load the TypeScript compiler.
//
// Precedent: pycheck's `--imports` document (its readme, "Import facts") —
// report not gate, a `documentType` discriminator, `unanalyzable[]`
// load-bearing, additive fields only.

/** The facts document's own schema version, independent of the findings
 *  envelope's `SCHEMA_VERSION` (both `1.0` today; a field added later bumps
 *  the minor, a renamed or removed one the major). */
export const FACTS_SCHEMA_VERSION = '1.0';

export { FactsError } from './errors.js';
export { loadTypeScript } from './ts.js';
export { collectImportFacts, makeRelOf } from './collect.js';
export { factsDocument } from './document.js';
export { scanSource } from './scan.js';
export { ModuleResolver, packageRootOf, resolveExports } from './resolve.js';
export { walkModuleGraph, packageKey, DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES } from './modulegraph.js';
export {
  discoverLockfileGraphs,
  mergeDiscovered,
  parsePackageLockJson,
  parsePackageLockJsonGraph,
  parsePnpmLockYaml,
  parsePnpmLockYamlGraph
} from './lockfile-graph.js';
export { specifierToPackage, aliasBaseFromPathsKey } from './specifier.js';
export { discoverWorkspace } from './workspace.js';
