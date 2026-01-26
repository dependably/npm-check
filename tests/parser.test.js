import { test } from '@jest/globals';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { parseLockfile, serializeLockfile } from '../src/parser.js';

test('parser: serialize and parse a lockfile', async () => {
  const tmpPath = path.join(process.cwd(), 'tests', 'tmp-lock.json');
  const sample = { name: 'sample', version: '1.0.0', lockfileVersion: 2, packages: { '': { name: 'sample', version: '1.0.0' } } };
  serializeLockfile(tmpPath, sample, true);
  const parsed = parseLockfile(tmpPath);
  assert.deepStrictEqual(parsed.name, sample.name);
  assert.deepStrictEqual(parsed.lockfileVersion, sample.lockfileVersion);
  fs.unlinkSync(tmpPath);
});
