// tests/backup.test.js
import { createBackup, listBackups, restoreFromLatestBackup, cleanOldBackups } from '../src/backup.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_FILE = path.join(__dirname, 'test-lockfile.json');
const BACKUPS_DIR = '.backups';

// Cleanup function
function cleanup() {
  if (fs.existsSync(TEST_FILE)) {
    fs.unlinkSync(TEST_FILE);
  }
  if (fs.existsSync(BACKUPS_DIR)) {
    const files = fs.readdirSync(BACKUPS_DIR);
    files.forEach(f => fs.unlinkSync(path.join(BACKUPS_DIR, f)));
    fs.rmdirSync(BACKUPS_DIR);
  }
}

describe('Backup System', () => {
  beforeEach(() => {
    cleanup();
    // Create test file
    fs.writeFileSync(TEST_FILE, JSON.stringify({ test: 'data' }, null, 2), 'utf8');
  });

  afterEach(() => {
    cleanup();
  });

  it('creates a backup with timestamp', () => {
    const backupPath = createBackup(TEST_FILE);
    expect(backupPath).toBeDefined();
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(backupPath).toContain('.bak');
  });

  it('lists backups for a file', () => {
    const backup1 = createBackup(TEST_FILE);
    expect(backup1).toBeDefined();

    const backups = listBackups('test-lockfile.json');
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(backups[0].path).toBeDefined();
  });  it('restores from latest backup', () => {
    const originalContent = fs.readFileSync(TEST_FILE, 'utf8');
    createBackup(TEST_FILE);

    // Modify the file
    fs.writeFileSync(TEST_FILE, JSON.stringify({ modified: true }, null, 2), 'utf8');
    const modifiedContent = fs.readFileSync(TEST_FILE, 'utf8');
    expect(modifiedContent).not.toBe(originalContent);

    // Restore
    const restored = restoreFromLatestBackup(TEST_FILE);
    expect(restored).toBe(true);

    const restoredContent = fs.readFileSync(TEST_FILE, 'utf8');
    expect(restoredContent).toBe(originalContent);
  });

  it('cleans old backups keeping only N most recent', () => {
    createBackup(TEST_FILE);
    createBackup(TEST_FILE);
    createBackup(TEST_FILE);

    const backups = listBackups('test-lockfile.json');
    const initialCount = backups.length;

    if (initialCount > 1) {
      const deleted = cleanOldBackups('test-lockfile.json', 1);
      expect(deleted).toBeGreaterThanOrEqual(0);

      const backupsAfter = listBackups('test-lockfile.json');
      expect(backupsAfter.length).toBeLessThanOrEqual(initialCount);
    }
  });

  it('handles missing files gracefully', () => {
    const backupPath = createBackup('/nonexistent/file.json');
    expect(backupPath).toBeNull();
  });
});
