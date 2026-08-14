/**
 * 배포 환경별 DO 인스턴스 이름 (방안 B — staging/production 서킷 독립화, 2026-08-14).
 *
 * staging/production 은 같은 DO 워커(ssak-do-worker)와 Pages 프로젝트를 공유하지만,
 * RATE_LIMITER DO 의 인스턴스 키를 환경별로 분리해 서킷·rate window·cooldown·통계를
 * 완전 독립화한다 (그 전까지는 단일 'global' 인스턴스를 공유해 staging 실수가
 * production 서킷을 망가뜨릴 수 있었다 — 2026-08-14 full-eval 실측에서 재현).
 *
 * 주입 방식: 빌드 타임에 vite define 이 `__DEPLOY_ENV__` 토큰을 리터럴로 치환한다
 * (vite.config.ts 참고):
 *   - DEPLOY_ENV=staging     → "staging"   (staging 배포, Pages branch=staging)
 *   - DEPLOY_ENV=production  → "production" (production 배포, branch=main)
 *   - 미설정                  → "production" (안전 기본값 — production 이 주 환경)
 *
 * 테스트(vitest.config.ts — vite.config.ts 를 쓰지 않음)나 esbuild 직접 번들 등
 * define 이 없는 컨텍스트에서는 `typeof` 가드로 'global' (기존 단일 인스턴스 동작)에
 * 폴백한다. `typeof` 는 미선언 식별자에 대해 ReferenceError 없이 'undefined' 를
 * 반환하므로 안전하다.
 */
declare const __DEPLOY_ENV__: string | undefined

/** 배포 환경 문자열 — 'production' | 'staging' | (테스트/로컬 폴백) 'global'. */
export const DEPLOY_ENV: string = typeof __DEPLOY_ENV__ !== 'undefined' && __DEPLOY_ENV__ ? __DEPLOY_ENV__ : 'global'

/** RATE_LIMITER DO 인스턴스 키 — 환경별로 분리되어 서킷 상태를 독립화한다. */
export function rateLimiterInstanceName(): string {
  return DEPLOY_ENV
}
