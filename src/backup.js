// src/backup.js
import fs from 'fs';
import path from 'path';

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

const BACKUPS_DIR = '.backups';

/**
 * Create a backup directory if it doesn't exist
 * @throws {BackupError} If directory creation fails
 */
function ensureBackupsDir() {
  try {
    if (!fs.existsSync(BACKUPS_DIR)) {
      fs.mkdirSync(BACKUPS_DIR, { recursive: true });
    }
  } catch (e) {
    throw new BackupError(`Failed to create backups directory: ${e.message}`);
  }
}

/**
 * Create a timestamped backup of a file
 * @param {string} filePath - Path to the file to backup
 * @returns {string} Path to the backup file
 * @throws {BackupError} If backup creation fails
 */
export function createBackup(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new BackupError(`File not found: ${filePath}`);
  }

  try {
    ensureBackupsDir();

    const fileName = path.basename(filePath);
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5); // YYYY-MM-DDTHH-mm-ss
    const backupFileName = `${fileName}.${timestamp}.bak`;
    const backupPath = path.join(BACKUPS_DIR, backupFileName);

    const content = fs.readFileSync(filePath, 'utf8');
    fs.writeFileSync(backupPath, content, 'utf8');

    return backupPath;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(`Failed to create backup: ${e.message}`);
  }
}

/**
 * List all backups for a given file
 * @param {string} fileName - Name of the file (e.g., 'package-lock.json')
 * @returns {Array} Array of backup file info { name, path, timestamp }
 * @throws {BackupError} If backup listing fails
 */
export function listBackups(fileName) {
  try {
    ensureBackupsDir();

    if (!fs.existsSync(BACKUPS_DIR)) {
      return [];
    }

    const files = fs.readdirSync(BACKUPS_DIR);
    const backups = files
      .filter(f => f.startsWith(fileName))
      .map(f => {
        const backupPath = path.join(BACKUPS_DIR, f);
        const stats = fs.statSync(backupPath);
        // Parse "<name>.<timestamp>.bak" without a backtracking-prone regex:
        // strip the ".bak" suffix, then take everything after the first dot.
        let timestamp = 'unknown';
        if (f.endsWith('.bak')) {
          const withoutExt = f.slice(0, -4);
          const firstDot = withoutExt.indexOf('.');
          if (firstDot !== -1) timestamp = withoutExt.slice(firstDot + 1);
        }
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
    if (e instanceof BackupError) throw e;
    throw new BackupError(`Failed to list backups: ${e.message}`);
  }
}

/**
 * Restore a file from its most recent backup
 * @param {string} filePath - Path to the file to restore
 * @returns {boolean} True if restoration was successful
 * @throws {BackupError} If restoration fails
 */
export function restoreFromLatestBackup(filePath) {
  try {
    const fileName = path.basename(filePath);
    const backups = listBackups(fileName);

    if (backups.length === 0) {
      throw new BackupError(`No backups found for ${fileName}`);
    }

    const latestBackup = backups[0];
    const backupContent = fs.readFileSync(latestBackup.path, 'utf8');
    fs.writeFileSync(filePath, backupContent, 'utf8');

    console.log(`Restored ${fileName} from backup: ${latestBackup.name}`);
    return true;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(`Failed to restore backup: ${e.message}`);
  }
}

/**
 * Clean old backups, keeping only the most recent N
 * @param {string} fileName - Name of the file
 * @param {number} keepCount - Number of backups to keep (default: 5)
 * @returns {number} Number of backups deleted
 * @throws {BackupError} If cleanup fails
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
    if (e instanceof BackupError) throw e;
    throw new BackupError(`Failed to clean old backups: ${e.message}`);
  }
}

export default { createBackup, listBackups, restoreFromLatestBackup, cleanOldBackups, BackupError };
