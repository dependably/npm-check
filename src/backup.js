// src/backup.js
import fs from 'fs';
import path from 'path';

const BACKUPS_DIR = '.backups';

/**
 * Create a backup directory if it doesn't exist
 */
function ensureBackupsDir() {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

/**
 * Create a timestamped backup of a file
 * @param {string} filePath - Path to the file to backup
 * @returns {string} Path to the backup file, or null if backup failed
 */
export function createBackup(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    ensureBackupsDir();

    const fileName = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5); // YYYY-MM-DDTHH-mm-ss
    const backupFileName = `${fileName}.${timestamp}.bak`;
    const backupPath = path.join(BACKUPS_DIR, backupFileName);

    const content = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(backupPath, content, 'utf8');

    return backupPath;
  } catch (e) {
    console.error(`Failed to create backup: ${e.message}`);
    return null;
  }
}

/**
 * List all backups for a given file
 * @param {string} fileName - Name of the file (e.g., 'package-lock.json')
 * @returns {Array} Array of backup file info { name, path, timestamp }
 */
export function listBackups(fileName) {
  try {
    ensureBackupsDir();

    const files = fs.readdirSync(BACKUPS_DIR);
    const backups = files
      .filter(f => f.startsWith(fileName))
      .map(f => {
        const backupPath = path.join(BACKUPS_DIR, f);
        const stats = fs.statSync(backupPath);
        const match = f.match(/\.(.+)\.bak$/);
        const timestamp = match ? match[1] : 'unknown';
        return {
          name: f,
          path: backupPath,
          timestamp,
          created: stats.mtime
        };
      })
      .sort((a, b) => b.created - a.created);

    return backups;
  } catch (e) {
    console.error(`Failed to list backups: ${e.message}`);
    return [];
  }
}

/**
 * Restore a file from its most recent backup
 * @param {string} filePath - Path to the file to restore
 * @returns {boolean} True if restoration was successful
 */
export function restoreFromLatestBackup(filePath) {
  try {
    const fileName = path.basename(filePath);
    const backups = listBackups(fileName);

    if (backups.length === 0) {
      throw new Error(`No backups found for ${fileName}`);
    }

    const latestBackup = backups[0];
    const backupContent = fs.readFileSync(latestBackup.path, 'utf8');
    fs.writeFileSync(filePath, backupContent, 'utf8');

    console.log(`Restored ${fileName} from backup: ${latestBackup.name}`);
    return true;
  } catch (e) {
    console.error(`Failed to restore backup: ${e.message}`);
    return false;
  }
}

/**
 * Clean old backups, keeping only the most recent N
 * @param {string} fileName - Name of the file
 * @param {number} keepCount - Number of backups to keep (default: 5)
 * @returns {number} Number of backups deleted
 */
export function cleanOldBackups(fileName, keepCount = 5) {
  try {
    ensureBackupsDir();

    const backups = listBackups(fileName);
    if (backups.length <= keepCount) {
      return 0;
    }

    const toDelete = backups.slice(keepCount);
    let deleted = 0;

    for (const backup of toDelete) {
      fs.unlinkSync(backup.path);
      deleted++;
    }

    return deleted;
  } catch (e) {
    console.error(`Failed to clean old backups: ${e.message}`);
    return 0;
  }
}
