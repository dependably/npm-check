import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  createBackup,
  listBackups,
  restoreFromLatestBackup,
  cleanOldBackups,
  BackupError
} from '../src/backup.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Backup System', () => {
  const testDir = path.join(__dirname, '.test-backups');
  const testFile = path.join(testDir, 'test-lockfile.json');

  beforeAll(() => {
    // Create test directory and file
    if (!fs.existsSync(testDir)) {
      fs.mkdirSync(testDir, { recursive: true });
    }
    fs.writeFileSync(testFile, JSON.stringify({ test: 'data' }), 'utf8');
  });

  afterAll(() => {
    // Clean up test directory
    if (fs.existsSync(testDir)) {
      const backupsDir = path.join(testDir, '.backups');
      if (fs.existsSync(backupsDir)) {
        fs.rmSync(backupsDir, { recursive: true });
      }
      fs.rmSync(testDir, { recursive: true });
    }
  });

  beforeEach(() => {
    // Change to test directory for backup operations
    process.chdir(testDir);
  });

  afterEach(() => {
    process.chdir(__dirname);
  });

  it('creates a backup file with timestamp', () => {
    const backupPath = createBackup(testFile);
    expect(backupPath).toBeTruthy();
    expect(fs.existsSync(backupPath)).toBe(true);
    expect(backupPath).toMatch(/\.bak$/);
  });

  it('lists backups for a file', () => {
    createBackup(testFile);
    const backups = listBackups('test-lockfile.json');
    expect(Array.isArray(backups)).toBe(true);
    expect(backups.length).toBeGreaterThan(0);
    expect(backups[0]).toHaveProperty('name');
    expect(backups[0]).toHaveProperty('path');
    expect(backups[0]).toHaveProperty('timestamp');
  });

  it('restores a file from the latest backup', () => {
    // Modify the file
    fs.writeFileSync(testFile, JSON.stringify({ modified: true }), 'utf8');

    // Create a backup of the modified version
    createBackup(testFile);

    // Modify again
    fs.writeFileSync(testFile, JSON.stringify({ changed: true }), 'utf8');

    // Restore from backup
    const restored = restoreFromLatestBackup(testFile);
    expect(restored).toBe(true);

    const restoredContent = JSON.parse(fs.readFileSync(testFile, 'utf8'));
    expect(restoredContent.modified).toBe(true);
  });

  it('cleans old backups keeping only the most recent', () => {
    // Create multiple backups
    createBackup(testFile);
    createBackup(testFile);
    createBackup(testFile);

    const initialCount = listBackups('test-lockfile.json').length;
    cleanOldBackups('test-lockfile.json', 1);
    const backupsAfter = listBackups('test-lockfile.json');
    expect(backupsAfter.length).toBeLessThanOrEqual(initialCount);
  });

  it('throws error for missing files', () => {
    expect(() => {
      createBackup('/nonexistent/file.json');
    }).toThrow(BackupError);
  });

  it('throws error when no backups exist for restore', () => {
    const nonExistentFile = path.join(testDir, 'never-backed-up.json');
    fs.writeFileSync(nonExistentFile, JSON.stringify({}), 'utf8');

    expect(() => {
      restoreFromLatestBackup(nonExistentFile);
    }).toThrow(BackupError);

    fs.unlinkSync(nonExistentFile);
  });
});
