/**
 * Unit tests: 팬아웃 부하 모델 캘리브레이션 (scripts/sim-calibrate.ts)
 *
 * eval run-*.json의 실측 responseTimeMs 분포로 BACKEND_MODEL의 per-attempt
 * 레이턴시(전역 스케일) + waitFor 백엔드 실패 확률을 수렴시켜, 시뮬레이션이
 * 실측 지연 분포를 반영하도록 한다. 데이터 한계: eval 결과는 엔드투엔드
 * responseTimeMs만 기록하고 백엔드별 레이턴시는 없으므로, 캘리브레이션은
 * 전역 스케일 + 429-취약 waitFor 백엔드의 failProb으로 집계 수렴한다.
 */
import { describe, it, expect } from 'vitest'
import {
  statsFromWallTimes,
  observedFromReports,
  simulateStats,
  latencyError,
  calibrateLatencyModel,
  applyScale,
  type EvalReportShape,
} from '../../scripts/sim-calibrate'
import { BACKEND_MODEL, PRODUCTION_WAIT_FOR, type FailureScenario } from '../../scripts/sim-fanout-latency'

describe('observedFromReports / statsFromWallTimes', () => {
  it('extracts responseTimeMs samples and merges backendCoverage across reports', () => {
    const reports: EvalReportShape[] = [
      {
        report: {
          results: [{ responseTimeMs: 800 }, { responseTimeMs: 1200 }],
          backendCoverage: { bing: 3, naver: 2 },
        },
      },
      {
        report: {
          results: [{ responseTimeMs: 2000 }],
          backendCoverage: { bing: 1, wikipedia: 4 },
        },
      },
    ]
    const { wallTimes, coverage } = observedFromReports(reports)
    expect(wallTimes).toEqual([800, 1200, 2000])
    expect(coverage).toEqual({ bing: 4, naver: 2, wikipedia: 4 })
  })

  it('computes p50/p95/p99 from the merged wall times', () => {
    const s = statsFromWallTimes([100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 2000, 4000])
    expect(s.n).toBe(12)
    expect(s.p50).toBeGreaterThanOrEqual(500)
    expect(s.p95).toBeGreaterThanOrEqual(1900)
    expect(s.p99).toBeGreaterThanOrEqual(3900)
  })
})

describe('simulateStats — 쿼리 멤버십(presenceProb) 반영', () => {
  it('presenceProb 0 백엔드는 수집률 0 — 다른 백엔드는 그대로 채운다', () => {
    const absent = BACKEND_MODEL.map((c) => (c.name === 'wikipedia' ? { ...c, presenceProb: 0 } : c))
    const s = simulateStats(absent, 500, 5, 10)
    expect(s.collectedRate['wikipedia'] ?? 0).toBe(0)
    // wikipedia가 없어도 나머지 백엔드가 phase-1(800ms)을 채운다.
    expect(s.p50).toBeLessThan(2000)
  })

  it('존재하는 waitFor 백엔드만 꼬리를 만들고 중앙값은 밀지 않는다', () => {
    // bing/hackernews는 항상 존재해 phase-1(800ms) 조기 종료를 보장하고,
    // wikipedia(존재 0.9, failProb 0.5)만 429 체인으로 늦게 정착한다:
    //   성공 50% → ~400ms (연장 없음), 1회 재시도 25% → ~1100ms,
    //   2회 재시도 25% → ~2100ms → 벽시간 = max(800, wikipedia settle).
    const model = BACKEND_MODEL.map((c) =>
      c.name === 'wikipedia'
        ? { ...c, presenceProb: 0.9, failProb: 0.5 }
        : c.name === 'bing' || c.name === 'hackernews'
          ? { ...c, presenceProb: 1 }
          : { ...c, presenceProb: 0 },
    )
    const s = simulateStats(model, 3000, 5, 10)
    expect(s.p95).toBeGreaterThan(1500) // 재시도 체인 꼬리 (~2100ms)
    expect(s.p50).toBeLessThan(1200) // 중앙값은 phase-1 부근에 남는다 (멤버십이 꼬리와 분리)
  })

  it('PRODUCTION_WAIT_FOR의 각 백엔드가 BACKEND_MODEL에 waitFor로 존재한다', () => {
    const byName = new Map(BACKEND_MODEL.map((c) => [c.name, c]))
    for (const name of PRODUCTION_WAIT_FOR) {
      const cfg = byName.get(name)
      expect(cfg, `${name} in BACKEND_MODEL`).toBeDefined()
      expect(cfg!.waitFor, `${name} waitFor`).toBe(true)
    }
  })
})

describe('simulateStats — 조건부 실패 시나리오 (p95/p99 악화 정량화)', () => {
  const wikipediaWindow: FailureScenario = {
    wikipediaWindowProb: 1,
    wikipediaMirrorSuccess: 0.8,
    downBackends: [],
  }

  it('wikipedia-429-window: 체인 스킵 → wikipedia 수집 0, 미러가 회수하고 벽시간 연장', () => {
    const base = simulateStats(BACKEND_MODEL, 2000, 5, 10)
    const windowed = simulateStats(BACKEND_MODEL, 2000, 5, 10, undefined, wikipediaWindow)
    expect(windowed.collectedRate['wikipedia'] ?? 0).toBe(0) // 체인 항상 스킵
    expect(windowed.collectedRate['wikipedia-mirror'] ?? 0).toBeGreaterThan(0.5) // 미러가 일부 회수
    // 미러(~1.4s 중앙값)가 팬아웃 벽시간을 연장 → 중앙값이 명확히 악화
    expect(windowed.p50).toBeGreaterThan(base.p50 + 200)
  })

  it('backend-down:bing — bing 수집 0, 팬아웃이 bing 없이도 작동하되 꼬리가 악화될 수 있다', () => {
    const down: FailureScenario = { wikipediaWindowProb: 0, wikipediaMirrorSuccess: 0.8, downBackends: ['bing'] }
    const base = simulateStats(BACKEND_MODEL, 2000, 5, 10)
    const degraded = simulateStats(BACKEND_MODEL, 2000, 5, 10, undefined, down)
    expect(degraded.collectedRate['bing'] ?? 0).toBe(0)
    expect(degraded.collectedRate['hackernews'] ?? 0).toBeGreaterThan(0.5) // 다른 백엔드는 정상
    // phase 임계값을 채우는 주력 백엔드 이탈 → phase 연장으로 p50 이상 상승
    expect(degraded.p50).toBeGreaterThan(base.p50)
  })
})

describe('simulateStats — waitFor 대안 정책 (조건부 await) 비교', () => {
  it('동일 시드에서 정책은 static 대비 지연을 단조 비증가시키고 wikipedia 커버리지를 유지한다', () => {
    const staticRun = simulateStats(BACKEND_MODEL, 2000, 5, 10, undefined, undefined, { kind: 'static' })
    const evRun = simulateStats(BACKEND_MODEL, 2000, 5, 10, undefined, undefined, {
      kind: 'expected-value',
      threshold: 2.0,
    })
    // 정책은 await을 제거만 하므로 (베이스 체인 스트림 동일) 벽시간은 단조 비증가.
    expect(evRun.p50).toBeLessThanOrEqual(staticRun.p50)
    expect(evRun.p95).toBeLessThanOrEqual(staticRun.p95)
    expect(evRun.p99).toBeLessThanOrEqual(staticRun.p99)
    // wikipedia(예상 가치 ≈6.4)는 임계치 2.0에서도 유지된다.
    const staticWiki = staticRun.collectedRate['wikipedia'] ?? 0
    expect(evRun.collectedRate['wikipedia'] ?? 0).toBeGreaterThan(staticWiki * 0.9)
    // 저가치 waitFor 백엔드(qiita ≈0.5)는 drop되어 수집률이 떨어진다.
    expect(evRun.collectedRate['qiita'] ?? 0).toBeLessThan(staticRun.collectedRate['qiita'] ?? 0)
  })

  it('none 정책은 waitFor 연장을 완전히 제거해 지연이 가장 낮다', () => {
    const staticRun = simulateStats(BACKEND_MODEL, 2000, 5, 10, undefined, undefined, { kind: 'static' })
    const noneRun = simulateStats(BACKEND_MODEL, 2000, 5, 10, undefined, undefined, { kind: 'none' })
    expect(noneRun.p50).toBeLessThan(staticRun.p50)
    expect(noneRun.p95).toBeLessThan(staticRun.p95)
  })
})

describe('latencyError (log-scale percentile error)', () => {
  it('is zero for identical distributions and grows with divergence', () => {
    const obs = { p50: 800, p95: 3000, p99: 4500, n: 100 }
    expect(latencyError({ p50: 800, p95: 3000, p99: 4500 }, obs)).toBe(0)
    const near = latencyError({ p50: 900, p95: 3500, p99: 5000 }, obs)
    const far = latencyError({ p50: 1600, p95: 6000, p99: 9000 }, obs)
    expect(far).toBeGreaterThan(near)
  })
})

describe('calibrateLatencyModel', () => {
  it('recovers a synthetic measured distribution (scale + wikipedia 429 window + overhead)', () => {
    // Synthetic "measured" data from a KNOWN model hidden from the calibrator:
    // global scale 1.2 + wikipedia failProb 0.55 (429 window) + non-fanout
    // overhead LN(150, 1.5) — pushes the p99 above the fanout ceiling (4500).
    const groundTruth = applyScale(BACKEND_MODEL, 1.2).map((c) =>
      c.name === 'wikipedia' ? { ...c, failProb: 0.55 } : c,
    )
    const sim = simulateStats(groundTruth, 400, 7, 10, { medianMs: 150, sigma: 1.5 })
    const obs = { ...sim, n: 400 }

    const r = calibrateLatencyModel(obs, {
      iterations: 400,
      seed: 7,
      scaleMin: 0.5,
      scaleMax: 2.0,
      scaleStep: 0.05,
      overheadMedianMin: 0,
      overheadMedianMax: 400,
      overheadMedianStep: 50,
      overheadSigmas: [1.0, 1.5, 2.0],
      coordinatePasses: 4,
    })

    // Calibration must strictly reduce the error and find a scale > 1.
    expect(r.errorAfter).toBeLessThan(r.errorBefore)
    expect(r.scale).toBeGreaterThan(1)
    // The calibrator must detect the non-fanout overhead (p99 > ceiling shape).
    expect(r.overhead.medianMs).toBeGreaterThan(0)
    // The calibrated simulation tracks the measured distribution within noise.
    expect(Math.abs(r.after.p50 - obs.p50) / obs.p50).toBeLessThan(0.2)
    expect(Math.abs(r.after.p95 - obs.p95) / obs.p95).toBeLessThan(0.2)
    expect(Math.abs(r.after.p99 - obs.p99) / obs.p99).toBeLessThan(0.3)
    // Re-run with the recovered model + overhead reproduces the observed tail
    // beyond the fanout ceiling (4500) — the measured p99 exceeds it.
    expect(obs.p99).toBeGreaterThan(4500)
  })

  it('does not invent overhead when the ground truth has none', () => {
    // Truth: scale 1.1 only — no non-fanout overhead.
    const groundTruth = applyScale(BACKEND_MODEL, 1.1)
    const sim = simulateStats(groundTruth, 400, 11, 10)
    const obs = { ...sim, n: 400 }

    const r = calibrateLatencyModel(obs, {
      iterations: 400,
      seed: 11,
      scaleMin: 0.5,
      scaleMax: 2.0,
      scaleStep: 0.05,
      overheadMedianMin: 0,
      overheadMedianMax: 400,
      overheadMedianStep: 50,
      overheadSigmas: [1.0, 1.5, 2.0],
      coordinatePasses: 4,
    })

    expect(r.errorAfter).toBeLessThan(r.errorBefore)
    // The p50 (weight 0.4) guard keeps the calibrator from inventing a large
    // median overhead — at most one grid step.
    expect(r.overhead.medianMs).toBeLessThanOrEqual(50)
    expect(Math.abs(r.after.p50 - obs.p50) / obs.p50).toBeLessThan(0.2)
  })

  it('is deterministic for a fixed seed', () => {
    const obs = { p50: 900, p95: 3200, p99: 4700, n: 500 }
    const a = calibrateLatencyModel(obs, { iterations: 300, seed: 99 })
    const b = calibrateLatencyModel(obs, { iterations: 300, seed: 99 })
    expect(a.scale).toBe(b.scale)
    expect(a.overhead).toEqual(b.overhead)
    expect(a.errorAfter).toBe(b.errorAfter)
  })
})
