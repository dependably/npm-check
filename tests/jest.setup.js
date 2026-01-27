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
