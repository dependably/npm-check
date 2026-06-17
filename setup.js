// Setup script for npm-check development environment
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function setupPreCommitHook() {
  const hookSource = path.join(__dirname, '.git/hooks/pre-commit');
  const hookDest = path.join(__dirname, '.git/hooks/pre-commit');

  if (!fs.existsSync(hookSource)) {
    console.log('⚠️  pre-commit hook not found at', hookSource);
    return false;
  }

  try {
    // Make hook executable
    fs.chmodSync(hookDest, '755');
    console.log('✅ Pre-commit hook configured');
    return true;
  } catch (e) {
    console.error('❌ Failed to set up pre-commit hook:', e.message);
    return false;
  }
}

function setupBackupsDir() {
  const backupsDir = path.join(__dirname, '.backups');
  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
    console.log('✅ Backups directory created');
  }
}

function main() {
  console.log('🚀 Setting up npm-check development environment...\n');

  setupBackupsDir();
  setupPreCommitHook();

  console.log('\n✨ Setup complete! You can now use the following commands:');
  console.log('   npm test              - Run all tests');
  console.log('   npm run lint          - Run ESLint');
  console.log('   npm start             - Run CLI (use: npm start validate package-lock.json)');
}

main();

