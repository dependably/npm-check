// tests/unit/vuln-range-matching.test.js
// Version matching against an advisory range when two versions of one name
// are locked (semver precedence incl. prereleases, every comparator
// operator), and the default bulk-advisory transport against a local server.
import http from 'http';
import { checkVulnerabilities } from '../../src/vuln.js';

const HASH = 'sha512-' + 'A'.repeat(86) + '==';
const reg = 'https://registry.npmjs.org';

function lockfileWith(packages) {
  return {
    name: 'demo', version: '1.0.0', lockfileVersion: 3,
    packages: { '': { name: 'demo', version: '1.0.0' }, ...packages }
  };
}

function twoVersionsOfFoo(a, b) {
  return lockfileWith({
    'node_modules/foo': { version: a, resolved: `${reg}/foo/-/foo-${a}.tgz`, integrity: HASH },
    'node_modules/legacy/node_modules/foo': { version: b, resolved: `${reg}/foo/-/foo-${b}.tgz`, integrity: HASH }
  });
}

async function scan(range, a, b) {
  return checkVulnerabilities(twoVersionsOfFoo(a, b), {
    fetchAdvisories: () => Promise.resolve({
      foo: [{ id: 1, title: 'Bug', severity: 'critical', vulnerable_versions: range, url: 'https://example.test/advisory/1' }]
    })
  });
}

describe('advisory range matching across two locked versions', () => {
  it.each([
    ['<1.0.0-beta', '1.0.0-alpha.1', '1.0.0', ['1.0.0-alpha.1']],
    ['<1.0.0', '1.0.0-rc.1', '1.0.0', ['1.0.0-rc.1']],
    ['<1.0.0-alpha', '1.0.0-1', '1.0.0-beta', ['1.0.0-1']],
    ['>1.0.0-5', '1.0.0-alpha', '1.0.0-2', ['1.0.0-alpha']],
    ['<1.0.0-10', '1.0.0-9', '1.0.0-11', ['1.0.0-9']],
    ['<=1.0.0-rc.1', '1.0.0-rc.1', '1.0.0-rc.1.1', ['1.0.0-rc.1']],
    ['>1.0.0-rc.1', '1.0.0-rc.1', '1.0.0-rc.1.1', ['1.0.0-rc.1.1']],
    ['>=2.0.0', '2.0.0', '1.9.9', ['2.0.0']],
    ['>1.4.0', '1.4.0', '1.4.1', ['1.4.1']],
    ['<=1.4.0', '1.4.0', '1.5.0', ['1.4.0']],
    ['=1.2.3', '1.2.3', '1.2.4', ['1.2.3']],
    ['1.2.3', '1.2.3', '2.2.3', ['1.2.3']],
    ['>=1.0.0 <1.2.0', '1.1.9', '1.2.0', ['1.1.9']]
  ])('range %s flags only the covered version of %s and %s', async (range, a, b, flagged) => {
    const result = await scan(range, a, b);
    expect(result.errors.map((e) => e.version)).toEqual(flagged);
    expect(result.vulnerable).toBe(1);
    expect(result.clean).toBe(1);
    expect(result.warnings).toHaveLength(0);
  });

  it('a wildcard range covers both versions', async () => {
    const result = await scan('*', '1.0.0', '2.0.0');
    expect(result.errors.map((e) => e.version).sort()).toEqual(['1.0.0', '2.0.0']);
  });

  it('a locked version that is not semver is reported as a warning, not an error', async () => {
    const result = await scan('<2.0.0', '1.0.0', 'not-a-version');
    expect(result.errors.map((e) => e.version)).toEqual(['1.0.0']);
    expect(result.warnings.map((w) => w.version)).toEqual(['not-a-version']);
  });

  it('an advisory without a range is a warning for every version', async () => {
    const result = await scan(undefined, '1.0.0', '2.0.0');
    expect(result.errors).toHaveLength(0);
    expect(result.warnings).toHaveLength(2);
    expect(result.valid).toBe(true);
  });
});

describe('default bulk advisory transport', () => {
  let server;
  let baseUrl;
  let requests;

  beforeEach(async () => {
    requests = [];
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        requests.push({ method: req.method, url: req.url, body: JSON.parse(body) });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ bad: [{ id: 7, title: 'Bug', severity: 'high', vulnerable_versions: '*', url: 'https://example.test/advisory/7' }] }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  it('POSTs name to versions to the bulk endpoint of the default registry, trailing slashes stripped', async () => {
    const lockfile = lockfileWith({
      'node_modules/bad': { version: '1.0.0', integrity: HASH },
      'node_modules/good': { version: '3.1.0', integrity: HASH }
    });
    const result = await checkVulnerabilities(lockfile, { defaultRegistry: `${baseUrl}//` });
    expect(requests).toEqual([
      { method: 'POST', url: '/-/npm/v1/security/advisories/bulk', body: { bad: ['1.0.0'], good: ['3.1.0'] } }
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors.map((e) => [e.package, e.version])).toEqual([['bad', '1.0.0']]);
    expect(result.clean).toBe(1);
  });
});
