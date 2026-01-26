const { test } = require('@jest/globals');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseLockfile, serializeLockfile } = require('../src/parser.js');

test('parser: serialize and parse a lockfile', async () => {
  const tmpPath = path.join(process.cwd(), 'tests', 'tmp-lock.json');
  const sample = { name: 'sample', version: '1.0.0', lockfileVersion: 2, packages: { '': { name: 'sample', version: '1.0.0' } } };
  serializeLockfile(tmpPath, sample, true);
  const parsed = parseLockfile(tmpPath);
  assert.deepStrictEqual(parsed.name, sample.name);
  assert.deepStrictEqual(parsed.lockfileVersion, sample.lockfileVersion);
  fs.unlinkSync(tmpPath);
});
