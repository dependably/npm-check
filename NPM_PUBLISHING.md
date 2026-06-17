# NPM Publishing Guide

This document provides step-by-step instructions for publishing `npm-check` to the npm registry.

## Prerequisites

1. **npm Account**: Create an account at https://www.npmjs.com
2. **Credentials**: Log in locally using `npm login`
3. **Repository Access**: Ensure you have write access to the GitHub repository
4. **Node.js**: Version 18.0.0 or higher

## Pre-Publication Checklist

Before publishing, ensure:

- [ ] All tests pass: `npm test`
- [ ] Linting passes: `npm run lint`
- [ ] CHANGELOG.md is updated with new features
- [ ] Version number in package.json is bumped appropriately
- [ ] README.md is comprehensive and up-to-date
- [ ] Git repository is clean (no uncommitted changes)
- [ ] You're on the main/master branch
- [ ] All commits are pushed to GitHub

## Publishing Steps

### 1. Verify Build Quality

```bash
# Run all tests
npm test

# Check linting
npm run lint

# Verify the prepublishOnly script works
npm run prepublishOnly
```

### 2. Update Version Number

Use semantic versioning (MAJOR.MINOR.PATCH):

```bash
# For patch release (1.0.0 → 1.0.1)
npm version patch

# For minor release (1.0.0 → 1.1.0)
npm version minor

# For major release (1.0.0 → 2.0.0)
npm version major
```

This will:
- Update version in package.json
- Create a git tag
- Commit the change

### 3. Update CHANGELOG.md

Add a new section for the version being released:

```markdown
## [1.0.1] - 2026-01-27

### Fixed
- Bug fix description

### Added
- New feature description

### Changed
- Breaking change description
```

Commit the changelog:

```bash
git add CHANGELOG.md
git commit -m "docs: update CHANGELOG for v1.0.1"
```

### 4. Push to GitHub

```bash
# Push commits
git push origin main

# Push tags
git push origin --tags
```

### 5. Create GitHub Release

1. Go to https://github.com/mhiland/npm-check/releases
2. Click "Draft a new release"
3. Select the tag you just pushed
4. Set title: `v1.0.1`
5. Copy relevant CHANGELOG section as description
6. Click "Publish release"

### 6. Publish to npm

```bash
# Ensure you're logged in
npm whoami

# Publish the package
npm publish

# Verify it's published
npm view npm-check
```

## Post-Publication

### Verify Publication

```bash
# Check npm registry
npm search npm-check

# Install globally to test
npm install -g npm-check
npm-check --help

# Or test with npx
npx npm-check --help
```

### Update Release Information

1. Update GitHub release with npm link
2. Post announcement in relevant channels
3. Monitor npm package for any issues

## Version Numbering Strategy

Follow [Semantic Versioning](https://semver.org/):

- **MAJOR** (1.0.0): Incompatible API changes
  - Breaking changes to CLI or programmatic API
  - Major new features requiring updated documentation

- **MINOR** (1.1.0): Backwards-compatible functionality
  - New features that don't break existing API
  - New CLI commands
  - Performance improvements

- **PATCH** (1.0.1): Backwards-compatible bug fixes
  - Bug fixes
  - Documentation improvements
  - Dependency updates

## Troubleshooting

### "You must be logged in to publish"

```bash
npm login
# Enter credentials when prompted
```

### "This package name is not available"

The package name might already exist on npm. Check:

```bash
npm view npm-check
```

### "403 Forbidden"

Ensure your npm account has publish permissions. You may need:
- To be organization member (if published under org)
- Account verification via email

### Tests Fail Before Publishing

Run `npm test` to identify and fix issues:

```bash
npm test
# Fix failing tests
git add .
git commit -m "fix: resolve test failures"
npm version patch  # Re-tag version
```

## Automation with GitHub Actions (Future)

Once GitHub Actions is configured, consider automating:

1. Automatic version bumping on releases
2. Automated npm publish on tagged releases
3. Automatic changelog generation
4. Registry validation

Example workflow structure:

```yaml
name: Publish to npm
on:
  release:
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'
          registry-url: 'https://registry.npmjs.org'
      - run: npm ci
      - run: npm test
      - run: npm publish
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## Security Considerations

### npm Token Management

1. Never commit tokens to git
2. Use GitHub Secrets for CI/CD tokens
3. Rotate tokens periodically
4. Use scoped tokens when possible

### 2FA (Two-Factor Authentication)

Enable 2FA on your npm account:
- Go to npm settings
- Enable "Authorization only" or "Authorization and publishing" mode
- Use authenticator app for token generation

### Package Security

Ensure dependencies are:
- Minimal (no unnecessary dependencies)
- Audited: `npm audit`
- Updated regularly

## Rollback Procedure

If an issue is discovered after publishing:

```bash
# Deprecate problematic version
npm deprecate npm-check@1.0.1 "Critical bug, use 1.0.2"

# OR unpublish (within 24 hours of publication)
npm unpublish npm-check@1.0.1

# Then release fixed version
npm version patch
npm publish
```

## Monitoring After Publication

Monitor these channels for issues:

1. **GitHub Issues**: https://github.com/mhiland/npm-check/issues
2. **npm Trends**: https://www.npmtrends.com/npm-check
3. **npm Notifications**: Check for security advisories
4. **Community**: Monitor popular Node.js forums and chat channels

## Distribution Channels

### Primary
- **npm registry**: https://www.npmjs.com/package/npm-check

### Secondary (Optional Future)
- **GitHub releases**: For binary distributions
- **CDN**: For browser-compatible distributions
- **Docker**: Container image for CI/CD environments

## Release Schedule

Suggested release cadence:

- **Patch releases**: As needed for bug fixes (no specific schedule)
- **Minor releases**: Monthly for feature additions
- **Major releases**: Quarterly for significant updates

Adjust based on:
- Community demand
- Bug severity
- Feature maturity
- Dependency updates

## Additional Resources

- [npm Publishing Documentation](https://docs.npmjs.com/packages-and-modules/contributing-packages-to-the-registry)
- [Semantic Versioning](https://semver.org/)
- [Keep a Changelog](https://keepachangelog.com/)
- [npm Security](https://docs.npmjs.com/security/)

## Questions or Issues?

Contact the maintainers or open an issue on GitHub for publication-related questions.

---

Happy publishing! 🚀
