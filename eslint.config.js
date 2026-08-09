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
      // Fixture parsing asserts non-null shapes liberally (b_algo, .text()
      // on parsed nodes). The runtime cost of `!` here is zero and the
      // assertions ARE the test — re-narrowing every fixture would add
      // noise without catching anything the parser's own types wouldn't.
      // Mirrors the no-explicit-any precedent above (2026-08-07 lint budget
      // pass: removed 177/232 non-null warnings this way).
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // === Eval file overrides ===
  // S61 (2026-08-09): eval/ was previously in the global ignores — the
  // overrides below existed but were dead until the directory was added to
  // the lint gate. Eval scripts legitimately use console for CLI output and
  // loose typing for versioned artifact shapes; other rules (non-null,
  // unused, imports) are enforced to keep the whole codebase at 0 warnings.
  {
    files: ['eval/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      'no-console': 'off',
    },
  },
)
