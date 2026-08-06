import path from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      // Pages wrangler config doesn't have a `main` field, so set it explicitly
      main: './src/index.tsx',
      miniflare: {
        compatibilityFlags: ['nodejs_compat'],
        // Installed workerd binary supports compat dates only up to 2026-07-02
        // (verified 2026-08-05) — 2026-07-10 fails with ERR_RUNTIME_FAILURE
        // "newest date supported by this server binary is 2026-07-02".
        compatibilityDate: '2026-07-02',
      },
    }),
  ],
  test: {
    include: ['tests/integration/**/*.test.ts'],
    reporters: ['verbose'],
    // Single worker + no isolate so the DO binding warning doesn't spam
    maxWorkers: 1,
    minWorkers: 1,
    pool: '@cloudflare/vitest-pool-workers',
    // Search tests make real HTTP calls to external APIs (Wikipedia, Bing, etc.)
    // which can take 6-10s per request, especially under rate limiting
    testTimeout: 30_000,
  },
})
