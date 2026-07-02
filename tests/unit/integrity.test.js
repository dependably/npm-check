// tests/integrity.test.js
import {
  generateIntegrityFromData,
  generateIntegrityFromFile,
  fetchPackumentIntegrity,
  fetchPackument,
  deriveRegistryBase,
  getJson,
  postJson,
  isValidIntegrity,
  isPlaceholder
} from '../../src/integrity.js';
import fs from 'fs';
import http from 'http';
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

// Regression: issue #30 — packumentVersionUrl / fetchPackument under-encoded
// scoped names (only the first '/' → %2f, nothing else), letting a lockfile-
// controlled name inject extra path segments or a query string onto the registry.
describe('registry URL name encoding (issue #30)', () => {
  function captureTransport(reply = { dist: { integrity: 'sha512-OK==' } }) {
    const calls = [];
    const fetchJson = async (url, timeoutMs) => {
      calls.push({ url, timeoutMs });
      return reply;
    };
    return { fetchJson, calls };
  }

  it('rejects a scoped name that smuggles extra path segments / a query string', async () => {
    const { fetchJson } = captureTransport();
    // OLD code: replace('/', '%2f') only touches the first slash → the rest of
    // "@a/b/../../-/npm/v1/x?y=1" passes through raw and the transport is called.
    await expect(
      fetchPackumentIntegrity('@a/b/../../-/npm/v1/x?y=1', '1.0.0', { fetchJson })
    ).rejects.toThrow(/Invalid package name/);
  });

  it('rejects a scoped name with an injected query on fetchPackument too', async () => {
    const { fetchJson } = captureTransport({ 'dist-tags': { latest: '1.0.0' } });
    await expect(
      fetchPackument('@evil/pkg?spider=1', { fetchJson })
    ).rejects.toThrow(/Invalid package name/);
  });

  it('rejects an unscoped name containing a slash', async () => {
    const { fetchJson } = captureTransport();
    await expect(
      fetchPackumentIntegrity('a/../secret', '1.0.0', { fetchJson })
    ).rejects.toThrow(/Invalid package name/);
  });

  it('still builds the correct URL for a legitimate scoped name', async () => {
    const { fetchJson, calls } = captureTransport();
    await fetchPackumentIntegrity('@babel/core', '7.0.0', {
      registryBase: 'https://npm.example.com/registry/',
      fetchJson
    });
    expect(calls[0].url).toBe('https://npm.example.com/registry/@babel%2fcore/7.0.0');
  });

  it('tolerates legacy mixed-case names', async () => {
    const { fetchJson, calls } = captureTransport();
    await fetchPackumentIntegrity('JSONStream', '1.3.5', { fetchJson });
    expect(calls[0].url).toBe('https://registry.npmjs.org/JSONStream/1.3.5');
  });
});

// Regression: issue #12 — deriveRegistryBase() derives the fetch host from the
// untrusted lockfile `resolved` URL (SSRF / self-attesting host). An optional
// allowlist lets a caller pin the trusted registry set.
describe('deriveRegistryBase host allowlist (issue #12)', () => {
  const evilResolved = 'https://evil.internal.example/@scope/pkg/-/pkg-1.0.0.tgz';

  it('derives the base with no allowlist (back-compat)', () => {
    expect(deriveRegistryBase(evilResolved, '@scope/pkg')).toBe('https://evil.internal.example');
  });

  it('returns null when the resolved host is outside the allowlist', () => {
    // OLD code ignores the 3rd arg and returns the attacker host regardless.
    expect(
      deriveRegistryBase(evilResolved, '@scope/pkg', { allowedHosts: ['registry.npmjs.org'] })
    ).toBeNull();
  });

  it('derives the base when the host is on the allowlist', () => {
    const ok = 'https://registry.npmjs.org/@scope/pkg/-/pkg-1.0.0.tgz';
    expect(
      deriveRegistryBase(ok, '@scope/pkg', { allowedHosts: ['registry.npmjs.org'] })
    ).toBe('https://registry.npmjs.org');
  });

  it('treats an empty allowlist as "no restriction"', () => {
    expect(
      deriveRegistryBase(evilResolved, '@scope/pkg', { allowedHosts: [] })
    ).toBe('https://evil.internal.example');
  });
});

// Regression: issues #16 & #12 — the shared HTTP transport (getJson/postJson).
describe('HTTP transport hardening (issues #16, #12)', () => {
  let server;
  let baseUrl;
  let handler;

  beforeEach(async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    };
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  // Issue #16 (1): the old https-only transport threw ERR_INVALID_PROTOCOL on an
  // http:// URL, so plaintext (LAN) registries were never fetchable.
  it('getJson fetches over http://', async () => {
    await expect(getJson(baseUrl + '/pkg', 5000)).resolves.toEqual({ ok: true });
  });

  it('postJson fetches over http://', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ posted: true }));
    };
    await expect(postJson(baseUrl + '/bulk', { names: [] }, 5000)).resolves.toEqual({ posted: true });
  });

  // Issue #16 (2): a mid-body socket error is emitted on the response stream, not
  // the request. Without a res 'error' handler this was an uncaught exception that
  // crashed the process; now it rejects the single request.
  it('getJson rejects (does not crash) on a truncated/reset response body', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '1000' });
      res.write('{"partial":');
      // Abruptly kill the socket before Content-Length bytes are delivered.
      res.socket.destroy();
    };
    await expect(getJson(baseUrl + '/pkg', 5000)).rejects.toThrow();
  });

  // Issue #12 (1): response size cap.
  it('getJson rejects when the body exceeds maxBytes', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ blob: 'x'.repeat(500) }));
    };
    await expect(
      getJson(baseUrl + '/pkg', 5000, 1, { maxBytes: 50 })
    ).rejects.toThrow(/exceeded 50 bytes/);
  });

  it('postJson rejects when the body exceeds maxBytes', async () => {
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ blob: 'y'.repeat(500) }));
    };
    await expect(
      postJson(baseUrl + '/bulk', {}, 5000, 1, { maxBytes: 50 })
    ).rejects.toThrow(/exceeded 50 bytes/);
  });

  // Issue #12 (2): wall-clock deadline defeats a byte-trickle that keeps resetting
  // the idle timeout. The idle timeout here (5000ms) would NOT fire; only the
  // wall-clock deadline (50ms) does.
  it('getJson rejects when the wall-clock deadline elapses', async () => {
    handler = (req, res) => {
      // Respond only after 400ms — old code (no deadline) would eventually resolve.
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ slow: true }));
      }, 400);
    };
    await expect(
      getJson(baseUrl + '/pkg', 5000, 1, { deadlineMs: 50 })
    ).rejects.toThrow(/deadline/);
  });
});
