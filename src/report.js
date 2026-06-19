// src/report.js
// Unified report: runs every check npm-check offers (the audit rules covering
// lockfile + package.json + .npmrc validation, plus registry integrity
// verification and license validation) and renders one clean, sectioned report.
import fs from 'fs';
import path from 'path';
import { runAudit, classifyInstallScripts } from './audit.js';
import { mergeConfig } from './audit-config.js';
import { checkIntegrity, checkLicenses } from './checker.js';
import { checkVulnerabilities } from './vuln.js';
import { checkDeprecations } from './deprecation.js';

export class ReportError extends Error {
  constructor(message, code, context = {}) {
    super(message);
    this.name = 'ReportError';
    this.code = code;
    this.context = context;
  }
}

// Which report section each audit rule feeds into.
const RULE_SECTION = {
  'lockfile-version': 'structure',
  'valid-structure': 'structure',
  'lockfile-sync': 'structure',
  'valid-package-json': 'package-json',
  'valid-npmrc': 'npmrc',
  'integrity-hygiene': 'integrity',
  'secure-resolved': 'resolved',
  'install-scripts': 'install-scripts',
  'no-git-deps': 'git',
  'no-remote-deps': 'remote',
  'pinned-versions': 'pinned',
  'no-orphan-packages': 'orphans',
  'unused-dependencies': 'unused',
  'no-fund': 'fund'
};

// Display order and titles for the sections.
const SECTIONS = [
  { id: 'structure', title: 'Structure & format' },
  { id: 'package-json', title: 'package.json' },
  { id: 'npmrc', title: '.npmrc (config)' },
  { id: 'integrity', title: 'Integrity (registry)' },
  { id: 'vuln', title: 'Known vulnerabilities' },
  { id: 'deprecated', title: 'Deprecated packages' },
  { id: 'resolved', title: 'Resolved URLs' },
  { id: 'licenses', title: 'Licenses' },
  { id: 'install-scripts', title: 'Install scripts' },
  { id: 'git', title: 'Git dependencies' },
  { id: 'remote', title: 'Remote-URL deps' },
  { id: 'pinned', title: 'Pinned versions' },
  { id: 'orphans', title: 'Orphaned packages' },
  { id: 'unused', title: 'Unused dependencies' },
  { id: 'fund', title: 'Funding solicitations' }
];

const MAX_DETAIL = 50; // cap per-section detail lines so the report stays readable

function worstSeverity(findings) {
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warn')) return 'warn';
  return null;
}

// Append a normalized finding to its section bucket, creating it on first use.
function pushFinding(buckets, id, finding) {
  const list = buckets[id] || (buckets[id] = []);
  list.push(finding);
}

// Bucket integrity findings: real hash mismatches are errors, unresolved entries warn.
function collectIntegrityFindings(buckets, integrityResult) {
  for (const err of integrityResult.errors) {
    if (err.expected && err.actual) {
      pushFinding(buckets, 'integrity', { severity: 'error', location: err.packagePath, message: `lockfile hash differs from registry for ${err.package}` });
    }
  }
  for (const item of integrityResult.unresolvedItems) {
    pushFinding(buckets, 'integrity', { severity: 'warn', location: item.packagePath, message: `${item.package}@${item.version}: ${item.reason}` });
  }
}

// Bucket vulnerability findings. Only advisory findings are errors here; unresolved
// entries (which appear in `errors` too when failOnUnresolved) are rendered once as warnings.
function collectVulnFindings(buckets, vulnResult) {
  for (const err of vulnResult.errors) {
    if (!err.advisoryId) continue;
    pushFinding(buckets, 'vuln', { severity: 'error', location: err.packagePath, message: `${err.package}@${err.version}: ${err.title} (${err.severity})` });
  }
  for (const warn of vulnResult.warnings) {
    pushFinding(buckets, 'vuln', { severity: 'warn', location: warn.packagePath, message: `${warn.package}@${warn.version}: ${warn.title} (${warn.severity})` });
  }
  for (const item of vulnResult.unresolvedItems) {
    pushFinding(buckets, 'vuln', { severity: 'warn', location: item.packagePath, message: `${item.package}@${item.version}: ${item.reason}` });
  }
}

// Bucket deprecation findings. Unresolved entries also land in `errors` when
// failOnUnresolved; render those once, as warnings — only findings carry a `message`.
function collectDeprecationFindings(buckets, deprecationResult) {
  for (const err of deprecationResult.errors) {
    if (!err.message) continue;
    pushFinding(buckets, 'deprecated', { severity: 'error', location: err.packagePath, message: `${err.package}@${err.version}: ${err.message}` });
  }
  for (const warn of deprecationResult.warnings) {
    pushFinding(buckets, 'deprecated', { severity: 'warn', location: warn.packagePath, message: `${warn.package}@${warn.version}: ${warn.message}` });
  }
  for (const item of deprecationResult.unresolvedItems) {
    pushFinding(buckets, 'deprecated', { severity: 'warn', location: item.packagePath, message: `${item.package}@${item.version}: ${item.reason}` });
  }
}

// Bucket license findings: rejected licenses are errors, unknown licenses warn.
function collectLicenseFindings(buckets, licenseResult) {
  for (const err of licenseResult.errors) {
    pushFinding(buckets, 'licenses', { severity: 'error', location: err.package, message: `license "${err.license || 'UNKNOWN'}" not approved` });
  }
  for (const warn of licenseResult.warnings) {
    pushFinding(buckets, 'licenses', { severity: 'warn', location: warn.package, message: `license "${warn.license || 'UNKNOWN'}" unknown` });
  }
}

// One-line summary for the integrity section's count bits.
function integritySummary(r) {
  const bits = [`${r.passed} verified`];
  if (r.failed) bits.push(`${r.failed} mismatched`);
  if (r.unresolved) bits.push(`${r.unresolved} unresolved`);
  if (r.skipped) bits.push(`${r.skipped} skipped`);
  return bits.join(' · ');
}

// One-line summary shared by the vuln and deprecation sections (scanned/flagged/…).
function scanSummary(r, flaggedKey, flaggedLabel) {
  const bits = [`${r.scanned} scanned`];
  if (r[flaggedKey]) bits.push(`${r[flaggedKey]} ${flaggedLabel}`);
  if (r.unresolved) bits.push(`${r.unresolved} unresolved`);
  if (r.skipped) bits.push(`${r.skipped} skipped`);
  return bits.join(' · ');
}

// One-line summary for the license section's count bits.
function licenseSummary(r) {
  const bits = [`${r.approved} ok`];
  if (r.rejected) bits.push(`${r.rejected} rejected`);
  if (r.unknown) bits.push(`${r.unknown} unknown`);
  return bits.join(' · ');
}

// One-line summary for the install-scripts section, reconciled against allowScripts.
function installScriptsSummary(tally) {
  if (tally.total === 0) return 'none';
  if (tally.v12Aware) {
    return `${tally.total} ${tally.total === 1 ? 'script' : 'scripts'} · ${tally.allowed.length} allowed · ${tally.blocked.length} blocked`;
  }
  return `${tally.total} ${tally.total === 1 ? 'package' : 'packages'} (no allowScripts — all need review)`;
}

// Default pass-state summary for a generic section: count its findings or fall back.
function genericSummary(id, findings) {
  const sev = worstSeverity(findings);
  if (sev) return `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}`;
  return DEFAULT_PASS_SUMMARY[id] || 'pass';
}

// Build a passing/severity result whose summary comes from the given producer.
function liveSection(findings, summary) {
  return { status: worstSeverity(findings) || 'pass', summary };
}

// Per-section describers keyed by section id. Each returns { status, summary },
// short-circuiting to a 'skip' when the underlying check didn't run.
const SECTION_DESCRIBERS = {
  integrity(findings, state) {
    if (!state.integrity) return { status: 'skip', summary: 'skipped (--offline)' };
    return liveSection(findings, integritySummary(state.integrityResult));
  },
  vuln(findings, state) {
    if (!state.vuln) return { status: 'skip', summary: 'skipped (--offline)' };
    return liveSection(findings, scanSummary(state.vulnResult, 'vulnerable', 'vulnerable'));
  },
  deprecated(findings, state) {
    if (!state.deprecated) return { status: 'skip', summary: 'skipped (--offline)' };
    return liveSection(findings, scanSummary(state.deprecationResult, 'deprecated', 'deprecated'));
  },
  licenses(findings, state) {
    if (state.licenseSkip) return { status: 'skip', summary: `skipped (${state.licenseSkip})` };
    return liveSection(findings, licenseSummary(state.licenseResult));
  },
  'install-scripts'(findings, state) {
    return liveSection(findings, installScriptsSummary(state.scriptTally));
  }
};

// Resolve a section's { status, summary } from its findings and the run's results.
function describeSection(id, findings, state) {
  const describer = SECTION_DESCRIBERS[id];
  if (describer) return describer(findings, state);
  return liveSection(findings, genericSummary(id, findings));
}

/**
 * Run every available check and build a structured report.
 *
 * @param {object} target - { lockfile, packageJson|null, filePath, dir }
 * @param {object} options
 * @param {object} options.auditConfig - Resolved/raw audit config (passed to runAudit)
 * @param {boolean} options.integrity - Run registry integrity verification (default true)
 * @param {boolean} options.license - Run license validation (default true)
 * @param {string} options.licensesCsv - Path to approved-licenses CSV
 * @param {string} options.nodeModulesPath - node_modules path for license reads
 * @param {boolean} options.strict - Treat warnings as failures
 * @param {number} options.maxWarnings - Warning budget (-1 = unlimited)
 * @param {number} options.concurrency / options.timeoutMs / options.defaultRegistry / options.failOnUnresolved
 * @param {Function} options.fetchIntegrity - Injectable registry transport (tests)
 * @param {Function} options.onProgress - Progress callback for the integrity stage
 * @returns {Promise<object>} { filePath, sections, summary }
 */
// Merge caller options over the report defaults, resolving CSV / node_modules
// paths relative to the target dir. Returns the fully-defaulted option set.
function resolveRunOptions(options, dir) {
  return {
    auditConfig: {},
    integrity: true,
    license: true,
    vuln: true,
    deprecated: true,
    failOnDeprecated: false,
    minSeverity: 'high',
    licensesCsv: path.join(dir, 'approved-licenses.csv'),
    nodeModulesPath: path.join(dir, 'node_modules'),
    strict: false,
    maxWarnings: -1,
    concurrency: 8,
    timeoutMs: 10000,
    defaultRegistry: undefined,
    failOnUnresolved: false,
    fetchIntegrity: null,
    fetchAdvisories: null,
    fetchManifest: null,
    onProgress: null,
    ...options
  };
}

// Install-script tally (allowed vs blocked), reconciled against npm v12's
// package.json `allowScripts` — used for the section's summary line.
function tallyInstallScripts(lockfile, packageJson, auditConfig) {
  const sampleRule = auditConfig.rules && auditConfig.rules['install-scripts'];
  const isResolved = sampleRule && typeof sampleRule === 'object' && !Array.isArray(sampleRule) && typeof sampleRule.severity === 'string';
  const resolvedConfig = isResolved ? auditConfig : mergeConfig(auditConfig);
  const scriptOptions = (resolvedConfig.rules['install-scripts'] || {}).options || {};
  return classifyInstallScripts(lockfile, packageJson, scriptOptions);
}

// Bucket audit findings into report sections (normalized shape).
function bucketAuditFindings(buckets, audit) {
  for (const f of audit.findings) {
    const id = RULE_SECTION[f.ruleId] || 'structure';
    pushFinding(buckets, id, { severity: f.severity, location: f.packagePath, message: f.message });
  }
}

// Optional defaultRegistry spread, shared by every network stage.
function registryOption(defaultRegistry) {
  return defaultRegistry ? { defaultRegistry } : {};
}

// Registry integrity verification (network). Returns the result or null when off.
async function runIntegrityStage(buckets, lockfile, opts) {
  if (!opts.integrity) return null;
  const result = await checkIntegrity(lockfile, {
    concurrency: opts.concurrency, timeoutMs: opts.timeoutMs, failOnUnresolved: opts.failOnUnresolved,
    fetchIntegrity: opts.fetchIntegrity, onProgress: opts.onProgress, ...registryOption(opts.defaultRegistry)
  });
  collectIntegrityFindings(buckets, result);
  return result;
}

// Known-vulnerability scan (network; registry bulk advisory endpoint).
async function runVulnStage(buckets, lockfile, opts) {
  if (!opts.vuln) return null;
  const result = await checkVulnerabilities(lockfile, {
    concurrency: opts.concurrency, timeoutMs: opts.timeoutMs, minSeverity: opts.minSeverity,
    failOnUnresolved: opts.failOnUnresolved, fetchAdvisories: opts.fetchAdvisories, onProgress: opts.onProgress,
    ...registryOption(opts.defaultRegistry)
  });
  collectVulnFindings(buckets, result);
  return result;
}

// Deprecation scan (network; registry version manifest `deprecated` field).
async function runDeprecationStage(buckets, lockfile, opts) {
  if (!opts.deprecated) return null;
  const result = await checkDeprecations(lockfile, {
    concurrency: opts.concurrency, timeoutMs: opts.timeoutMs, failOnDeprecated: opts.failOnDeprecated,
    failOnUnresolved: opts.failOnUnresolved, fetchManifest: opts.fetchManifest, onProgress: opts.onProgress,
    ...registryOption(opts.defaultRegistry)
  });
  collectDeprecationFindings(buckets, result);
  return result;
}

// License validation (filesystem; needs node_modules + an approved list).
// Returns { licenseResult, licenseSkip } — a non-null skip reason means it was skipped.
async function runLicenseStage(buckets, lockfile, opts) {
  if (!opts.license) return { licenseResult: null, licenseSkip: 'disabled' };
  if (!fs.existsSync(opts.nodeModulesPath)) return { licenseResult: null, licenseSkip: 'no node_modules' };
  if (!fs.existsSync(opts.licensesCsv)) return { licenseResult: null, licenseSkip: 'no approved-licenses.csv' };
  try {
    const licenseResult = await checkLicenses(lockfile, {
      csvPath: opts.licensesCsv, nodeModulesPath: opts.nodeModulesPath, strict: opts.strict
    });
    collectLicenseFindings(buckets, licenseResult);
    return { licenseResult, licenseSkip: null };
  } catch (e) {
    return { licenseResult: null, licenseSkip: e.message };
  }
}

// Assemble the ordered sections (status + one-line summary) and roll up totals.
function assembleSections(buckets, sectionState, maxWarnings) {
  const sections = SECTIONS.map(({ id, title }) => {
    const findings = buckets[id] || [];
    const { status, summary } = describeSection(id, findings, sectionState);
    return { id, title, status, summary, findings };
  });

  const allFindings = sections.flatMap((s) => s.findings);
  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const warnings = allFindings.filter((f) => f.severity === 'warn').length;
  const pass = errors === 0 && (maxWarnings < 0 || warnings <= maxWarnings);
  return { sections, summary: { errors, warnings, total: errors + warnings, pass } };
}

export async function runReport(target, options = {}) {
  const { lockfile, packageJson = null, filePath = 'package-lock.json', dir = process.cwd() } = target;
  if (!lockfile || typeof lockfile !== 'object') {
    throw new ReportError('lockfile data is required', 'MISSING_LOCKFILE');
  }

  const opts = resolveRunOptions(options, dir);

  // 1. Offline audit rules + install-script tally, bucketed into report sections.
  const audit = runAudit({ lockfile, packageJson, filePath }, opts.auditConfig);
  const scriptTally = tallyInstallScripts(lockfile, packageJson, opts.auditConfig);
  const buckets = {};
  bucketAuditFindings(buckets, audit);

  // 2–4. Network + filesystem stages (each no-ops to null when disabled).
  const integrityResult = await runIntegrityStage(buckets, lockfile, opts);
  const vulnResult = await runVulnStage(buckets, lockfile, opts);
  const deprecationResult = await runDeprecationStage(buckets, lockfile, opts);
  const { licenseResult, licenseSkip } = await runLicenseStage(buckets, lockfile, opts);

  // Assemble ordered sections with status + one-line summary, then roll up totals.
  const sectionState = {
    integrity: opts.integrity, integrityResult, vuln: opts.vuln, vulnResult,
    deprecated: opts.deprecated, deprecationResult, licenseSkip, licenseResult, scriptTally
  };
  const { sections, summary } = assembleSections(buckets, sectionState, opts.maxWarnings);

  return { filePath, sections, summary };
}

const DEFAULT_PASS_SUMMARY = {
  structure: 'valid',
  'package-json': 'valid',
  npmrc: 'valid',
  resolved: 'all TLS / trusted',
  'install-scripts': 'none',
  git: 'none',
  remote: 'none',
  pinned: 'all pinned',
  orphans: 'none',
  unused: 'none',
  fund: 'suppressed'
};

const ICON = { pass: '✔', warn: '⚠', error: '✖', skip: '·' };

/**
 * Render a report produced by runReport().
 * @param {object} report
 * @param {object} options - { format: 'pretty' | 'json' }
 * @returns {string}
 */
export function formatReport(report, options = {}) {
  const { format = 'pretty' } = options;

  if (format === 'json') {
    return JSON.stringify(report, null, 2);
  }
  if (format !== 'pretty') {
    throw new ReportError(`Unknown report format: ${format}`, 'UNKNOWN_FORMAT');
  }

  const lines = [];
  lines.push(`npm-check report — ${report.filePath}`);
  lines.push('');
  lines.push(...renderSummaryTable(report.sections));
  for (const s of report.sections) {
    lines.push(...renderSectionDetail(s));
  }
  lines.push('');
  lines.push(renderFooter(report.summary));
  return lines.join('\n');
}

// Section summary table: one aligned status line per section.
function renderSummaryTable(sections) {
  const titleWidth = Math.max(...sections.map((s) => s.title.length));
  return sections.map((s) => `  ${ICON[s.status]}  ${s.title.padEnd(titleWidth)}   ${s.summary}`);
}

// Detail block for a single section — empty unless it has findings.
function renderSectionDetail(s) {
  if (s.findings.length === 0) return [];
  const lines = ['', `${s.title} (${s.findings.length})`];
  const shown = s.findings.slice(0, MAX_DETAIL);
  for (const f of shown) {
    const loc = f.location ? `${f.location}  ` : '';
    lines.push(`  ${ICON[f.severity] || '·'}  ${loc}${f.message}`);
  }
  if (s.findings.length > shown.length) {
    lines.push(`  …and ${s.findings.length - shown.length} more`);
  }
  return lines;
}

// Closing totals line: an all-clear, or an error/warning count.
function renderFooter({ errors, warnings, total }) {
  if (total === 0) return '✔ all checks passed';
  const word = total === 1 ? 'problem' : 'problems';
  return `✖ ${total} ${word} (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})`;
}
