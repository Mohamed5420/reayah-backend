import { defineConfig, globalIgnores } from 'eslint/config';
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';
import globals from 'globals';

export default defineConfig(
  globalIgnores(['dist/', 'coverage/', 'logs/', 'node_modules/', 'docs/openapi.json']),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: globals.node,
      parserOptions: {
        projectService: { allowDefaultProject: ['*.mjs', '*.mts'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      // Async mistakes are the costly ones in an Express + Mongo app.
      '@typescript-eslint/no-floating-promises': 'error',
      // Express accepts async handlers; only flag promises passed where a value is checked.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { arguments: false } }],
      '@typescript-eslint/await-thenable': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },
  {
    // TypeScript's `declare global` / `declare module` blocks need namespaces.
    files: ['src/types/**/*.d.ts'],
    rules: { '@typescript-eslint/no-namespace': 'off' },
  },
  {
    // Scripts and tests may print and use non-null assertions freely.
    files: ['tests/**/*.ts', 'src/docs/export-*.ts', 'src/scripts/**/*.ts'],
    rules: { 'no-console': 'off', '@typescript-eslint/no-non-null-assertion': 'off' },
  },
  prettier,
);
