// Ensure `jest` globals are available when running ESM tests
if (typeof jest === 'undefined') {
  // Dynamically import jest-mock in ESM environment without top-level await
  import('jest-mock')
    .then((jm) => {
      // jest-mock may export as default or named, normalize it
      global.jest = jm.default || jm;
    })
    .catch(() => {});
}

// Isolate every test from the developer's (or CI runner's) user-level .npmrc.
// pnpm registry resolution and registry credentials read it, so a machine whose
// ~/.npmrc names a private registry would otherwise change test outcomes. Tests
// that exercise the user layer pass their own `env`/`homeDir`.
process.env.NPM_CONFIG_USERCONFIG = '/nonexistent/npm-check-test/.npmrc';
delete process.env.npm_config_userconfig;
