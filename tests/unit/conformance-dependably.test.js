// tests/unit/conformance-dependably.test.js
//
// Replays the vendored cross-language conformance corpus
// (conformance/dependably/cases/*.json) through npm-check's REAL config entry
// point, loadAuditConfig(cwd, explicitPath). The corpus is the contract six
// tools share; npm-check authored most of it, so a case that fails here is a
// drift report against the reference implementation itself.
//
// Deliberately driven through the loader rather than through the primitives it
// calls: a suite that reaches past loadAuditConfig into parseExceptions and
// mergeConfig would still pass with a broken loader, which is the failure mode
// this suite exists to catch.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  loadAuditConfig,
  normalizeRuleEntry,
  DEFAULT_CONFIG,
  SECTION_KEY
} from '../../src/audit-config.js';
import { applyExceptions } from '../../src/exceptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, '../../conformance/dependably/cases');

// Cases npm-check cannot replay. Every entry is named and reasoned: silently
// filtering by filename prefix is how a corpus grows cases nobody runs.
// A waiver may only cover a case authored in another tool's vocabulary — the
// coverage tests below enforce that, so an npm-check case can never be waived.
const WAIVED = {
  'discovery-explicit-config':
    'codemetrics case: the explicit file carries only a `codemetrics` section, so the ' +
    'sole assertion (resolved.rules.cyclomatic) is a rule id npm-check does not define.',
  'exceptions-common-and-tool-union':
    'cslint case: the tool half of the union lives in the `cslint` section, which ' +
    'npm-check never reads, and the common half selects on `path`, which npm-check findings never carry.',
  'exceptions-id-advisory':
    'nucheck case: the exception lives in the `nucheck` section and names the ' +
    '`vulnerable-package` rule, neither of which npm-check resolves.',
  'exceptions-package-version-pin':
    'nucheck case: the exception lives in the `nucheck` section, and npm-check findings ' +
    'carry no version, so an @version pin has nothing to pin against.',
  'exceptions-path-and-symbol-and':
    'codemetrics case: the exception lives in the `codemetrics` section and ANDs ' +
    '`path` with `symbol`, selectors npm-check rejects in its own section by design.',
  'merge-scalar-failon-override':
    'cslint case: the overriding half of the failOn merge lives in the `cslint` section, ' +
    'so replaying it under npm-check would only exercise `common` and could not observe the override.'
};

// Cases npm-check genuinely fails. Each is a bug, not a waiver: the case is
// replayed and asserted to STILL FAIL, so fixing the bug trips this suite and
// forces the entry to be deleted. Never add one without a reason a reader can act on.
const KNOWN_DIVERGENCES = {
  'validation-unknown-rule-in-common-ignored':
    'npm-check throws UNKNOWN_RULE for a sibling tool\'s rule id in `common`. The spec ' +
    'makes an unknown rule id legal there (it belongs to another tool) and an error only ' +
    'in the tool\'s own section, which is how npm-check already treats unknown rule ids in ' +
    '`exceptions` — the `rules` map is the inconsistent path: common.rules is merged into ' +
    'the tool rule map before mergeConfig validates rule ids.'
};

const CASES = fs
  .readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), 'utf8')));

const byName = new Map(CASES.map((c) => [c.name, c]));
const isRegistered = (c) => c.name in WAIVED || c.name in KNOWN_DIVERGENCES;
const REPLAYED = CASES.filter((c) => !isRegistered(c));
const DIVERGENT = CASES.filter((c) => c.name in KNOWN_DIVERGENCES);

// npm-check does not surface the shared registry allowlist as a list: the loader
// layers it onto the host-based rules. Project it back out of `secure-resolved`
// by dropping that rule's built-in defaults, which preserves the merged order.
const DEFAULT_SECURE_HOSTS = normalizeRuleEntry(DEFAULT_CONFIG.rules['secure-resolved']).options.allowedHosts;

let tmpDir;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-conformance-')); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

// Write a case's `files` into the temp repo, with a `.git` marker so discovery
// stops at the boundary instead of walking out into the real filesystem.
function materialize(files) {
  fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });
  for (const [rel, content] of Object.entries(files || {})) {
    const target = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  }
}

// Load the case's config the way the CLI does: discovery from `startDir`, or an
// explicit --config path when the case supplies one.
function load(caseDef) {
  const startDir = caseDef.startDir ? path.join(tmpDir, caseDef.startDir) : tmpDir;
  if (caseDef.startDir) fs.mkdirSync(startDir, { recursive: true });
  const explicit = caseDef.cli && caseDef.cli.config ? path.join(tmpDir, caseDef.cli.config) : null;
  try {
    return { config: loadAuditConfig(startDir, explicit), error: null };
  } catch (error) {
    return { config: null, error };
  }
}

// Feed the case's synthetic findings to the exception matcher, using the
// exceptions the loader resolved and the case's fixed clock.
function match(caseDef, config) {
  if (!Array.isArray(caseDef.findings)) return null;
  const findings = caseDef.findings.map((f) => ({ ...f }));
  const result = applyExceptions(findings, config.exceptions, { today: caseDef.today });
  const kept = new Set(result.kept);
  return {
    ...result,
    suppressedIndexes: findings.map((f, i) => (kept.has(f) ? -1 : i)).filter((i) => i >= 0),
    unusedIndexes: result.unused.map((ex) => config.exceptions.indexOf(ex)),
    expiredIndexes: result.expired.map((ex) => config.exceptions.indexOf(ex))
  };
}

// The corpus's `gated` axis asks whether the run would fail after suppression.
// npm-check's own gate (runAudit) only ever sees findings derived from a real
// lockfile, so a synthetic corpus finding cannot flow through it. Reconstruct
// the same decision from the config the loader produced: an error-severity
// survivor gates, warnings gate once they exceed maxWarnings, and failOn's
// lowest rung (`warning`) gates on any surviving warning.
function isGated(kept, config) {
  const severities = kept
    .map((f) => (config.rules[f.rule] ? config.rules[f.rule].severity : 'error'))
    .filter((s) => s !== 'off');
  const errors = severities.filter((s) => s === 'error').length;
  const warnings = severities.filter((s) => s === 'warn').length;
  if (errors > 0) return true;
  if (config.maxWarnings >= 0 && warnings > config.maxWarnings) return true;
  return config.failOnSeverity === 'warning' && warnings > 0;
}

function warningCodes(config, run) {
  const codes = (config.warnings || []).map((w) => w.code);
  if (run) {
    codes.push(...run.unused.map(() => 'UNUSED_EXCEPTION'));
    codes.push(...run.expired.map(() => 'EXPIRED_EXCEPTION'));
  }
  return [...new Set(codes)].sort();
}

function assertResolved(expected, config) {
  if (expected.rules !== undefined) {
    for (const [ruleId, entry] of Object.entries(expected.rules)) {
      const want = normalizeRuleEntry(entry);
      const got = config.rules[ruleId];
      expect(got).toBeDefined();
      expect(got.severity).toBe(want.severity);
      for (const [key, value] of Object.entries(want.options)) {
        expect(got.options[key]).toEqual(value);
      }
    }
  }
  if (expected.exclude !== undefined) {
    expect(config.exclude).toEqual(expected.exclude);
  }
  if (expected.allowedRegistryHosts !== undefined) {
    const hosts = config.rules['secure-resolved'].options.allowedHosts
      .filter((h) => !DEFAULT_SECURE_HOSTS.includes(h));
    expect(hosts).toEqual(expected.allowedRegistryHosts);
    // The allowlist has to reach BOTH host rules or a private-registry project
    // silences one and still trips the other.
    for (const host of expected.allowedRegistryHosts) {
      expect(config.rules['no-remote-deps'].options.allowedHosts).toContain(host);
    }
  }
  if (expected.failOn !== undefined) {
    if (expected.failOn.severity !== undefined) expect(config.failOnSeverity).toBe(expected.failOn.severity);
    if (expected.failOn.count !== undefined) expect(config.maxWarnings).toBe(expected.failOn.count);
  }
}

// Assert every key a case actually declares. An absent key is NOT asserted, so a
// case can pin one axis without over-constraining the others.
function replay(caseDef) {
  materialize(caseDef.files);
  const expected = caseDef.expect || {};
  const { config, error } = load(caseDef);

  if (typeof expected.error === 'string') {
    expect(error).toBeTruthy();
    expect(error.code).toBe(expected.error);
    return;
  }
  if (error) throw error; // an unexpected throw is the case failing, reported as itself
  expect(config).toBeTruthy();

  if (expected.selectedFile !== undefined) {
    expect(config.sharedConfigPath).toBeTruthy();
    expect(path.relative(tmpDir, config.sharedConfigPath)).toBe(expected.selectedFile);
  }

  const run = match(caseDef, config);

  if (expected.warnings !== undefined) {
    expect(warningCodes(config, run)).toEqual([...new Set(expected.warnings)].sort());
  }
  if (expected.resolved !== undefined) assertResolved(expected.resolved, config);

  if (expected.suppressedFindings !== undefined) {
    expect(run).toBeTruthy();
    expect(run.suppressedIndexes).toEqual(expected.suppressedFindings);
  }
  if (expected.unusedExceptions !== undefined) {
    expect(run).toBeTruthy();
    expect(run.unusedIndexes.sort()).toEqual([...expected.unusedExceptions].sort());
  }
  if (expected.expiredExceptions !== undefined) {
    expect(run).toBeTruthy();
    expect(run.expiredIndexes.sort()).toEqual([...expected.expiredExceptions].sort());
  }
  if (expected.gated !== undefined) {
    expect(run).toBeTruthy();
    expect(isGated(run.kept, config)).toBe(expected.gated);
  }
}

describe('.dependably conformance corpus', () => {
  it.each(REPLAYED.map((c) => [c.name, c]))('%s', (name, caseDef) => {
    replay(caseDef);
  });
});

describe('.dependably conformance corpus — known divergences', () => {
  it.each(DIVERGENT.map((c) => [c.name, c]))('%s still fails', (name, caseDef) => {
    let conforms = true;
    try {
      replay(caseDef);
    } catch {
      conforms = false;
    }
    if (conforms) {
      throw new Error(
        `${name} now conforms — delete its KNOWN_DIVERGENCES entry so the case is replayed for real.`
      );
    }
  });
});

describe('.dependably conformance corpus — coverage', () => {
  it('accounts for every vendored case', () => {
    const accounted = new Set([
      ...REPLAYED.map((c) => c.name),
      ...Object.keys(WAIVED),
      ...Object.keys(KNOWN_DIVERGENCES)
    ]);
    expect(CASES.filter((c) => !accounted.has(c.name)).map((c) => c.name)).toEqual([]);
  });

  it('replays every case authored in npm-check\'s own vocabulary', () => {
    const skipped = CASES
      .filter((c) => c.tool === SECTION_KEY && c.name in WAIVED)
      .map((c) => c.name);
    expect(skipped).toEqual([]);
  });

  it.each(Object.entries(WAIVED))('waives %s for a stated reason', (name, reason) => {
    expect(byName.get(name)).toBeDefined();
    expect(reason.length).toBeGreaterThan(20);
  });

  it.each(Object.entries(KNOWN_DIVERGENCES))('records %s as a divergence for a stated reason', (name, reason) => {
    expect(byName.get(name)).toBeDefined();
    expect(reason.length).toBeGreaterThan(20);
  });
});
