// src/exceptions.js
//
// Reference implementation of the `.dependably` exception grammar, specified in
// §6 of the config spec at
// https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec. This is the module
// the C# and Python ports mirror; keep it behavior-compatible with the vendored
// conformance fixtures under conformance/dependably/.
//
// An exception suppresses SPECIFIC findings so a run does not fail on them,
// without excluding whole files (`exclude`) or disabling a rule globally
// (`rules: {id: "off"}`). Each entry is:
//
//   { rule, package?, path?, symbol?, id?, reason, expires? }
//
// `rule` + `reason` are mandatory; at least one selector is required; all
// selectors present on an entry must match a finding (AND within an entry,
// OR across entries). Suppressed findings are still counted and reported.

export class ExceptionConfigError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'ExceptionConfigError';
    this.code = code;
    this.context = context;
  }
}

// The four finding selectors, in a stable order for messages.
export const SELECTORS = ['package', 'path', 'symbol', 'id'];

const EXPIRES_RE = /^\d{4}-\d{2}-\d{2}$/;

// --- glob (portable subset: ** any depth, * within a segment, ? one char) ---

function globToRegExp(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') {
        // `**/` — zero or more leading path segments.
        re += '(?:.*/)?';
        i += 3;
      } else if (re.endsWith('/')) {
        // `foo/**` at the end — match `foo` and `foo/anything`.
        re = `${re.slice(0, -1)}(?:/.*)?`;
        i += 2;
      } else {
        // bare `**` — any number of characters including separators.
        re += '.*';
        i += 2;
      }
    } else if (c === '*') {
      // `*` — anything except a path separator.
      re += '[^/]*';
      i++;
    } else if (c === '?') {
      re += '[^/]';
      i++;
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      i++;
    }
  }
  return new RegExp(`^${re}$`);
}

/** Match a POSIX-style path against a portable glob (`**`, `*`, `?`). */
export function matchGlob(glob, value) {
  if (typeof value !== 'string') return false;
  return globToRegExp(glob).test(value.replace(/\\/g, '/'));
}

// --- parsing / validation ---

function ensureArray(raw, context) {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    throw new ExceptionConfigError(
      'exceptions must be an array',
      'INVALID_EXCEPTIONS',
      context
    );
  }
  return raw;
}

// Split a `package` selector into { name, version } (version optional, from an
// `@<version>` suffix). Scoped names keep their leading `@`.
function splitPackageSelector(pkg) {
  const at = pkg.lastIndexOf('@');
  if (at > 0) {
    return { name: pkg.slice(0, at).toLowerCase(), version: pkg.slice(at + 1) };
  }
  return { name: pkg.toLowerCase(), version: null };
}

/**
 * Parse and validate a raw `exceptions` array into normalized entries.
 *
 * @param {*} raw - the raw `exceptions` value from a config section
 * @param {object} opts
 * @param {'own'|'common'} [opts.source] - `own` enforces selector applicability
 *        (§6.7); `common` tolerates selectors this tool never emits.
 * @param {string[]} [opts.applicableSelectors] - selectors this tool's findings
 *        can carry (e.g. npm-check: ['package','id']). Required for `own`.
 * @param {string[]} [opts.knownRules] - if given, an unknown `rule` in an `own`
 *        entry throws UNKNOWN_RULE (spec §8); in `common` it is tolerated.
 * @param {string} [opts.configPath]
 * @returns {Array<{rule, reason, expires, source, selectors, _raw}>}
 */
export function parseExceptions(raw, opts = {}) {
  const { source = 'own', applicableSelectors = SELECTORS, knownRules = null, configPath = null } = opts;
  const entries = ensureArray(raw, { configPath });
  const out = [];

  entries.forEach((entry, index) => {
    const at = { configPath, source, index };
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ExceptionConfigError(`exception #${index} must be an object`, 'INVALID_EXCEPTIONS', at);
    }
    if (typeof entry.rule !== 'string' || entry.rule.trim() === '') {
      throw new ExceptionConfigError(`exception #${index} is missing "rule"`, 'EXCEPTION_MISSING_RULE', at);
    }
    if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
      throw new ExceptionConfigError(
        `exception for rule "${entry.rule}" is missing a non-empty "reason"`,
        'EXCEPTION_MISSING_REASON',
        at
      );
    }

    const present = SELECTORS.filter((s) => entry[s] !== undefined);
    if (present.length === 0) {
      throw new ExceptionConfigError(
        `exception for rule "${entry.rule}" needs at least one selector (${SELECTORS.join(', ')})`,
        'EXCEPTION_NO_SELECTOR',
        at
      );
    }
    for (const sel of present) {
      if (typeof entry[sel] !== 'string' || entry[sel].trim() === '') {
        throw new ExceptionConfigError(
          `exception selector "${sel}" for rule "${entry.rule}" must be a non-empty string`,
          'EXCEPTION_BAD_SELECTOR',
          at
        );
      }
      // A selector this tool's findings never carry is an error in the tool's
      // OWN section but is tolerated in `common` (it simply never matches).
      if (source === 'own' && !applicableSelectors.includes(sel)) {
        throw new ExceptionConfigError(
          `exception selector "${sel}" is not applicable to this tool (applicable: ${applicableSelectors.join(', ')})`,
          'EXCEPTION_BAD_SELECTOR',
          at
        );
      }
    }

    if (entry.expires !== undefined) {
      if (typeof entry.expires !== 'string' || !EXPIRES_RE.test(entry.expires) || Number.isNaN(Date.parse(entry.expires))) {
        throw new ExceptionConfigError(
          `exception "expires" for rule "${entry.rule}" must be a valid YYYY-MM-DD date`,
          'EXCEPTION_BAD_EXPIRES',
          at
        );
      }
    }

    if (source === 'own' && knownRules && !knownRules.includes(entry.rule)) {
      throw new ExceptionConfigError(
        `Unknown rule "${entry.rule}" in exception (known rules: ${knownRules.join(', ')})`,
        'UNKNOWN_RULE',
        at
      );
    }

    const selectors = { rule: entry.rule };
    if (entry.package !== undefined) selectors.package = splitPackageSelector(entry.package);
    if (entry.path !== undefined) selectors.path = entry.path;
    if (entry.symbol !== undefined) selectors.symbol = entry.symbol;
    if (entry.id !== undefined) selectors.id = entry.id;

    out.push({
      rule: entry.rule,
      reason: entry.reason,
      expires: entry.expires || null,
      source,
      selectors,
      _raw: entry
    });
  });

  return out;
}

// --- matching ---

function toDate(today) {
  if (today instanceof Date) return today;
  if (typeof today === 'string') return new Date(`${today}T00:00:00Z`);
  return new Date();
}

/** True when an exception's `expires` date is strictly before `today`. */
export function isExpired(exception, today = new Date()) {
  if (!exception.expires) return false;
  const exp = new Date(`${exception.expires}T00:00:00Z`);
  return toDate(today).getTime() > exp.getTime();
}

function matchPackage(sel, finding) {
  const name = (finding.package || '').toLowerCase();
  if (name !== sel.name) return false;
  if (sel.version === null) return true;
  return finding.version !== undefined && finding.version !== null && String(finding.version) === sel.version;
}

function matchSymbol(selSymbol, findingSymbol) {
  if (typeof findingSymbol !== 'string') return false;
  // `Type` matches `Type` and any `Type.Member`; `Type.Member` matches exactly.
  return findingSymbol === selSymbol || findingSymbol.startsWith(`${selSymbol}.`);
}

/**
 * True when every selector on `exception` matches `finding` (AND). Expiry is
 * NOT consulted here — callers skip expired entries via isExpired().
 *
 * A finding is `{ rule|ruleId, package?, version?, path?, symbol?, id? }`.
 */
export function matchException(exception, finding) {
  const s = exception.selectors;
  const findingRule = finding.rule !== undefined ? finding.rule : finding.ruleId;
  if (s.rule !== findingRule) return false;
  if (s.package !== undefined && !matchPackage(s.package, finding)) return false;
  if (s.path !== undefined && !matchGlob(s.path, finding.path)) return false;
  if (s.symbol !== undefined && !matchSymbol(s.symbol, finding.symbol)) return false;
  if (s.id !== undefined && s.id !== finding.id) return false;
  return true;
}

/**
 * Partition findings by the exceptions, returning suppression bookkeeping.
 *
 * @param {Array} findings - normalized findings (see matchException)
 * @param {Array} exceptions - parsed exceptions (from parseExceptions)
 * @param {object} [opts]
 * @param {Date|string} [opts.today] - clock for expiry (tests pass a fixed date)
 * @returns {{
 *   kept: Array,          // findings that still gate
 *   suppressed: Array,    // findings matched by a live exception (each carries `suppressed:true` + `suppressedBy`)
 *   unused: Array,        // exceptions that matched no finding
 *   expired: Array        // exceptions past their `expires` date (never suppress)
 * }}
 */
export function applyExceptions(findings, exceptions, opts = {}) {
  const today = opts.today;
  const live = [];
  const expired = [];
  for (const ex of exceptions) {
    if (isExpired(ex, today)) expired.push(ex);
    else live.push(ex);
  }

  const used = new Set();
  const kept = [];
  const suppressed = [];

  for (const finding of findings) {
    const hit = live.find((ex) => matchException(ex, finding));
    if (hit) {
      used.add(hit);
      suppressed.push({ ...finding, suppressed: true, suppressedBy: hit.reason });
    } else {
      kept.push(finding);
    }
  }

  const unused = live.filter((ex) => !used.has(ex));
  return { kept, suppressed, unused, expired };
}
