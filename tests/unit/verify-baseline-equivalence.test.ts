/**
 * verify-baseline-equivalence — the third pre-push gate. Recomputed median
 * NDCG@10 (current code, stored pools) must match the stored baseline
 * avgNdcgAt10 within SCORING_DRIFT_EPSILON — the "do the numbers still mean
 * what the baseline says" assertion that runs ALWAYS (unlike the S86i guard,
 * which only fires when scoring files changed).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkBaselineEquivalence, type BaselineEquivalenceResult } from '../../scripts/verify-baseline-equivalence'
import { SCORING_DRIFT_EPSILON } from '../../scripts/verify-commit-eval'
import type { EvalReport, EvalResult, EvalQuery } from '../../eval/types'

/** Minimal single-query report: gold[0] at rank 1 → recomputed NDCG@10 = 1.0. */
function makeReport(queryId: string, poolDomains: string[], gold: string[]): EvalReport {
  const results = poolDomains.map((domain, i) => ({
    title: `${domain} result`,
    url: `https://${domain}/article`,
    content: 'x',
    score: 1 - i * 0.1,
    domain,
  }))
  const query: EvalQuery = { id: queryId, query: `test query ${queryId}`, minResults: 1, tags: ['test'] }
  const result: EvalResult = {
    query,
    response: {
      query: query.query,
      results,
      response_time_ms: 100,
      backend: 'test',
      fallback_used: false,
      page: 1,
      page_size: 10,
      total_results: results.length,
      total_pages: 1,
      no_results: false,
    },
    resultCount: results.length,
    responseTimeMs: 100,
    backends: ['test'],
    passed: true,
    failures: [],
    ranking: {
      ndcgAt10: poolDomains.includes(gold[0]) ? 1 : 0,
      mrr: poolDomains.includes(gold[0]) ? 1 : 0,
      precisionAt10: poolDomains.includes(gold[0]) ? 1 : 0,
      relevantHits: poolDomains.includes(gold[0]) ? 1 : 0,
    },
  }
  return {
    timestamp: new Date().toISOString(),
    totalQueries: 1,
    passedQueries: 1,
    failedQueries: 0,
    passRate: 1,
    avgTimeMs: 100,
    avgResultCount: results.length,
    backendCoverage: { test: 1 },
    latencyPercentiles: { p50: 100, p75: 100, p90: 100, p95: 100, p99: 100, max: 100, min: 100 },
    qps: { avgQps: 0, totalQueries: 1, totalDurationMs: 100, byTag: {}, peakQps: 0 },
    ranking: { queriesWithGoldStandard: 1, avgNdcgAt10: 0, avgMrr: 0, avgPrecisionAt10: 0 },
    results: [result],
  }
}

/** Override the STORED aggregate NDCG (the baseline snapshot's headline value). */
function withNdcg(report: EvalReport, ndcg: number): EvalReport {
  const base = report.ranking
  return {
    ...report,
    ranking: {
      queriesWithGoldStandard: base?.queriesWithGoldStandard ?? 1,
      avgNdcgAt10: ndcg,
      avgMrr: base?.avgMrr ?? 0,
      avgPrecisionAt10: base?.avgPrecisionAt10 ?? 0,
    },
  }
}

function writeRun(dir: string, n: number, report: EvalReport): void {
  writeFileSync(join(dir, `run-${n}.json`), JSON.stringify({ report }, null, 2), 'utf-8')
}

function writeBaseline(dir: string, report: EvalReport, timestamp = '2026-01-01T00:00:00.000Z'): void {
  const bd = join(dir, 'baselines')
  mkdirSync(bd, { recursive: true })
  writeFileSync(join(bd, 'latest.json'), JSON.stringify({ timestamp, report }, null, 2), 'utf-8')
}

let tmp: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'vbeq-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const gold: Record<string, string[]> = { q1: ['good.example.com'] }
// gold at rank 1 → the RECOMPUTED (S54, from pool) NDCG@10 is 1.0, regardless
// of the stored ranking field computeMedianReport ignores.
const recomputed = 1.0

describe('checkBaselineEquivalence (3rd pre-push gate)', () => {
  it('PASS when the recomputed NDCG equals the stored baseline', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q1', ['good.example.com'], gold['q1']))
    writeRun(join(dir, 'results'), 2, makeReport('q1', ['good.example.com'], gold['q1']))
    writeBaseline(dir, withNdcg(makeReport('q1', ['good.example.com'], gold['q1']), recomputed))
    const r: BaselineEquivalenceResult = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('PASS')
    expect(r.recomputedNdcg).toBeCloseTo(recomputed, 9)
    expect(r.delta).toBeLessThanOrEqual(SCORING_DRIFT_EPSILON)
  })

  it('DRIFT when the stored baseline was measured under different rules', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q1', ['good.example.com'], gold['q1']))
    writeRun(join(dir, 'results'), 2, makeReport('q1', ['good.example.com'], gold['q1']))
    // Stored baseline predates a scoring change (0.4 vs recomputed 1.0).
    writeBaseline(dir, withNdcg(makeReport('q1', ['good.example.com'], gold['q1']), 0.4))
    const r = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('DRIFT')
    expect(r.delta).toBeCloseTo(0.6, 9)
    expect(r.detail).toContain('Δ+0.6000')
  })

  it('DRIFT for a NEGATIVE delta (baseline above recompute)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    // >=2 runs → computeMedianReport recomputes NDCG from pools (S54); a
    // single run would return the STORED ranking field as-is (median.ts
    // single-run shortcut) and defeat the recompute semantics under test.
    writeRun(join(dir, 'results'), 1, makeReport('q1', ['good.example.com'], gold['q1']))
    writeRun(join(dir, 'results'), 2, makeReport('q1', ['good.example.com'], gold['q1']))
    writeBaseline(dir, withNdcg(makeReport('q1', ['good.example.com'], gold['q1']), recomputed + 0.6))
    const r = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('DRIFT')
    expect(r.delta).toBeCloseTo(-0.6, 9)
    expect(r.detail).toContain('Δ-0.6000')
  })

  it('respects a caller epsilon (default is the S86i 1e-4)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q1', ['good.example.com'], gold['q1']))
    writeRun(join(dir, 'results'), 2, makeReport('q1', ['good.example.com'], gold['q1']))
    // 5e-5 < default 1e-4 → PASS; but > strict 1e-6 → DRIFT under caller epsilon.
    writeBaseline(dir, withNdcg(makeReport('q1', ['good.example.com'], gold['q1']), recomputed - 5e-5))
    expect(checkBaselineEquivalence(dir, { gold }).status).toBe('PASS')
    expect(checkBaselineEquivalence(dir, { gold, epsilon: 1e-6 }).status).toBe('DRIFT')
  })

  it('NO_BASELINE when baselines/latest.json is absent (weak signal, not red)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q1', ['good.example.com'], gold['q1']))
    const r = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('NO_BASELINE')
  })

  it('ERROR on corrupt run artifact', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeFileSync(join(dir, 'results', 'run-1.json'), 'not json', 'utf-8')
    const r = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('ERROR')
    expect(r.detail).toContain('artifact integrity')
  })

  it('ERROR when results/ exists but has no run files', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    const r = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('ERROR')
    expect(r.detail).toContain('no run-*.json')
  })

  it('ERROR on corrupt baselines/latest.json (integrity pre-check, not silent PASS)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q1', ['good.example.com'], gold['q1']))
    const bd = join(dir, 'baselines')
    mkdirSync(bd, { recursive: true })
    writeFileSync(join(bd, 'latest.json'), '{ "report": {', 'utf-8')
    const r = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('ERROR')
    expect(r.detail).toContain('baselines/latest.json')
  })

  it('unions queries across runs (missing query in run-2 not dropped)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q1', ['good.example.com'], gold['q1']))
    writeRun(join(dir, 'results'), 2, makeReport('q2', ['good.example.com'], ['good.example.com']))
    // Baseline has the same two queries with matching stored NDCG → PASS.
    const base = makeReport('q1', ['good.example.com'], gold['q1'])
    const base2 = makeReport('q2', ['good.example.com'], ['good.example.com'])
    writeBaseline(dir, withNdcg({ ...base, results: [...base.results, ...base2.results] }, recomputed))
    const r = checkBaselineEquivalence(dir, { gold })
    expect(r.status).toBe('PASS')
  })
})
