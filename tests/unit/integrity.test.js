// tests/integrity.test.js
import {
  generateIntegrityFromData,
  generateIntegrityFromFile,
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
