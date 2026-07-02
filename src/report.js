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
import { detectLockfileFlavor } from './format-library.js';
import { buildEnvelope } from './schema.js';

// Sections that apply to a pnpm lockfile: the registry-backed scans plus the
// config validators (package.json, .npmrc, pnpm-workspace.yaml + pnpm field).
// The npm-lockfile-shape sections (and license, pending a `.pnpm` store walk) are
// marked N/A rather than rendered as a misleading pass.
const PNPM_LIVE_SECTIONS = new Set(['integrity', 'vuln', 'deprecated', 'package-json', 'npmrc', 'pnpm-config']);
// The pnpm-config section has no meaning for an npm lockfile.
const NPM_NA_SECTIONS = new Set(['pnpm-config']);

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
  'no-fund': 'fund',
  'valid-pnpm-workspace': 'pnpm-config',
  'valid-pnpm-field': 'pnpm-config'
};

// Display order and titles for the sections.
const SECTIONS = [
  { id: 'structure', title: 'Structure & format' },
  { id: 'package-json', title: 'package.json' },
  { id: 'npmrc', title: '.npmrc (config)' },
  { id: 'pnpm-config', title: 'pnpm (workspace + manifest)' },
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

// Bucket integrity findings: real hash mismatches are errors. Unresolved entries
// (could-not-verify) are errors when failing closed (the default), else warnings.
function collectIntegrityFindings(buckets, integrityResult, failOnUnresolved) {
  for (const err of integrityResult.errors) {
    if (err.expected && err.actual) {
      pushFinding(buckets, 'integrity', { severity: 'error', location: err.packagePath, message: `lockfile hash differs from registry for ${err.package}` });
    }
  }
  const unresolvedSeverity = failOnUnresolved ? 'error' : 'warn';
  for (const item of integrityResult.unresolvedItems) {
    pushFinding(buckets, 'integrity', { severity: unresolvedSeverity, location: item.packagePath, message: `${item.package}@${item.version}: ${item.reason}` });
  }
}

// Coerce an advisory's references into an array: an explicit `references` array
// wins, else the single `url` (if any) becomes a one-element list, else empty.
function referencesOf(f) {
  if (Array.isArray(f.references)) return f.references;
  return f.url ? [f.url] : [];
}

// Normalize one advisory finding (from vuln.js's errors/warnings) into a report
// finding that PRESERVES the full advisory data instead of collapsing it. `level`
// is the report-tier severity (error|warn) that drives the icons, the section
// status and the pass/fail rollup; `advisorySeverity` carries the TRUE 5-level
// advisory severity (info|low|moderate|high|critical) so JSON consumers no longer
// have to scrape it out of the message string. Mirrors `vuln --format json`.
function advisoryFinding(level, f) {
  return {
    severity: level,
    location: f.packagePath,
    message: `${f.package}@${f.version}: ${f.title} (${f.severity})`,
    package: f.package,
    version: f.version,
    advisoryId: f.advisoryId,
    title: f.title,
    advisorySeverity: f.severity,
    fixedVersion: f.fixedVersion ?? null,
    cve: f.cve ?? null,
    vulnerableRange: f.vulnerableRange ?? null,
    references: referencesOf(f),
    url: f.url ?? null
  };
}

// Bucket vulnerability findings. Advisory findings are errors. Unresolved entries —
// packages the scan could not check at all — are errors when failing closed (the
// default), else warnings; rendered once here (not from `errors`, where they have no advisoryId).
function collectVulnFindings(buckets, vulnResult, failOnUnresolved) {
  for (const err of vulnResult.errors) {
    if (!err.advisoryId) continue;
    pushFinding(buckets, 'vuln', advisoryFinding('error', err));
  }
  for (const warn of vulnResult.warnings) {
    pushFinding(buckets, 'vuln', advisoryFinding('warn', warn));
  }
  const unresolvedSeverity = failOnUnresolved ? 'error' : 'warn';
  for (const item of vulnResult.unresolvedItems) {
    pushFinding(buckets, 'vuln', { severity: unresolvedSeverity, location: item.packagePath, message: `could not scan ${item.package}@${item.version}: ${item.reason}` });
  }
}

// Bucket deprecation findings. A *found* deprecation is an error only under
// failOnDeprecated (it lands in `errors` with a message), else a warning. Unresolved
// entries — the scan couldn't complete — are errors when failing closed (the default),
// else warnings; rendered once here (those in `errors` carry no `message`).
function collectDeprecationFindings(buckets, deprecationResult, failOnUnresolved) {
  for (const err of deprecationResult.errors) {
    if (!err.message) continue;
    pushFinding(buckets, 'deprecated', { severity: 'error', location: err.packagePath, message: `${err.package}@${err.version}: ${err.message}` });
  }
  for (const warn of deprecationResult.warnings) {
    pushFinding(buckets, 'deprecated', { severity: 'warn', location: warn.packagePath, message: `${warn.package}@${warn.version}: ${warn.message}` });
  }
  const unresolvedSeverity = failOnUnresolved ? 'error' : 'warn';
  for (const item of deprecationResult.unresolvedItems) {
    pushFinding(buckets, 'deprecated', { severity: unresolvedSeverity, location: item.packagePath, message: `could not scan ${item.package}@${item.version}: ${item.reason}` });
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
  // No allowScripts map: npm v12 blocks every install script by default.
  return `${tally.total} ${tally.total === 1 ? 'script' : 'scripts'} · ${tally.blocked.length} blocked by npm v12 (no allowScripts)`;
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
    // The registry check may be off (--offline / --no-integrity) while the offline
    // `integrity-hygiene` audit rule still bucketed findings here. A skipped section
    // must not silently carry (and count) findings, so only report `skip` when the
    // bucket is genuinely empty; otherwise surface the offline findings and let their
    // severity drive the status and the rollup. (The `integrity: false` boolean can't
    // distinguish --offline from --no-integrity, so the label stays flag-neutral.)
    if (!state.integrity) {
      if (findings.length === 0) return { status: 'skip', summary: 'registry check skipped' };
      const n = findings.length;
      return liveSection(findings, `registry check skipped · ${n} offline finding${n === 1 ? '' : 's'}`);
    }
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
    // An unexpected checkLicenses failure (malformed CSV, fs permission error,
    // internal bug) is recorded as an error-severity finding upstream — NOT swallowed
    // into a passing skip — so the license policy gate trips when the check breaks.
    if (state.licenseError) return liveSection(findings, `check failed (${state.licenseError})`);
    if (state.licenseSkip) return { status: 'skip', summary: `skipped (${state.licenseSkip})` };
    return liveSection(findings, licenseSummary(state.licenseResult));
  },
  'install-scripts'(findings, state) {
    return liveSection(findings, installScriptsSummary(state.scriptTally));
  }
};

// Resolve a section's { status, summary } from its findings and the run's results.
function describeSection(id, findings, state) {
  if (state.flavor === 'pnpm' && !PNPM_LIVE_SECTIONS.has(id)) {
    return { status: 'skip', summary: 'N/A (pnpm)' };
  }
  if (state.flavor !== 'pnpm' && NPM_NA_SECTIONS.has(id)) {
    return { status: 'skip', summary: 'N/A (npm)' };
  }
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
    // Fail closed by default: a registry-backed scan that couldn't complete must not
    // pass the report as clean. Set false (CLI `--allow-unresolved`) to tolerate.
    failOnUnresolved: true,
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
    pushFinding(buckets, id, { severity: f.severity, location: f.packagePath, message: f.message, ruleId: f.ruleId });
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
  collectIntegrityFindings(buckets, result, opts.failOnUnresolved);
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
  collectVulnFindings(buckets, result, opts.failOnUnresolved);
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
  collectDeprecationFindings(buckets, result, opts.failOnUnresolved);
  return result;
}

// License validation (filesystem; needs node_modules + an approved list).
// Returns { licenseResult, licenseSkip, licenseError }. The two benign degrade cases
// (no node_modules, no CSV) are explicit `existsSync` skips above. An UNEXPECTED
// checkLicenses failure (malformed CSV, fs permission error, internal bug) must NOT be
// swallowed into a passing skip — it's recorded as an error-severity finding so the
// gate trips (fail-closed), and surfaced via `licenseError`.
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
    pushFinding(buckets, 'licenses', { severity: 'error', location: opts.licensesCsv, message: `license check failed: ${e.message}` });
    return { licenseResult: null, licenseSkip: null, licenseError: e.message };
  }
}

// The 5-level ladder used by the suite-wide `--fail-on severity=` gate.
const SEVERITY_RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

// Does any finding meet or exceed the severity gate? This is the suite-wide CI gate:
// each finding's ladder severity comes from `ladderSeverity()` (advisory severity, else
// error→high / warn→low), so the gate applies across EVERY section that carries
// severities — not just the vuln stage, whose `minSeverity` only shaped its own
// error/warn split. An unknown/absent gate never trips.
function severityGateTripped(findings, gate) {
  const threshold = SEVERITY_RANK[gate];
  if (threshold === undefined) return false;
  return findings.some((f) => (SEVERITY_RANK[ladderSeverity(f)] ?? 0) >= threshold);
}

// Assemble the ordered sections (status + one-line summary) and roll up totals.
function assembleSections(buckets, sectionState, maxWarnings, severityGate) {
  const sections = SECTIONS.map(({ id, title }) => {
    const findings = buckets[id] || [];
    const { status, summary } = describeSection(id, findings, sectionState);
    return { id, title, status, summary, findings };
  });

  const allFindings = sections.flatMap((s) => s.findings);
  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const warnings = allFindings.filter((f) => f.severity === 'warn').length;
  // Fail-closed rollup: any error, over the warning budget, OR any finding at/above the
  // severity gate (default `high`, so errors→high already trip and the default behavior
  // is unchanged; lowering the gate to e.g. `low` now correctly fails on warn-tier
  // findings from deprecation / install-scripts / pinned-versions / etc.).
  const gateTripped = severityGateTripped(allFindings, severityGate);
  const pass = errors === 0 && (maxWarnings < 0 || warnings <= maxWarnings) && !gateTripped;
  return { sections, summary: { errors, warnings, total: errors + warnings, pass } };
}

export async function runReport(target, options = {}) {
  const { lockfile, packageJson = null, filePath = 'package-lock.json', dir = process.cwd() } = target;
  if (!lockfile || typeof lockfile !== 'object') {
    throw new ReportError('lockfile data is required', 'MISSING_LOCKFILE');
  }

  const opts = resolveRunOptions(options, dir);
  const flavor = detectLockfileFlavor(lockfile);
  const isPnpm = flavor === 'pnpm';

  const buckets = {};

  // 1. Offline audit rules + install-script tally, bucketed into report sections.
  //    runAudit self-gates by flavor: on pnpm only the config rules run
  //    (package.json / .npmrc / pnpm-workspace.yaml + pnpm field); the npm
  //    lockfile-shape rules no-op and their sections render N/A. The install-script
  //    tally is npm-only (pnpm gates builds via onlyBuiltDependencies).
  const audit = runAudit({ lockfile, packageJson, filePath }, opts.auditConfig);
  bucketAuditFindings(buckets, audit);
  let scriptTally = { total: 0, allowed: [], blocked: [], v12Aware: false };
  if (!isPnpm) {
    scriptTally = tallyInstallScripts(lockfile, packageJson, opts.auditConfig);
  }

  // 2–4. Network + filesystem stages (each no-ops to null when disabled). The
  //    registry-backed scans work for both flavors; license is npm-only for now.
  const integrityResult = await runIntegrityStage(buckets, lockfile, opts);
  const vulnResult = await runVulnStage(buckets, lockfile, opts);
  const deprecationResult = await runDeprecationStage(buckets, lockfile, opts);
  const { licenseResult, licenseSkip, licenseError = null } = isPnpm
    ? { licenseResult: null, licenseSkip: 'N/A (pnpm)' }
    : await runLicenseStage(buckets, lockfile, opts);

  // Assemble ordered sections with status + one-line summary, then roll up totals.
  const sectionState = {
    flavor,
    integrity: opts.integrity, integrityResult, vuln: opts.vuln, vulnResult,
    deprecated: opts.deprecated, deprecationResult, licenseSkip, licenseError, licenseResult, scriptTally
  };
  const { sections, summary } = assembleSections(buckets, sectionState, opts.maxWarnings, opts.minSeverity);

  return { filePath, scanned: countExaminedPackages(lockfile), sections, summary };
}

// Count the package entries the report examined (the non-root lockfile entries):
// v2/v3 keep them under `packages` (the "" root is excluded), v1 under `dependencies`.
function countExaminedPackages(lockfile) {
  if (lockfile && lockfile.packages && typeof lockfile.packages === 'object') {
    return Object.keys(lockfile.packages).filter((k) => k !== '').length;
  }
  if (lockfile && lockfile.dependencies && typeof lockfile.dependencies === 'object') {
    return Object.keys(lockfile.dependencies).length;
  }
  return 0;
}

const DEFAULT_PASS_SUMMARY = {
  structure: 'valid',
  'package-json': 'valid',
  npmrc: 'valid',
  'pnpm-config': 'valid',
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

// Map each report section to a shared-schema `category`. The lockfile-hygiene
// audit sections fold into `lint`; policy-ish sections into `policy`; the scan
// sections keep their first-class categories.
const SECTION_CATEGORY = {
  structure: 'lint',
  'package-json': 'lint',
  npmrc: 'lint',
  'pnpm-config': 'lint',
  integrity: 'integrity',
  vuln: 'vulnerability',
  deprecated: 'deprecated',
  resolved: 'lint',
  licenses: 'policy',
  'install-scripts': 'policy',
  git: 'policy',
  remote: 'policy',
  pinned: 'policy',
  orphans: 'lint',
  unused: 'unused',
  fund: 'lint'
};

// The report tier is error|warn; the shared ladder needs one of five strings.
// Advisory findings carry their TRUE ladder severity (advisorySeverity); for every
// other finding map error→high, warn→low (the suite's error/warn→ladder rule).
function ladderSeverity(f) {
  if (f.advisorySeverity) return f.advisorySeverity;
  return f.severity === 'error' ? 'high' : 'low';
}

// Map one report finding (any section) into the shared Finding shape. The report
// tier (error/warn) that drives the gate is preserved under `extra.reportSeverity`;
// advisory findings additionally carry the vuln-tool `extra` payload.
// The advisory-specific slice of a finding's `extra` payload (only populated for
// vuln/advisory findings); kept separate so reportFindingToSchema stays flat.
function advisoryExtra(f) {
  return {
    package: f.package ?? null,
    installedVersion: f.version ?? null,
    fixedVersion: f.fixedVersion ?? null,
    advisoryId: f.advisoryId ?? null,
    cve: f.cve ?? null,
    vulnerableRange: f.vulnerableRange ?? null,
    references: referencesOf(f)
  };
}

function reportFindingToSchema(sectionId, f) {
  const isAdvisory = f.advisoryId != null || f.advisorySeverity != null;
  const extra = { section: sectionId, reportSeverity: f.severity };
  if (isAdvisory) Object.assign(extra, advisoryExtra(f));
  return {
    severity: ladderSeverity(f),
    ruleId: f.advisoryId != null ? String(f.advisoryId) : (f.ruleId || sectionId),
    category: SECTION_CATEGORY[sectionId] || 'lint',
    message: f.message,
    location: f.location ? { file: f.location, line: null, column: null } : null,
    remediation: f.fixedVersion ? `upgrade to ${f.fixedVersion}` : null,
    extra
  };
}

/**
 * Wrap a runReport() result in the shared finding-schema envelope. The COMPLETE
 * set of findings (every section, in section order) becomes the top-level
 * `findings`; the section statuses/summaries and the report-tier rollup
 * (errors/warnings/total/pass — the gate signal) are preserved under `extra`.
 *
 * @param {object} report   - a runReport() result
 * @param {object} [meta]
 * @param {string} [meta.target]   - path scanned, as given (defaults to report.filePath)
 * @param {number} [meta.exitCode] - the real exit code (defaults to pass ? 0 : 1)
 * @returns {object} the shared envelope
 */
export function reportEnvelope(report, meta = {}) {
  const target = meta.target ?? report.filePath;
  const exitCode = meta.exitCode ?? (report.summary.pass ? 0 : 1);
  const findings = [];
  for (const section of report.sections) {
    for (const f of section.findings) findings.push(reportFindingToSchema(section.id, f));
  }
  return buildEnvelope({
    target,
    scanned: report.scanned ?? 0,
    findings,
    exitCode,
    extra: {
      sections: report.sections.map((s) => ({ id: s.id, title: s.title, status: s.status, summary: s.summary })),
      summary: report.summary
    }
  });
}

/**
 * Render a report produced by runReport().
 * @param {object} report
 * @param {object} options - { format: 'human' | 'json', target?, exitCode? }
 *   In 'json' mode the output is the shared finding-schema envelope (see schema.js).
 * @returns {string}
 */
export function formatReport(report, options = {}) {
  const { format = 'human' } = options;

  if (format === 'json') {
    // The shared finding-schema envelope is the ONLY thing printed in json mode.
    return JSON.stringify(reportEnvelope(report, { target: options.target, exitCode: options.exitCode }), null, 2);
  }
  if (format !== 'human') {
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
