#!/usr/bin/env node
/**
 * Standalone benchmark harness for the import-facts scan pipeline:
 * enumerate (discoverWorkspace / fast-glob) -> byte pre-filter
 * (import|require|export regex) -> ts.createSourceFile parse-only scan
 * (scanSource) -> the full collectImportFacts() call. This is NOT part of the
 * test suite and must never be wired into CI — it is a manual perf tool.
 *
 * It generates a synthetic-but-realistic workspace on disk under
 * os.tmpdir(), then runs the REAL scanSource() / discoverWorkspace() /
 * collectImportFacts() APIs against it (imports src/facts/ directly — there
 * is no build step in this package).
 *
 * Moved from sbom-reach's packages/analyzer-npm/bench/scan-bench.mjs along
 * with the code it benchmarks; the end-to-end phase there timed the verdict
 * layer (npmAnalyzer), which stayed behind — here it times the facts.
 *
 * Usage:
 *   node bench/scan-bench.mjs --files=5k
 *   node bench/scan-bench.mjs --files=20k
 *   node bench/scan-bench.mjs --files=50k
 *
 * Options:
 *   --files=<n|n k>   file count to generate (default 5000)
 *   --seed=<n>         PRNG seed for reproducible fixtures (default 42)
 *   --keep              don't delete the generated scratch directory
 *   --pool=<n>          also time an artificial N-way-chunked scan loop
 *                       (single-threaded chunking, NOT worker_threads) to
 *                       sanity-check how much headroom parallel chunking
 *                       could buy before committing to a real thread pool
 */

import { mkdirSync, writeFileSync, rmSync, readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir, cpus } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { discoverWorkspace, scanSource, collectImportFacts } from '../src/facts/index.js';

// ---------------------------------------------------------------- args ----

const rawArgs = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, '').split('=');
    return [k, v ?? 'true'];
  })
);

function parseCount(s) {
  const m = /^(\d+(?:\.\d+)?)(k)?$/i.exec(String(s).trim());
  if (!m) throw new Error(`bad file count: "${s}" (expected e.g. 5000 or 5k)`);
  return Math.round(Number(m[1]) * (m[2] ? 1000 : 1));
}

const FILE_COUNT = parseCount(rawArgs.get('files') ?? '5000');
const SEED = Number(rawArgs.get('seed') ?? '42');
const KEEP = rawArgs.get('keep') === 'true';
const POOL_N = rawArgs.has('pool') ? Number(rawArgs.get('pool')) : undefined;

// ------------------------------------------------------- deterministic RNG --

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(SEED);
const pick = (arr) => arr[Math.floor(rand() * arr.length)];
const int = (min, max) => min + Math.floor(rand() * (max - min + 1));

// --------------------------------------------------------- package pools ----

// Packages a consumer would typically ask about — a mix that will show up as
// imported and as declared-but-never-imported, mirroring a real workspace.
const QUERIED_PACKAGES = [
  'lodash',
  'axios',
  'chalk',
  'dayjs',
  'express',
  'uuid',
  'qs',
  'zod',
  'commander',
  'fast-glob',
  'react',
  'react-dom',
  '@scope/widgets',
  '@scope/utils',
  'left-pad',
  'never-imported-dep'
];
// Noise packages: imported by generated files but of no interest to any
// consumer, so most of the scan's work is thrown away (as in real repos).
const NOISE_PACKAGES = [
  'is-odd',
  'is-even',
  'pad-start',
  'trim-left',
  'trim-right',
  'string-width',
  'strip-ansi',
  'ansi-styles',
  'supports-color',
  'wrap-ansi',
  'cli-cursor',
  'cli-spinners',
  'figures',
  'log-symbols',
  'p-limit',
  'p-queue'
];
// left-pad / never-imported-dep are deliberately excluded from the import
// pool below (declared in package.json, never actually imported).
const NEVER_IMPORTED = new Set(['left-pad', 'never-imported-dep']);
const ALL_PACKAGES = [...QUERIED_PACKAGES, ...NOISE_PACKAGES].filter((p) => !NEVER_IMPORTED.has(p));

// Words that are safe filler for "no import at all" files: none of these
// contain "import", "require" or "export" as a substring, since the
// pre-filter is a raw regex test over file bytes (not tokenized).
const FILLER_WORDS = [
  'alpha',
  'bravo',
  'charlie',
  'delta',
  'echo',
  'total',
  'count',
  'value',
  'result',
  'buffer',
  'handler',
  'context',
  'payload',
  'record',
  'widget',
  'session'
];

// ------------------------------------------------------ content generators --

function fillerLine() {
  const a = pick(FILLER_WORDS);
  const b = pick(FILLER_WORDS);
  return `const ${a}${int(0, 999)} = compute(${b}, ${int(1, 100)});`;
}

// Deliberately no `export` keyword: the file class this feeds must not trip
// the byte pre-filter (see FILLER_WORDS).
function helperFn(name) {
  const lines = [];
  const n = int(3, 10);
  for (let i = 0; i < n; i++) lines.push(`  ${fillerLine()}`);
  return [`function ${name}(x: number): number {`, ...lines, `  return x + ${int(1, 50)};`, `}`].join('\n');
}

/** File with zero import/require/export occurrences anywhere — exercises the
 *  fast pre-filter reject path (no ts.createSourceFile call at all). */
function noImportFile(idx) {
  const fns = int(2, 5);
  const body = Array.from({ length: fns }, (_, i) => helperFn(`fn${idx}_${i}`)).join('\n\n');
  return `// generated fixture module ${idx} — no external references\n\n${body}\n`;
}

/** Typical file: 1-5 imports, small body. */
function typicalFile(idx, ext) {
  const importCount = int(1, 5);
  const lines = [];
  for (let i = 0; i < importCount; i++) {
    const pkg = pick(ALL_PACKAGES);
    lines.push(pickImportStyle(pkg, ext));
  }
  if (rand() < 0.3) lines.push(`import { helper } from './sibling${int(0, 9)}.js';`);
  const fnBody = helperFn(`typical${idx}`);
  return `${lines.join('\n')}\n\n${fnBody}\n`;
}

/** Heavy file: 15-40 imports and a larger body — the parser workhorse case. */
function heavyFile(idx, ext) {
  const importCount = int(15, 40);
  const lines = [];
  for (let i = 0; i < importCount; i++) {
    const pkg = pick(ALL_PACKAGES);
    lines.push(pickImportStyle(pkg, ext));
  }
  // A tsconfig path-alias import, and a dynamic-argument require
  // (non-literal — counted as dynamicUnknown, never attributed).
  lines.push(`import { util${idx} } from '@app/shared/util${idx % 50}';`);
  lines.push(`const dynamicName = pickName();`);
  lines.push(`const mod = require(dynamicName);`);
  const fns = int(5, 12);
  const body = Array.from({ length: fns }, (_, i) => helperFn(`heavy${idx}_${i}`)).join('\n\n');
  return `${lines.join('\n')}\n\n${body}\n`;
}

function pickImportStyle(pkg, ext) {
  const style = int(0, 3);
  if (ext === 'cjs' || (ext === 'js' && style === 3)) {
    return `const ${safeIdent(pkg)} = require('${pkg}');`;
  }
  switch (style) {
    case 0:
      return `import ${safeIdent(pkg)} from '${pkg}';`;
    case 1:
      return `import { ${safeIdent(pkg)}Fn } from '${pkg}';`;
    case 2:
      return `export { ${safeIdent(pkg)}Fn } from '${pkg}';`;
    default:
      return `const ${safeIdent(pkg)} = await import('${pkg}');`;
  }
}

function safeIdent(pkg) {
  return pkg.replace(/[^a-zA-Z0-9]/g, '_').replace(/^_+/, '') || 'pkg';
}

// File extension mix: mostly .ts, a realistic tail of .tsx/.js/.mjs/.cjs.
function pickExt() {
  const r = rand();
  if (r < 0.7) return 'ts';
  if (r < 0.8) return 'tsx';
  if (r < 0.9) return 'js';
  if (r < 0.95) return 'mjs';
  return 'cjs';
}

// -------------------------------------------------------- workspace layout --

function buildLayout(fileCount) {
  const filesPerDir = 120;
  const leafCount = Math.max(1, Math.ceil(fileCount / filesPerDir));
  const level1Count = Math.max(1, Math.ceil(Math.sqrt(leafCount)));
  const leaves = [];
  for (let i = 0; i < leafCount; i++) {
    const area = i % level1Count;
    const mod = Math.floor(i / level1Count);
    leaves.push(join('src', `area${area}`, `module${mod}`));
  }
  return leaves;
}

function generateWorkspace(root, fileCount) {
  mkdirSync(root, { recursive: true });

  const deps = Object.fromEntries(QUERIED_PACKAGES.slice(0, 12).map((p) => [p, '^1.0.0']));
  const devDeps = Object.fromEntries(QUERIED_PACKAGES.slice(12).map((p) => [p, '^1.0.0']));
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: '@bench/workspace-root', version: '0.0.0', private: true, workspaces: ['packages/*'], dependencies: deps, devDependencies: devDeps }, null, 2)
  );

  writeFileSync(
    join(root, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', baseUrl: '.', paths: { '@app/*': ['src/*'] } } }, null, 2)
  );

  mkdirSync(join(root, 'packages', 'shared'), { recursive: true });
  writeFileSync(join(root, 'packages', 'shared', 'package.json'), JSON.stringify({ name: '@bench/shared', version: '0.0.0', dependencies: {} }, null, 2));
  writeFileSync(join(root, 'packages', 'shared', 'index.ts'), `export const shared = true;\n`);

  const leaves = buildLayout(fileCount);
  for (const leaf of leaves) mkdirSync(join(root, leaf), { recursive: true });

  // File class mix: 30% no-import (pre-filter reject), 55% typical, 15% heavy.
  let written = 0;
  let leafIdx = 0;
  let inLeaf = 0;
  const filesPerDir = 120;
  for (let i = 0; i < fileCount; i++) {
    if (inLeaf >= filesPerDir && leafIdx < leaves.length - 1) {
      leafIdx++;
      inLeaf = 0;
    }
    const leaf = leaves[leafIdx];
    const ext = pickExt();
    const r = rand();
    let content;
    if (r < 0.3) content = noImportFile(i);
    else if (r < 0.85) content = typicalFile(i, ext);
    else content = heavyFile(i, ext);
    writeFileSync(join(root, leaf, `mod_${String(i).padStart(6, '0')}.${ext}`), content);
    written++;
    inLeaf++;
  }
  return written;
}

// ---------------------------------------------------------------- timing ----

function fmtMs(ms) {
  return `${ms.toFixed(1)}ms`;
}
function fmtS(ms) {
  return `${(ms / 1000).toFixed(2)}s`;
}

function main() {
  console.log(`scan-bench: files=${FILE_COUNT} seed=${SEED} cpus=${cpus().length} (${cpus()[0]?.model ?? 'unknown'})`);

  const scratchRoot = mkdtempSync(join(tmpdir(), 'npm-check-scan-bench-'));
  const srcDir = join(scratchRoot, 'workspace');

  const genStart = performance.now();
  const written = generateWorkspace(srcDir, FILE_COUNT);
  const genMs = performance.now() - genStart;
  console.log(`generated ${written} files under ${srcDir} in ${fmtS(genMs)} (not part of scan timing)`);

  try {
    // ---- Phase 1: enumerate ----
    const t0 = performance.now();
    const ws = discoverWorkspace(srcDir);
    const enumerateMs = performance.now() - t0;

    // +1 expected: the generated packages/shared/index.ts fixture file.
    if (ws.sourceFiles.length !== FILE_COUNT + 1) {
      console.warn(`note: discoverWorkspace found ${ws.sourceFiles.length} source files, expected ${FILE_COUNT + 1}`);
    }

    // ---- Phase 2: read (fs) ----
    const t1 = performance.now();
    const contents = new Array(ws.sourceFiles.length);
    for (let i = 0; i < ws.sourceFiles.length; i++) {
      contents[i] = readFileSync(ws.sourceFiles[i], 'utf8');
    }
    const readMs = performance.now() - t1;

    // ---- Phase 3a: pre-filter only (approximation of the production
    // PREFILTER, as a separate pass, to estimate the cheap reject path) ----
    const PREFILTER_APPROX = /import|require|export/;
    const t2 = performance.now();
    let prefilterPassCount = 0;
    for (const c of contents) {
      if (PREFILTER_APPROX.test(c)) prefilterPassCount++;
    }
    const prefilterMs = performance.now() - t2;

    // ---- Phase 3b: real scanSource() ----
    const t3 = performance.now();
    let totalSites = 0;
    let totalDynamicUnknown = 0;
    for (let i = 0; i < ws.sourceFiles.length; i++) {
      const rel = ws.sourceFiles[i].slice(srcDir.length + 1);
      const { sites, dynamicUnknown } = scanSource(rel, contents[i]);
      totalSites += sites.length;
      totalDynamicUnknown += dynamicUnknown;
    }
    const scanSourceMs = performance.now() - t3;
    const parseApproxMs = Math.max(0, scanSourceMs - prefilterMs);

    const manualTotalMs = enumerateMs + readMs + scanSourceMs;

    console.log('');
    console.log('phase breakdown (manual instrumentation around the real APIs):');
    console.log(`  enumerate (discoverWorkspace)      ${fmtMs(enumerateMs)}`);
    console.log(`  read (fs, ${ws.sourceFiles.length} files)          ${fmtMs(readMs)}`);
    console.log(`  pre-filter only (approx, ${prefilterPassCount} pass)  ${fmtMs(prefilterMs)}`);
    console.log(`  parse (approx = scanSource - prefilter) ${fmtMs(parseApproxMs)}`);
    console.log(`  scanSource total (real API, incl. its own pre-filter) ${fmtMs(scanSourceMs)}`);
    console.log(`  ---`);
    console.log(`  manual total (enumerate+read+scanSource) ${fmtS(manualTotalMs)}`);
    console.log(`  sites found: ${totalSites}, dynamicUnknown: ${totalDynamicUnknown}`);

    // ---- Phase 4: full real pipeline via collectImportFacts() — the
    // authoritative end-to-end number (does its own enumerate/read/scan,
    // resolves every site, walks node_modules — none here — and reads the
    // lockfile graph) ----
    const t4 = performance.now();
    const facts = collectImportFacts(srcDir);
    const pipelineMs = performance.now() - t4;
    const sites = facts.files.reduce((n, f) => n + f.sites.length, 0);

    console.log('');
    console.log(`full collectImportFacts() pipeline: ${fmtS(pipelineMs)}`);
    console.log(`  ${facts.files.length} files, ${sites} sites, ${facts.unanalyzable.length} unanalyzable, nodeModulesMissing=${facts.nodeModulesMissing}`);

    const rss = process.memoryUsage().rss;
    console.log('');
    console.log(`peak RSS at end of run: ${(rss / 1024 / 1024).toFixed(0)} MiB`);

    if (POOL_N && POOL_N > 1) {
      const chunkCount = POOL_N;
      const chunkSize = Math.ceil(ws.sourceFiles.length / chunkCount);
      const chunkTimes = [];
      for (let c = 0; c < chunkCount; c++) {
        const start = c * chunkSize;
        const end = Math.min(start + chunkSize, ws.sourceFiles.length);
        const t = performance.now();
        for (let i = start; i < end; i++) {
          const rel = ws.sourceFiles[i].slice(srcDir.length + 1);
          scanSource(rel, contents[i]);
        }
        chunkTimes.push(performance.now() - t);
      }
      const maxChunkMs = Math.max(...chunkTimes);
      console.log('');
      console.log(
        `chunked-scan sanity check (${chunkCount} sequential chunks, NOT parallel): ` +
          `max chunk ${fmtMs(maxChunkMs)} vs single-pass scanSource total ${fmtMs(scanSourceMs)} ` +
          `(a real worker pool's wall time floor is roughly max-chunk, ignoring IPC/serialization overhead)`
      );
    }

    console.log('');
    console.log(
      `RESULT files=${FILE_COUNT} enumerateMs=${enumerateMs.toFixed(1)} readMs=${readMs.toFixed(1)} prefilterMs=${prefilterMs.toFixed(1)} parseApproxMs=${parseApproxMs.toFixed(1)} scanSourceMs=${scanSourceMs.toFixed(1)} manualTotalS=${(manualTotalMs / 1000).toFixed(2)} pipelineS=${(pipelineMs / 1000).toFixed(2)}`
    );
  } finally {
    if (KEEP) {
      console.log(`\n--keep set: scratch workspace left at ${srcDir}`);
    } else {
      rmSync(scratchRoot, { recursive: true, force: true });
    }
  }
}

main();
