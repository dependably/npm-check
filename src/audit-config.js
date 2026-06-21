// src/audit-config.js
import fs from 'fs';
import path from 'path';

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
// from the working directory. Its `common`/`npm` `allowedRegistryHosts` extend
// the secure-resolved trusted-host allowlist additively (public npm stays trusted).
export const SHARED_CONFIG_FILENAME = '.dependably-check';

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
    'no-remote-deps': 'warn',
    'pinned-versions': ['warn', {
      sections: ['dependencies', 'devDependencies', 'optionalDependencies'],
      ignore: []
    }],
    'lockfile-sync': 'error',
    'no-orphan-packages': 'warn',
    'unused-dependencies': ['warn', { includeDev: false, ignore: [] }],
    'no-fund': 'warn',
    'valid-npmrc': ['warn', {}]
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
      options = entry[1];
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
 * Resolve the effective audit config: built-in defaults overlaid by a
 * discovered or explicitly-given JSON config file.
 * Rule options merge over the defaults for that rule; severity replaces.
 *
 * @param {string} cwd - Directory to search for config files
 * @param {string|null} explicitPath - Path passed via --config (wins over discovery)
 * @returns {{maxWarnings, rules: {[id]: {severity, options}}, configPath}}
 */
/**
 * Walk up from `cwd` to the filesystem root looking for the shared
 * `.dependably-check` config file. Stops at the first hit, at a directory
 * containing a `.git` entry (the repo root), or at the filesystem root.
 *
 * @param {string} cwd - Directory to start the search from
 * @returns {string|null} Absolute path to the shared config, or null when absent
 */
export function findSharedConfig(cwd = process.cwd()) {
  let dir = path.resolve(cwd);
  for (;;) {
    const candidate = path.join(dir, SHARED_CONFIG_FILENAME);
    if (fs.existsSync(candidate)) return candidate;

    // Stop at the repo root: a directory containing `.git`.
    if (fs.existsSync(path.join(dir, '.git'))) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

/**
 * Read and parse the shared `.dependably-check` file, returning the union of
 * `common.allowedRegistryHosts` and `npm.allowedRegistryHosts` (deduped). Other
 * tool sections and unknown keys are ignored.
 *
 * @param {string} cwd - Directory to start discovery from
 * @returns {{ allowedRegistryHosts: string[], sharedPath: string|null }}
 */
export function loadSharedConfig(cwd = process.cwd()) {
  const sharedPath = findSharedConfig(cwd);
  if (!sharedPath) return { allowedRegistryHosts: [], sharedPath: null };

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

  const collect = (section) => {
    const hosts = section && section.allowedRegistryHosts;
    return Array.isArray(hosts) ? hosts.filter((h) => typeof h === 'string') : [];
  };
  const allowedRegistryHosts = [...new Set([...collect(parsed.common), ...collect(parsed.npm)])];
  return { allowedRegistryHosts, sharedPath };
}

export function loadAuditConfig(cwd = process.cwd(), explicitPath = null) {
  let userConfig = {};
  let configPath = null;

  if (explicitPath) {
    configPath = path.resolve(explicitPath);
    if (!fs.existsSync(configPath)) {
      throw new AuditConfigError(`Config file not found: ${configPath}`, 'CONFIG_NOT_FOUND');
    }
  } else {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(cwd, name);
      if (fs.existsSync(candidate)) {
        configPath = candidate;
        break;
      }
    }
  }

  if (configPath) {
    let raw;
    try {
      raw = fs.readFileSync(configPath, 'utf8');
    } catch (e) {
      throw new AuditConfigError(`Cannot read config file: ${e.message}`, 'CONFIG_READ', { configPath });
    }
    try {
      userConfig = JSON.parse(raw);
    } catch (e) {
      throw new AuditConfigError(`Invalid JSON in ${configPath}: ${e.message}`, 'CONFIG_PARSE', { configPath });
    }
  }

  const config = mergeConfig(userConfig, configPath);

  // Layer the shared `.dependably-check` hosts ADDITIVELY onto whatever
  // secure-resolved.allowedHosts resolved to (built-in default or a
  // tool-config replacement) — public npm always stays trusted.
  const { allowedRegistryHosts, sharedPath } = loadSharedConfig(cwd);
  if (allowedRegistryHosts.length > 0) {
    extendAllowedHosts(config, allowedRegistryHosts);
  }
  config.sharedConfigPath = sharedPath;

  return config;
}

/**
 * Add the given hosts to the secure-resolved rule's `allowedHosts`, deduplicated,
 * without replacing the existing entries. No-op when the rule is absent.
 *
 * @param {object} config - A merged audit config (from mergeConfig)
 * @param {string[]} hosts - Bare hostnames to add to the allowlist
 */
export function extendAllowedHosts(config, hosts) {
  const rule = config.rules && config.rules['secure-resolved'];
  if (!rule) return;
  const existing = Array.isArray(rule.options.allowedHosts) ? rule.options.allowedHosts : [];
  rule.options = { ...rule.options, allowedHosts: [...new Set([...existing, ...hosts])] };
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
