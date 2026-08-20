/**
 * Vitest config for the E2E golden-path test — fully LOCAL workerd runtime.
 *
 * Why a separate config: with the default `remoteBindings: true`, the
 * cloudflare pool calls wrangler.maybeStartOrUpdateRemoteProxySession() for
 * any wrangler config that declares remote resources (Vectorize/D1 with
 * `remote: true` in wrangler.jsonc), which requires CLOUDFLARE_API_TOKEN —
 * so the E2E test could not run on a laptop without credentials.
 *
 * `remoteBindings: false` keeps everything local: remote Vectorize/D1
 * bindings are not dialed, and the worker code treats missing/unavailable
 * index bindings as "self-index not seeded yet" (semanticCacheLookup →
 * undefined, indexFromSearchResults → early return, self-index task →
 * not built) — a legitimate production state.
 *
 * Run: npm run test:e2e
 */
import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { DO_MINIFLARE_FRAGMENT } from './tests/integration/do-bindings'

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: './wrangler.jsonc',
      },
      main: './src/index.tsx',
      // Keep the whole session local — no Cloudflare credentials needed.
      remoteBindings: false,
      miniflare: {
        // Fail-closed auth (auth.ts): the test worker declares a key so the
        // golden path authenticates like a real tenant (same 'test-key'
        // convention as the other integration tests). The test's fetchJson
        // helper sends X-API-Key accordingly.
        // NOTE: use `bindings`, not `vars` — this pool version's core
        // miniflare plugin schema has no `vars` field (silently dropped),
        // while `bindings` (object form) is merged into the worker env.
        bindings: { SEARCH_API_KEY: 'test-key' },
        compatibilityFlags: ['nodejs_compat'],
        // Installed workerd binary supports compat dates only up to 2026-07-02
        // (same constraint as vitest.integration.config.ts).
        compatibilityDate: '2026-07-02',
        // Self-referencing DO designators (see tests/integration/do-bindings.ts).
        ...DO_MINIFLARE_FRAGMENT,
      },
    }),
  ],
  test: {
    include: ['tests/integration/e2e-golden-path.test.ts'],
    reporters: ['verbose'],
    maxWorkers: 1,
    minWorkers: 1,
    pool: '@cloudflare/vitest-pool-workers',
    testTimeout: 30_000,
  },
})
