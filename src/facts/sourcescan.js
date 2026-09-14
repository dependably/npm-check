// src/facts/sourcescan.js
// What an in-process analyzer is allowed to exclude from its FIRST-PARTY
// source scan, and how it says so.
//
// The rule this file exists to enforce: **a directory's NAME is not evidence
// that the code inside it is generated.** Excluding `build/` or `dist/` by
// name was a guess, and where the guess was wrong an analyzer reported
// `not-observed` -- "I looked and did not find" -- about files it never
// opened. That is invariant 1's expensive direction (sbom-reach's CLAUDE.md),
// and it was found in a real repo: SvelteDocs keeps its build pipeline in a
// tracked, non-gitignored `build/`, the only importer of a high-severity
// advisory (sbom-reach GitLab #31; sbom-reach commit 95f2b94).
//
// `.gitignore` is the authority instead: a project that builds into `dist/`
// gitignores `dist/`, and one whose source lives in `build/` does not. That
// moves the decision from a guess to the project's own statement about its
// own tree.
//
// What a scan may STILL exclude by name is a location defined by a tool
// rather than by convention, holding a COPY of the dependency closure --
// `node_modules`. That is excluded for a different and correct reason: a
// dependency's imports are the DEPENDENCY's, and counting them would make
// every transitive dependency look first-party-imported.
//
// Ported verbatim (semantics preserved) from sbom-reach's
// `packages/core/src/reach/sourcescan.ts`.
import { readFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import fg from 'fast-glob';
import ignoreFactory from 'ignore';

/** @typedef {import('./types.d.ts').GitignoreLayer} GitignoreLayer */

/**
 * Every `.gitignore` under `srcDir`, deepest first -- not just the root one.
 *
 * Reading the root alone is not "letting gitignore decide": a monorepo
 * routinely ignores `dist/` from `packages/foo/.gitignore` and says nothing
 * about it at the root, so a root-only reader would start scanning exactly
 * the built output that dropping hardcoded directory names is not meant to
 * touch.
 *
 * `ignoreDirs` keeps the walk out of `node_modules`, which is both a large
 * speedup and correct: a dependency's own `.gitignore` governs its own
 * repository, not this tree.
 *
 * @param {string} srcDir
 * @param {readonly string[]} ignoreDirs
 * @returns {GitignoreLayer[]}
 */
export function loadGitignores(srcDir, ignoreDirs) {
  const paths = fg.sync('**/.gitignore', {
    cwd: srcDir,
    absolute: true,
    ignore: [...ignoreDirs],
    dot: false,
    followSymbolicLinks: false,
    suppressErrors: true
  });
  /** @type {GitignoreLayer[]} */
  const layers = [];
  for (const path of paths) {
    /** @type {string} */
    let content;
    try {
      content = readFileSync(path, 'utf8');
    } catch {
      continue;
    }
    layers.push({
      dir: relative(srcDir, dirname(path)).split(sep).join('/'),
      matcher: ignoreFactory().add(content)
    });
  }
  // Deepest first: git gives the nearest `.gitignore` the last word, including
  // its right to re-include with `!` something a parent ignored.
  layers.sort((a, b) => b.dir.length - a.dir.length || a.dir.localeCompare(b.dir));
  return layers;
}

/**
 * Is `rel` (relative to srcDir, `/`-joined) ignored, by git's own rules?
 *
 * Component by component, outermost first, because that is how git decides:
 * each path component is judged by the NEAREST `.gitignore` that says
 * anything about it, and an ignored DIRECTORY ends the walk -- git does not
 * descend into one, so no deeper rule and no deeper `.gitignore` inside it
 * can re-include anything. Doing it this way is what makes `!build/` in
 * `tools/.gitignore` re-include `tools/build/` against a root that ignores
 * `build/`, which real git does and a single flat matcher does not.
 *
 * @param {readonly GitignoreLayer[]} layers
 * @param {string} rel
 * @returns {boolean}
 */
export function isGitignored(layers, rel) {
  if (layers.length === 0 || rel === '' || rel.startsWith('..')) return false;
  const parts = rel.split('/');
  for (let i = 0; i < parts.length; i++) {
    const path = parts.slice(0, i + 1).join('/');
    // A trailing slash is how `ignore` is told the path is a directory, which
    // decides whether a directory-only pattern (`build/`) matches it at all.
    const isDir = i < parts.length - 1;
    if (componentIgnored(layers, path, isDir ? `${path}/` : path)) return true;
  }
  return false;
}

/**
 * The nearest layer with an explicit verdict about one path component decides it.
 * @param {readonly GitignoreLayer[]} layers
 * @param {string} path
 * @param {string} testPath
 * @returns {boolean}
 */
function componentIgnored(layers, path, testPath) {
  const slash = path.lastIndexOf('/');
  const parent = slash === -1 ? '' : path.slice(0, slash);
  for (const layer of layers) {
    // Layers are deepest-first; one applies when its directory is the
    // component's own directory or an ancestor of it.
    if (layer.dir !== '' && parent !== layer.dir && !parent.startsWith(`${layer.dir}/`)) continue;
    const rel = layer.dir === '' ? path : path.slice(layer.dir.length + 1);
    const sub = layer.dir === '' ? testPath : testPath.slice(layer.dir.length + 1);
    // `ignore` reports a path as ignored when an ANCESTOR directory of it
    // matched, which is its own walk, not this one. Disregard that: the
    // ancestor was judged on its own turn above, and reaching this component
    // at all means a nearer layer re-included it.
    if (rel.includes('/') && layer.matcher.test(`${rel.slice(0, rel.lastIndexOf('/'))}/`).ignored) {
      continue;
    }
    const result = layer.matcher.test(sub);
    if (result.ignored) return true;
    if (result.unignored) return false;
    // Silent about this component: keep walking outwards.
  }
  return false;
}

/**
 * Drop the absolute paths under `srcDir` that a `.gitignore` in the tree ignores.
 * @param {string} srcDir
 * @param {readonly GitignoreLayer[]} layers
 * @param {string[]} paths
 * @returns {string[]}
 */
export function filterGitignored(srcDir, layers, paths) {
  if (layers.length === 0) return paths;
  return paths.filter((p) => !isGitignored(layers, relative(srcDir, p).split(sep).join('/')));
}

/**
 * Directory names that usually DO hold generated or vendored output. Nothing
 * is excluded for being on this list -- it exists only so that scanning one
 * can be said out loud, for the project that commits its build output
 * without gitignoring it and then wonders why its evidence points into a
 * bundle.
 * @type {readonly string[]}
 */
export const OUTPUT_SHAPED_DIRS = ['build', 'coverage', 'dist', 'out', 'vendor'];

/**
 * `OUTPUT_DIR_SCANNED`, or undefined when no such directory was scanned.
 *
 * Deliberately a NOTE, not a warning. A warning marks a run that examined
 * LESS than it appears to -- a degraded run that must not look clean. This
 * read MORE of the tree.
 *
 * Reading more is not free, and the honest version of this rationale says
 * so: a newly-scanned directory can SHADOW a package name -- a top-level
 * `build/` against the `build` distribution, a committed `vendor/js-yaml`
 * against `js-yaml` -- and a consumer answers `unknown` for that, which
 * gates LESS than the `reachable` it replaced. What holds is that no
 * negative gets SILENTLY weaker: each of those is reported on the finding
 * itself, naming the colliding name and the path that owns it, instead of
 * becoming a confident negative (invariant 1). A warning marks a gap the
 * findings do not carry; this one they do.
 *
 * It still has to be visible, because a user who sees evidence at
 * `dist/bundle.js` should be able to find out why a bundle counted as
 * first-party source. Raising it to a warning would also fire on every run
 * of every repo that commits a built `dist/`, which is how a signal becomes
 * noise everyone skims past.
 *
 * @param {readonly string[]} relPaths scanned source files, relative to srcDir, `/`-joined.
 * @param {readonly string[]} [names]
 * @returns {string | undefined}
 */
export function outputDirScannedDiagnostic(relPaths, names = OUTPUT_SHAPED_DIRS) {
  const nameSet = new Set(names);
  /** @type {Set<string>} */
  const scanned = new Set();
  for (const rel of relPaths) {
    const segments = rel.split('/');
    for (const segment of segments.slice(0, -1)) {
      if (nameSet.has(segment)) scanned.add(segment);
    }
  }
  if (scanned.size === 0) return undefined;
  const listed = [...scanned]
    .sort()
    .map((n) => `${n}/`)
    .join(', ');
  return (
    `OUTPUT_DIR_SCANNED: scanned source under ${listed}, which no .gitignore under srcDir ` +
    'ignores. A directory name is not evidence, so those files are read as first-party source -- ' +
    'the alternative is claiming `not-observed` for a package only such a file imports. One of ' +
    'them may also SHADOW a package of the same name, in which case that finding is reported ' +
    '`unknown` naming the collision rather than as a negative. If they really are generated ' +
    'output, gitignore them and they will be excluded.'
  );
}
