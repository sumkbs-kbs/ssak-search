import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'

/**
 * Vitest config with two projects:
 * 1. unit: node environment (fast, no Workers runtime)
 * 2. integration: @cloudflare/vitest-pool-workers (real Workers runtime)
 */

// Unit tests project
const unitProject = {
  test: {
    name: 'unit',
    environment: 'node',
    include: ['tests/unit/**/*.test.ts'],
    exclude: ['tests/integration/**', 'node_modules/**'],
    reporters: ['verbose'],
    update: false,
    coverage: {
      reporter: ['text', 'html'],
      include: ['src/lib/**/*.ts', 'src/routes/**/*.ts'],
      exclude: ['src/pages/**'],
    },
  },
}

// Integration tests project (Workers runtime)
const integrationProject = {
  // Cloudflare Workers pool options
  plugins: [cloudflareTest({
    main: './src/index.tsx',  // Entry point for Workers
    miniflare: {
      bindings: {
        SEARCH_API_KEY: 'test-key',
        TENANTS_CONFIG: JSON.stringify({
          default: { plan: 'pro', rateLimit: 60 },
        }),
        JINA_API_KEY: 'test-jina-key',
        RATE_LIMITER: 'RATE_LIMITER',
      },
      durableObjects: {
        RATE_LIMITER: 'RateLimiterDO',
      },
      // Override compatibility date to match workerd binary
      compatibilityDate: '2026-07-02',
    },
    wrangler: {
      configPath: './wrangler.jsonc',
    },
  })],
  test: {
    name: 'integration',
    pool: 'cloudflare-pool',
    include: ['tests/integration/**/*.test.ts'],
    exclude: ['node_modules/**', 'tests/unit/**'],
    reporters: ['verbose'],
    update: false,
    testTimeout: 60000,
    hookTimeout: 60000,
  },
}

export default defineConfig({
  test: {
    projects: [unitProject, integrationProject],
  },
})
