// src/report.js
// Unified report: runs every check npm-check offers (the 9 audit rules +
// registry integrity verification + license validation) and renders one
// clean, sectioned report.
import fs from 'fs';
import path from 'path';
import { runAudit } from './audit.js';
import { checkIntegrity, checkLicenses } from './checker.js';

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
  'integrity-hygiene': 'integrity',
  'secure-resolved': 'resolved',
  'install-scripts': 'install-scripts',
  'pinned-versions': 'pinned',
  'no-orphan-packages': 'orphans',
  'unused-dependencies': 'unused'
};

// Display order and titles for the sections.
const SECTIONS = [
  { id: 'structure', title: 'Structure & format' },
  { id: 'integrity', title: 'Integrity (registry)' },
  { id: 'resolved', title: 'Resolved URLs' },
  { id: 'licenses', title: 'Licenses' },
  { id: 'install-scripts', title: 'Install scripts' },
  { id: 'pinned', title: 'Pinned versions' },
  { id: 'orphans', title: 'Orphaned packages' },
  { id: 'unused', title: 'Unused dependencies' }
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
    licensesCsv = path.join(dir, 'approved-licenses.csv'),
    nodeModulesPath = path.join(dir, 'node_modules'),
    strict = false,
    maxWarnings = -1,
    concurrency = 8,
    timeoutMs = 10000,
    defaultRegistry,
    failOnUnresolved = false,
    fetchIntegrity = null,
    onProgress = null
  } = options;

  // 1. Offline audit rules.
  const audit = runAudit({ lockfile, packageJson, filePath }, auditConfig);

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

  // 3. License validation (filesystem; needs node_modules + an approved list).
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
    } else if (id === 'licenses' && licenseSkip) {
      status = 'skip'; summary = `skipped (${licenseSkip})`;
    } else if (id === 'licenses') {
      const sev = worstSeverity(findings);
      status = sev || 'pass';
      const bits = [`${licenseResult.approved} ok`];
      if (licenseResult.rejected) bits.push(`${licenseResult.rejected} rejected`);
      if (licenseResult.unknown) bits.push(`${licenseResult.unknown} unknown`);
      summary = bits.join(' · ');
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
  resolved: 'all TLS / trusted',
  'install-scripts': 'none',
  pinned: 'all pinned',
  orphans: 'none',
  unused: 'none'
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
