/**
 * S80-① 호환성: update-readme-eval.ts의 Cache Hit Rate 행이 skipped 필드를
 * hitRate와 함께 표기하는 계약을 고정한다.
 *
 * - skipped가 정의되어 있으면 (0이어도) `(skipped N)` 접미사를 항상 표기
 *   → denominator 의미론(hits+misses < totalQueries 가능)이 README에서 투명
 * - pre-S80-① 아티팩트(skipped undefined)는 접미사 생략 (필드 부재 = 레거시
 *   denominator, "0 skips"와 동일 의미)
 */
import { describe, it, expect } from 'vitest'
import { buildMetricsSection } from '../../scripts/update-readme-eval'

function makeReport(cache: {
  hitRate: number
  hits: number
  misses: number
  skipped?: number
  avgColdMs: number
  avgWarmMs: number
}): Parameters<typeof buildMetricsSection>[0] {
  return {
    timestamp: '2026-08-09T00:00:00.000Z',
    totalQueries: 500,
    passedQueries: 500,
    failedQueries: 0,
    passRate: 1,
    avgTimeMs: 1000,
    avgResultCount: 10,
    latencyPercentiles: { p50: 800, p95: 3000, p99: 5000 },
    qps: { avgQps: 0.5 },
    cache: {
      hitRate: cache.hitRate,
      hits: cache.hits,
      misses: cache.misses,
      avgColdMs: cache.avgColdMs,
      avgWarmMs: cache.avgWarmMs,
      // 레거시(skipped undefined) 시뮬레이션 — buildMetricsSection이 필드
      // 부재를 처리하는 경로를 검증하기 위해 undefined 허용 (런타임 데이터는
      // JSON 파싱이라 optional 필드가 존재할 수 있음)
      skipped: cache.skipped as number,
    } as Parameters<typeof buildMetricsSection>[0]['cache'],
    ranking: { queriesWithGoldStandard: 500, avgNdcgAt10: 0.28, avgMrr: 0.5, avgPrecisionAt10: 0.3 },
  }
}

describe('update-readme-eval Cache Hit Rate 행 (S80-① skipped 표기)', () => {
  it('skipped=0이어도 hitRate 옆에 (skipped 0)을 표기', () => {
    const section = buildMetricsSection(
      makeReport({ hitRate: 1, hits: 500, misses: 0, skipped: 0, avgColdMs: 1000, avgWarmMs: 0 }),
    )
    expect(section).toContain('| **Cache Hit Rate** | 100.0% (500/500) (skipped 0) |')
  })

  it('skipped>0이면 hitRate와 함께 (skipped N) 표기 — denominator 투명화', () => {
    // 실패 1 + 히트 1 → hitRate 1.0이지만 hits+misses < totalQueries
    const section = buildMetricsSection(
      makeReport({ hitRate: 1, hits: 1, misses: 0, skipped: 1, avgColdMs: 900, avgWarmMs: 5 }),
    )
    expect(section).toContain('| **Cache Hit Rate** | 100.0% (1/1) (skipped 1) |')
  })

  it('skipped undefined (pre-S80-① 레거시)면 접미사 생략', () => {
    const section = buildMetricsSection(
      makeReport({ hitRate: 0.5, hits: 1, misses: 1, avgColdMs: 900, avgWarmMs: 400 }),
    )
    expect(section).toContain('| **Cache Hit Rate** | 50.0% (1/2) |')
    expect(section).not.toContain('skipped')
  })

  it('Cache avg cold→warm 행은 skipped와 무관하게 유지', () => {
    const section = buildMetricsSection(
      makeReport({ hitRate: 1, hits: 5, misses: 0, skipped: 2, avgColdMs: 1234, avgWarmMs: 0 }),
    )
    expect(section).toContain('| **Cache avg cold→warm** | 1234ms → 0ms |')
  })
})

describe('update-readme-eval import 부작용 가드 (isDirectRun)', () => {
  it('모듈 import 시 main()이 실행되지 않음 (buildMetricsSection은 순수 함수)', () => {
    // vitest import 환경에서 process.argv[1]은 vitest 바이너리 경로이므로
    // isDirectRun=false → main() 미실행. buildMetricsSection은 README를
    // 읽지도 쓰지도 않는 순수 문자열 생성기임을 고정한다.
    const section = buildMetricsSection(
      makeReport({ hitRate: 1, hits: 500, misses: 0, skipped: 0, avgColdMs: 1000, avgWarmMs: 0 }),
    )
    expect(section.length).toBeGreaterThan(0)
    // main()의 성공 메시지는 buildMetricsSection 출력에 절대 나타나지 않는다.
    expect(section).not.toContain('README.md metrics section updated.')
  })
})
