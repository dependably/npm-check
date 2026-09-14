// tests/unit/facts-sourcescan.test.js
// The shared source-scan policy `discoverWorkspace` uses instead of guessing
// "generated output" from a directory name (sbom-reach GitLab #31; ported
// with sbom-reach commit 95f2b94).
//
// Every expectation about ignoring below was checked against real `git
// status` on the same tree shape before it was written -- the point of
// deferring to `.gitignore` is that the tool agrees with git about what the
// project considers generated, so an approximation that quietly differs
// would put the false negative back.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isGitignored, loadGitignores, outputDirScannedDiagnostic } from '../../src/facts/sourcescan.js';

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files) {
  const root = mkdtempSync(join(tmpdir(), 'npm-check-sourcescan-'));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
  return root;
}

const NO_DIRS = ['**/node_modules/**'];

describe('isGitignored', () => {
  test('has no opinion when the tree has no .gitignore at all', () => {
    const root = tree({ 'build/pipeline.js': '' });
    expect(isGitignored(loadGitignores(root, NO_DIRS), 'build/pipeline.js')).toBe(false);
  });

  test('applies a root rule at any depth, as git does', () => {
    const root = tree({ '.gitignore': 'dist/\n', 'a.js': '' });
    const layers = loadGitignores(root, NO_DIRS);
    expect(isGitignored(layers, 'dist/bundle.js')).toBe(true);
    expect(isGitignored(layers, 'packages/lib/dist/bundle.js')).toBe(true);
    expect(isGitignored(layers, 'src/dist.js')).toBe(false);
  });

  test('reads a nested .gitignore the root says nothing about', () => {
    const root = tree({ '.gitignore': 'node_modules/\n', 'packages/lib/.gitignore': 'dist/\n' });
    const layers = loadGitignores(root, NO_DIRS);
    expect(isGitignored(layers, 'packages/lib/dist/bundle.js')).toBe(true);
    expect(isGitignored(layers, 'packages/app/dist/bundle.js')).toBe(false);
  });

  test('lets a nearer .gitignore re-include a directory an outer one ignored', () => {
    const root = tree({ '.gitignore': 'build/\n', 'tools/.gitignore': '!build/\n' });
    const layers = loadGitignores(root, NO_DIRS);
    expect(isGitignored(layers, 'build/generated.js')).toBe(true);
    expect(isGitignored(layers, 'tools/build/pipeline.js')).toBe(false);
  });

  test('does not re-include from INSIDE an ignored directory -- git never descends', () => {
    const root = tree({ '.gitignore': 'dist/\n', 'dist/.gitignore': '!keep.js\n' });
    const layers = loadGitignores(root, NO_DIRS);
    expect(isGitignored(layers, 'dist/keep.js')).toBe(true);
    expect(isGitignored(layers, 'dist/drop.js')).toBe(true);
  });

  test('anchors a leading-slash rule to its own .gitignore directory', () => {
    const root = tree({ '.gitignore': '/out/\n' });
    const layers = loadGitignores(root, NO_DIRS);
    expect(isGitignored(layers, 'out/a.js')).toBe(true);
    expect(isGitignored(layers, 'packages/lib/out/a.js')).toBe(false);
  });

  test("never reads a dependency's own .gitignore", () => {
    const root = tree({ 'node_modules/pkg/.gitignore': 'src/\n', 'src/index.js': '' });
    expect(loadGitignores(root, NO_DIRS)).toEqual([]);
  });
});

describe('outputDirScannedDiagnostic', () => {
  test('names every output-shaped directory that was scanned, sorted and deduped', () => {
    const diag = outputDirScannedDiagnostic(['dist/a.js', 'dist/b.js', 'build/c.js', 'src/d.js', 'packages/lib/out/e.js']);
    expect(diag).toMatch(/^OUTPUT_DIR_SCANNED: scanned source under build\/, dist\/, out\//);
  });

  test('ignores a FILE whose name matches -- only directories count', () => {
    expect(outputDirScannedDiagnostic(['src/build', 'src/dist'])).toBeUndefined();
  });

  test('is undefined for an ordinary tree', () => {
    expect(outputDirScannedDiagnostic(['src/index.ts', 'test/index.test.ts'])).toBeUndefined();
  });

  test('honours a narrowed name list (a consumer can pass its own set)', () => {
    expect(outputDirScannedDiagnostic(['vendor/a.py'], ['build', 'dist'])).toBeUndefined();
    expect(outputDirScannedDiagnostic(['build/a.py'], ['build', 'dist'])).toContain('build/');
  });
});
