import fs from 'fs/promises';
import path from 'path';

/**
 * Capture node_modules state
 * @param {string} projectDir - Project directory
 * @returns {Promise<{packages: Object, packageCount: number}>}
 */
export async function captureNodeModulesState(projectDir) {
  const nodeModulesDir = path.join(projectDir, 'node_modules');

  if (!await exists(nodeModulesDir)) {
    return { packages: {}, packageCount: 0 };
  }

  const packages = {};

  await walkNodeModules(nodeModulesDir, async (pkgPath) => {
    const packageJsonPath = path.join(pkgPath, 'package.json');
    if (await exists(packageJsonPath)) {
      const packageJson = JSON.parse(await fs.readFile(packageJsonPath, 'utf8'));
      const relativePath = path.relative(nodeModulesDir, pkgPath);

      packages[relativePath] = {
        name: packageJson.name,
        version: packageJson.version,
        main: packageJson.main,
        bin: packageJson.bin
      };
    }
  });

  return {
    packages,
    packageCount: Object.keys(packages).length
  };
}

/**
 * Compare two node_modules states
 * @param {Object} state1 - First node_modules state
 * @param {Object} state2 - Second node_modules state
 * @returns {Object} Comparison result
 */
export function compareNodeModulesStates(state1, state2) {
  const packages1 = Object.keys(state1.packages).sort();
  const packages2 = Object.keys(state2.packages).sort();

  const missingInV3 = packages1.filter(p => !state2.packages[p]);
  const extraInV3 = packages2.filter(p => !state1.packages[p]);

  const versionMismatches = [];
  for (const pkgPath of packages1) {
    if (state2.packages[pkgPath]) {
      const v1 = state1.packages[pkgPath].version;
      const v2 = state2.packages[pkgPath].version;
      if (v1 !== v2) {
        versionMismatches.push({
          package: pkgPath,
          v2Version: v1,
          v3Version: v2
        });
      }
    }
  }

  return {
    identical: missingInV3.length === 0 &&
               extraInV3.length === 0 &&
               versionMismatches.length === 0,
    missingInV3,
    extraInV3,
    versionMismatches,
    v2Count: packages1.length,
    v3Count: packages2.length
  };
}

/**
 * Walk node_modules directory
 * @private
 */
async function walkNodeModules(dir, callback) {
  const entries = await fs.readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === '.bin') continue;

    const fullPath = path.join(dir, entry.name);

    // Handle scoped packages
    if (entry.name.startsWith('@')) {
      const scopedEntries = await fs.readdir(fullPath, { withFileTypes: true });
      for (const scopedEntry of scopedEntries) {
        if (scopedEntry.isDirectory()) {
          await callback(path.join(fullPath, scopedEntry.name));
        }
      }
    } else {
      await callback(fullPath);
    }
  }
}

/**
 * Check if file/directory exists
 * @private
 */
async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
