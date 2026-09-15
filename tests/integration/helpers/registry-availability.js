// tests/integration/helpers/registry-availability.js
//
// A PREREQUISITE probe, not an assertion softener.
//
// Two integration suites genuinely need a live package registry: the `npm ci`
// migration suite (it installs the fixture twice and diffs node_modules) and
// the fix-checksums suite (it re-fetches an integrity hash from the registry
// the lockfile's `resolved` URL names). Neither can run on an air-gapped
// machine, in a sandbox that blocks registry.npmjs.org, or behind a proxy that
// refuses it.
//
// The honest behaviour there is to SKIP naming the unmet prerequisite, never to
// relax the assertion: a test that stops checking is worse than one that fails
// loudly. So the skip reason is carried into the Jest suite title — a skipped
// suite reads `… — SKIPPED: registry https://registry.npmjs.org/ is
// unreachable (getaddrinfo ENOTFOUND registry.npmjs.org)`, not a silent `○`.
//
// The probe is deliberately SYNCHRONOUS (a child `node` process), because Jest
// has no runtime skip: `describe`/`test` selection has to happen while the test
// file is still being evaluated. It is cached per URL, so a file that probes
// the same URL twice pays for one request.
//
// It requests exactly the URL the code under test will request — an anonymous
// GET, no credentials — so a 401/403/404/timeout/DNS failure all count as "this
// registry cannot serve this test", which is the question being asked.

import { execFileSync } from 'child_process';

const PROBE_TIMEOUT_MS = 10000;
const cache = new Map();

// Runs in a child `node`; prints `OK` on a 2xx and `FAIL <reason>` otherwise.
// Redirects are followed (a registry mirror or CDN commonly 302s a tarball), so
// a redirect is never mistaken for an unreachable host.
const PROBE_SOURCE = `
const https = require('https');
const http = require('http');
const timeoutMs = Number(process.argv[2]);
const done = (msg) => { process.stdout.write(msg); process.exit(0); };
const get = (url, hops) => {
  if (hops > 5) return done('FAIL too many redirects');
  const client = url.startsWith('http://') ? http : https;
  const req = client.get(url, { timeout: timeoutMs }, (res) => {
    const code = res.statusCode;
    if (code >= 300 && code < 400 && res.headers.location) {
      res.resume();
      return get(new URL(res.headers.location, url).toString(), hops + 1);
    }
    res.resume();
    if (code >= 200 && code < 300) done('OK');
    else done('FAIL HTTP ' + code + ' ' + (res.statusMessage || ''));
  });
  req.on('timeout', () => { req.destroy(); done('FAIL timed out after ' + timeoutMs + 'ms'); });
  req.on('error', (err) => done('FAIL ' + (err.message || String(err))));
};
get(process.argv[1], 0);
`;

/**
 * Probe one registry URL.
 * @param {string} url - The exact URL the code under test will fetch.
 * @returns {string|null} null when reachable, else a human reason.
 */
export function registryUnavailableReason(url) {
  if (cache.has(url)) return cache.get(url);

  let reason = null;
  try {
    const out = execFileSync(
      process.execPath,
      ['-e', PROBE_SOURCE, url, String(PROBE_TIMEOUT_MS)],
      { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS + 5000, stdio: ['ignore', 'pipe', 'pipe'] }
    ).trim();
    if (out !== 'OK') {
      reason = `${url} is unreachable (${out.replace(/^FAIL /, '')})`;
    }
  } catch (err) {
    reason = `${url} could not be probed (${err.message})`;
  }

  cache.set(url, reason);
  return reason;
}

/**
 * Suite gate: a `describe` (or `describe.skip`) plus a title that states the
 * unmet prerequisite when the suite is skipped.
 *
 * @param {string} title - The suite title when the registry is available.
 * @param {string} url - The exact URL the code under test will fetch.
 * @returns {{describe: Function, title: string, reason: string|null}}
 */
export function describeWithRegistry(title, url) {
  const reason = registryUnavailableReason(url);
  return {
    describe: reason ? global.describe.skip : global.describe,
    title: reason ? `${title} — SKIPPED: registry ${reason}` : title,
    reason
  };
}
