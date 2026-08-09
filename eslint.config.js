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

  // === Eval file overrides (REMOVED — S70) ===
  // S61 (2026-08-09) added eval/ to the lint gate with a local override that
  // turned off no-explicit-any and no-console. S70 (2026-08-09) audited the
  // actual usage and found the override was fully redundant:
  //   - no-explicit-any: exactly ONE real type-level `any` existed in eval/
  //     (eval/runner-self.ts `{} as any` — now `{} as unknown as Env`); all
  //     other "any" grep hits were the English word in comments/strings.
  //   - no-console: all 75 usages use ONLY console.error/log/warn, which the
  //     base project rule already allows. No eval script uses console.info/
  //     debug/table/time, so nothing regresses under the base rule.
  // Both rules now fall through to the project defaults (no-explicit-any:
  // warn, no-console: warn with allow list) — eval/ must stay at 0 warnings
  // like every other directory.
)
