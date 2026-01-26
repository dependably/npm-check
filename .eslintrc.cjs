module.exports = {
  env: {
    node: true,
    es2021: true,
    jest: true
  },
  extends: ['eslint:recommended'],
  parserOptions: {
    ecmaVersion: 12,
    sourceType: 'module'
  },
  overrides: [
    {
      files: ['tests/**/*.js'],
      env: {
        jest: true
      }
    }
  ],
  rules: {
    'no-console': 'off',
    'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-useless-escape': 'off'
  }
};
