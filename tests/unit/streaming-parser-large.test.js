// tests/unit/streaming-parser-large.test.js
// The chunked (above-threshold) read paths of the buffered lockfile parser:
// they must return the real parsed lockfile, report progress, and reject on
// content that is not a lockfile.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { StreamingParser, parseLockfileStream, parseLockfileStreamSync } from '../../src/streaming-parser.js';

const LOCKFILE = {
  name: 'test-app',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'test-app', version: '1.0.0' },
    'node_modules/lodash': { version: '4.17.21', integrity: 'sha512-test' }
  }
};

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-stream-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function write(name, content) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('parseLockfileStream above the streaming threshold', () => {
  it('parses the buffered content and reports progress up to the file size', async () => {
    const content = JSON.stringify(LOCKFILE, null, 2);
    const file = write('package-lock.json', content);
    const progress = [];
    const result = await parseLockfileStream(file, {
      streamingThreshold: 1,
      onProgress: (bytesRead, total) => progress.push([bytesRead, total])
    });
    expect(result).toEqual(LOCKFILE);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress.at(-1)).toEqual([Buffer.byteLength(content), Buffer.byteLength(content)]);
  });

  it('parses without a progress callback', async () => {
    const file = write('package-lock.json', JSON.stringify(LOCKFILE));
    await expect(parseLockfileStream(file, { streamingThreshold: 1 })).resolves.toEqual(LOCKFILE);
  });

  it('rejects when the content is not valid JSON', async () => {
    const file = write('package-lock.json', '{ "lockfileVersion": 3, ');
    await expect(parseLockfileStream(file, { streamingThreshold: 1 })).rejects.toThrow();
  });
});

describe('parseLockfileStreamSync above the streaming threshold', () => {
  it('returns the same lockfile as the small-file path', () => {
    const file = write('package-lock.json', JSON.stringify(LOCKFILE));
    expect(parseLockfileStreamSync(file, { streamingThreshold: 1 })).toEqual(parseLockfileStreamSync(file));
  });
});

describe('StreamingParser.parseLockfileStream', () => {
  it('resolves the parsed lockfile and reports progress against the total size', async () => {
    const content = JSON.stringify(LOCKFILE);
    const file = write('package-lock.json', content);
    const progress = [];
    const result = await StreamingParser.parseLockfileStream(file, {
      chunkSize: 16,
      onProgress: (bytesRead, total) => progress.push([bytesRead, total])
    });
    expect(result).toEqual(LOCKFILE);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.every(([, total]) => total === Buffer.byteLength(content))).toBe(true);
    expect(progress.at(-1)[0]).toBe(Buffer.byteLength(content));
  });

  it('resolves without a progress callback', async () => {
    const file = write('package-lock.json', JSON.stringify(LOCKFILE));
    await expect(StreamingParser.parseLockfileStream(file)).resolves.toEqual(LOCKFILE);
  });

  it('rejects an empty file instead of resolving an empty lockfile', async () => {
    const file = write('package-lock.json', '  \n');
    await expect(StreamingParser.parseLockfileStream(file)).rejects.toThrow('Cannot parse lockfile: stream produced no data');
  });

  it('rejects content that is not valid JSON', async () => {
    const file = write('package-lock.json', '{ nope');
    await expect(StreamingParser.parseLockfileStream(file)).rejects.toThrow();
  });
});
