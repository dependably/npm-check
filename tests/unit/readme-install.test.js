// tests/unit/readme-install.test.js
// Locks the README's install section to the published-package shape: the
// canonical path is the public-registry install (`npm install -g
// @dependably/npm-check`, or npx), building from source is delegated to
// CONTRIBUTING.md, and no private-registry/private-GitLab instructions leak
// into the public README.
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const README = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');

// Pull out the "## Install" section (up to the next top-level heading).
function installSection() {
  const start = README.indexOf('## Install');
  expect(start).toBeGreaterThan(-1);
  const rest = README.slice(start + '## Install'.length);
  const next = rest.indexOf('\n## ');
  return next === -1 ? rest : rest.slice(0, next);
}

describe('README install section is canonical (published package)', () => {
  const section = installSection();

  test('leads with the global registry install', () => {
    expect(section).toMatch(/npm install -g @dependably\/npm-check/);
  });

  test('documents the no-install npx route', () => {
    expect(section).toMatch(/npx @dependably\/npm-check/);
  });

  test('delegates building from source to CONTRIBUTING.md instead of inline clone steps', () => {
    expect(section).toMatch(/CONTRIBUTING\.md/);
    expect(section).not.toMatch(/git clone/);
  });

  test('does not present the install as aspirational or point at private hosts', () => {
    expect(section).not.toMatch(/once published|not yet on a public registry/i);
    expect(section).not.toMatch(/northwardlabs\.ca/);
    expect(section).not.toMatch(/npm config set @dependably:registry/);
  });
});
