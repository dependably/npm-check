// Every envelope sample in the docs must be a document this build could actually
// emit. `docs/CLI.md` once printed `"toolVersion": "1.10.1"` beside
// `"schemaVersion": "1.2"` — an impossible pair, since 1.10.1 shipped facts
// schema 1.1 and 1.2 first exists in 1.11.0. A reader gating on the tool version
// would have drawn the wrong conclusion from the canonical example.
//
// The rule is deliberately narrow: samples must name THIS build's tool version,
// and the schemaVersion beside one must be the constant its own documentType
// selects (facts documents carry `documentType`, the findings envelope does not
// and stays at the findings schema).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { FACTS_SCHEMA_VERSION } from '../../src/facts/version.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pkgVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const FINDINGS_SCHEMA_VERSION = '1.0';

/** Every ```json block in a doc, with the line it starts on. */
function jsonBlocks(relPath) {
  const text = readFileSync(join(root, relPath), 'utf8');
  const out = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== '```json') continue;
    const start = i + 1;
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== '```') j++;
    out.push({ relPath, line: start + 1, body: lines.slice(start, j).join('\n') });
    i = j;
  }
  return out;
}

const DOCS = ['docs/CLI.md', 'docs/API.md', 'README.md'];

describe('docs envelope samples are documents this build could emit', () => {
  const blocks = DOCS.flatMap((d) => {
    try {
      return jsonBlocks(d);
    } catch {
      return []; // a doc that does not exist is not this test's business
    }
  });

  const envelopes = blocks.filter((b) => /"toolVersion"\s*:/.test(b.body));

  it('finds envelope samples to check (guards against a vacuous pass)', () => {
    expect(envelopes.length).toBeGreaterThan(0);
  });

  it.each(envelopes.map((b) => [`${b.relPath}:${b.line}`, b]))(
    '%s names this build and a schemaVersion its documentType selects',
    (_label, b) => {
      const tool = /"toolVersion"\s*:\s*"([^"]+)"/.exec(b.body);
      expect(tool?.[1]).toBe(pkgVersion);

      const schema = /"schemaVersion"\s*:\s*"([^"]+)"/.exec(b.body);
      if (!schema) return; // a fragment that omits it is not making a claim
      const isFacts = /"documentType"\s*:/.test(b.body);
      expect(schema[1]).toBe(isFacts ? FACTS_SCHEMA_VERSION : FINDINGS_SCHEMA_VERSION);
    },
  );
});
