// src/backup.js
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

export class BackupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BackupError';
  }
}

/**
 * Derive the backup directory for a given source file.
 * Backups live in a `.backups/` sibling directory next to the source file,
 * so they follow the file regardless of the caller's cwd.
 *
 * @param {string} absFilePath - Absolute path to the source file
 * @returns {string} Absolute path to the backup directory
 */
function backupDirFor(absFilePath) {
  return path.join(path.dirname(absFilePath), '.backups');
}

/**
 * A short, stable hex hash of the absolute source path.  Used as part of the
 * backup filename so that two files with the same basename in different
 * directories (e.g. `web/package-lock.json` and `api/package-lock.json`) get
 * distinct backup names and never overwrite each other's history.
 *
 * @param {string} absPath - Absolute path to hash
 * @returns {string} 8-character lowercase hex string
 */
function pathHash(absPath) {
  // Not security-sensitive — just an 8-char discriminator so same-basename files
  // in different directories get distinct backup names. sha256 (over sha1) keeps
  // static analysis happy about weak hashes at zero cost.
  return crypto.createHash('sha256').update(absPath).digest('hex').slice(0, 8);
}

/**
 * Create a backup directory if it doesn't exist.
 *
 * @param {string} dir - Absolute path to the backup directory
 * @throws {BackupError} If directory creation fails
 */
function ensureBackupsDir(dir) {
  try {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  } catch (e) {
    throw new BackupError(`Failed to create backups directory: ${e.message}`);
  }
}

/**
 * Create a timestamped backup of a file.
 *
 * The backup is placed in a `.backups/` directory next to the source file so
 * that backups are always adjacent to what they protect and are not sensitive
 * to the caller's cwd.
 *
 * Filename format: `<basename>.<pathHash8>.<isoTimestampMs>.bak`
 *
 * - `pathHash8` — 8-char hash of the absolute source path, preventing
 *   cross-file collisions when two files share the same basename.
 * - Millisecond-precision ISO timestamp — prevents same-second overwrites.
 * - `wx` open flag — refuses to overwrite an existing file; a monotonically
 *   increasing counter suffix (`.1`, `.2`, …) is appended on the rare
 *   EEXIST collision (e.g. two calls within the same millisecond in tests).
 *
 * @param {string} filePath - Path to the file to backup (absolute or relative)
 * @returns {string} Absolute path to the created backup file
 * @throws {BackupError} If the source file is missing or backup creation fails
 */
export function createBackup(filePath) {
  const absPath = path.resolve(filePath);
  if (!fs.existsSync(absPath)) {
    throw new BackupError(`File not found: ${filePath}`);
  }

  const backupDir = backupDirFor(absPath);
  try {
    ensureBackupsDir(backupDir);

    const basename = path.basename(absPath);
    const hash = pathHash(absPath);
    // ms-precision: YYYY-MM-DDTHH-mm-ss-mmmZ (all colons/dots replaced)
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const baseBackupName = `${basename}.${hash}.${timestamp}.bak`;
    const content = fs.readFileSync(absPath, 'utf8');

    // Open with 'wx' — errors on EEXIST rather than overwriting.  On the rare
    // same-millisecond collision append a counter and retry.
    let backupPath = path.join(backupDir, baseBackupName);
    let counter = 0;
    for (;;) {
      try {
        fs.writeFileSync(backupPath, content, { encoding: 'utf8', flag: 'wx' });
        break;
      } catch (e) {
        if (e.code === 'EEXIST') {
          counter++;
          backupPath = path.join(backupDir, `${baseBackupName}.${counter}`);
        } else {
          throw e;
        }
      }
    }

    return backupPath;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(`Failed to create backup: ${e.message}`);
  }
}

/**
 * List all backups for a given source file, ordered newest-first.
 *
 * Backups are scoped by both the basename and the path hash, so only backups
 * for this exact file are returned — not backups for same-named files in other
 * directories.
 *
 * @param {string} filePath - Path to the source file (not a bare basename)
 * @returns {Array<{name: string, path: string, timestamp: string, created: Date}>}
 * @throws {BackupError} If backup listing fails
 */
export function listBackups(filePath) {
  const absPath = path.resolve(filePath);
  const backupDir = backupDirFor(absPath);
  try {
    ensureBackupsDir(backupDir);

    if (!fs.existsSync(backupDir)) {
      return [];
    }

    const basename = path.basename(absPath);
    const hash = pathHash(absPath);
    // All backups for this exact source file share this prefix.
    const prefix = `${basename}.${hash}.`;

    const files = fs.readdirSync(backupDir);
    const backups = files
      .filter(f => f.startsWith(prefix) && f.includes('.bak'))
      .map(f => {
        const backupPath = path.join(backupDir, f);
        const stats = fs.statSync(backupPath);
        // Timestamp is everything between the prefix and ".bak"
        let timestamp = 'unknown';
        const withoutPrefix = f.slice(prefix.length);
        const bakIdx = withoutPrefix.indexOf('.bak');
        if (bakIdx !== -1) timestamp = withoutPrefix.slice(0, bakIdx);
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
 * Restore a file from its most recent backup.
 *
 * @param {string} filePath - Path to the file to restore
 * @returns {boolean} True if restoration was successful
 * @throws {BackupError} If restoration fails or no backups exist
 */
export function restoreFromLatestBackup(filePath) {
  try {
    const absPath = path.resolve(filePath);
    const backups = listBackups(absPath);

    if (backups.length === 0) {
      throw new BackupError(`No backups found for ${filePath}`);
    }

    const latestBackup = backups[0];
    const backupContent = fs.readFileSync(latestBackup.path, 'utf8');
    fs.writeFileSync(absPath, backupContent, 'utf8');

    console.log(`Restored ${path.basename(absPath)} from backup: ${latestBackup.name}`);
    return true;
  } catch (e) {
    if (e instanceof BackupError) throw e;
    throw new BackupError(`Failed to restore backup: ${e.message}`);
  }
}

/**
 * Clean old backups for a source file, keeping only the most recent N.
 *
 * Cleanup is scoped to the specific source file (by absolute path) so that
 * pruning one file's history never deletes backups for a same-named file in a
 * different directory.
 *
 * @param {string} filePath - Path to the source file
 * @param {number} keepCount - Number of backups to keep (default: 5)
 * @returns {number} Number of backups deleted
 * @throws {BackupError} If cleanup fails
 */
export function cleanOldBackups(filePath, keepCount = 5) {
  try {
    const absPath = path.resolve(filePath);
    const backups = listBackups(absPath);
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
