import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'
import { DO_MINIFLARE_FRAGMENT } from './tests/integration/do-bindings'

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
        // Self-referencing DO designators — overrides wrangler.jsonc's
        // script_name bindings so the test runtime resolves the DO classes
        // from the main worker's exports (see tests/integration/do-bindings.ts).
        ...DO_MINIFLARE_FRAGMENT,
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
