// src/audit-config.js
import fs from 'fs';
import path from 'path';
import { parseExceptions } from './exceptions.js';

export class AuditConfigError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'AuditConfigError';
    this.code = code;
    this.context = context;
  }
}

export const CONFIG_FILENAMES = ['.npm-checkrc.json', 'npm-check.config.json'];

// Shared, cross-tool config file (JSON, no extension) discovered by walking up
// from the working directory. `.dependably` is canonical; `.dependably-check` is
// a deprecated alias kept for the migration window (config spec §7, at
// https://gitlab.northwardlabs.ca/moonlitlabs/dependably-spec).
export const SHARED_CONFIG_FILENAME = '.dependably';
export const DEPRECATED_SHARED_CONFIG_FILENAME = '.dependably-check';
// Checked in this order at each directory level (canonical wins).
export const SHARED_CONFIG_FILENAMES = [SHARED_CONFIG_FILENAME, DEPRECATED_SHARED_CONFIG_FILENAME];

// Canonical section key for npm-check, plus the deprecated ecosystem alias.
export const SECTION_KEY = 'npm-check';
export const DEPRECATED_SECTION_KEY = 'npm';

// Highest .dependably format version this build understands.
export const SUPPORTED_CONFIG_VERSION = 1;

// Exception selectors an npm-check finding can carry (spec §6.7). `path`/`symbol`
// are code-location selectors used by the C# tools; they are errors in npm-check's
// own section but tolerated (ignored) in `common`.
export const APPLICABLE_SELECTORS = ['package', 'id'];

// Keys npm-check recognizes inside its own section. An unrecognized key there warns;
// the same key in `common` is ignored, since it may belong to a sibling tool.
const KNOWN_SECTION_KEYS = new Set([
  'rules', 'exceptions', 'exclude', 'failOn',
  'allowedRegistryHosts', 'allowedLocalFeeds', 'maxWarnings'
]);

export const SEVERITIES = ['error', 'warn', 'off'];

export const DEFAULT_CONFIG = {
  maxWarnings: -1,
  rules: {
    'lockfile-version': ['error', { minVersion: 3 }],
    'valid-structure': 'error',
    'valid-package-json': 'error',
    'integrity-hygiene': ['error', { allowSha1: false }],
    'secure-resolved': ['error', {
      allowedHosts: ['registry.npmjs.org'],
      allowHttp: false,
      allowGit: true,
      allowFile: true
    }],
    'install-scripts': ['warn', { allow: [] }],
    'no-git-deps': 'warn',
    'no-remote-deps': ['warn', { allowedHosts: ['registry.npmjs.org', 'npm.pkg.github.com'] }],
    'pinned-versions': ['error', {
      sections: ['dependencies', 'devDependencies', 'optionalDependencies'],
      ignore: []
    }],
    'lockfile-sync': 'error',
    'no-orphan-packages': 'warn',
    'unused-dependencies': ['warn', { includeDev: false, ignore: [] }],
    'no-fund': 'warn',
    'valid-npmrc': ['warn', {}],
    // pnpm-only rules (no-op on npm lockfiles via flavor gating in runAudit).
    'valid-pnpm-workspace': 'error',
    'valid-pnpm-field': 'error'
  }
};

export const KNOWN_RULES = Object.keys(DEFAULT_CONFIG.rules);

/**
 * Normalize a config rule entry to { severity, options }.
 * Accepts 'error' | 'warn' | 'off' | [severity, options].
 */
export function normalizeRuleEntry(entry) {
  let severity;
  let options = {};

  if (typeof entry === 'string') {
    severity = entry;
  } else if (Array.isArray(entry) && entry.length >= 1) {
    severity = entry[0];
    if (entry.length > 1) {
      if (typeof entry[1] !== 'object' || entry[1] === null) {
        throw new AuditConfigError(
          `Rule options must be an object, got: ${JSON.stringify(entry[1])}`,
          'INVALID_RULE_OPTIONS'
        );
      }
      options = structuredClone(entry[1]);
    }
  } else {
    throw new AuditConfigError(
      `Invalid rule entry: ${JSON.stringify(entry)}`,
      'INVALID_RULE_ENTRY'
    );
  }

  if (!SEVERITIES.includes(severity)) {
    throw new AuditConfigError(
      `Invalid severity "${severity}" (expected: ${SEVERITIES.join(', ')})`,
      'INVALID_SEVERITY'
    );
  }

  return { severity, options };
}

/**
 * Walk up from `cwd` to the filesystem root looking for a shared config file.
 * At each level `.dependably` is preferred over the deprecated `.dependably-check`.
 * Stops at the first hit, at a directory containing a `.git` entry (the repo
 * root), or at the filesystem root.
 *
 * @param {string} cwd - Directory to start the search from
 * @returns {string|null} Absolute path to the shared config, or null when absent
 */
export function findSharedConfig(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    for (const name of SHARED_CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) return candidate;
    }

    // Stop at the repo root: a directory containing `.git`.
    if (fs.existsSync(path.join(dir, '.git'))) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

// Deprecation warnings for the selected shared-config file (§2.2/§2.3).
function filenameWarnings(sharedPath) {
  if (!sharedPath) return [];
  const dir = path.dirname(sharedPath);
  const base = path.basename(sharedPath);
  const warnings = [];
  if (base === DEPRECATED_SHARED_CONFIG_FILENAME) {
    if (fs.existsSync(path.join(dir, SHARED_CONFIG_FILENAME))) {
      // Both present but findSharedConfig preferred canonical — should not reach
      // here; keep the guard for direct callers.
      warnings.push({ code: 'BOTH_FILES_PRESENT', message: `both ${SHARED_CONFIG_FILENAME} and ${DEPRECATED_SHARED_CONFIG_FILENAME} found in ${dir}; using ${SHARED_CONFIG_FILENAME}` });
    } else {
      warnings.push({ code: 'DEPRECATED_FILENAME', message: `${DEPRECATED_SHARED_CONFIG_FILENAME} is deprecated; rename it to ${SHARED_CONFIG_FILENAME}` });
    }
  } else if (fs.existsSync(path.join(dir, DEPRECATED_SHARED_CONFIG_FILENAME))) {
    warnings.push({ code: 'BOTH_FILES_PRESENT', message: `both ${SHARED_CONFIG_FILENAME} and ${DEPRECATED_SHARED_CONFIG_FILENAME} found in ${dir}; using ${SHARED_CONFIG_FILENAME} (${DEPRECATED_SHARED_CONFIG_FILENAME} is ignored — delete it)` });
  }
  return warnings;
}

// Bare hostnames from a section's allowedRegistryHosts (lowercased, filtered).
function sectionHosts(section) {
  const hosts = section && section.allowedRegistryHosts;
  if (!Array.isArray(hosts)) return [];
  return hosts.filter((h) => typeof h === 'string').map((h) => h.trim().toLowerCase()).filter(Boolean);
}

// Union of `common` and the npm-check section's allowedRegistryHosts (deduped,
// case-insensitive, common first). The canonical section is preferred; the `npm`
// alias is read only when the canonical section is absent.
function collectSharedHosts(parsed) {
  const tool = parsed[SECTION_KEY] !== undefined ? parsed[SECTION_KEY] : parsed[DEPRECATED_SECTION_KEY];
  return [...new Set([...sectionHosts(parsed && parsed.common), ...sectionHosts(tool)])];
}

// Union two arrays (ordinal dedupe), tolerating non-arrays.
function unionList(a, b) {
  const out = [];
  const seen = new Set();
  for (const v of [...(Array.isArray(a) ? a : []), ...(Array.isArray(b) ? b : [])]) {
    if (!seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

// Merge the `rules` maps of two sections per rule-id: the tool entry for a given
// id replaces common's wholesale (no cross-section option deep-merge, §B.3).
function mergeRuleMaps(commonRules, toolRules) {
  if (!commonRules && !toolRules) return undefined;

  // A rule id in `common` that npm-check does not know belongs to a sibling tool, so it is
  // dropped rather than merged (§8). Without this it reached mergeConfig's registry check and
  // raised UNKNOWN_RULE, which made a shared config unusable the moment any sibling configured
  // one of its own rules. Ids from the tool's own section are passed through untouched, so an
  // unknown id there still errors — that one is a typo, not a sibling's.
  const fromCommon = {};
  if (commonRules && typeof commonRules === 'object') {
    for (const [ruleId, value] of Object.entries(commonRules)) {
      if (KNOWN_RULES.includes(ruleId)) fromCommon[ruleId] = value;
    }
  }

  return { ...fromCommon, ...(toolRules && typeof toolRules === 'object' ? toolRules : {}) };
}

// Warn about keys npm-check does not recognize inside its own section (§8). `common`
// is deliberately not checked: it is shared with the sibling tools, so a key npm-check
// does not know there belongs to one of them, not to a typo. This matches how unknown
// rule ids are already treated — tolerated in `common`, an error in the own section.
function unknownKeyWarnings(section, label, warnings) {
  if (!section || typeof section !== 'object') return;
  for (const key of Object.keys(section)) {
    if (!KNOWN_SECTION_KEYS.has(key)) {
      warnings.push({ code: 'UNKNOWN_KEY', message: `unknown key "${label}.${key}" in shared config — ignoring` });
    }
  }
}

/**
 * Resolve npm-check's settings from a parsed shared-config object: merge `common`
 * under the npm-check section per the single merge rule (§5). Returns the audit
 * settings plus parsed exceptions and any warnings.
 */
function resolveToolSection(parsed, warnings) {
  const common = parsed && parsed.common;
  const canonical = parsed && parsed[SECTION_KEY];
  const alias = parsed && parsed[DEPRECATED_SECTION_KEY];
  const tool = canonical !== undefined ? canonical : alias;
  if (canonical === undefined && alias !== undefined) {
    warnings.push({ code: 'DEPRECATED_ALIAS_SECTION', message: `section "${DEPRECATED_SECTION_KEY}" is deprecated; rename it to "${SECTION_KEY}"` });
  } else if (canonical !== undefined && alias !== undefined) {
    warnings.push({ code: 'DEPRECATED_ALIAS_SECTION', message: `both "${SECTION_KEY}" and "${DEPRECATED_SECTION_KEY}" sections present; using "${SECTION_KEY}"` });
  }

  unknownKeyWarnings(tool, SECTION_KEY, warnings);

  const settings = {};
  const rules = mergeRuleMaps(common && common.rules, tool && tool.rules);
  if (rules) settings.rules = rules;

  // Scalars: tool overrides common. failOn merges per key.
  const failOn = pickFailOn(common && common.failOn, tool && tool.failOn);
  if (failOn) settings.failOn = failOn;

  const pickMax = (s) => (s && s.maxWarnings !== undefined ? s.maxWarnings : undefined);
  const toolMax = pickMax(tool);
  const commonMax = pickMax(common);
  if (toolMax !== undefined) settings.maxWarnings = toolMax;
  else if (commonMax !== undefined) settings.maxWarnings = commonMax;

  settings.exclude = unionList(common && common.exclude, tool && tool.exclude);

  // Exceptions: common (tolerant) + own section (strict selector/rule checks).
  const commonEx = parseExceptions(common && common.exceptions, {
    source: 'common', applicableSelectors: APPLICABLE_SELECTORS
  });
  const ownEx = parseExceptions(tool && tool.exceptions, {
    source: 'own', applicableSelectors: APPLICABLE_SELECTORS, knownRules: KNOWN_RULES
  });
  settings.exceptions = [...commonEx, ...ownEx];

  return settings;
}

// Merge two failOn objects per key (tool wins). Returns undefined if neither set.
function pickFailOn(commonFailOn, toolFailOn) {
  const c = commonFailOn && typeof commonFailOn === 'object' ? commonFailOn : {};
  const t = toolFailOn && typeof toolFailOn === 'object' ? toolFailOn : {};
  const merged = { ...c, ...t };
  if (merged.severity === undefined && merged.count === undefined) return undefined;
  return merged;
}

// True when a parsed config is the shared (sectioned) shape rather than the
// legacy flat tool-config shape (top-level rules/maxWarnings).
function isSharedShape(configPath, parsed) {
  if (SHARED_CONFIG_FILENAMES.includes(path.basename(configPath))) return true;
  if (!parsed || typeof parsed !== 'object') return false;
  const hasToolKeys = 'rules' in parsed || 'maxWarnings' in parsed;
  const hasSharedSections = 'common' in parsed || SECTION_KEY in parsed || DEPRECATED_SECTION_KEY in parsed;
  return !hasToolKeys && hasSharedSections;
}

// Read + JSON-parse a tool-config file, raising CONFIG_READ / CONFIG_PARSE.
function readJsonConfig(configPath) {
  let raw;
  try {
    raw = fs.readFileSync(configPath, 'utf8');
  } catch (e) {
    throw new AuditConfigError(`Cannot read config file: ${e.message}`, 'CONFIG_READ', { configPath });
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new AuditConfigError(`Invalid JSON in ${configPath}: ${e.message}`, 'CONFIG_PARSE', { configPath });
  }
}

// Validate the top-level shape + version of a shared-config object (§3, §8).
function validateSharedShape(parsed, sharedPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AuditConfigError(`Shared config must be a JSON object: ${sharedPath}`, 'CONFIG_SHAPE', { sharedPath });
  }
  if (parsed.version !== undefined) {
    if (typeof parsed.version !== 'number' || !Number.isInteger(parsed.version) || parsed.version > SUPPORTED_CONFIG_VERSION) {
      throw new AuditConfigError(
        `Unsupported .dependably version ${JSON.stringify(parsed.version)} (this build supports up to ${SUPPORTED_CONFIG_VERSION})`,
        'CONFIG_VERSION',
        { sharedPath }
      );
    }
  }
}

/**
 * Read and parse the shared config file, returning npm-check's registry-host
 * allowlist, audit settings (`rules`/`maxWarnings`/`failOn`/`exclude`),
 * parsed exceptions, and any deprecation/unknown-key warnings.
 *
 * @param {string} cwd - Directory to start discovery from
 * @returns {{ allowedRegistryHosts, sharedPath, auditSettings, exceptions, exclude, failOn, warnings }}
 */
export function loadSharedConfig(cwd = process.cwd()) {
  const sharedPath = findSharedConfig(cwd);
  if (!sharedPath) {
    return { allowedRegistryHosts: [], sharedPath: null, auditSettings: {}, exceptions: [], exclude: [], failOn: null, warnings: [] };
  }

  let raw;
  try {
    raw = fs.readFileSync(sharedPath, 'utf8');
  } catch (e) {
    throw new AuditConfigError(`Cannot read shared config file: ${e.message}`, 'SHARED_CONFIG_READ', { sharedPath });
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new AuditConfigError(`Invalid JSON in ${sharedPath}: ${e.message}`, 'SHARED_CONFIG_PARSE', { sharedPath });
  }

  validateSharedShape(parsed, sharedPath);
  const warnings = filenameWarnings(sharedPath);
  const settings = resolveToolSection(parsed, warnings);

  return {
    allowedRegistryHosts: collectSharedHosts(parsed),
    sharedPath,
    auditSettings: { ...(settings.rules ? { rules: settings.rules } : {}), ...(settings.maxWarnings !== undefined ? { maxWarnings: settings.maxWarnings } : {}) },
    exceptions: settings.exceptions,
    exclude: settings.exclude,
    failOn: settings.failOn || null,
    warnings
  };
}

export function loadAuditConfig(cwd = process.cwd(), explicitPath = null) {
  // The shared `.dependably` (discovered by walking up to the repo root) is the
  // PRIMARY config source. A tool-specific `.npm-checkrc.json` (or an explicit
  // `--config`) overrides it.
  const shared = loadSharedConfig(cwd);

  let toolConfig = {};
  let configPath = null;
  let explicitSharedHosts = [];
  let explicitExtras = null; // { exceptions, exclude, failOn } from an explicit shared-shape file

  if (explicitPath) {
    configPath = path.resolve(explicitPath);
    if (!fs.existsSync(configPath)) {
      throw new AuditConfigError(`Config file not found: ${configPath}`, 'CONFIG_NOT_FOUND');
    }
    const parsed = readJsonConfig(configPath);
    if (isSharedShape(configPath, parsed)) {
      validateSharedShape(parsed, configPath);
      const warnings = [];
      const settings = resolveToolSection(parsed, warnings);
      shared.warnings.push(...warnings);
      toolConfig = { ...(settings.rules ? { rules: settings.rules } : {}), ...(settings.maxWarnings !== undefined ? { maxWarnings: settings.maxWarnings } : {}) };
      explicitSharedHosts = collectSharedHosts(parsed);
      explicitExtras = { exceptions: settings.exceptions, exclude: settings.exclude, failOn: settings.failOn || null };
    } else {
      // Legacy flat tool-config (.npm-checkrc.json shape) given explicitly.
      toolConfig = parsed;
    }
  } else {
    // Discover a tool-specific config in the working directory (fallback for
    // back-compat; the shared `.dependably` above is the primary source).
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(cwd, name);
      if (fs.existsSync(candidate)) {
        configPath = candidate;
        toolConfig = readJsonConfig(candidate);
        break;
      }
    }
  }

  // Shared audit settings are the base; the tool-specific config overrides them.
  const userConfig = { ...shared.auditSettings, ...toolConfig };
  const config = mergeConfig(userConfig, configPath || shared.sharedPath);

  // Layer the shared allowlist ADDITIVELY onto secure-resolved / no-remote-deps
  // (public npm always stays trusted).
  const hosts = [...new Set([...shared.allowedRegistryHosts, ...explicitSharedHosts])];
  if (hosts.length > 0) {
    extendAllowedHosts(config, hosts);
  }

  // failOn.count is the standard form of maxWarnings; a legacy maxWarnings in a
  // tool-config still wins if it was set (it flowed through mergeConfig above).
  const failOn = explicitExtras ? explicitExtras.failOn : shared.failOn;
  if (failOn) {
    if (failOn.count !== undefined && toolConfig.maxWarnings === undefined && shared.auditSettings.maxWarnings === undefined) {
      if (typeof failOn.count !== 'number' || !Number.isInteger(failOn.count) || failOn.count < 0) {
        throw new AuditConfigError(`failOn.count must be a non-negative integer, got: ${JSON.stringify(failOn.count)}`, 'INVALID_FAIL_ON');
      }
      config.maxWarnings = failOn.count;
    }
    config.failOnSeverity = failOn.severity || null;
  }

  config.exceptions = explicitExtras ? explicitExtras.exceptions : shared.exceptions;
  config.exclude = explicitExtras ? explicitExtras.exclude : shared.exclude;
  config.warnings = shared.warnings;
  config.sharedConfigPath = shared.sharedPath;

  return config;
}

/**
 * Add the given hosts to every host-based rule's `allowedHosts`, deduplicated,
 * without replacing the existing entries. No-op for rules that are absent.
 *
 * BOTH `secure-resolved` and `no-remote-deps` consult `allowedHosts`; the shared
 * allowlist must reach both or a private-registry project silences one rule but
 * still trips the other.
 *
 * @param {object} config - A merged audit config (from mergeConfig)
 * @param {string[]} hosts - Bare hostnames to add to the allowlist
 */
export function extendAllowedHosts(config, hosts) {
  for (const ruleId of ['secure-resolved', 'no-remote-deps']) {
    const rule = config.rules && config.rules[ruleId];
    if (!rule) continue;
    const opts = rule.options || {};
    const existing = Array.isArray(opts.allowedHosts) ? opts.allowedHosts : [];
    rule.options = { ...opts, allowedHosts: [...new Set([...existing, ...hosts])] };
  }
}

/**
 * Merge a user config object over the defaults, validating rule ids and severities.
 * @param {object} userConfig - Parsed user config ({ maxWarnings?, rules? })
 * @param {string|null} configPath - Where it came from (for reporting)
 */
export function mergeConfig(userConfig = {}, configPath = null) {
  if (userConfig.rules) {
    for (const ruleId of Object.keys(userConfig.rules)) {
      if (!KNOWN_RULES.includes(ruleId)) {
        throw new AuditConfigError(
          `Unknown rule "${ruleId}" (known rules: ${KNOWN_RULES.join(', ')})`,
          'UNKNOWN_RULE',
          { ruleId, configPath }
        );
      }
    }
  }

  const rules = {};
  for (const ruleId of KNOWN_RULES) {
    const defaults = normalizeRuleEntry(DEFAULT_CONFIG.rules[ruleId]);
    if (userConfig.rules && userConfig.rules[ruleId] !== undefined) {
      const user = normalizeRuleEntry(userConfig.rules[ruleId]);
      rules[ruleId] = {
        severity: user.severity,
        options: { ...defaults.options, ...user.options }
      };
    } else {
      rules[ruleId] = defaults;
    }
  }

  let maxWarnings = DEFAULT_CONFIG.maxWarnings;
  if (userConfig.maxWarnings !== undefined) {
    if (typeof userConfig.maxWarnings !== 'number' || !Number.isInteger(userConfig.maxWarnings)) {
      throw new AuditConfigError(
        `maxWarnings must be an integer, got: ${JSON.stringify(userConfig.maxWarnings)}`,
        'INVALID_MAX_WARNINGS'
      );
    }
    maxWarnings = userConfig.maxWarnings;
  }

  return { maxWarnings, rules, configPath };
}
