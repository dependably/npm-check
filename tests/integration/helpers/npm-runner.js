import { spawn } from 'child_process';

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
    const child = spawn('npm', ['ci', '--loglevel=error'], {
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
