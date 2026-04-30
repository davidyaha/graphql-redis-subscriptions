// @ts-check
import { defineConfig } from "eslint/config";
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from "globals";

export default defineConfig([
  eslint.configs.recommended,
  tseslint.configs.recommended,
  {
    name: 'global ignore',
    ignores: ['coverage/', 'dist/', 'src/test/']
  },
  {
    languageOptions: {
      globals: {
        ...globals.nodeBuiltin
      }
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-require-imports': 'warn',
      '@typescript-eslint/no-unused-vars': [ 'error',
          { caughtErrors: 'none' }
      ]
    }
  }
]);