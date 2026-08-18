import path from 'node:path'
import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

/**
 * Integration 테스트 설정.
 *
 * ⚠️ 이 스위트는 CLOUDFLARE_API_TOKEN 이 반드시 필요합니다 (2026-08-18 확인).
 *
 * 근본 원인: wrangler.jsonc 의 `"ai": { "binding": "AI" }` 입니다.
 * Workers AI 는 로컬 에뮬레이션이 없어 vitest-pool-workers 가 항상
 * remote proxy session 을 열려고 하며, 자격증명이 없으면 테스트 수집 전에
 * "Could not start remote dev session" 으로 8건의 오류를 내고 중단됩니다.
 *
 * 최소 재현으로 인과관계를 확정했습니다:
 *   ai 바인딩만 있는 빈 워커  → 동일 오류 재현
 *   ai 바인딩 제거            → 정상 통과
 * 즉 P0-3(remote:true 제거)와는 무관한 별개의 제약입니다. remote:true 를
 * 지웠어도 이 스위트는 토큰 없이는 실행되지 않습니다.
 *
 * 실행 방법:
 *   CLOUDFLARE_API_TOKEN=<token> npm run test:integration
 *
 * 토큰이 없는 환경(로컬 기본/샌드박스)에서는 unit 스위트를 사용하세요:
 *   npm run test          (2,156건, 외부 의존 없음)
 */
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
