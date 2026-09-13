# API guide

`@dependably/npm-check` is usable as a library (ESM). Import from the package root.

## Core functions

```js
import {
  parseLockfile,
  serializeLockfile,
  validatePackageLock,
  migrateToVersion,
  fixPackageLock,
  upgradeIntegrityHashes,
  deduplicatePackages,
  checkIntegrity,
  checkLicenses,
  checkAll,
  parseLicensesCsv
} from '@dependably/npm-check';

// Parse and validate a lockfile
const lockfile = parseLockfile('package-lock.json');
const { valid, errors } = validatePackageLock(lockfile);

// Migrate between versions
const v3Lockfile = migrateToVersion(lockfile, 3);

// Apply automated fixes
const { fixedLockfile, fixes } = fixPackageLock(lockfile, {
  fillMissingIntegrity: true,
  dedupe: true
});

// Write back to file
serializeLockfile('package-lock.json', fixedLockfile, true);
```

## Checking integrity and licenses

```js
// Check integrity hashes
const { valid: hashesValid, passed, failed, errors } = await checkIntegrity(
  lockfile,
  {
    nodeModulesPath: './node_modules',
    onProgress: (progress) => console.log(progress.percentage + '%')
  }
);

// Check licenses
const approvedLicenses = await parseLicensesCsv('./approved-licenses.csv');
const { valid: licensesValid, approved, rejected, warnings } = await checkLicenses(
  lockfile,
  {
    nodeModulesPath: './node_modules',
    csvPath: './approved-licenses.csv',
    strict: false, // Unknown licenses are warnings, not errors
    onProgress: (progress) => console.log(progress.percentage + '%')
  }
);

// Or run both checks at once
const { valid, integrity, licenses } = await checkAll(lockfile, {
  nodeModulesPath: './node_modules',
  csvPath: './approved-licenses.csv',
  strict: false
});
```

Common options: `nodeModulesPath` (default `'./node_modules'`), `csvPath` (license check; default `'./approved-licenses.csv'`), `strict` (license check; treat unknown licenses as errors, default `false`), and `onProgress` (callback with `{ current, total, percentage, stage }`).

## Large lockfiles (performance utilities)

Utilities for processing very large lockfiles without loading or copying everything at once — batching, chunking, streaming parsing, parallel processing, and progress reporting:

```js
import {
  isLargeLockfile,
  processBatchedPackages,
  chunkLockfile,
  mergeLockfileChunks,
  StreamingParser,
  parallelUpgradeIntegrityHashes,
  createProgressReporter
} from '@dependably/npm-check';

const lockfile = parseLockfile('large-package-lock.json');

if (isLargeLockfile(lockfile, 10)) {           // 10MB threshold
  await processBatchedPackages(lockfile.packages, (path, pkg) => {
    // Process each package; yields for GC every batch
  }, 1000);
}
```

See the [performance guide](PERFORMANCE.md) for the full API (shallow copies, lazy filtering, memory stats, streaming, parallel processing, progress tracking).

## Complete workflow

```js
import {
  parseLockfile,
  validatePackageLock,
  fixPackageLock,
  serializeLockfile
} from '@dependably/npm-check';

// 1. Parse
const lockfile = parseLockfile('package-lock.json');

// 2. Validate
const validation = validatePackageLock(lockfile);
if (!validation.valid) {
  console.error('Validation errors:', validation.errors);
}

// 3. Fix
const { fixedLockfile, fixes } = fixPackageLock(lockfile, {
  fillMissingIntegrity: true,
  dedupe: true,
  normalizeTo: 3  // Upgrade to v3
});

console.log('Fixes applied:', fixes);

// 4. Write
serializeLockfile('package-lock.json', fixedLockfile, true);
```

## Find and analyze issues

```js
import {
  parseLockfile,
  validatePackageLock,
  findDuplicatePackages,
  countUniquePackages
} from '@dependably/npm-check';

const lockfile = parseLockfile('package-lock.json');

// Validation details
const { errors, warnings } = validatePackageLock(lockfile);
errors.forEach(err => console.error(`[${err.code}] ${err.message}`));

// Duplicate analysis
const duplicates = findDuplicatePackages(lockfile);
duplicates.forEach((versions, packageName) => {
  console.log(`${packageName}: ${versions.length} versions found`);
});

console.log(`Total unique packages: ${countUniquePackages(lockfile)}`);
```

## Import facts (`@dependably/npm-check/facts`)

The language-facts layer behind `npm-check imports` is a separate subpath
export, deliberately **not** re-exported from the package root: it needs the
TypeScript compiler, and a consumer of the lockfile API must never pay for
loading it.

```js
import { collectImportFacts, factsDocument } from '@dependably/npm-check/facts';

const facts = collectImportFacts('./my-app');          // in-memory: Maps, Sets, absolute paths
const body = factsDocument(facts);                     // JSON-ready: arrays, target-relative POSIX paths
```

`typescript` is an **optional peer dependency** (`>=5.6`). Nothing under
`/facts` is loaded until you import the subpath, and the first parse throws a
`FactsError` with `code === 'TYPESCRIPT_MISSING'` when it is not installed —
`collectImportFacts` checks before touching the tree, so there is no partial
result to misread.

```js
import { collectImportFacts, FactsError } from '@dependably/npm-check/facts';

try {
  collectImportFacts('.');
} catch (err) {
  if (err instanceof FactsError && err.code === 'TYPESCRIPT_MISSING') {
    // install `typescript` alongside npm-check
  }
}
```

### `collectImportFacts(srcDir, options?) → ImportFacts`

One call that gathers everything and reports what it could not read. Options:
`moduleGraph` (default `true`; follow imports through `node_modules`),
`maxFiles` / `maxFileBytes` (walk budgets; defaults `25000` / `1500000`), and
`scan` (an injected scanner with `scanSource`'s signature, used for
first-party and `node_modules` files alike — for caching or instrumentation).

The result:

| Field | What |
| --- | --- |
| `srcDir`, `realSrcDir` | The tree, absolute, and its realpath. |
| `workspace` | `discoverWorkspace`'s result: `firstPartyNames` (Set), `depScopes` (Map, name → `runtime`/`dev`), `aliasPrefixes` (Set), `sourceFiles`, `diagnostics`. |
| `files` | One `FirstPartyFile` per file read: `file` (absolute), `rel` (srcDir-relative, POSIX), `scan` (the `ScanResult`), `sites` (each `ImportSite` plus `package` — the npm package the specifier names, or `undefined` — and `installed` — the copy it resolved into, when it did). |
| `graph` | The `ModuleGraph`, or `undefined` when `moduleGraph: false`. |
| `nodeModulesMissing` | The walk reached nothing, something was unresolved, and there is no `node_modules`. |
| `lockfile` | `discoverLockfileGraphs`' result: merged `packages`, `rootDependencies`, `edges`, the `files` read, `diagnostics`. |
| `unanalyzable` | **Always present.** `{ file, kind, reason }` for every first-party file that could not be read (`file`), every `.svelte` file with an extraction problem (`file-partial`), every `node_modules` file the walk skipped (`node-modules-file`), and a budget stop (`walk`). |
| `dynamicUnknownTotal` | Non-literal `require()`/`import()` calls across first-party files. |

`factsDocument(facts, { exitCode })` renders that as the body of the
`imports` document (`summary` + `workspace` + `imports` + `moduleGraph` +
`lockfile` + `unanalyzable`); `buildFactsEnvelope` in `src/schema.js` wraps
it in the envelope. The [CLI reference](./CLI.md#imports-command) documents
every field.

### Primitives

The pieces `collectImportFacts` is built from are exported too, for a
consumer that wants to run its own pipeline:

```js
import {
  scanSource,                       // (fileName, content) → { sites, dynamicUnknown, parseErrors? }
  ModuleResolver,                   // new ModuleResolver(aliasPrefixes?).resolve(fromFile, specifier, 'import'|'require')
  packageRootOf, resolveExports,    // path → package root; exports/imports-map resolution
  walkModuleGraph,                  // ({ srcDir, resolver, roots, scan, maxFiles?, maxFileBytes? }) → ModuleGraph
  DEFAULT_MAX_FILES, DEFAULT_MAX_FILE_BYTES, packageKey,
  discoverWorkspace,                // (srcDir) → Workspace
  discoverLockfileGraphs,           // (srcDir) → every lockfile under the tree, merged
  parsePackageLockJsonGraph, parsePnpmLockYamlGraph, parsePackageLockJson, parsePnpmLockYaml, mergeDiscovered,
  specifierToPackage, aliasBaseFromPathsKey,
  makeRelOf,                        // (srcDir, realSrcDir) → realpath-aware relativizer
  loadTypeScript,                   // the compiler API, loaded once; throws TYPESCRIPT_MISSING
  FACTS_SCHEMA_VERSION, FactsError
} from '@dependably/npm-check/facts';
```

Types for all of it ship as `src/facts/types.d.ts` (the subpath's `types`
condition), so a TypeScript consumer gets `ImportSite`, `ScanResult`,
`Resolution`, `ModuleGraph`, `ReachedPackage`, `LockfileGraph`,
`ImportFacts`, `FactsDocument` and the rest without a build step.

Three rules travel with this code and are what a consumer is entitled to
rely on: the scan **over-reports use and never under-reports it**
(`referenced` counts any occurrence, shadowing locals included); `opaque` is
**fail-safe** (an opaque site could use anything, so it must never support a
"symbol not used" conclusion); and `unanalyzable` is **load-bearing** (a
non-empty list means the search was incomplete, and every negative drawn
from the facts has to account for it).
