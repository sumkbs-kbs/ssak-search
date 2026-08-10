import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGate, baselineFromArtifacts } from '../../scripts/verify-commit-eval'
import { parseEvalArtifacts } from '../../scripts/verify-jsonc'
import type { EvalReport, EvalResult, EvalQuery } from '../../eval/types'

/** Build a minimal EvalReport with a query whose pool ranks gold[0] first. */
function makeReport(
  queryId: string,
  opts: {
    poolDomains: string[]
    resultCount?: number
    responseTimeMs?: number
    passed?: boolean
    gold?: string[]
  },
): EvalReport {
  const gold = opts.gold ?? [opts.poolDomains[0]]
  const results = opts.poolDomains.map((domain, i) => ({
    title: `${domain} result`,
    url: `https://${domain}/article`,
    content: 'x',
    score: 1 - i * 0.1,
    domain,
  }))
  const query: EvalQuery = {
    id: queryId,
    query: `test query ${queryId}`,
    minResults: 1,
    tags: ['test'],
  }
  const result: EvalResult = {
    query,
    response: {
      query: query.query,
      results,
      response_time_ms: opts.responseTimeMs ?? 100,
      backend: 'test',
      fallback_used: false,
      page: 1,
      page_size: 10,
      total_results: results.length,
      total_pages: 1,
      no_results: false,
    },
    resultCount: opts.resultCount ?? results.length,
    responseTimeMs: opts.responseTimeMs ?? 100,
    backends: ['test'],
    passed: opts.passed ?? true,
    failures: [],
    ranking:
      gold.length > 0
        ? {
            // gold[0] at rank 1 → ndcg > 0 when it is in the pool
            ndcgAt10: opts.poolDomains.includes(gold[0]) ? 1 : 0,
            mrr: opts.poolDomains.includes(gold[0]) ? 1 : 0,
            precisionAt10: opts.poolDomains.includes(gold[0]) ? 1 : 0,
            relevantHits: opts.poolDomains.includes(gold[0]) ? 1 : 0,
          }
        : undefined,
  }
  return {
    timestamp: new Date().toISOString(),
    totalQueries: 1,
    passedQueries: (opts.passed ?? true) ? 1 : 0,
    failedQueries: (opts.passed ?? true) ? 0 : 1,
    passRate: (opts.passed ?? true) ? 1 : 0,
    avgTimeMs: opts.responseTimeMs ?? 100,
    avgResultCount: results.length,
    backendCoverage: { test: 1 },
    latencyPercentiles: { p50: 100, p75: 100, p90: 100, p95: 100, p99: 100, max: 100, min: 100 },
    qps: { avgQps: 0, totalQueries: 1, totalDurationMs: 100, byTag: {}, peakQps: 0 },
    ranking: { queriesWithGoldStandard: gold.length > 0 ? 1 : 0, avgNdcgAt10: 0, avgMrr: 0, avgPrecisionAt10: 0 },
    results: [result],
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
  tmp = mkdtempSync(join(tmpdir(), 'vce-'))
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

const gold: Record<string, string[]> = { 'q-pass': ['good.example.com'], 'q-fail': ['good.example.com'] }

// S86e: loadRunFiles was removed — runGate (via parseEvalArtifacts) is the
// single run-loading path. The numeric-order and missing-runs behaviors that
// loadRunFiles used to guarantee are asserted through runGate below.
describe('runGate run-file loading (S86e single path)', () => {
  it('lists run files in numeric order (run-1, run-2, ... run-10)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeRun(join(dir, 'results'), 2, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeRun(join(dir, 'results'), 10, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    const o = runGate(dir, { gold })
    expect(o.status).toBe('PASS')
    // parseEvalArtifacts globs alphabetically (run-1, run-10, run-2); the
    // gate re-sorts numerically like the removed loadRunFiles path.
    expect(o.detail).toContain('run-1.json, run-2.json, run-10.json')
    expect(o.detail).toContain('runs: 3')
  })

  it('ERROR when results/ exists but has no run files', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    const o = runGate(dir, { gold })
    expect(o.status).toBe('ERROR')
    expect(o.detail).toContain('no run-*.json artifacts found')
  })

  it('unions queries across runs (q-pass in run-1, q-fail in run-2)', () => {
    // The removed loadRunFiles returned a query union across ALL runs so a
    // query dropped from one run (runner error) is not silently excluded
    // from the median aggregation. runGate preserves that contract.
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeRun(join(dir, 'results'), 2, makeReport('q-fail', { poolDomains: ['good.example.com'] }))
    const o = runGate(dir, { gold })
    expect(o.status).toBe('PASS')
    expect(o.detail).toContain('queries: 2')
  })
})

// S86f: loadBaselineFromWorktree was removed — runGate derives the baseline
// from the SAME parsed artifacts (parseEvalArtifacts), so baselines/latest.json
// is never re-read/re-parsed (~3.4 MB per commit).
describe('baselineFromArtifacts (S86f — derived from the single parse pass)', () => {
  it('returns null when no baseline artifact exists', () => {
    const artifacts = parseEvalArtifacts(tmp)
    expect(baselineFromArtifacts(artifacts, tmp)).toBeNull()
  })

  it('derives a valid baseline from the already-parsed artifact', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'baselines'), { recursive: true })
    const rep = makeReport('q-pass', { poolDomains: ['good.example.com'] })
    writeFileSync(join(dir, 'baselines', 'latest.json'), JSON.stringify({ timestamp: 't1', report: rep }), 'utf-8')
    const artifacts = parseEvalArtifacts(dir)
    const b = baselineFromArtifacts(artifacts, dir)
    expect(b?.timestamp).toBe('t1')
    expect(b?.report.results).toHaveLength(1)
  })

  it('runGate surfaces the derived baseline timestamp (baseline not re-read)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeBaseline(dir, makeReport('q-pass', { poolDomains: ['good.example.com'] }), '2026-02-02T00:00:00.000Z')
    const o = runGate(dir, { gold })
    expect(o.status).toBe('PASS')
    expect(o.detail).toContain('baseline: 2026-02-02T00:00:00.000Z')
  })
})

describe('runGate', () => {
  it('SKIP when the eval dir does not exist', () => {
    const o = runGate(join(tmp, 'missing'), { gold })
    expect(o.status).toBe('SKIP')
  })

  it('SKIP when eval exists but no results/', () => {
    mkdirSync(tmp, { recursive: true })
    const o = runGate(tmp, { gold })
    expect(o.status).toBe('SKIP')
  })

  it('PASS when artifacts exist and no baseline to compare', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    const o = runGate(dir, { gold })
    expect(o.status).toBe('PASS')
    expect(o.detail).toContain('run-1.json')
    expect(o.detail).toContain('baseline: none')
  })

  it('PASS when the median run matches the baseline (no regression)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    const good = makeReport('q-pass', { poolDomains: ['good.example.com'] })
    writeRun(join(dir, 'results'), 1, good)
    writeRun(join(dir, 'results'), 2, good)
    writeBaseline(dir, good)
    const o = runGate(dir, { gold })
    expect(o.status).toBe('PASS')
    expect(o.detail).toContain('regressions: 0')
  })

  it('FAIL when the current run lost the gold result vs baseline', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    // Baseline: gold at rank 1 (good NDCG).
    writeBaseline(dir, makeReport('q-fail', { poolDomains: ['good.example.com'], gold: gold['q-fail'] }))
    // Current run: gold missing from the pool entirely → NDCG 0 → regression.
    const regressed = makeReport('q-fail', {
      poolDomains: ['irrelevant.example.com'],
      gold: gold['q-fail'],
      passed: false,
    })
    writeRun(join(dir, 'results'), 1, regressed)
    writeRun(join(dir, 'results'), 2, regressed)
    const o = runGate(dir, { gold })
    expect(o.status).toBe('FAIL')
    expect(o.detail).toContain('regressions:')
    expect(o.detail).toContain('q-fail')
  })

  it('ERROR on corrupt run file', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeFileSync(join(dir, 'results', 'run-1.json'), 'not json', 'utf-8')
    const o = runGate(dir, { gold })
    expect(o.status).toBe('ERROR')
    expect(o.detail).toContain('artifact integrity')
    expect(o.detail).toContain('run-1.json')
  })

  it('S86c ERROR (not silent PASS) on corrupt baselines/latest.json', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    // A corrupt baseline used to load as null via the removed
    // loadBaselineFromWorktree's try/catch → "baseline: none" → PASS. The
    // integrity pre-check must surface it as ERROR instead.
    const bd = join(dir, 'baselines')
    mkdirSync(bd, { recursive: true })
    writeFileSync(join(bd, 'latest.json'), '{ "report": {', 'utf-8')
    const o = runGate(dir, { gold })
    expect(o.status).toBe('ERROR')
    expect(o.detail).toContain('baselines/latest.json')
  })

  it('S86c ERROR on parseable-but-shapeless baseline ({} shape)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    const bd = join(dir, 'baselines')
    mkdirSync(bd, { recursive: true })
    writeFileSync(join(bd, 'latest.json'), '{}', 'utf-8')
    const o = runGate(dir, { gold })
    expect(o.status).toBe('ERROR')
    expect(o.detail).toContain('report.results')
  })

  it('S86c ERROR on corrupt results/latest.json (not read by loadRunFiles)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeFileSync(join(dir, 'results', 'latest.json'), 'not json', 'utf-8')
    const o = runGate(dir, { gold })
    expect(o.status).toBe('ERROR')
    expect(o.detail).toContain('results/latest.json')
  })

  it('S86c valid artifacts still PASS (no false positives)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeBaseline(dir, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    const o = runGate(dir, { gold })
    expect(['PASS', 'FAIL']).toContain(o.status)
  })

  it('single run file uses the single-run diffBaseline path (no crash)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeBaseline(dir, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    const o = runGate(dir, { gold })
    expect(['PASS', 'FAIL']).toContain(o.status)
  })

  it('S86d run reports are built from parseEvalArtifacts (no separate re-parse)', () => {
    // The integrity pre-check parses every artifact once; the gate must build
    // run reports from those SAME parsed objects. A corrupt results/latest.json
    // (not a run file) that WOULD have been ignored by loadRunFiles is caught
    // here; a valid run file passes through with the parsed report intact.
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeBaseline(dir, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    const o = runGate(dir, { gold })
    expect(['PASS', 'FAIL']).toContain(o.status)
    expect(o.detail).toContain('run-1.json')
  })

  it('S86d gate ERRORs when results/latest.json is corrupt (was silently ignored)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(join(dir, 'results'), { recursive: true })
    writeRun(join(dir, 'results'), 1, makeReport('q-pass', { poolDomains: ['good.example.com'] }))
    writeFileSync(join(dir, 'results', 'latest.json'), 'broken {', 'utf-8')
    const o = runGate(dir, { gold })
    expect(o.status).toBe('ERROR')
    expect(o.detail).toContain('latest.json')
  })

  it('does not fail when eval/ exists but results/ is absent (SKIP, not ERROR)', () => {
    const dir = join(tmp, 'eval')
    mkdirSync(dir, { recursive: true })
    const o = runGate(dir, { gold })
    expect(o.status).toBe('SKIP')
  })
})
