// tests/unit/readme-install.test.js
// Locks the README's install section to an HONEST shape: a public user must have
// a route that works today (from source), and the registry install must be
// presented as aspirational ("once published"), never asserted as available —
// @dependably/npm-check is not on a public registry.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');

// Pull out the "## Installation" section (up to the next top-level heading).
function installSection() {
  const start = README.indexOf('## Installation');
  expect(start).toBeGreaterThan(-1);
  const rest = README.slice(start + '## Installation'.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('README install section is honest', () => {
  const section = installSection();

  test('documents a from-source route that works today (npm link or node bin/cli.js)', () => {
    expect(section).toMatch(/npm link|node bin\/cli\.js|npm install -g \./);
    // the clone step grounds the from-source route in the real repo
    expect(section).toMatch(/git clone/);
  });

  test('still documents the registry install command', () => {
    expect(section).toMatch(/npm install -g @dependably\/npm-check/);
  });

  test('presents the registry install as aspirational ("once published"), not asserted as available', () => {
    expect(section).toMatch(/once published|not yet|when it is/i);
    // The old copy asserted it as fact ("Published to the private registry").
    expect(section).not.toMatch(/^Published to the private registry/im);
  });
});
