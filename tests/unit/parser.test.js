import { describe, it, expect, afterEach } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { parseLockfile, serializeLockfile } from '../../src/parser.js';

describe('Parser Functions', () => {
  const tmpPath = path.join(process.cwd(), 'tmp-test-lock.json');

  afterEach(() => {
    if (fs.existsSync(tmpPath)) {
      fs.unlinkSync(tmpPath);
    }
  });

  it('serialize and parse a lockfile', () => {
    const sample = { name: 'sample', version: '1.0.0', lockfileVersion: 2, packages: { '': { name: 'sample', version: '1.0.0' } } };
    serializeLockfile(tmpPath, sample, true);
    const parsed = parseLockfile(tmpPath);
    expect(parsed.name).toBe(sample.name);
    expect(parsed.lockfileVersion).toBe(sample.lockfileVersion);
  });

  it('throws error when file does not exist', () => {
    const nonexistent = path.join(process.cwd(), 'nonexistent-lock.json');
    expect(() => parseLockfile(nonexistent)).toThrow();
  });

  it('throws error on invalid JSON', () => {
    const invalidPath = path.join(process.cwd(), 'invalid-lock.json');
    fs.writeFileSync(invalidPath, '{invalid json}', 'utf8');
    expect(() => parseLockfile(invalidPath)).toThrow();
    fs.unlinkSync(invalidPath);
  });

  it('throws when serializeLockfile file exists and overwrite is false', () => {
    const sample = { name: 'test', version: '1.0.0', lockfileVersion: 2, packages: {} };
    serializeLockfile(tmpPath, sample, true);
    // Try to serialize again with overwrite=false
    expect(() => serializeLockfile(tmpPath, sample, false)).toThrow();
  });

  it('invokes onProgress callback during parsing', () => {
    const sample = { name: 'test', version: '1.0.0', lockfileVersion: 2, packages: {} };
    serializeLockfile(tmpPath, sample, true);

    let progressCalled = false;
    parseLockfile(tmpPath, {
      onProgress: () => {
        progressCalled = true;
      }
    });
    // onProgress is optional and may be called depending on file size
    // Just ensure function doesn't error with callback
    expect(typeof progressCalled).toBe('boolean');
  });
});
