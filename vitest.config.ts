import { defineConfig } from 'vitest/config'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { DO_MINIFLARE_FRAGMENT } from './tests/integration/do-bindings'

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
    // 수정 112: 셸 스크립트 검증 테스트(--self-test 컨벤션)가 병렬 부하에서
    // 기본 5s를 초과해 flaky 타임아웃 발생 (verify-slack-alert-e2e,
    // verify-do-binding-token, set-slack-webhook 실측 재현). 30s로 상향.
    testTimeout: 30_000,
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
      },
      // Self-referencing DO designators — overrides wrangler.jsonc's
      // script_name bindings so the test runtime resolves the DO classes
      // from the main worker's exports (see tests/integration/do-bindings.ts).
      ...DO_MINIFLARE_FRAGMENT,
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
