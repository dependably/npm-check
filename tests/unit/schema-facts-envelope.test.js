// tests/unit/schema-facts-envelope.test.js
// The two envelopes in src/schema.js are siblings that share an identity and
// differ in ONE discriminator: the findings envelope has no `documentType`
// (schema 1.0 predates the split and is unchanged), the facts envelope has
// `documentType: "imports"` and no `findings`.
import { buildEnvelope, buildFactsEnvelope, DOCUMENT_TYPE_IMPORTS, SCHEMA_VERSION, TOOL_NAME, toolVersion } from '../../src/schema.js';
import { FACTS_SCHEMA_VERSION } from '../../src/facts/index.js';

describe('buildFactsEnvelope', () => {
  const summary = { scanned: 2, analyzed: 2, unanalyzable: 0, imports: 3, moduleGraph: { filesParsed: 0, reached: 0, unresolved: 0, truncated: false }, exitCode: 0 };
  const body = { workspace: { firstPartyNames: [] }, imports: [], moduleGraph: { enabled: false }, lockfile: { files: [] }, unanalyzable: [] };

  test('carries the shared identity fields, the discriminator, and the body sections — in that order', () => {
    const env = buildFactsEnvelope({ target: '.', summary, body });
    expect(Object.keys(env)).toEqual(['tool', 'toolVersion', 'schemaVersion', 'documentType', 'target', 'summary', 'workspace', 'imports', 'moduleGraph', 'lockfile', 'unanalyzable']);
    expect(env.tool).toBe(TOOL_NAME);
    expect(env.toolVersion).toBe(toolVersion());
    expect(env.schemaVersion).toBe(SCHEMA_VERSION);
    expect(env.documentType).toBe('imports');
    expect(DOCUMENT_TYPE_IMPORTS).toBe('imports');
    expect(env.target).toBe('.');
    expect(env.summary).toBe(summary);
    expect(env.findings).toBeUndefined();
  });

  test('a `summary` inside body never overrides the explicit one, and identity fields always win', () => {
    const env = buildFactsEnvelope({ target: 'x', summary, body: { ...body, summary: { bogus: true }, tool: 'evil', documentType: 'findings' } });
    expect(env.summary).toBe(summary);
    expect(env.tool).toBe('npm-check');
    expect(env.documentType).toBe('imports');
  });

  test('tolerates a missing body', () => {
    const env = buildFactsEnvelope({ target: 'x', summary });
    expect(env.documentType).toBe('imports');
    expect(env.summary).toBe(summary);
  });

  test('the facts schema version matches the envelope schema version today', () => {
    expect(FACTS_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });
});

describe('buildEnvelope (findings) is unchanged', () => {
  test('still has no documentType and still carries findings', () => {
    const env = buildEnvelope({ target: 'package-lock.json', scanned: 1, findings: [{ severity: 'high' }], exitCode: 1 });
    expect(env.documentType).toBeUndefined();
    expect('documentType' in env).toBe(false);
    expect(env.findings).toHaveLength(1);
    expect(env.summary).toEqual({ scanned: 1, findings: 1, bySeverity: { critical: 0, high: 1, moderate: 0, low: 0, info: 0 }, exitCode: 1 });
  });
});
