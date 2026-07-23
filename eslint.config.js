/**
 * ESLint v9 Flat Config — TypeScript + Hono + Cloudflare Workers
 *
 * Uses:
 * - @eslint/js: base JS rules
 * - typescript-eslint: TypeScript-aware rules
 * - eslint-config-prettier: disable formatting rules (Prettier handles those)
 *
 * Strict but pragmatic — allows console.warn/error (Cloudflare Workers logging)
 * and patterns common in serverless/edge code.
 */
import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import prettier from 'eslint-config-prettier'

export default tseslint.config(
  // === Global ignore ===
  {
    ignores: [
      'dist/',
      '.wrangler/',
      'coverage/',
      'node_modules/',
      'eval/',
      'tests/k6/',
      '*.config.*',        // vite.config.ts, vitest.config.ts, etc.
      'ecosystem.config.cjs',
    ],
  },

  // === Base JS rules ===
  js.configs.recommended,

  // === TypeScript rules ===
  ...tseslint.configs.recommended,

  // === Disable formatting rules (Prettier handles these) ===
  prettier,

  // === Project-specific overrides ===
  {
    rules: {
      // Cloudflare Workers uses console for logging — allow warn/error
      'no-console': ['warn', { allow: ['warn', 'error', 'log', 'time', 'timeEnd'] }],

      // Allow `any` with explicit documentation
      '@typescript-eslint/no-explicit-any': 'warn',

      // Allow require() in config files at the top level
      '@typescript-eslint/no-require-imports': 'off',

      // Allow non-null assertions when type system can't narrow
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // Allow unused vars with underscore prefix
      '@typescript-eslint/no-unused-vars': [
        'warn',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],

      // Prefer const over let when variable is never reassigned
      'prefer-const': 'warn',

      // No duplicate imports
      'no-duplicate-imports': 'warn',

      // Prefer optional chaining
      'no-unneeded-ternary': 'warn',

      // Enforce `import type { ... }` for type-only imports
      // Prevents bundler from including unused types in the bundle
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          prefer: 'type-imports',
          fixStyle: 'separate-type-imports',
          disallowTypeAnnotations: false,
        },
      ],
    },
  },

  // === Test file overrides ===
  {
    files: ['tests/**/*.test.ts', 'tests/**/*.spec.ts'],
    rules: {
      // Tests often use mock data with `any` — allow freely
      '@typescript-eslint/no-explicit-any': 'off',
      // Tests use `expect().rejects` patterns
      '@typescript-eslint/no-floating-promises': 'off',
      // Allow empty catch blocks in tests
      'no-empty': 'off',
    },
  },

  // === Eval file overrides ===
  {
    files: ['eval/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
)
