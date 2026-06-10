// tests/integrity.test.js
import {
  generateIntegrityFromData,
  generateIntegrityFromFile,
  fetchPackumentIntegrity,
  isValidIntegrity,
  isPlaceholder
} from '../../src/integrity.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_FILE = path.join(__dirname, 'test-integrity-file.txt');

// Cleanup
function cleanup() {
  if (fs.existsSync(TEST_FILE)) {
    fs.unlinkSync(TEST_FILE);
  }
}

describe('Integrity Hash Generation', () => {
  afterEach(() => {
    cleanup();
  });

  it('generates consistent integrity hash from data', () => {
    const data = 'test content for hashing';
    const hash1 = generateIntegrityFromData(data);
    const hash2 = generateIntegrityFromData(data);

    expect(hash1).toBe(hash2);
    expect(hash1).toMatch(/^sha512-/);
  });

  it('generates different hashes for different data', () => {
    const hash1 = generateIntegrityFromData('content1');
    const hash2 = generateIntegrityFromData('content2');

    expect(hash1).not.toBe(hash2);
  });

  it('generates integrity from file', () => {
    fs.writeFileSync(TEST_FILE, 'file content', 'utf8');
    const hash = generateIntegrityFromFile(TEST_FILE);

    expect(hash).toMatch(/^sha512-/);
  });

  it('validates correct integrity format', () => {
    const validHashes = [
      'sha512-abcdefg1234567890==',
      'sha256-abcdefg1234567890==',
      'sha512-' + 'A'.repeat(86) + '=='
    ];

    validHashes.forEach(hash => {
      expect(isValidIntegrity(hash)).toBe(true);
    });
  });

  it('rejects invalid integrity format', () => {
    const invalidHashes = [
      null,
      undefined,
      'sha1-abc123',
      'invalid-abc123',
      'sha512-!!!invalid',
      ''
    ];

    invalidHashes.forEach(hash => {
      expect(isValidIntegrity(hash)).toBe(false);
    });
  });

  it('identifies placeholder integrity', () => {
    expect(isPlaceholder('sha512-PLACEHOLDER')).toBe(true);
    expect(isPlaceholder('sha256-PLACEHOLDER')).toBe(true);
    expect(isPlaceholder('PLACEHOLDER')).toBe(true);
    expect(isPlaceholder('sha512-abc123')).toBe(false);
  });

  it('returns null when reading nonexistent file', () => {
    const hash = generateIntegrityFromFile('/nonexistent/file.txt');
    expect(hash).toBeNull();
  });

  it('hashes binary files as raw bytes (not utf8-decoded)', () => {
    // Bytes that are invalid utf8 — a utf8 round-trip would corrupt them
    const binary = Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0xff, 0xfe, 0x80, 0x81]);
    fs.writeFileSync(TEST_FILE, binary);

    const fileHash = generateIntegrityFromFile(TEST_FILE);
    const dataHash = generateIntegrityFromData(binary);

    expect(fileHash).toBe(dataHash);
    expect(fileHash).not.toBe(generateIntegrityFromData(binary.toString('utf8')));
  });

  describe('Edge cases', () => {
    it('handles empty file', () => {
      fs.writeFileSync(TEST_FILE, '', 'utf8');
      const hash = generateIntegrityFromFile(TEST_FILE);
      expect(hash).toMatch(/^sha512-/);
    });

    it('handles large content', () => {
      const largeContent = 'x'.repeat(10000);
      const hash = generateIntegrityFromData(largeContent);
      expect(hash).toMatch(/^sha512-/);
    });

    it('handles special characters', () => {
      const specialContent = '{"name":"test","version":"1.0.0","unicode":"€"}';
      const hash = generateIntegrityFromData(specialContent);
      expect(hash).toMatch(/^sha512-/);
    });

    it('handles multiline content', () => {
      const multilineContent = 'line1\nline2\nline3\n';
      const hash = generateIntegrityFromData(multilineContent);
      expect(hash).toMatch(/^sha512-/);
    });
  });
});

describe('fetchPackumentIntegrity', () => {
  // Injectable transport that records the requested URL and replies with a packument
  function fakeTransport(reply) {
    const calls = [];
    const fetchJson = async (url, timeoutMs) => {
      calls.push({ url, timeoutMs });
      if (reply instanceof Error) throw reply;
      return reply;
    };
    return { fetchJson, calls };
  }

  it('returns dist.integrity from the packument', async () => {
    const { fetchJson, calls } = fakeTransport({ dist: { integrity: 'sha512-REAL==' } });
    const hash = await fetchPackumentIntegrity('lodash', '4.17.21', { fetchJson });
    expect(hash).toBe('sha512-REAL==');
    expect(calls[0].url).toBe('https://registry.npmjs.org/lodash/4.17.21');
    expect(calls[0].timeoutMs).toBe(10000);
  });

  it('encodes scoped names with %2f and respects registryBase', async () => {
    const { fetchJson, calls } = fakeTransport({ dist: { integrity: 'sha512-SCOPED==' } });
    const hash = await fetchPackumentIntegrity('@babel/core', '7.0.0', {
      registryBase: 'https://npm.example.com/registry/',
      fetchJson
    });
    expect(hash).toBe('sha512-SCOPED==');
    expect(calls[0].url).toBe('https://npm.example.com/registry/@babel%2fcore/7.0.0');
  });

  it('passes a custom timeout to the transport', async () => {
    const { fetchJson, calls } = fakeTransport({ dist: { integrity: 'sha512-X==' } });
    await fetchPackumentIntegrity('pkg', '1.0.0', { timeoutMs: 250, fetchJson });
    expect(calls[0].timeoutMs).toBe(250);
  });

  it('resolves null when the transport returns null (404)', async () => {
    const { fetchJson } = fakeTransport(null);
    await expect(fetchPackumentIntegrity('not-a-pkg', '1.0.0', { fetchJson })).resolves.toBeNull();
  });

  it('resolves null when dist.integrity is absent', async () => {
    const { fetchJson } = fakeTransport({ dist: { shasum: 'abc' } });
    await expect(fetchPackumentIntegrity('old-pkg', '0.0.1', { fetchJson })).resolves.toBeNull();
  });

  it('propagates transport errors (network failure)', async () => {
    const { fetchJson } = fakeTransport(new Error('ECONNREFUSED'));
    await expect(fetchPackumentIntegrity('pkg', '1.0.0', { fetchJson })).rejects.toThrow('ECONNREFUSED');
  });
});
