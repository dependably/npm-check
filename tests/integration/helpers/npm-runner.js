import { spawn } from 'child_process';

// The registry these integration installs must use.
//
// The fixtures' lockfiles were resolved against the PUBLIC npm registry (every
// `resolved` URL is a registry.npmjs.org one), and the repo's own `.npmrc`
// pins that registry for exactly this reason — contributors commonly have a
// private registry as their user-level default. But `createTestWorkspace`
// builds each workspace under `os.tmpdir()`, OUTSIDE the repo, so that pin does
// not apply there: npm falls back to the user-level default and rewrites the
// lockfile's `resolved` host to it, then fails (`403 Forbidden - GET
// https://<private-host>/npm/glob/-/glob-8.1.0.tgz`). The 403 is NOT "a private
// feed lacks this path" -- that reading was checked and is wrong: the same feed
// serves non-deprecated packages fine. It refuses DEPRECATED versions at the
// tarball layer while still advertising them in its packument, and the fixture
// pins glob@8.1.0, which upstream deprecated. See dependably-community#700.
// Either way the workspace must not be asking that feed for a tarball it locked
// against npmjs, which is what this fixes. Passing `--registry` restores the
// repo's pin for the spawned install instead of inheriting whatever the machine
// happens to default to.
//
// Override with $NPM_CHECK_TEST_REGISTRY to run these against an internal
// mirror of the public registry.
export const TEST_REGISTRY =
  process.env.NPM_CHECK_TEST_REGISTRY || 'https://registry.npmjs.org/';

/**
 * The exact tarball URL `npm ci` fetches for one of the fixture's locked
 * packages — the reachability probe for these suites uses it verbatim.
 * @type {string}
 */
export const TEST_REGISTRY_PROBE_URL =
  `${TEST_REGISTRY.replace(/\/$/, '')}/glob/-/glob-8.1.0.tgz`;

/**
 * Run npm ci in workspace directory
 * @param {string} workspaceDir - Working directory
 * @param {Object} options - Options
 * @param {number} options.timeout - Timeout in milliseconds (default: 120000)
 * @param {Object} options.env - Environment variables to merge
 * @returns {Promise<{stdout: string, stderr: string, exitCode: number}>}
 */
export async function runNpmCi(workspaceDir, options = {}) {
  const {
    timeout = 120000,
    env = {}
  } = options;

  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['ci', '--loglevel=error', `--registry=${TEST_REGISTRY}`], {
      cwd: workspaceDir,
      env: { ...process.env, ...env },
      timeout,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => { stdout += data; });
    child.stderr.on('data', (data) => { stderr += data; });

    child.on('close', (exitCode) => {
      if (exitCode === 0) {
        resolve({ stdout, stderr, exitCode });
      } else {
        const error = new Error(`npm ci failed with exit code ${exitCode}`);
        error.stdout = stdout;
        error.stderr = stderr;
        error.exitCode = exitCode;
        reject(error);
      }
    });

    child.on('error', reject);
  });
}

/**
 * Get npm version
 * @returns {Promise<string>}
 */
export async function getNpmVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn('npm', ['--version']);
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.on('close', () => resolve(output.trim()));
    child.on('error', reject);
  });
}

/**
 * Get Node version
 * @returns {Promise<string>}
 */
export async function getNodeVersion() {
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['--version']);
    let output = '';
    child.stdout.on('data', (data) => { output += data; });
    child.on('close', () => resolve(output.trim()));
    child.on('error', reject);
  });
}
