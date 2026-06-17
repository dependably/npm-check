# Release Notes - npm-check v1.2.0

## Lockfile Linter Release

v1.2.0 turns npm-check into a linter/checker for package-lock.json best practices and supply-chain hygiene:

- 🛡️ **`npm-check audit`** — opinionated, configurable lockfile linter with CI-friendly exit codes (0 pass / 1 findings / 2 operational error). Five rules covering lockfile version, structure, integrity hygiene, resolved-URL security, and version pinning; configured via `.npm-checkrc.json` / `npm-check.config.json` with CLI overrides.
- 🔐 **`npm-check fix-checksums`** — fills missing, placeholder, and sha1 integrity hashes with real `dist.integrity` values fetched from each package's registry (private registries derived from resolved URLs). Opt-in, clearly flagged local fallback for air-gapped use.
- 📌 **`npm-check pin`** — removes `^`/`~` from package.json ranges, pinning to the lockfile-resolved versions and keeping the lockfile root entry in sync.
- ⬆️ **`npm-check upgrade`** — one-word lockfile upgrade to v3 with no-op detection.

Also fixes binary-file hashing (raw bytes instead of utf8) and aligns the validator with what npm actually writes (no `name` on non-root entries, `link:` entries without versions, string ranges in packages-map dependencies).

See CHANGELOG.md for the complete list.

---

# Release Notes - npm-check v1.0.0

## Welcome to npm-check!

We're excited to announce the first stable release of **npm-check**, a comprehensive tool for validating, migrating, and updating npm package-lock.json files.

## What is npm-check?

`npm-check` is a powerful utility designed to help Node.js/npm developers:
- ✅ **Validate** package-lock.json files for structural and consistency issues
- 🔄 **Migrate** lockfiles between npm versions (v1 ↔ v2 ↔ v3)
- 🔐 **Upgrade** integrity hashes to modern SHA512 standards
- 🗂️ **Deduplicate** redundant package entries
- 💾 **Backup & Restore** files safely before modifications
- 🔧 **Auto-fix** common lockfile issues with a single command

## Key Features

### 🎯 Complete Lockfile Support
- Full support for npm package-lock.json versions 1, 2, and 3
- Automatic version detection and handling
- Bidirectional migration between any versions

### 🔒 Security & Safety
- **Non-destructive by default**: Automatic timestamped backups created before modifications
- SHA512 integrity hash generation and validation
- Comprehensive integrity checks and placeholder detection
- Pre-commit hooks for automatic validation

### 📦 Smart Fixing
- Auto-migration detection and execution
- Placeholder integrity hash filling with real SHA512 hashes
- Intelligent deduplication preserving workspace dependencies
- Preservation of git dependencies and custom resolved URLs

### 🛠️ Developer-Friendly
- Simple command-line interface with clear output
- Programmatic API for integration into build pipelines
- Comprehensive error messages and reporting
- 58 comprehensive tests covering edge cases

### ⚡ Performance
- Efficient algorithms for large lockfiles
- Zero production dependencies
- Fast validation and migration operations

## Installation

```bash
npm install -g npm-check
# or use with npx
npx npm-check --help
```

## Quick Start

### Command Line Usage

```bash
# Validate a lockfile
npm-check validate package-lock.json

# Migrate to a newer version
npm-check migrate package-lock.json 3

# Upgrade all integrity hashes to SHA512
npm-check upgrade-hashes package-lock.json

# Deduplicate packages
npm-check dedupe package-lock.json

# Apply all automatic fixes (with safe --write flag)
npm-check fix --write package-lock.json

# Manage backups
npm-check backups                    # List backups
npm-check restore package-lock.json  # Restore from latest backup
```

### Programmatic API

```javascript
import {
  parseLockfile,
  validatePackageLock,
  migrateToVersion,
  fixPackageLock,
  LOCKFILE_VERSIONS
} from 'npm-check';

// Parse and validate
const lockfile = parseLockfile('./package-lock.json');
const validation = validatePackageLock(lockfile);

if (validation.isValid) {
  console.log('✅ Lockfile is valid');
} else {
  console.log('❌ Issues found:', validation.errors);
}

// Migrate and fix
const migratedLockfile = migrateToVersion(lockfile, LOCKFILE_VERSIONS.V3);
const { fixedLockfile, fixes } = fixPackageLock(migratedLockfile, {
  fillMissingIntegrity: true,
  dedupe: true
});

console.log('Applied fixes:', fixes);
```

## What's Included

### Core Modules
- **format-library.js**: Version detection and lockfile format utilities
- **validator.js**: Comprehensive validation engine
- **migrator.js**: Bidirectional version migration
- **updater.js**: Hash upgrading and deduplication
- **fixer.js**: Automated fixing strategies
- **backup.js**: Non-destructive backup operations
- **integrity.js**: SHA512 hash generation and validation
- **parser.js**: Safe file I/O
- **index.js**: Main API exports

### CLI Interface
- Full-featured command-line tool in `bin/cli.js`
- Commands for all core operations
- Safe `--write` flag with automatic backups

### Testing & Quality
- 58 comprehensive tests with edge case coverage
- ESLint configuration for code quality
- Jest configuration with ESM support
- Pre-commit hooks for validation

## Technical Requirements

- **Node.js**: 18.0.0 or higher
- **npm**: 9.0.0 or higher
- No production dependencies (minimal footprint)

## Configuration

### Pre-commit Hooks
Automatically validate files before committing:

```bash
# Hook is installed automatically in .git/hooks/pre-commit
# It runs ESLint and fast test validation
```

### ESLint Configuration
Code quality enforced via `.eslintrc.cjs`

### Jest Configuration
Testing via `jest.config.mjs` with ES module support

## Use Cases

### 1. Monorepo Maintenance
- Validate lockfiles across workspace packages
- Migrate entire monorepos to new npm versions
- Handle workspace-specific dependencies correctly

### 2. Legacy Project Upgrades
- Automatically migrate old v1 lockfiles to v3
- Upgrade all integrity hashes at once
- Safely preserve project-specific configurations

### 3. CI/CD Integration
- Validate lockfiles in CI pipelines
- Auto-fix common issues in pull requests
- Ensure consistency across team workflows

### 4. Build Tool Integration
- Use as npm script in build pipelines
- Programmatic API for custom tools
- Integration with webpack, vite, etc.

## Migration Path

### From Previous Versions
If you're currently managing package-lock.json files manually:

1. Install npm-check globally or locally
2. Run `npm-check validate` on your existing lockfile
3. Use `npm-check fix --write` to automatically resolve issues
4. Review the backup in `.backups/` if needed
5. Integrate into your development workflow

## Known Limitations

- Requires Node.js 14+ (use `n` or `nvm` for version management)
- Backup directory (`.backups/`) must be writable
- Git dependencies identified by `resolved` field format

## Roadmap

Future releases will include:
- Full Updater features (targeted updates, rollback diffs)
- Backup compression and retention policies
- Interactive conflict resolution TUI
- Performance optimizations for very large lockfiles
- Plugin system for custom validators
- GitHub Actions integration

## Support & Contribution

- 📖 Full documentation in [README.md](README.md)
- 📝 Detailed changelog in [CHANGELOG.md](CHANGELOG.md)
- 🐛 Report issues on GitHub
- 🤝 Contributions welcome!

## License

MIT License - see LICENSE file for details

---

### Next Steps

1. Read the [README.md](README.md) for comprehensive documentation
2. Try the command-line interface: `npm-check --help`
3. Integrate into your project workflow
4. Share feedback and contribute improvements!

**Happy locking! 🔒**
