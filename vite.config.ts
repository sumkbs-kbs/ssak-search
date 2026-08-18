import path from 'node:path'
import build from '@hono/vite-build/cloudflare-pages'
import devServer from '@hono/vite-dev-server'
import adapter from '@hono/vite-dev-server/cloudflare'
import { defineConfig } from 'vite'

export default defineConfig({
  // P0-1 (2026-08-18): `npm run dev` 는 엔트리를 Node 모듈 러너에서 평가하므로
  // workerd 가상 모듈 `cloudflare:workers` 를 해석할 수 없어 모든 요청이 500 이었다.
  // Node 에서만 구조적 stub 으로 치환한다. 아래 build.rollupOptions.external 이
  // 빌드 산출물에서는 이 모듈을 그대로 외부화하므로, wrangler dev / 프로덕션 /
  // vitest-pool-workers 는 진짜 모듈을 사용하며 DO 의 RPC 동작이 보존된다.
  //
  // ⚠️ 이 별칭을 지우고 런타임 globalThis 분기로 되돌리지 말 것:
  // workerd 에서 globalThis.DurableObject 는 undefined 이며(2026-08-18 실측),
  // 그 방식은 프로덕션에서도 stub 을 상속해 RPC 를 깨뜨린다.
  resolve: {
    alias: [
      {
        find: /^cloudflare:workers$/,
        replacement: path.resolve(__dirname, 'src/lib/cloudflare-workers-node-stub.ts'),
      },
    ],
  },
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
