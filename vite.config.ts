import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  // 방안 B (2026-08-14): 배포 환경별 DO 인스턴스 키를 빌드 타임에 주입한다.
  // staging/production 은 같은 DO 워커를 공유하지만 인스턴스('staging'/'production')
  // 를 분리해 서킷·rate window·cooldown 을 독립화한다 (src/lib/deploy-env.ts).
  // CI(ci.yml)는 두 아티팩트를 각각 빌드하고, deploy.yml 폴백 빌드도 환경 변수를
  // 설정한다. 미설정 시 production 이 기본값. 테스트(vitest.config.ts)는 이
  // config 를 쓰지 않아 define 이 적용되지 않는다 — 코드 쪽 typeof 가드로 폴백.
  define: {
    __DEPLOY_ENV__: JSON.stringify(process.env.DEPLOY_ENV || 'production'),
    // 배포 후 번들 내용 검증용 (수정 56): 빌드 타임에 커밋 SHA 를 심는다.
    // deploy-local-worktree.sh 가 배포 URL 의 /api/health build_commit 과
    // 대조해 'Uploaded 0 files' 가 스테일이 아님을 런타임에서 증명한다.
    // 미설정('')이면 헬스에서 빈 값 — 배포 스크립트/CI 가 항상 설정한다.
    __BUILD_COMMIT__: JSON.stringify(process.env.BUILD_COMMIT || ''),
  },
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
