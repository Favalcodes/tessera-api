// @ts-check
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'migrations/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  prettier,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/explicit-member-accessibility': ['error', { accessibility: 'no-public' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // ADR-005: `entries` may only be written through LedgerService. Everything else must
    // go through it. This makes a direct write a lint failure, not a code-review catch.
    files: ['src/**/*.ts'],
    ignores: ['src/ledger/**'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: "CallExpression[callee.property.name='insertInto'][arguments.0.value='entries']",
          message:
            'Direct writes to `entries` are forbidden (ADR-005). Use LedgerService.post() instead.',
        },
        {
          selector:
            "CallExpression[callee.property.name='insertInto'][arguments.0.value='transactions']",
          message:
            'Direct writes to `transactions` are forbidden (ADR-005). Use LedgerService.post() instead.',
        },
        {
          selector: "CallExpression[callee.property.name='updateTable'][arguments.0.value='balances']",
          message:
            'Direct writes to `balances` are forbidden (ADR-005). Use LedgerService.post() instead.',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', '**/*.spec.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
    },
  },
);
