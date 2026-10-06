// tests/unit/integrity-registry.test.js
// The registry transport's status and redirect handling (getJson/postJson)
// and the packument helpers layered on top of it.
import http from 'http';
import {
  getJson,
  postJson,
  fetchLatestVersion,
  fetchPackumentManifest,
  generateOrPlaceholderIntegrity
} from '../../src/integrity.js';

describe('registry transport status and redirect handling', () => {
  let server;
  let baseUrl;
  let handler;

  beforeEach(async () => {
    server = http.createServer((req, res) => handler(req, res));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  function redirectOnce(location) {
    return (req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { Location: location });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, url: req.url }));
    };
  }

  it('getJson resolves null on a 404', async () => {
    handler = (req, res) => {
      res.writeHead(404);
      res.end('not found');
    };
    await expect(getJson(`${baseUrl}/missing`, 5000)).resolves.toBeNull();
  });

  it('getJson rejects with the status on any other non-200', async () => {
    handler = (req, res) => {
      res.writeHead(503);
      res.end('down');
    };
    await expect(getJson(`${baseUrl}/pkg`, 5000)).rejects.toThrow(/status 503/);
  });

  it('getJson follows a same-host redirect', async () => {
    handler = redirectOnce('/final');
    await expect(getJson(`${baseUrl}/start`, 5000)).resolves.toEqual({ method: 'GET', url: '/final' });
  });

  it('postJson follows a same-host redirect and re-sends the POST', async () => {
    handler = redirectOnce('/final');
    await expect(postJson(`${baseUrl}/start`, { a: 1 }, 5000)).resolves.toEqual({ method: 'POST', url: '/final' });
  });

  it('getJson does not follow a redirect once the hop budget is spent', async () => {
    handler = redirectOnce('/final');
    await expect(getJson(`${baseUrl}/start`, 5000, 0)).rejects.toThrow(/status 302/);
  });

  it('getJson refuses a cross-host redirect', async () => {
    handler = redirectOnce(`http://localhost:${server.address().port}/final`);
    await expect(getJson(`${baseUrl}/start`, 5000)).rejects.toThrow(/refusing cross-host redirect to localhost/);
  });

  it('getJson rejects an unparseable redirect location', async () => {
    handler = redirectOnce('http://[');
    await expect(getJson(`${baseUrl}/start`, 5000)).rejects.toThrow(/Invalid redirect location "http:\/\/\["/);
  });

  it('getJson rejects when the server stays silent past the idle timeout', async () => {
    handler = () => {};
    await expect(getJson(`${baseUrl}/slow`, 50, 1, { deadlineMs: 5000 })).rejects.toThrow(/timed out after 50ms/);
  });

  it('getJson rejects (does not throw synchronously) on an unsupported URL scheme', async () => {
    await expect(getJson('ftp://127.0.0.1/pkg', 5000)).rejects.toThrow();
  });
});

describe('fetchLatestVersion', () => {
  const transport = (reply) => () => Promise.resolve(reply);

  it('returns the latest dist-tag', async () => {
    const fetchJson = transport({ 'dist-tags': { latest: '2.3.4' } });
    await expect(fetchLatestVersion('left-pad', { fetchJson })).resolves.toBe('2.3.4');
  });

  it('returns null when the package is unknown, has no dist-tags, or the tag is not a string', async () => {
    await expect(fetchLatestVersion('left-pad', { fetchJson: transport(null) })).resolves.toBeNull();
    await expect(fetchLatestVersion('left-pad', { fetchJson: transport({}) })).resolves.toBeNull();
    await expect(fetchLatestVersion('left-pad', { fetchJson: transport({ 'dist-tags': { latest: 7 } }) })).resolves.toBeNull();
  });
});

describe('fetchPackumentManifest', () => {
  it('requests the version manifest URL and returns it verbatim', async () => {
    const calls = [];
    const manifest = { name: 'left-pad', version: '1.3.0', dist: { integrity: 'sha512-X==' } };
    const fetchJson = (url, timeoutMs) => {
      calls.push([url, timeoutMs]);
      return Promise.resolve(manifest);
    };
    const result = await fetchPackumentManifest('left-pad', '1.3.0', { registryBase: 'https://registry.example.test', timeoutMs: 1234, fetchJson });
    expect(result).toBe(manifest);
    expect(calls).toEqual([['https://registry.example.test/left-pad/1.3.0', 1234]]);
  });
});

describe('generateOrPlaceholderIntegrity', () => {
  it('returns the placeholder for a missing or non-object package', async () => {
    await expect(generateOrPlaceholderIntegrity(null)).resolves.toBe('sha512-PLACEHOLDER');
    await expect(generateOrPlaceholderIntegrity('left-pad')).resolves.toBe('sha512-PLACEHOLDER');
  });

  it('keeps an integrity the package already has', async () => {
    await expect(generateOrPlaceholderIntegrity({ name: 'a', version: '1.0.0', integrity: 'sha512-REAL==' })).resolves.toBe('sha512-REAL==');
  });

  it('returns the placeholder without touching the registry unless tryRegistry is set', async () => {
    await expect(generateOrPlaceholderIntegrity({ name: 'a', version: '1.0.0' })).resolves.toBe('sha512-PLACEHOLDER');
  });

  it('returns the placeholder when tryRegistry is set but the package has no name or version', async () => {
    await expect(generateOrPlaceholderIntegrity({ name: 'a' }, { tryRegistry: true })).resolves.toBe('sha512-PLACEHOLDER');
    await expect(generateOrPlaceholderIntegrity({ version: '1.0.0' }, { tryRegistry: true })).resolves.toBe('sha512-PLACEHOLDER');
  });
});
