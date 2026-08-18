/**
 * Node 전용 `cloudflare:workers` 대체 모듈 (P0-1, 2026-08-18 재작성).
 *
 * ## 배경
 *
 * 11개 DO 클래스는 `import { DurableObject } from 'cloudflare:workers'` 를 사용한다.
 * `cloudflare:workers` 는 workerd 내부에만 존재하는 가상 모듈이므로, 이 프로젝트가
 * 동작하는 4개 컨텍스트 중 `vite`(= `npm run dev`) 에서만 해석에 실패했다:
 *
 *   1. `vite build`        → build.rollupOptions.external 로 외부화 ✅
 *   2. `wrangler dev`      → workerd 제공 ✅
 *   3. vitest-pool-workers → workerd 제공 ✅
 *   4. `vite` (npm run dev) → ❌ Node 에 해당 모듈이 없음
 *
 * 컨텍스트 4 는 README 가 안내하는 기본 실행 경로인데 모든 요청이 500 이었다:
 *   "Cannot find module 'cloudflare:workers' imported from
 *    src/lib/ltr/click-logger.ts"
 * @hono/vite-dev-server 가 엔트리를 Node 모듈 러너에서 평가하면서 src/index.tsx 를
 * 통해 11개 DO 모듈을 모두 즉시 로드하기 때문이다.
 *
 * ## 해결 방식
 *
 * 이 파일은 vite.config.ts 의 `resolve.alias` 를 통해 **Node(vite dev) 에서만**
 * `cloudflare:workers` 자리에 주입된다. workerd 컨텍스트(2·3·4번 외 전부)는
 * 이 파일을 거치지 않고 진짜 가상 모듈을 그대로 사용하므로 프로덕션 동작은
 * 완전히 불변이다.
 *
 * ## 왜 globalThis 런타임 분기가 아닌가 (중요)
 *
 * 최초 구현은 `globalThis.DurableObject` 를 조회해 workerd 의 진짜 클래스를 얻고
 * 없으면 stub 으로 폴백하는 방식이었다. 이는 **틀렸다**. workerd 에서 실측하면:
 *
 *   { globalThis_DurableObject: "undefined",
 *     module_DurableObject: "function", same: false }
 *
 * 즉 `DurableObject` 는 전역이 아니라 모듈 export 로만 제공된다. 따라서 그 구현은
 * 프로덕션에서도 항상 stub 으로 폴백해 DO 가 진짜 기반 클래스를 상속하지 못했고,
 * RPC 가 다음 오류로 깨졌다:
 *
 *   "The receiving Durable Object does not support RPC, because its class was
 *    not declared with `extends DurableObject`."
 *
 * (2026-08-18 로컬 런타임에서 이미지 검색 실패로 발현 — 회귀 재발 방지를 위해
 *  기록한다. 런타임 분기로 되돌리지 말 것.)
 */

/**
 * workerd `DurableObject` 기반 클래스의 최소 구조적 대역.
 *
 * Node 컨텍스트에서는 DO 가 **인스턴스화되지 않는다** — 모듈 평가와 `extends`
 * 해석만 일어난다. 따라서 ctx/env 를 보관하는 생성 가능한 클래스면 충분하다.
 */
export class DurableObject<TEnv = unknown> {
  protected ctx: DurableObjectState
  protected env: TEnv

  constructor(ctx: DurableObjectState, env: TEnv) {
    this.ctx = ctx
    this.env = env
  }
}

/**
 * `WorkerEntrypoint` 도 같은 이유로 필요할 수 있어 함께 제공한다.
 * (현재 코드베이스는 미사용이지만, 추후 import 시 Node 에서 깨지지 않도록 대비)
 */
export class WorkerEntrypoint<TEnv = unknown> {
  protected ctx: ExecutionContext
  protected env: TEnv

  constructor(ctx: ExecutionContext, env: TEnv) {
    this.ctx = ctx
    this.env = env
  }
}

/** Node stub 에서는 RPC 대상이 없으므로 그대로 반환한다. */
export const RpcTarget = class RpcTarget {}
