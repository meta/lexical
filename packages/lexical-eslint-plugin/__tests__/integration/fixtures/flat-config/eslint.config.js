const lexical = require('@lexical/eslint-plugin');

module.exports = [
  {
    files: ['**/*.js'],
    ignores: [],
    ...lexical.configs.recommended,
    rules: {
      '@lexical/rules-of-lexical': 'error',
    },
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        module: 'readonly',
        require: 'readonly',
      },
    },
  },
];
