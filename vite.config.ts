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
      entryContentDefaultExportHook: (appName) =>
        `export default ${appName}\nexport { RateLimiterDO } from '/src/index.tsx'`,
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
