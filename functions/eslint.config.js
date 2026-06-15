// Flat ESLint config for the Cloud Functions TypeScript source.
const tseslint = require('@typescript-eslint/eslint-plugin');
const tsparser = require('@typescript-eslint/parser');

module.exports = [
  {
    ignores: ['lib/**', 'node_modules/**'],
  },
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parser: tsparser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: {
      '@typescript-eslint': tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      'no-console': 'error',
      '@typescript-eslint/no-explicit-any': 'off',
      // The codebase marks deliberately-unused stub params with a leading `_`.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Tests use jest globals and looser typing.
    files: ['src/**/__tests__/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
