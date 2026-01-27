import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import os from 'os';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const FIXTURES_DIR = path.join(__dirname, '../../fixtures');

/**
 * Create isolated test workspace
 * @param {string} fixtureName - Name of the fixture to copy
 * @returns {Promise<{dir: string, lockfilePath: string, packageJsonPath: string, cleanup: Function}>}
 */
export async function createTestWorkspace(fixtureName) {
  const workspaceId = `${fixtureName}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'plf-test-'));
  const workspaceDir = path.join(tmpDir, workspaceId);

  await fs.mkdir(workspaceDir, { recursive: true });

  // Copy fixture files
  const fixtureDir = path.join(FIXTURES_DIR, fixtureName);
  await copyRecursive(fixtureDir, workspaceDir);

  return {
    dir: workspaceDir,
    lockfilePath: path.join(workspaceDir, 'package-lock.json'),
    packageJsonPath: path.join(workspaceDir, 'package.json'),

    async cleanup() {
      try {
        await fs.rm(tmpDir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`Cleanup failed: ${err.message}`);
      }
    }
  };
}

/**
 * Clean node_modules directory
 * @param {string} workspaceDir - Workspace directory path
 */
export async function cleanNodeModules(workspaceDir) {
  const nodeModulesPath = path.join(workspaceDir, 'node_modules');
  try {
    await fs.rm(nodeModulesPath, { recursive: true, force: true });
  } catch {
    // Ignore if doesn't exist
  }
}

/**
 * Read JSON file
 * @param {string} filePath - Path to JSON file
 * @returns {Promise<Object>}
 */
export async function readJSON(filePath) {
  const content = await fs.readFile(filePath, 'utf8');
  return JSON.parse(content);
}

/**
 * Write JSON file
 * @param {string} filePath - Path to JSON file
 * @param {Object} data - Data to write
 */
export async function writeJSON(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  await fs.writeFile(filePath, content, 'utf8');
}

/**
 * Copy directory recursively
 * @private
 */
async function copyRecursive(src, dest) {
  const stat = await fs.stat(src);

  if (stat.isDirectory()) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src);

    for (const entry of entries) {
      await copyRecursive(
        path.join(src, entry),
        path.join(dest, entry)
      );
    }
  } else {
    await fs.copyFile(src, dest);
  }
}
