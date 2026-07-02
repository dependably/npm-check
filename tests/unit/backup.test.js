// tests/unit/backup.test.js
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  createBackup,
  listBackups,
  restoreFromLatestBackup,
  cleanOldBackups,
  BackupError
} from '../../src/backup.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a temporary directory that is cleaned up automatically.  Returns the
 * absolute path.
 */
function makeTempDir(suffix = '') {
  return fs.mkdtempSync(path.join(os.tmpdir(), `backup-test-${suffix}`));
}

/**
 * Remove a directory tree, ignoring errors (e.g. already gone).
 */
function rmDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Basic happy-path tests
// ---------------------------------------------------------------------------

describe('Backup System — basic operations', () => {
  let tmpDir;
  let sourceFile;

  beforeEach(() => {
    tmpDir = makeTempDir('basic');
    sourceFile = path.join(tmpDir, 'package-lock.json');
    fs.writeFileSync(sourceFile, JSON.stringify({ name: 'test', version: '1.0.0' }), 'utf8');
  });

  afterEach(() => rmDir(tmpDir));

  it('creates a backup file in .backups/ next to the source file', () => {
    const backupPath = createBackup(sourceFile);

    expect(backupPath).toBeTruthy();
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(backupPath).toMatch(/\.bak$/);

    // The backup must land in <sourceDir>/.backups/, not in cwd.
    const expectedBackupDir = path.join(tmpDir, '.backups');
    expect(backupPath.startsWith(expectedBackupDir)).toBe(true);
  });

  it('backup filename includes a hash component so same-basename files differ', () => {
    const backupPath = createBackup(sourceFile);
    const basename = path.basename(backupPath);
    // Format: package-lock.json.<hash8>.<timestamp>.bak
    // The hash ensures cross-directory uniqueness.
    expect(basename).toMatch(/^package-lock\.json\.[0-9a-f]{8}\./);
  });

  it('lists backups for a file using the full path', () => {
    createBackup(sourceFile);
    const backups = listBackups(sourceFile);

    expect(Array.isArray(backups)).toBe(true);
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0]).toHaveProperty('name');
    expect(backups[0]).toHaveProperty('path');
    expect(backups[0]).toHaveProperty('timestamp');
  });

  it('restores a file from the latest backup', () => {
    const originalContent = JSON.stringify({ state: 'original' });
    fs.writeFileSync(sourceFile, originalContent, 'utf8');
    createBackup(sourceFile);

    // Overwrite with something else.
    fs.writeFileSync(sourceFile, JSON.stringify({ state: 'modified' }), 'utf8');

    const restored = restoreFromLatestBackup(sourceFile);
    expect(restored).toBe(true);

    const afterRestore = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
    expect(afterRestore.state).toBe('original');
  });

  it('cleans old backups keeping only the most recent N', () => {
    // Create 4 backups.  Between each we wait 1 ms to guarantee ordering.
    for (let i = 0; i < 4; i++) {
      createBackup(sourceFile);
    }

    const beforeCount = listBackups(sourceFile).length;
    expect(beforeCount).toBeGreaterThanOrEqual(4);

    const deleted = cleanOldBackups(sourceFile, 2);
    const afterCount = listBackups(sourceFile).length;

    expect(deleted).toBe(beforeCount - 2);
    expect(afterCount).toBe(2);
  });

  it('throws BackupError for a missing source file', () => {
    expect(() => createBackup('/nonexistent/path/package-lock.json')).toThrow(BackupError);
  });

  it('throws BackupError when no backups exist for restore', () => {
    const noBackupFile = path.join(tmpDir, 'never-backed-up.json');
    fs.writeFileSync(noBackupFile, '{}', 'utf8');
    expect(() => restoreFromLatestBackup(noBackupFile)).toThrow(BackupError);
  });

  it('uses ms-precision timestamps so rapid successive backups have distinct names', () => {
    const p1 = createBackup(sourceFile);
    const p2 = createBackup(sourceFile);
    // Even within the same millisecond the wx-flag + counter suffix must avoid
    // collisions, so the two returned paths must differ.
    expect(p1).not.toBe(p2);
    expect(fs.existsSync(p1)).toBe(true);
    expect(fs.existsSync(p2)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Cross-file collision regression test (bug #31)
// ---------------------------------------------------------------------------

describe('Backup System — cross-file isolation (regression #31)', () => {
  let tmpDir;
  let webDir;
  let apiDir;
  let webLockfile;
  let apiLockfile;

  beforeEach(() => {
    tmpDir = makeTempDir('isolation');
    webDir = path.join(tmpDir, 'web');
    apiDir = path.join(tmpDir, 'api');
    fs.mkdirSync(webDir, { recursive: true });
    fs.mkdirSync(apiDir, { recursive: true });

    webLockfile = path.join(webDir, 'package-lock.json');
    apiLockfile = path.join(apiDir, 'package-lock.json');

    fs.writeFileSync(webLockfile, JSON.stringify({ name: 'web', version: '1.0.0' }), 'utf8');
    fs.writeFileSync(apiLockfile, JSON.stringify({ name: 'api', version: '2.0.0' }), 'utf8');
  });

  afterEach(() => rmDir(tmpDir));

  it('places backups next to each source file, not in a shared cwd directory', () => {
    const webBackup = createBackup(webLockfile);
    const apiBackup = createBackup(apiLockfile);

    const webBackupDir = path.join(webDir, '.backups');
    const apiBackupDir = path.join(apiDir, '.backups');

    expect(webBackup.startsWith(webBackupDir)).toBe(true);
    expect(apiBackup.startsWith(apiBackupDir)).toBe(true);

    // The two backup dirs are distinct.
    expect(webBackupDir).not.toBe(apiBackupDir);
  });

  it('listBackups scopes results to the exact source file — no cross-dir leakage', () => {
    createBackup(webLockfile);
    createBackup(apiLockfile);

    const webBackups = listBackups(webLockfile);
    const apiBackups = listBackups(apiLockfile);

    // Each list contains only backups for its own file.
    expect(webBackups.length).toBe(1);
    expect(apiBackups.length).toBe(1);

    // No backup from api/ appears in web/'s list and vice-versa.
    const apiBackupDir = path.join(apiDir, '.backups');
    const webBackupDir = path.join(webDir, '.backups');
    expect(webBackups[0].path.startsWith(webBackupDir)).toBe(true);
    expect(apiBackups[0].path.startsWith(apiBackupDir)).toBe(true);
  });

  it('restoreFromLatestBackup restores the correct file — not a same-named file from another dir', () => {
    // Back up both files.
    createBackup(webLockfile);
    createBackup(apiLockfile);

    // Corrupt both files.
    fs.writeFileSync(webLockfile, '{"corrupted":true}', 'utf8');
    fs.writeFileSync(apiLockfile, '{"corrupted":true}', 'utf8');

    // Restore each independently.
    restoreFromLatestBackup(webLockfile);
    restoreFromLatestBackup(apiLockfile);

    const webRestored = JSON.parse(fs.readFileSync(webLockfile, 'utf8'));
    const apiRestored = JSON.parse(fs.readFileSync(apiLockfile, 'utf8'));

    // Each file gets its own data back, not the other's.
    expect(webRestored.name).toBe('web');
    expect(apiRestored.name).toBe('api');
  });

  it('cleanOldBackups only deletes backups for the specified file (regression #31)', () => {
    // Create 3 backups for web and 1 for api.
    for (let i = 0; i < 3; i++) createBackup(webLockfile);
    createBackup(apiLockfile);

    // Clean web's backups, keeping 1.
    const deleted = cleanOldBackups(webLockfile, 1);
    expect(deleted).toBe(2);

    // api's backup is untouched.
    expect(listBackups(apiLockfile).length).toBe(1);
    // web's history is trimmed to 1.
    expect(listBackups(webLockfile).length).toBe(1);
  });

  it('backup filenames differ even when source basenames are identical', () => {
    const webBackup = createBackup(webLockfile);
    const apiBackup = createBackup(apiLockfile);

    // Different paths → different path hashes → different filenames.
    expect(path.basename(webBackup)).not.toBe(path.basename(apiBackup));
  });
});
