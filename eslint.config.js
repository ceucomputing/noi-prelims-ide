// Lint rules: ESLint's recommended rules, plus checks that functions have correct JSDoc comments.
import js from '@eslint/js';
import jsdoc from 'eslint-plugin-jsdoc';
import globals from 'globals';

export default [
  { ignores: ['dist/', 'downloads/', 'node_modules/'] },
  js.configs.recommended,
  jsdoc.configs['flat/recommended'],
  {
    rules: {
      // Braces are required when a statement's body is on another line.
      curly: ['error', 'multi-line'],
      // Descriptions are written where they add something, not for every parameter.
      'jsdoc/require-param-description': 'off',
      'jsdoc/require-returns-description': 'off',
      'jsdoc/require-property-description': 'off',
    },
  },
  {
    files: ['src/**/*.js'],
    languageOptions: { globals: globals.browser },
  },
  {
    files: ['src/*-worker.js'],
    languageOptions: { globals: globals.worker },
  },
  {
    files: ['src/sw.js'],
    languageOptions: { globals: globals.serviceworker },
  },
  {
    files: ['*.mjs', '*.js', 'demo/*.mjs'],
    ignores: ['src/**'],
    languageOptions: { globals: globals.node },
  },
];
