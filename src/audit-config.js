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

export const CONFIG_FILENAMES = ['.npfixrc.json', 'npfix.config.json'];

export const SEVERITIES = ['error', 'warn', 'off'];

export const DEFAULT_CONFIG = {
  maxWarnings: -1,
  rules: {
    'lockfile-version': ['error', { minVersion: 3 }],
    'valid-structure': 'error',
    'integrity-hygiene': ['error', { allowSha1: false }],
    'secure-resolved': ['error', {
      allowedHosts: ['registry.npmjs.org'],
      allowHttp: false,
      allowGit: true,
      allowFile: true
    }],
    'pinned-versions': ['warn', {
      sections: ['dependencies', 'devDependencies', 'optionalDependencies'],
      ignore: []
    }],
    'lockfile-sync': 'error',
    'no-orphan-packages': 'warn',
    'unused-dependencies': ['warn', { includeDev: false, ignore: [] }]
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

  return mergeConfig(userConfig, configPath);
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
