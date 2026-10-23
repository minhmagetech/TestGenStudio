/**
 * (c) Meta Platforms, Inc. and affiliates. Confidential and proprietary.
 */

/**
 * ESLint configuration for Meta Horizon Studio TypeScript projects
 * This is the recommended configuration for linting Horizon TypeScript code
 *
 * To set up ESLint and use the MHS Linter package, follow these instructions: https://developers.meta.com/horizon/documentation/studio/scripting/eslint-setup
 *
 * Summary:
 * 1. Download the MHS Linter Package: https://fburl.com/4kk2ilwq
 * 2. Install the package: npm install --save-dev /path/to/mhs-linter-x.x.x.tgz
 * 3. Install required dependencies: npm install --save-dev eslint @typescript-eslint/eslint-plugin @typescript-eslint/parser eslint-plugin-tsdoc
 * 4. Uncomment the lines below to enable MHS Linter
 */

// Uncomment this line after installing the eslint-plugin-mhs-linter package
// const mhsLinter = require('eslint-plugin-mhs-linter');

const typescriptEslint = require('@typescript-eslint/eslint-plugin');
const typescriptParser = require('@typescript-eslint/parser');
const tsdocPlugin = require('eslint-plugin-tsdoc');

module.exports = [
  // Uncomment this line after installing the eslint-plugin-mhs-linter package
  // ...mhsLinter.configs['flat/recommended'],
  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parser: typescriptParser,
      parserOptions: {
        project: './tsconfig.json',
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslint,
      'tsdoc': tsdocPlugin,
    },
    rules: {
      // TypeScript recommended rules
      ...typescriptEslint.configs.recommended.rules,
      ...typescriptEslint.configs['recommended-requiring-type-checking'].rules,

      // Custom rule configurations
      // Allow inferrable types, they improve readability
      '@typescript-eslint/no-inferrable-types': 'off',
      // Lower severity to warning, there are cases where this might be necessary
      '@typescript-eslint/ban-ts-comment': 'warn',
      // Allow empty functions as there is no current alternative in HSR
      '@typescript-eslint/no-empty-function': 'off',
      // Allow non-null assertions (foo!.bar) - improves error handling patterns
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Allow leading underscores to indicate that something is intentionally unused
      '@typescript-eslint/no-unused-vars': [
        'warn', {
          'argsIgnorePattern': '^_',
          'varsIgnorePattern': '^_',
          'caughtErrorsIgnorePattern': '^_',
          'destructuredArrayIgnorePattern': '^_'
        }
      ],

      // TSDoc validation
      'tsdoc/syntax': 'warn',
    },
  },
];
