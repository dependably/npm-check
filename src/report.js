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
export async function runReport(target, options = {}) {
  const { lockfile, packageJson = null, filePath = 'package-lock.json', dir = process.cwd() } = target;
  if (!lockfile || typeof lockfile !== 'object') {
    throw new ReportError('lockfile data is required', 'MISSING_LOCKFILE');
  }

  const {
    auditConfig = {},
    integrity = true,
    license = true,
    vuln = true,
    deprecated = true,
    failOnDeprecated = false,
    minSeverity = 'high',
    licensesCsv = path.join(dir, 'approved-licenses.csv'),
    nodeModulesPath = path.join(dir, 'node_modules'),
    strict = false,
    maxWarnings = -1,
    concurrency = 8,
    timeoutMs = 10000,
    defaultRegistry,
    failOnUnresolved = false,
    fetchIntegrity = null,
    fetchAdvisories = null,
    fetchManifest = null,
    onProgress = null
  } = options;

  // 1. Offline audit rules.
  const audit = runAudit({ lockfile, packageJson, filePath }, auditConfig);

  // Install-script tally (allowed vs blocked), reconciled against npm v12's
  // package.json `allowScripts` — used for the section's summary line.
  const sampleRule = auditConfig.rules && auditConfig.rules['install-scripts'];
  const isResolved = sampleRule && typeof sampleRule === 'object' && !Array.isArray(sampleRule) && typeof sampleRule.severity === 'string';
  const resolvedConfig = isResolved ? auditConfig : mergeConfig(auditConfig);
  const scriptOptions = (resolvedConfig.rules['install-scripts'] || {}).options || {};
  const scriptTally = classifyInstallScripts(lockfile, packageJson, scriptOptions);

  // Bucket audit findings into report sections (normalized shape).
  const buckets = {};
  for (const f of audit.findings) {
    const id = RULE_SECTION[f.ruleId] || 'structure';
    (buckets[id] = buckets[id] || []).push({ severity: f.severity, location: f.packagePath, message: f.message });
  }

  // 2. Registry integrity verification (network).
  let integrityResult = null;
  if (integrity) {
    integrityResult = await checkIntegrity(lockfile, {
      concurrency, timeoutMs, failOnUnresolved, fetchIntegrity, onProgress,
      ...(defaultRegistry ? { defaultRegistry } : {})
    });
    const intFindings = buckets.integrity = buckets.integrity || [];
    for (const err of integrityResult.errors) {
      if (err.expected && err.actual) {
        intFindings.push({ severity: 'error', location: err.packagePath, message: `lockfile hash differs from registry for ${err.package}` });
      }
    }
    for (const item of integrityResult.unresolvedItems) {
      intFindings.push({ severity: 'warn', location: item.packagePath, message: `${item.package}@${item.version}: ${item.reason}` });
    }
  }

  // 3. Known-vulnerability scan (network; registry bulk advisory endpoint).
  let vulnResult = null;
  if (vuln) {
    vulnResult = await checkVulnerabilities(lockfile, {
      concurrency, timeoutMs, minSeverity, failOnUnresolved, fetchAdvisories, onProgress,
      ...(defaultRegistry ? { defaultRegistry } : {})
    });
    const vulnFindings = buckets.vuln = buckets.vuln || [];
    // Only advisory findings are errors here; unresolved entries (which appear in
    // `errors` too when failOnUnresolved) are rendered once, as warnings, below.
    for (const err of vulnResult.errors) {
      if (!err.advisoryId) continue;
      vulnFindings.push({ severity: 'error', location: err.packagePath, message: `${err.package}@${err.version}: ${err.title} (${err.severity})` });
    }
    for (const warn of vulnResult.warnings) {
      vulnFindings.push({ severity: 'warn', location: warn.packagePath, message: `${warn.package}@${warn.version}: ${warn.title} (${warn.severity})` });
    }
    for (const item of vulnResult.unresolvedItems) {
      vulnFindings.push({ severity: 'warn', location: item.packagePath, message: `${item.package}@${item.version}: ${item.reason}` });
    }
  }

  // 3b. Deprecation scan (network; registry version manifest `deprecated` field).
  let deprecationResult = null;
  if (deprecated) {
    deprecationResult = await checkDeprecations(lockfile, {
      concurrency, timeoutMs, failOnDeprecated, failOnUnresolved, fetchManifest, onProgress,
      ...(defaultRegistry ? { defaultRegistry } : {})
    });
    const depFindings = buckets.deprecated = buckets.deprecated || [];
    for (const err of deprecationResult.errors) {
      // Unresolved entries also land in `errors` when failOnUnresolved; render those
      // once, as warnings, below — only deprecation findings carry a `message`.
      if (!err.message) continue;
      depFindings.push({ severity: 'error', location: err.packagePath, message: `${err.package}@${err.version}: ${err.message}` });
    }
    for (const warn of deprecationResult.warnings) {
      depFindings.push({ severity: 'warn', location: warn.packagePath, message: `${warn.package}@${warn.version}: ${warn.message}` });
    }
    for (const item of deprecationResult.unresolvedItems) {
      depFindings.push({ severity: 'warn', location: item.packagePath, message: `${item.package}@${item.version}: ${item.reason}` });
    }
  }

  // 4. License validation (filesystem; needs node_modules + an approved list).
  let licenseResult = null;
  let licenseSkip = null;
  if (!license) {
    licenseSkip = 'disabled';
  } else if (!fs.existsSync(nodeModulesPath)) {
    licenseSkip = 'no node_modules';
  } else if (!fs.existsSync(licensesCsv)) {
    licenseSkip = 'no approved-licenses.csv';
  } else {
    try {
      licenseResult = await checkLicenses(lockfile, { csvPath: licensesCsv, nodeModulesPath, strict });
      const licFindings = buckets.licenses = buckets.licenses || [];
      for (const err of licenseResult.errors) {
        licFindings.push({ severity: 'error', location: err.package, message: `license "${err.license || 'UNKNOWN'}" not approved` });
      }
      for (const warn of licenseResult.warnings) {
        licFindings.push({ severity: 'warn', location: warn.package, message: `license "${warn.license || 'UNKNOWN'}" unknown` });
      }
    } catch (e) {
      licenseSkip = e.message;
    }
  }

  // Assemble ordered sections with status + one-line summary.
  const sections = SECTIONS.map(({ id, title }) => {
    const findings = buckets[id] || [];
    let status;
    let summary;

    if (id === 'integrity' && !integrity) {
      status = 'skip'; summary = 'skipped (--offline)';
    } else if (id === 'integrity') {
      const sev = worstSeverity(findings);
      status = sev || 'pass';
      const bits = [`${integrityResult.passed} verified`];
      if (integrityResult.failed) bits.push(`${integrityResult.failed} mismatched`);
      if (integrityResult.unresolved) bits.push(`${integrityResult.unresolved} unresolved`);
      if (integrityResult.skipped) bits.push(`${integrityResult.skipped} skipped`);
      summary = bits.join(' · ');
    } else if (id === 'vuln' && !vuln) {
      status = 'skip'; summary = 'skipped (--offline)';
    } else if (id === 'vuln') {
      const sev = worstSeverity(findings);
      status = sev || 'pass';
      const bits = [`${vulnResult.scanned} scanned`];
      if (vulnResult.vulnerable) bits.push(`${vulnResult.vulnerable} vulnerable`);
      if (vulnResult.unresolved) bits.push(`${vulnResult.unresolved} unresolved`);
      if (vulnResult.skipped) bits.push(`${vulnResult.skipped} skipped`);
      summary = bits.join(' · ');
    } else if (id === 'deprecated' && !deprecated) {
      status = 'skip'; summary = 'skipped (--offline)';
    } else if (id === 'deprecated') {
      const sev = worstSeverity(findings);
      status = sev || 'pass';
      const bits = [`${deprecationResult.scanned} scanned`];
      if (deprecationResult.deprecated) bits.push(`${deprecationResult.deprecated} deprecated`);
      if (deprecationResult.unresolved) bits.push(`${deprecationResult.unresolved} unresolved`);
      if (deprecationResult.skipped) bits.push(`${deprecationResult.skipped} skipped`);
      summary = bits.join(' · ');
    } else if (id === 'licenses' && licenseSkip) {
      status = 'skip'; summary = `skipped (${licenseSkip})`;
    } else if (id === 'licenses') {
      const sev = worstSeverity(findings);
      status = sev || 'pass';
      const bits = [`${licenseResult.approved} ok`];
      if (licenseResult.rejected) bits.push(`${licenseResult.rejected} rejected`);
      if (licenseResult.unknown) bits.push(`${licenseResult.unknown} unknown`);
      summary = bits.join(' · ');
    } else if (id === 'install-scripts') {
      const sev = worstSeverity(findings);
      status = sev || 'pass';
      if (scriptTally.total === 0) {
        summary = 'none';
      } else if (scriptTally.v12Aware) {
        summary = `${scriptTally.total} ${scriptTally.total === 1 ? 'script' : 'scripts'} · ${scriptTally.allowed.length} allowed · ${scriptTally.blocked.length} blocked`;
      } else {
        summary = `${scriptTally.total} ${scriptTally.total === 1 ? 'package' : 'packages'} (no allowScripts — all need review)`;
      }
    } else {
      const sev = worstSeverity(findings);
      status = sev || 'pass';
      summary = sev ? `${findings.length} ${findings.length === 1 ? 'finding' : 'findings'}` : DEFAULT_PASS_SUMMARY[id] || 'pass';
    }

    return { id, title, status, summary, findings };
  });

  const allFindings = sections.flatMap((s) => s.findings);
  const errors = allFindings.filter((f) => f.severity === 'error').length;
  const warnings = allFindings.filter((f) => f.severity === 'warn').length;
  const pass = errors === 0 && (maxWarnings < 0 || warnings <= maxWarnings);

  return { filePath, sections, summary: { errors, warnings, total: errors + warnings, pass } };
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

  // Section summary table.
  const titleWidth = Math.max(...report.sections.map((s) => s.title.length));
  for (const s of report.sections) {
    lines.push(`  ${ICON[s.status]}  ${s.title.padEnd(titleWidth)}   ${s.summary}`);
  }

  // Detail blocks for sections that have findings.
  for (const s of report.sections) {
    if (s.findings.length === 0) continue;
    lines.push('');
    lines.push(`${s.title} (${s.findings.length})`);
    const shown = s.findings.slice(0, MAX_DETAIL);
    for (const f of shown) {
      const loc = f.location ? `${f.location}  ` : '';
      lines.push(`  ${ICON[f.severity] || '·'}  ${loc}${f.message}`);
    }
    if (s.findings.length > shown.length) {
      lines.push(`  …and ${s.findings.length - shown.length} more`);
    }
  }

  lines.push('');
  const { errors, warnings, total } = report.summary;
  if (total === 0) {
    lines.push('✔ all checks passed');
  } else {
    const word = total === 1 ? 'problem' : 'problems';
    lines.push(`✖ ${total} ${word} (${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'})`);
  }
  return lines.join('\n');
}
