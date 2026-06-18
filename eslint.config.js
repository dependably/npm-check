import js from '@eslint/js';
import globals from 'globals';

// Flat config (ESLint v9+/v10). Replaces the legacy .eslintrc.cjs:
// `eslint:recommended` → js.configs.recommended, env globals → the `globals`
// package, parserOptions → languageOptions.
export default [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'module',
      globals: {
        ...globals.node,
        ...globals.es2021,
        ...globals.jest
      }
    },
    rules: {
      'no-console': 'off',
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-useless-escape': 'off'
    }
  },
  {
    files: ['tests/**/*.js'],
    languageOptions: {
      globals: {
        ...globals.jest
      }
    }
  }
];
