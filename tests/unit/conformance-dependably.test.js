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
//
// Cases written in the shared symbolic vocabulary (spec §12) carry `"tool":
// "$any"` and are bound to npm-check's own section keys and rule ids before they
// run. A placeholder that cannot be bound fails the run rather than reaching the
// loader: an unbound `$tool` would become an unknown top-level section, which §3.5
// requires be ignored silently, so the case would pass while asserting nothing.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import {
  loadAuditConfig,
  normalizeRuleEntry,
  APPLICABLE_SELECTORS,
  DEFAULT_CONFIG,
  DEPRECATED_SECTION_KEY,
  KNOWN_RULES,
  KNOWN_SECTION_KEYS,
  SECTION_KEY
} from '../../src/audit-config.js';
import { applyExceptions } from '../../src/exceptions.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, '../../conformance/dependably/cases');

// --- vocabulary binding (spec §12) ---------------------------------------

// Rule ids whose DEFAULT severity is not `error`. The corpus pins `$rule1`/`$rule2`
// at `error`, so binding them to a rule that already defaults to `error` would let
// a case pass without the config being read at all. Deriving the pair from the real
// registry keeps that hazard closed on its own as the defaults change.
const NON_DEFAULT_ERROR_RULES = KNOWN_RULES.filter(
  (id) => normalizeRuleEntry(DEFAULT_CONFIG.rules[id]).severity !== 'error'
);

// npm-check's binding of the seven §12.2 placeholders. Whole-string replacement
// only: a placeholder is an entire object key or an entire string value, never a
// fragment, so `$rule1` can never match inside `$rule10`.
const BINDINGS = new Map([
  // §3.3 registry entries for npm-check.
  ['$tool', SECTION_KEY],
  ['$alias', DEPRECATED_SECTION_KEY],

  // Two distinct ids from npm-check's own rule registry.
  ['$rule1', NON_DEFAULT_ERROR_RULES[0]],
  ['$rule2', NON_DEFAULT_ERROR_RULES[1]],

  // codemetrics' rule — the one its own corpus cases configure — and in no
  // npm-check registry, so npm-check must ignore it in `common`.
  ['$foreignRule', 'cyclomatic'],

  // Deliberate nonsense: in no tool's registry, so it can only ever be UNKNOWN_RULE.
  ['$unknownRule', 'no-such-rule-in-any-registry'],

  // nucheck's own-section legacy key (spec §7.1). npm-check's vocabulary has no
  // such key, which is what makes it a sibling's key rather than a typo.
  ['$foreignKey', 'ignoreUnusedPackages']
]);

// The subtrees binding applies to (§12.2). `tool`, `name`, `startDir` and `today`
// are not bound.
const BOUND_SUBTREES = ['files', 'cli', 'findings', 'expect'];

// The §12.5 capability tokens, answered from npm-check's real vocabulary rather
// than from a hand-maintained list: adding a selector to APPLICABLE_SELECTORS
// flips the matching capability on by itself.
const CAPABILITIES = {
  alias: Boolean(DEPRECATED_SECTION_KEY),
  packageSelector: APPLICABLE_SELECTORS.includes('package'),
  pathSelector: APPLICABLE_SELECTORS.includes('path'),
  symbolSelector: APPLICABLE_SELECTORS.includes('symbol'),
  idSelector: APPLICABLE_SELECTORS.includes('id')
};

// The §12.5/§12.6 skip decision: null to replay, else the reason it cannot run here.
// An unrecognized capability token throws rather than being read as satisfied —
// treating one as satisfied is exactly how a case silently passes while asserting
// nothing about the behavior it names.
function skipReason(caseDef) {
  for (const capability of caseDef.requires || []) {
    if (!Object.hasOwn(CAPABILITIES, capability)) {
      throw new Error(
        `case "${caseDef.name}" requires capability "${capability}", which this adapter does not ` +
        'know how to answer. Teach CAPABILITIES about it — treating an unknown token as satisfied ' +
        'is how a skipped case silently passes (spec §12.5).'
      );
    }
    if (!CAPABILITIES[capability]) {
      return `requires capability "${capability}", which npm-check does not have`;
    }
  }
  if (Array.isArray(caseDef.appliesTo) && !caseDef.appliesTo.includes(SECTION_KEY)) {
    return `appliesTo [${caseDef.appliesTo.join(', ')}] does not name ${SECTION_KEY}`;
  }
  return null;
}

const bindString = (text) => (BINDINGS.has(text) ? BINDINGS.get(text) : text);

// Whole-string replacement over both object keys and string values (§12.2).
// Object.fromEntries is used rather than plain assignment so a `__proto__` key in
// a case could never reach the prototype setter.
function substitute(node) {
  if (Array.isArray(node)) return node.map(substitute);
  if (node !== null && typeof node === 'object') {
    return Object.fromEntries(
      Object.entries(node).map(([key, value]) => [bindString(key), substitute(value)])
    );
  }
  return typeof node === 'string' ? bindString(node) : node;
}

// §12.7: nothing `$`-prefixed may survive binding. `$schema` is a real configuration
// key, not a placeholder, and is deliberately left alone.
function assertFullyBound(caseName, subtree, node) {
  const reject = (text) => {
    if (typeof text === 'string' && text.startsWith('$') && text !== '$schema') {
      throw new Error(
        `case "${caseName}" still carries the unbound placeholder "${text}" in \`${subtree}\`. ` +
        'Bind it in BINDINGS — an unbound $tool becomes an unknown top-level section that §3.5 ' +
        'requires be ignored silently, so the case would pass while asserting nothing.'
      );
    }
  };

  if (Array.isArray(node)) {
    for (const item of node) assertFullyBound(caseName, subtree, item);
    return;
  }
  if (node !== null && typeof node === 'object') {
    for (const [key, value] of Object.entries(node)) {
      reject(key);
      assertFullyBound(caseName, subtree, value);
    }
    return;
  }
  reject(node);
}

// Bind a vocabulary-bound case to npm-check's names, then prove nothing was left
// unbound. A tool-specific case (§12.1) carries literal vocabulary and is not
// substituted, but is still checked — a placeholder in one would be a corpus defect.
function bind(caseDef) {
  const bindable = caseDef.tool === '$any';
  const bound = structuredClone(caseDef);
  for (const subtree of BOUND_SUBTREES) {
    if (bound[subtree] === undefined || bound[subtree] === null) continue;
    if (bindable) bound[subtree] = substitute(bound[subtree]);
    assertFullyBound(bound.name, subtree, bound[subtree]);
  }
  return bound;
}

// Cases npm-check cannot replay. Every entry is named and reasoned: silently
// filtering by filename prefix is how a corpus grows cases nobody runs.
// A waiver may only cover a case authored in another tool's vocabulary — the
// coverage tests below enforce that, so an npm-check case can never be waived.
const WAIVED = {
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
    '`path` with `symbol`, selectors npm-check rejects in its own section by design.'
};

// Cases npm-check genuinely fails. Each is a bug, not a waiver: the case is
// replayed and asserted to STILL FAIL, so fixing the bug trips this suite and
// forces the entry to be deleted. Never add one without a reason a reader can act on.
// Cases npm-check replays but does not yet satisfy. Empty is the goal: an entry here is a
// known bug with a test already written for it, and the suite fails once one starts passing
// so the entry cannot outlive the defect.
const KNOWN_DIVERGENCES = {};

const CASES = fs
  .readdirSync(CASES_DIR)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .map((file) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, file), 'utf8')));

const byName = new Map(CASES.map((c) => [c.name, c]));
// Evaluated at load time so an unanswerable capability token fails the whole file
// loudly rather than quietly widening the replayed set.
const SKIPPED = new Map(
  CASES.map((c) => [c.name, skipReason(c)]).filter(([, reason]) => reason !== null)
);
const isRegistered = (c) => c.name in WAIVED || c.name in KNOWN_DIVERGENCES;
const REPLAYED = CASES.filter((c) => !isRegistered(c) && !SKIPPED.has(c.name));
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
// case can pin one axis without over-constraining the others. Binding happens
// first, so nothing symbolic can reach materialize().
function replay(rawCase) {
  const caseDef = bind(rawCase);
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
  (DIVERGENT.length ? it.each(DIVERGENT.map((c) => [c.name, c])) : it.skip.each([[null, null]]))('%s still fails', (name, caseDef) => {
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
      ...SKIPPED.keys(),
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

  // Every skip is reported by name and by the capability that forced it (§12.5):
  // a silently skipped case is the failure that field exists to prevent. A skip
  // naming a capability npm-check actually has is an adapter bug, not a skip.
  it('reports every capability skip', () => {
    for (const [name, reason] of SKIPPED) {
      console.log(`skipped: ${name} — ${reason}`);
      const satisfied = (byName.get(name).requires || []).filter((r) => CAPABILITIES[r]);
      expect(satisfied).toEqual([]);
    }
    expect(SKIPPED.size).toBe(CASES.filter((c) => skipReason(c) !== null).length);
  });

  it.each(Object.entries(WAIVED))('waives %s for a stated reason', (name, reason) => {
    expect(byName.get(name)).toBeDefined();
    expect(reason.length).toBeGreaterThan(20);
    // §12.1: a vocabulary-bound case is replayable by every tool, so it can never
    // be waived — it binds to npm-check's own words and runs as npm-check.
    expect(byName.get(name).tool).not.toBe('$any');
  });

  const DIV_ENTRIES = Object.entries(KNOWN_DIVERGENCES);
  (DIV_ENTRIES.length ? it.each(DIV_ENTRIES) : it.skip.each([[null, null]]))('records %s as a divergence for a stated reason', (name, reason) => {
    expect(byName.get(name)).toBeDefined();
    expect(reason.length).toBeGreaterThan(20);
  });
});

describe('.dependably conformance corpus — vocabulary binding', () => {
  // Binding must leave no placeholder behind in ANY vendored case — waived and
  // divergent ones included, because a corpus that grows an eighth placeholder has
  // to fail loudly here rather than reach a loader that would ignore it (§12.7).
  it.each(CASES.map((c) => [c.name, c]))('binds every placeholder in %s', (name, caseDef) => {
    expect(() => bind(caseDef)).not.toThrow();
  });

  it('binds every placeholder the corpus actually uses', () => {
    const used = new Set();
    const walk = (node) => {
      if (Array.isArray(node)) { node.forEach(walk); return; }
      if (node !== null && typeof node === 'object') {
        for (const [key, value] of Object.entries(node)) {
          if (key.startsWith('$') && key !== '$schema') used.add(key);
          walk(value);
        }
        return;
      }
      if (typeof node === 'string' && node.startsWith('$') && node !== '$schema') used.add(node);
    };
    for (const caseDef of CASES) {
      if (caseDef.tool !== '$any') continue;
      for (const subtree of BOUND_SUBTREES) walk(caseDef[subtree]);
    }
    expect([...used].filter((p) => !BINDINGS.has(p))).toEqual([]);
  });

  it('substitutes whole strings only, never fragments', () => {
    expect(substitute('$rule1')).toBe(BINDINGS.get('$rule1'));
    expect(substitute('prefix-$rule1')).toBe('prefix-$rule1');
    expect(substitute('$rule10')).toBe('$rule10');
    expect(substitute({ '$tool': { '$rule1': '$rule2' } }))
      .toEqual({ [SECTION_KEY]: { [BINDINGS.get('$rule1')]: BINDINGS.get('$rule2') } });
    expect(substitute(['$alias', 1, null, true])).toEqual([DEPRECATED_SECTION_KEY, 1, null, true]);
  });

  it('refuses to replay a case carrying an unbound placeholder', () => {
    expect(() => bind({ name: 'synthetic', tool: '$any', files: { '.dependably': { '$nope': {} } } }))
      .toThrow(/unbound placeholder "\$nope"/);
    expect(() => bind({ name: 'synthetic', tool: SECTION_KEY, files: { '.dependably': { '$tool': {} } } }))
      .toThrow(/unbound placeholder "\$tool"/);
  });

  it('leaves $schema alone — it is a configuration key, not a placeholder', () => {
    const bound = bind({ name: 'synthetic', tool: '$any', files: { '.dependably': { $schema: 'https://x/y.json' } } });
    expect(bound.files['.dependably'].$schema).toBe('https://x/y.json');
  });

  it('throws on a capability token it cannot answer', () => {
    expect(() => skipReason({ name: 'synthetic', requires: ['telepathy'] }))
      .toThrow(/does not know how to answer/);
  });

  it('binds the spec vocabulary to npm-check\'s real names', () => {
    expect(BINDINGS.get('$tool')).toBe(SECTION_KEY);
    expect(BINDINGS.get('$alias')).toBe(DEPRECATED_SECTION_KEY);
    expect(BINDINGS.get('$tool')).not.toBe(BINDINGS.get('$alias'));

    // $rule1/$rule2 are distinct real ids, and neither already defaults to `error`
    // — otherwise a case pinning `error` would pass without the config being read.
    expect(BINDINGS.get('$rule1')).not.toBe(BINDINGS.get('$rule2'));
    for (const key of ['$rule1', '$rule2']) {
      expect(KNOWN_RULES).toContain(BINDINGS.get(key));
      expect(normalizeRuleEntry(DEFAULT_CONFIG.rules[BINDINGS.get(key)]).severity).not.toBe('error');
    }

    // A foreign rule and an unknown rule are both outside npm-check's registry;
    // the difference is that the foreign one is real somewhere else.
    expect(KNOWN_RULES).not.toContain(BINDINGS.get('$foreignRule'));
    expect(KNOWN_RULES).not.toContain(BINDINGS.get('$unknownRule'));

    // §7.1: $foreignKey is a sibling tool's own-section key, not one of npm-check's.
    expect([...KNOWN_SECTION_KEYS]).not.toContain(BINDINGS.get('$foreignKey'));
  });

  it('answers every capability the corpus can ask about', () => {
    expect(CAPABILITIES).toEqual({
      alias: true,
      packageSelector: true,
      pathSelector: false,
      symbolSelector: false,
      idSelector: true
    });
  });

  // npm-check HAS a §3.3 alias section key, so the alias cases must run rather
  // than skip. A tool without one skips them and says so.
  it('replays the alias cases because npm-check has an alias', () => {
    expect(CAPABILITIES.alias).toBe(true);
    const replayed = REPLAYED.map((c) => c.name);
    expect(replayed).toContain('sections-alias-read');
    expect(replayed).toContain('sections-canonical-beats-alias');
  });
});
