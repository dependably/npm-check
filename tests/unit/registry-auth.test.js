// tests/unit/registry-auth.test.js
// .npmrc credential resolution (registry-auth.js), the transport sending it
// (getJson/postJson), and pnpm registry resolution reading the user .npmrc.
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { parseNpmrc } from '../../src/npmrc-validator.js';
import { createRegistryAuth, expandEnvRefs, loadRegistryAuth } from '../../src/registry-auth.js';
import { getJson, postJson } from '../../src/integrity.js';
import { parseLockfile } from '../../src/parser.js';
import { checkIntegrity } from '../../src/checker.js';
import { checkVulnerabilities } from '../../src/vuln.js';
import { checkDeprecations } from '../../src/deprecation.js';

const auth = (content, env = {}) => createRegistryAuth([parseNpmrc(content)], env);

describe('createRegistryAuth', () => {
  it('sends a bearer token only to URLs under its nerf dart', () => {
    const a = auth('//registry.example/npm/:_authToken=tok');
    expect(a.authFor('https://registry.example/npm/lodash/4.17.21')).toBe('Bearer tok');
    expect(a.authFor('https://registry.example/npm/-/npm/v1/security/advisories/bulk')).toBe('Bearer tok');
    expect(a.authFor('https://registry.example/other/lodash')).toBeNull();
    expect(a.authFor('https://evil.example/npm/lodash')).toBeNull();
    expect(a.authFor('https://registry.example.evil.test/npm/lodash')).toBeNull();
  });

  it('accepts a nerf dart written without the trailing slash', () => {
    expect(auth('//registry.example/npm:_authToken=tok').authFor('https://registry.example/npm/x')).toBe('Bearer tok');
  });

  it('prefers the longest matching prefix', () => {
    const a = auth('//registry.example/:_authToken=host\n//registry.example/npm/:_authToken=npm');
    expect(a.authFor('https://registry.example/npm/x')).toBe('Bearer npm');
    expect(a.authFor('https://registry.example/pypi/x')).toBe('Bearer host');
  });

  it('matches the port as part of the host', () => {
    const a = auth('//registry.example:8443/:_authToken=tok');
    expect(a.authFor('https://registry.example:8443/x')).toBe('Bearer tok');
    expect(a.authFor('https://registry.example/x')).toBeNull();
  });

  it('never sends a credential over plaintext http', () => {
    expect(auth('//registry.example/:_authToken=tok').authFor('http://registry.example/x')).toBeNull();
  });

  it('cannot be steered by a path that escapes the prefix', () => {
    const a = auth('//registry.example/npm/:_authToken=tok');
    expect(a.authFor('https://registry.example/npm/../admin/x')).toBeNull();
  });

  it('ignores unscoped legacy credentials, which name no host', () => {
    expect(auth('_authToken=tok\n_auth=dXNlcjpwYXNz').authFor('https://registry.npmjs.org/x')).toBeNull();
  });

  it('builds basic auth from _auth and from username + base64 _password', () => {
    expect(auth('//r.example/:_auth=dXNlcjpwYXNz').authFor('https://r.example/x')).toBe('Basic dXNlcjpwYXNz');
    const pw = Buffer.from('s3cret').toString('base64');
    const header = auth(`//r.example/:username=bob\n//r.example/:_password=${pw}`).authFor('https://r.example/x');
    expect(header).toBe(`Basic ${Buffer.from('bob:s3cret').toString('base64')}`);
  });

  it('expands ${VAR} references and drops a credential whose variable is unset', () => {
    expect(auth('//r.example/:_authToken=${TOKEN}', { TOKEN: 'abc' }).authFor('https://r.example/x')).toBe('Bearer abc');
    expect(auth('//r.example/:_authToken=${TOKEN}', {}).authFor('https://r.example/x')).toBeNull();
  });

  it('lets a later layer (the project) override an earlier one (the user)', () => {
    const a = createRegistryAuth([
      parseNpmrc('//r.example/:_authToken=user'),
      parseNpmrc('//r.example/:_authToken=project')
    ], {});
    expect(a.authFor('https://r.example/x')).toBe('Bearer project');
  });

  it('lists credentialed hosts without exposing the credentials', () => {
    const a = auth('//r.example/npm/:_authToken=supersecret');
    expect(a.hosts).toEqual(['r.example']);
    expect(JSON.stringify(a)).not.toContain('supersecret');
  });
});

describe('expandEnvRefs', () => {
  it('leaves a value without references unchanged', () => {
    expect(expandEnvRefs('https://r.example/', {})).toBe('https://r.example/');
  });

  it('returns null when any referenced variable is empty', () => {
    expect(expandEnvRefs('${A}-${B}', { A: 'x', B: '' })).toBeNull();
  });
});

describe('loadRegistryAuth and pnpm registry resolution read the user .npmrc', () => {
  let dir;
  let userrc;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-check-auth-'));
    userrc = path.join(dir, 'user.npmrc');
    fs.mkdirSync(path.join(dir, 'proj'));
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('combines the user file with the project file, project winning', () => {
    fs.writeFileSync(userrc, '//u.example/:_authToken=${UTOKEN}\n//p.example/:_authToken=user\n');
    fs.writeFileSync(path.join(dir, 'proj', '.npmrc'), '//p.example/:_authToken=project\n');
    const a = loadRegistryAuth({ projectDir: path.join(dir, 'proj'), env: { NPM_CONFIG_USERCONFIG: userrc, UTOKEN: 'ut' } });
    expect(a.authFor('https://u.example/x')).toBe('Bearer ut');
    expect(a.authFor('https://p.example/x')).toBe('Bearer project');
  });

  it('tolerates missing files', () => {
    const a = loadRegistryAuth({ projectDir: path.join(dir, 'proj'), env: { NPM_CONFIG_USERCONFIG: path.join(dir, 'none') } });
    expect(a.authFor('https://r.example/x')).toBeNull();
  });

  it('takes the pnpm registry from the user .npmrc when the project sets none', () => {
    // CI commonly writes the registry to $HOME/.npmrc rather than committing it.
    fs.writeFileSync(userrc, 'registry=${REG}\n@corp:registry=https://corp.example/\n');
    const lock = path.join(dir, 'proj', 'pnpm-lock.yaml');
    fs.writeFileSync(lock, "lockfileVersion: '9.0'\nimporters:\n  .: {}\n");
    const env = { NPM_CONFIG_USERCONFIG: userrc, REG: 'https://mirror.example/npm/' };
    expect(parseLockfile(lock, { env }).__npmCheckMeta).toMatchObject({
      registry: 'https://mirror.example/npm/',
      scopedRegistries: { '@corp': 'https://corp.example/' }
    });

    fs.writeFileSync(path.join(dir, 'proj', '.npmrc'), 'registry=https://project.example/\n');
    expect(parseLockfile(lock, { env }).__npmCheckMeta.registry).toBe('https://project.example/');
  });
});

describe('registry transport sends the resolved Authorization header', () => {
  let server;
  let baseUrl;
  let seen;

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ url: req.url, authorization: req.headers.authorization });
      if (req.url === '/start') {
        res.writeHead(302, { Location: '/landed' });
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('adds the header on GET and POST', async () => {
    const authFor = () => 'Bearer t';
    await getJson(`${baseUrl}/pkg`, 2000, 1, { authFor });
    await postJson(`${baseUrl}/bulk`, { a: ['1.0.0'] }, 2000, 1, { authFor });
    expect(seen.map((s) => s.authorization)).toEqual(['Bearer t', 'Bearer t']);
  });

  it('sends no header when there is no resolver', async () => {
    await getJson(`${baseUrl}/pkg`, 2000);
    expect(seen[0].authorization).toBeUndefined();
  });

  it('re-resolves the credential for a redirect target', async () => {
    const authFor = (url) => (url.endsWith('/start') ? 'Bearer start' : null);
    await getJson(`${baseUrl}/start`, 2000, 1, { authFor });
    expect(seen).toEqual([
      { url: '/start', authorization: 'Bearer start' },
      { url: '/landed', authorization: undefined }
    ]);
  });
});

describe('registry-backed scans pass registryAuth to the default transport', () => {
  const HASH = 'sha512-' + 'A'.repeat(86) + '==';
  let server;
  let baseUrl;
  let seen;

  beforeEach(async () => {
    seen = [];
    server = http.createServer((req, res) => {
      seen.push({ method: req.method, url: req.url, authorization: req.headers.authorization });
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(req.method === 'POST' ? '{}' : JSON.stringify({ dist: { integrity: HASH } }));
      });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  it('integrity, vuln and deprecation requests all carry the credential', async () => {
    const lockfile = {
      name: 'demo', version: '1.0.0', lockfileVersion: 3,
      packages: {
        '': { name: 'demo', version: '1.0.0' },
        'node_modules/foo': { version: '1.0.0', resolved: `${baseUrl}/foo/-/foo-1.0.0.tgz`, integrity: HASH }
      }
    };
    const registryAuth = { authFor: () => 'Bearer scan' };
    const integrity = await checkIntegrity(lockfile, { registryAuth, timeoutMs: 2000 });
    expect(integrity.passed).toBe(1);
    await checkVulnerabilities(lockfile, { registryAuth, timeoutMs: 2000 });
    await checkDeprecations(lockfile, { registryAuth, timeoutMs: 2000 });
    expect(seen.map((s) => s.method).sort()).toEqual(['GET', 'GET', 'POST']);
    expect(seen.every((s) => s.authorization === 'Bearer scan')).toBe(true);
  });
});
