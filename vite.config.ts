import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    build({
      entry: './src/index.tsx',
      // The virtual build entry uses import.meta.glob({ import: 'default' }),
      // which tree-shakes named exports (RateLimiterDO).  This hook adds an
      // explicit re-export so wrangler can discover the Durable Object class.
      // ⚠️ ALL 11 DO classes must be re-exported here — the previous version
      // only re-exported RateLimiterDO, silently tree-shaking ThreadDO,
      // PagesDO, LibraryDO, UserProfileDO, SpaceDO, ApiKeyDO, CrawlerDO,
      // ClickLogDO, ExperimentDO and CanaryOrchestratorDO from the bundle
      // (verified 2026-08-05: dist/_worker.js contained only RateLimiterDO).
      // DO bindings configured in the Dashboard would fail at runtime for
      // every DO except RateLimiterDO.
      entryContentDefaultExportHook: (appName) =>
        `export default ${appName}
export { RateLimiterDO, ThreadDO, PagesDO, LibraryDO, UserProfileDO, SpaceDO, ApiKeyDO, CrawlerDO, ClickLogDO, ExperimentDO, CanaryOrchestratorDO } from '/src/index.tsx'`,
    }),
    devServer({
      adapter,
      entry: 'src/index.tsx',
    }),
  ],
  build: {
    rollupOptions: {
      external: ['cloudflare:workers'],
    },
  },
})
