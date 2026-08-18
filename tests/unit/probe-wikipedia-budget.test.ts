/**
 * probe-wikipedia-budget 분석기 순수 함수 테스트 (TDD).
 *
 * REST/Action 예약 분할을 실측(max/p95 레이턴시 + 429 체인 타이밍)과 대조해
 * 검증하고, 필요 시 재조정하는 판정 로직(evaluateWikipediaBudget)을 고정한다.
 * 네트워크 없이 순수 계산만 검증 — 실측은 scripts/probe-wikipedia-budget.ts가 담당.
 *
 * 2026-08 실측 검증: REST 3000ms / Action 1500ms 유지 — 실제 429 체인
 * (REST 1812~1900ms, Action 1303~1380ms)이 각 예약 안에 들어옴 (비율 검증).
 */
import { describe, it, expect } from 'vitest'
import {
  evaluateWikipediaBudget,
  quantile,
  REST_ATTEMPTS,
  REST_DELAYS_MS,
  ACTION_ATTEMPTS,
  ACTION_DELAYS_MS,
  REST_BUDGET_MS,
  ACTION_BUDGET_MS,
  REST_PER_ATTEMPT_MS,
  ACTION_PER_ATTEMPT_MS,
  CEILING_MS,
} from '../../scripts/probe-wikipedia-budget'

describe('quantile — 순서 없는 샘플에서 p50/p95 계산', () => {
  it('정렬 후 지정 분위수를 반환한다', () => {
    const samples = [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000]
    expect(quantile(samples, 0.5)).toBe(550)
    expect(quantile(samples, 0.95)).toBe(955)
    expect(quantile(samples, 0.0)).toBe(100)
    expect(quantile(samples, 1.0)).toBe(1000)
  })

  it('빈 배열은 NaN, 단일 샘플은 그 값을 반환한다', () => {
    expect(Number.isNaN(quantile([], 0.5))).toBe(true)
    expect(quantile([420], 0.5)).toBe(420)
  })
})

describe('evaluateWikipediaBudget — REST/Action 예산 분할 검증', () => {
  // 현재 예산: REST = 3×700 + 900 = 3000, Action = 2×500 + 500 = 1500.
  it('실측 max/p95가 예산 안이면 ok (현재 분할 유지)', () => {
    const v = evaluateWikipediaBudget({
      restLatencyP95Ms: 300,
      restLatencyMaxMs: 450, // max 요구치 450 ≤ per-attempt 700
      actionLatencyP95Ms: 250,
      actionLatencyMaxMs: 380, // 380 ≤ 500
    })
    expect(v.ok).toBe(true)
    expect(v.restBudgetMs).toBe(3000)
    expect(v.actionBudgetMs).toBe(1500)
    expect(v.totalWorstMs).toBeLessThanOrEqual(CEILING_MS)
    expect(v.issues).toEqual([])
  })

  it('REST 실측 max가 per-attempt 예산(700)을 초과하면 adjust + 재분할', () => {
    const v = evaluateWikipediaBudget({
      restLatencyP95Ms: 600,
      restLatencyMaxMs: 900, // max 요구치 900 > 700 → REST 시도가 잘려 나갈 위험
      actionLatencyP95Ms: 200,
      actionLatencyMaxMs: 300,
    })
    expect(v.ok).toBe(false)
    expect(v.restPerAttemptMs).toBeGreaterThan(REST_PER_ATTEMPT_MS)
    expect(v.issues.some((i) => i.includes('REST'))).toBe(true)
    // 재분할 후에도 합산 worst ≤ ceiling
    expect(v.restChainWorstMs + v.actionChainWorstMs).toBeLessThanOrEqual(v.ceilingMs)
  })

  it('Action 실측 max가 per-attempt 예산(500)을 초과하면 adjust (REST 쪽 비중 축소)', () => {
    const v = evaluateWikipediaBudget({
      restLatencyP95Ms: 200,
      restLatencyMaxMs: 350,
      actionLatencyP95Ms: 450,
      actionLatencyMaxMs: 700, // 700 > 500 → Action 테일 잘림
    })
    expect(v.ok).toBe(false)
    expect(v.actionPerAttemptMs).toBeGreaterThan(ACTION_PER_ATTEMPT_MS)
    expect(v.issues.some((i) => i.includes('Action'))).toBe(true)
  })

  it('둘 다 max를 넘으면 둘 다 조정하고 ceiling 초과 시 초과분을 보고한다', () => {
    const v = evaluateWikipediaBudget({
      restLatencyP95Ms: 700,
      restLatencyMaxMs: 1100,
      actionLatencyP95Ms: 500,
      actionLatencyMaxMs: 800,
    })
    expect(v.ok).toBe(false)
    expect(v.issues.length).toBeGreaterThanOrEqual(1)
    // 재분할 worst는 ceiling을 넘을 수 없다 (조정 로직이 강제)
    expect(v.restChainWorstMs + v.actionChainWorstMs).toBeLessThanOrEqual(v.ceilingMs)
  })

  it('측정된 429 체인 총소요가 예약 예산을 초과하면 issue로 보고한다', () => {
    const v = evaluateWikipediaBudget({
      restLatencyP95Ms: 300,
      restLatencyMaxMs: 450,
      actionLatencyP95Ms: 250,
      actionLatencyMaxMs: 380,
      restChainTotalMs: 2600, // ≤ 3000 — 문제 없음
      actionChainTotalMs: 1900, // > 1500 예산 초과
    })
    expect(v.ok).toBe(false)
    expect(v.chainsFit).toBe(false)
    expect(v.issues.some((i) => i.includes('chain'))).toBe(true)
  })

  it('체인 미측정 시 chainsFit은 true (페이즈 B 스킵 허용)', () => {
    const v = evaluateWikipediaBudget({
      restLatencyP95Ms: 300,
      restLatencyMaxMs: 450,
      actionLatencyP95Ms: 250,
      actionLatencyMaxMs: 380,
    })
    expect(v.chainsFit).toBe(true)
    expect(v.ok).toBe(true)
  })

  it('예산 상수를 노출한다 (시뮬레이션 테이블과 정합)', () => {
    expect(REST_ATTEMPTS).toBe(3)
    expect(REST_DELAYS_MS).toEqual([300, 600])
    expect(ACTION_ATTEMPTS).toBe(2)
    expect(ACTION_DELAYS_MS).toEqual([500])
    expect(REST_BUDGET_MS).toBe(3000)
    expect(ACTION_BUDGET_MS).toBe(1500)
    expect(REST_PER_ATTEMPT_MS).toBe(700)
    expect(ACTION_PER_ATTEMPT_MS).toBe(500)
    expect(REST_ATTEMPTS * REST_PER_ATTEMPT_MS + REST_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      REST_BUDGET_MS,
    )
    expect(ACTION_ATTEMPTS * ACTION_PER_ATTEMPT_MS + ACTION_DELAYS_MS.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(
      ACTION_BUDGET_MS,
    )
  })
})
