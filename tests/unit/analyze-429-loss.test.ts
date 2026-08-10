/**
 * Unit tests for scripts/analyze-429-loss.ts — computeLossReport (S34/S37).
 *
 * Verifies the composition-controlled methodology with synthetic run-*.json
 * fixtures written to a temp dir:
 *  - wikipedia-absent runs lose NDCG vs wikipedia-present runs (same other
 *    backends) → the loss is attributed to wikipedia
 *  - co-failure runs (wikipedia + bing both gone) are EXCLUDED — no
 *    same-composition present twin → unattributable
 *  - EN+gold-wiki vs non-EN coverage split
 *  - the summary is importable without CLI side effects (S37 runner hook)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { SearchResult } from '../../src/types'
import type { EvalBaseline } from '../../eval/types'
import {
  computeLossReport,
  loadRunArtifacts,
  parseMirrorEvents,
  aggregateMirrorStats,
} from '../../scripts/analyze-429-loss'

function makeRunDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'loss-test-'))
  mkdirSync(dir, { recursive: true })
  return dir
}

interface FixtureQuery {
  id: string
  backends: string[][]
  ndcgs: number[]
  /** Per-run response.results (S54 — live recompute pool). Absent → stored-ranking fallback. */
  pools?: Array<Array<Pick<SearchResult, 'url' | 'domain' | 'title' | 'content' | 'score'>>>
}

/** Write one run-N.json per run index with the per-query backends/ndcg (+ optional pool).
 *  S86h-②: fixtures use the eval-root layout (results/ subdir) — parseRunFiles
 *  globs evalDir/results/run-*.json, so `dir` IS the eval root in every test. */
function writeRuns(dir: string, queries: FixtureQuery[], runCount: number): void {
  const resultsDir = join(dir, 'results')
  mkdirSync(resultsDir, { recursive: true })
  for (let r = 0; r < runCount; r++) {
    const results = queries.map((q) => ({
      query: { id: q.id },
      backends: q.backends[r] ?? [],
      ranking: { ndcgAt10: q.ndcgs[r] ?? 0 },
      ...(q.pools?.[r] ? { response: { results: q.pools[r] } } : {}),
    }))
    writeFileSync(join(resultsDir, `run-${r + 1}.json`), JSON.stringify({ report: { results } }), 'utf-8')
  }
}

describe('loadRunArtifacts (S86f single-pass)', () => {
  let dir: string
  beforeEach(() => {
    dir = makeRunDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('derives run maps and full reports from ONE parse per run file', () => {
    writeRuns(
      dir,
      [
        { id: 'en-fact-01', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.9, 0.2] },
        { id: 'zh-fact-03', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.8, 0.1] },
      ],
      2,
    )
    const gold = new Map<string, string[]>([
      ['en-fact-01', ['wikipedia.org']],
      ['zh-fact-03', ['baike.baidu.com']],
    ])
    const { runMaps, reports } = loadRunArtifacts(dir, gold)
    expect(runMaps).toHaveLength(2)
    expect(reports).toHaveLength(2)
    // run maps carry per-query backends + NDCG (legacy stored-ranking fallback)
    expect(runMaps[0].get('en-fact-01')?.backends).toEqual(['wikipedia', 'bing'])
    expect(runMaps[0].get('en-fact-01')?.ndcg).toBeCloseTo(0.9, 3)
    expect(runMaps[1].get('en-fact-01')?.backends).toEqual(['bing'])
    // full reports come from the SAME parse (S75 gate cross-ref input)
    expect(reports[0].results.map((r) => r.query.id)).toEqual(['en-fact-01', 'zh-fact-03'])
    expect(reports[1].results).toHaveLength(2)
  })

  it('EXCLUDES a bare-format (no report wrapper) run file — S86h gate contract', () => {
    // S86f kept the legacy behavior (bare raw.results file → run map
    // contributed, report skipped). S86h's parseRunFiles gate treats bare
    // files as CORRUPT — verify-jsonc --eval rejects the same shape, so the
    // loss report must not analyze them either (single entry point shared
    // with the CI integrity gate).
    writeRuns(dir, [{ id: 'q1', backends: [['wikipedia'], ['wikipedia']], ndcgs: [0.5, 0.5] }], 2)
    writeFileSync(
      join(dir, 'results', 'run-1.json'),
      JSON.stringify({
        results: [{ query: { id: 'q1' }, backends: ['wikipedia'], ranking: { ndcgAt10: 0.5 } }],
      }),
      'utf-8',
    )
    const { runMaps, reports } = loadRunArtifacts(dir, new Map([['q1', ['good.example.com']]]))
    expect(runMaps).toHaveLength(1) // bare run-1.json is gate-excluded
    expect(reports).toHaveLength(1)
    expect(runMaps[0].get('q1')?.ndcg).toBeCloseTo(0.5, 3) // run-2 stored-ranking fallback
  })

  it('recomputes NDCG live from the pool, falling back to stored ranking only without a pool (S54)', () => {
    const good = { url: 'https://good.example.com/a', domain: 'good.example.com', title: 'g', content: 'g', score: 1 }
    const other = {
      url: 'https://other.example.com/b',
      domain: 'other.example.com',
      title: 'o',
      content: 'o',
      score: 1,
    }
    writeRuns(
      dir,
      [{ id: 'q1', backends: [['wikipedia'], ['wikipedia']], ndcgs: [0.9, 0.4], pools: [[good, other]] }],
      2,
    )
    const { runMaps } = loadRunArtifacts(dir, new Map([['q1', ['good.example.com']]]))
    // run-1: pool present → LIVE recompute under CURRENT gold — good.example.com
    // at rank 1 → NDCG@10 = 1.0 (S49 label-suffix + S50 DCG cap). The stored
    // 0.9 is IGNORED even though it is plausible.
    expect(runMaps[0].get('q1')?.ndcg).toBeCloseTo(1.0, 3)
    expect(runMaps[0].get('q1')?.ndcg).not.toBeCloseTo(0.9, 3)
    // run-2: no pool → legacy stored-ranking fallback
    expect(runMaps[1].get('q1')?.ndcg).toBeCloseTo(0.4, 3)
  })
})

describe('computeLossReport', () => {
  let dir: string
  beforeEach(() => {
    dir = makeRunDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('attributes NDCG loss to wikipedia when absent runs share the same other-backend composition', () => {
    // en-fact-01: wikipedia present → ndcg 0.9 (bing+hackernews), absent →
    // 0.2 (same bing+hackernews). The 0.7 drop is wikipedia's.
    writeRuns(
      dir,
      [
        {
          id: 'en-fact-01',
          backends: [
            ['wikipedia', 'bing', 'hackernews'],
            ['bing', 'hackernews'],
            ['wikipedia', 'bing', 'hackernews'],
          ],
          ndcgs: [0.9, 0.2, 0.95],
        },
        { id: 'zh-fact-03', backends: [['wikipedia', 'bing'], ['bing'], ['bing']], ndcgs: [0.8, 0.1, 0.15] },
      ],
      3,
    )

    const s = computeLossReport(dir)
    expect(s.runCount).toBe(3)
    expect(s.attributableCount).toBe(2)

    const en = s.rows.find((r) => r.id === 'en-fact-01')
    expect(en).toBeDefined()
    // presentAvg = (0.9+0.95)/2 = 0.925; absent 0.2 → gain 0.725, weighted = 0.725
    expect(en!.gain).toBeCloseTo(0.725, 3)
    expect(en!.weighted).toBeCloseTo(0.725, 3)

    // weighted loss = Σ max(0, presentAvg − absentNdcg) over all absent runs.
    // en-fact-01: 0.925−0.2 = 0.725. zh-fact-03: presentAvg 0.8; two absent
    // runs (0.1, 0.15) → 0.7 + 0.65 = 1.35. Total 2.075.
    expect(s.weightedLoss).toBeCloseTo(0.725 + 1.35, 3)
    expect(s.nGain).toBe(2)
  })

  it('excludes co-failure runs that have no wikipedia-present twin (unattributable)', () => {
    // en-fact-17: run 1 loses EVERYTHING (backends:['failed'] → skipped),
    // run 2 is [duckduckgo] alone (wikipedia + bing + arxiv all gone) — no
    // run shares that composition WITH wikipedia → unattributable.
    writeRuns(
      dir,
      [
        {
          id: 'en-fact-17',
          backends: [['failed'], ['duckduckgo'], ['wikipedia', 'bing', 'arxiv', 'duckduckgo']],
          ndcgs: [0, 0.1, 0.85],
        },
      ],
      3,
    )

    const s = computeLossReport(dir)
    // Only one composition has wikipedia (run 3) and the other compositions
    // (failed is skipped, duckduckgo-alone) have no present twin → 0 rows.
    expect(s.attributableCount).toBe(0)
    expect(s.weightedLoss).toBeCloseTo(0, 3)
    expect(s.nGain).toBe(0)
  })

  it('splits mirror coverage by gold≈wikipedia vs not (S36/S38 closed the EN-only gap)', () => {
    // NOTE: this test reads the REAL eval/gold-standards.json (GOLD_PATH is
    // fixed) — en-fact-40 and ja-fact-02 must have wikipedia.org
    // relevantDomains. These are stable eval IDs from the 500-query golden
    // set; if the gold set is ever regenerated, update this fixture.
    // S36 (Wikidata non-EN) + S38 (ja 2nd tier) make ANY gold≈wikipedia
    // query coverable — ja-fact-02 is no longer "still vulnerable".
    writeRuns(
      dir,
      [
        { id: 'en-fact-40', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.9, 0.3] }, // gold ≈ wikipedia → coverable
        { id: 'ja-fact-02', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.8, 0.2] }, // gold ≈ wikipedia (non-EN) → coverable since S36
      ],
      2,
    )

    const s = computeLossReport(dir)
    expect(s.coverable).toBe(2)
    expect(s.stillVulnerable).toBe(0)
    expect(s.nonEnCount).toBe(1)
  })

  // ── S54: live NDCG recompute (stored ranking is stale under S49/S50) ──

  it('recomputes NDCG from response.results + CURRENT gold, ignoring the stale stored ranking', () => {
    // en-fact-01 gold (from eval/gold-standards.json) = [wikipedia.org,
    // britannica.com] — label-suffix: 'en.wikipedia.org' counts. The stored
    // ranking field carries PRE-S50 values (1.5/0.2 — impossible under the
    // DCG cap, i.e. inflated). S54 must recompute from the pool instead:
    //   run 1 (wikipedia present): wikipedia hit at rank 1 →
    //     NDCG = (1/log2(2)) / (1/log2(2) + 1/log2(3)) = 1 / 1.6309 ≈ 0.613
    //   run 2 (wikipedia absent, [bing]): example.com pool → 0
    writeRuns(
      dir,
      [
        {
          id: 'en-fact-01',
          backends: [['wikipedia', 'bing'], ['bing']],
          ndcgs: [1.5, 0.2], // stale stored values — MUST be ignored
          pools: [
            [
              {
                url: 'https://en.wikipedia.org/wiki/Nervous_system',
                domain: 'en.wikipedia.org',
                title: 'x',
                content: 'x',
                score: 1,
              },
            ],
            [{ url: 'https://example.com/unrelated', domain: 'example.com', title: 'x', content: 'x', score: 1 }],
          ],
        },
      ],
      2,
    )

    const s = computeLossReport(dir)
    expect(s.attributableCount).toBe(1)
    const row = s.rows[0]
    const idcg2 = 1 + 1 / Math.log2(3)
    const recomputed = 1 / idcg2
    // If the stale stored ranking (1.5) had been used, gain would be 1.3.
    expect(row.gain).toBeCloseTo(recomputed, 3)
    expect(s.weightedLoss).toBeCloseTo(recomputed, 3)
  })

  it('falls back to the stored ranking when the run has no response.results (legacy artifacts)', () => {
    // Old-style fixture (backends + ranking only, no serialized pool) — the
    // stored field is the only signal available; S54 keeps it analyzable.
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.9, 0.2] }], 2)

    const s = computeLossReport(dir)
    expect(s.attributableCount).toBe(1)
    expect(s.rows[0].gain).toBeCloseTo(0.7, 3)
  })

  it('recomputes to 0 when the pool exists but current gold is empty (gold-edit edge, review S54)', () => {
    // A gold edit that DELETES a query's domains must not leave a stale
    // stored value trusted — recompute yields 0 for an empty gold set
    // (computeNdcg(pool, [], 10) === 0). The id below has NO gold entry in
    // the real gold-standards.json, so the stored field (0.8/0.2) is the
    // only non-zero signal — the recompute path must win and zero it out.
    writeRuns(
      dir,
      [
        {
          id: 's54-no-gold-query',
          backends: [['wikipedia', 'bing'], ['bing']],
          ndcgs: [0.8, 0.2], // stale stored values — ignored via recompute
          pools: [
            [
              {
                url: 'https://en.wikipedia.org/wiki/X',
                domain: 'en.wikipedia.org',
                title: 'x',
                content: 'x',
                score: 1,
              },
            ],
            [{ url: 'https://example.com/y', domain: 'example.com', title: 'x', content: 'x', score: 1 }],
          ],
        },
      ],
      2,
    )

    const s = computeLossReport(dir)
    // present recompute = computeNdcg(pool, [], 10) = 0; absent = 0 → gain 0.
    // If the stored fallback had run (old `goldDomains.length > 0` guard),
    // gain would be 0.8 − 0.2 = 0.6.
    expect(s.attributableCount).toBe(1)
    expect(s.rows[0].gain).toBeCloseTo(0, 3)
    expect(s.weightedLoss).toBeCloseTo(0, 3)
  })

  it('uses the live-recomputed NDCG for the mirror recovery split (S39 under S54)', () => {
    // en-fact-02 gold = [en.wikipedia.org, ...]. run 1 (wikipedia present)
    // pool has the wiki hit at rank 1; run 2 absent fired the dbpedia mirror
    // and the mirror RECONSTRUCTED the same gold URL (rank 1 again) → NDCG
    // identical → loss ≈ 0 → recovered. Stored values (1.47/1.45) are ignored
    // but the classification must still hold on the recomputed ones.
    writeRuns(
      dir,
      [
        {
          id: 'en-fact-02',
          backends: [
            ['wikipedia', 'bing', 'hackernews'],
            ['bing', 'hackernews', 'dbpedia'],
          ],
          ndcgs: [1.47, 1.45],
          pools: [
            [
              {
                url: 'https://en.wikipedia.org/wiki/DNA_replication',
                domain: 'en.wikipedia.org',
                title: 'x',
                content: 'x',
                score: 1,
              },
            ],
            [
              {
                url: 'https://en.wikipedia.org/wiki/DNA_replication',
                domain: 'en.wikipedia.org',
                title: 'x',
                content: 'x',
                score: 1,
              },
            ],
          ],
        },
      ],
      2,
    )

    const s = computeLossReport(dir)
    expect(s.mirrorFiredRuns).toBe(1)
    expect(s.mirrorRecoveredRuns).toBe(1)
    expect(s.mirrorStillLostRuns).toBe(0)
    expect(s.weightedRecovered).toBeCloseTo(0, 3)
  })

  it('works without a log file (S37 runner integration) — 429 evidence simply zeroed', () => {
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.9, 0.2] }], 2)

    // No logText → no 429 counts, no DBpedia abort evidence, no never-present
    // set (needs 429 evidence) — but the weighted-loss core still computes.
    const s = computeLossReport(dir)
    expect(s.weightedLoss).toBeCloseTo(0.7, 3)
    expect(s.neverPresent).toBe(0)
    expect(s.wikiGoldNever).toBe(0)
    expect(s.dbpAbort).toBe(0)
    expect(s.rows[0].c429).toBe(0)
  })

  it('handles an empty results dir gracefully', () => {
    const s = computeLossReport(dir)
    expect(s.runCount).toBe(0)
    expect(s.attributableCount).toBe(0)
    expect(s.weightedLoss).toBe(0)
    expect(s.rows).toEqual([])
  })

  // ── S39: mirror-fallback recovery split ────────────────────────────────

  it('pairs mirror-fired absent runs with their wikipedia-present twin (mirrors excluded from composition)', () => {
    // en-fact-02: wikipedia present → ndcg 1.47 (bing+hackernews). The
    // wikipedia-absent run fired the S35 DBpedia mirror (dbpedia in
    // backends) and recovered en.wikipedia.org gold → ndcg 1.45. Before S39
    // the composition keys were 'bing+hackernews' (present) vs
    // 'bing+dbpedia+hackernews' (absent) → NO pair → the recovery was
    // invisible. S39 excludes mirror backends → they pair, loss ≈ 0.
    writeRuns(
      dir,
      [
        {
          id: 'en-fact-02',
          backends: [
            ['wikipedia', 'bing', 'hackernews'],
            ['bing', 'hackernews', 'dbpedia'],
          ],
          ndcgs: [1.47, 1.45],
        },
      ],
      2,
    )

    const s = computeLossReport(dir)
    expect(s.attributableCount).toBe(1)
    expect(s.mirrorFiredRuns).toBe(1)
    expect(s.mirrorRecoveredRuns).toBe(1) // loss 0.02 ≤ max(0.1, 0.294)
    expect(s.mirrorStillLostRuns).toBe(0)
    expect(s.mirrorRecoveredQueries).toBe(1)
    expect(s.mirrorStillLostQueries).toBe(0)
    expect(s.weightedRecovered).toBeCloseTo(0.02, 3)
    expect(s.weightedStillLost).toBe(0)
    expect(s.weightedNoMirror).toBe(0)

    const row = s.rows[0]
    expect(row.mirrorFired).toBe(1)
    expect(row.mirrorRecovered).toBe(1)
    expect(row.mirrorStillLost).toBe(0)
  })

  it('classifies a mirror-fired run that did NOT recover gold as still-lost', () => {
    // en-fact-07: present 1.38 (wikipedia), absent run fired the mirror but
    // the mirror returned nothing relevant → ndcg 0.00. loss 1.38 >
    // max(0.1, 0.276) → mirror-still-lost, full loss attributed.
    writeRuns(
      dir,
      [
        {
          id: 'en-fact-07',
          backends: [
            ['wikipedia', 'bing', 'hackernews'],
            ['bing', 'hackernews', 'dbpedia'],
          ],
          ndcgs: [1.38, 0],
        },
      ],
      2,
    )

    const s = computeLossReport(dir)
    expect(s.mirrorFiredRuns).toBe(1)
    expect(s.mirrorRecoveredRuns).toBe(0)
    expect(s.mirrorStillLostRuns).toBe(1)
    expect(s.mirrorStillLostQueries).toBe(1)
    expect(s.weightedStillLost).toBeCloseTo(1.38, 3)
    expect(s.weightedRecovered).toBe(0)
    expect(s.weightedLoss).toBeCloseTo(1.38, 3)

    const row = s.rows[0]
    expect(row.mirrorFired).toBe(1)
    expect(row.mirrorRecovered).toBe(0)
    expect(row.mirrorStillLost).toBe(1)
  })

  it('keeps classic no-mirror losses separate from mirror-fired runs', () => {
    // gk-11: 3 runs. run 1 wikipedia present (ndcg 1.2). run 2 absent
    // WITHOUT any mirror (no dbpedia — wikipedia just dropped) → ndcg 0.2,
    // classic S34 loss. run 3 absent WITH dbpedia mirror recovered → 1.15.
    writeRuns(
      dir,
      [{ id: 'gk-11', backends: [['wikipedia', 'bing'], ['bing'], ['bing', 'dbpedia']], ndcgs: [1.2, 0.2, 1.15] }],
      3,
    )

    const s = computeLossReport(dir)
    expect(s.mirrorFiredRuns).toBe(1)
    expect(s.mirrorRecoveredRuns).toBe(1)
    expect(s.mirrorStillLostRuns).toBe(0)
    // no-mirror absent run loss = 1.2 − 0.2 = 1.0; recovered run loss = 0.05
    expect(s.weightedNoMirror).toBeCloseTo(1.0, 3)
    expect(s.weightedRecovered).toBeCloseTo(0.05, 3)
    expect(s.weightedLoss).toBeCloseTo(1.05, 3)

    const row = s.rows[0]
    expect(row.mirrorFired).toBe(1)
    expect(row.mirrorRecovered).toBe(1)
    expect(row.mirrorStillLost).toBe(0)
  })

  it('does NOT count a mirror run as recovered when the present baseline is ~0 (pAvg floor, review S39)', () => {
    // Present baseline near 0 (wikipedia present but scored 0.05 — the gold
    // is not being served even WITH wikipedia). A mirror run at 0.0 is "no
    // signal", not a recovery: the presentAvg ≥ 0.1 gate (review S39) stops
    // the 0.1 loss floor from inflating recovery counts.
    writeRuns(
      dir,
      [
        {
          id: 'en-news-27',
          backends: [
            ['wikipedia', 'bing'],
            ['bing', 'dbpedia'],
          ],
          ndcgs: [0.05, 0],
        },
      ],
      2,
    )

    const s = computeLossReport(dir)
    expect(s.mirrorFiredRuns).toBe(1)
    expect(s.mirrorRecoveredRuns).toBe(0) // pAvg 0.05 < 0.1 → not recovered
    expect(s.mirrorStillLostRuns).toBe(1)
    expect(s.weightedStillLost).toBeCloseTo(0.05, 3)
    expect(s.weightedLoss).toBeCloseTo(0.05, 3)
  })

  it('detects the S35 orchestrator mirror log messages — abort + recovered, disjoint status', () => {
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.9, 0.2] }], 2)

    const log = [
      'Running 500 eval queries',
      '─ run 1/3 ─',
      '[Orchestrator] Wikipedia mirror fallback failed (non-critical): { error: fetch failed }',
      '[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing): { backend: "dbpedia", count: 5 }',
      'Wikipedia DBpedia lookup fallback failed (status 429)', // old-style status failure
      '─ run 2/3 ─',
      '[Orchestrator] Wikipedia mirror fallback failed (non-critical): { error: timeout }',
      '─ run 3/3 ─',
    ].join('\n')

    const s = computeLossReport(dir, log)
    // dbpAbort (generic errors, review S39): the 2 orchestrator catch-all
    // failures — the old-style status message is NOT a generic error.
    expect(s.dbpAbort).toBe(2)
    // dbpStatus is DISJOINT — status-code failures ONLY (review S39):
    // the old 'failed (status 429)' line is the only status failure.
    expect(s.dbpStatus).toBe(1)
    expect(s.mirrorRecoveredLog).toBe(1) // the recovered-gold line
  })

  it('classifies never-present wikipedia queries by mirror fire + NDCG>0 recovery', () => {
    // S35/S36/S38 PRIMARY target: wikipedia absent in EVERY run (no present
    // twin → invisible to the composition comparison). Here we classify them
    // directly: did a mirror fire, and did any run score NDCG > 0?
    // ja-fact-02: wikipedia never present, but run 2 fired the Wikidata
    // mirror and reconstructed the gold URL (ndcg 0.7) → recovered.
    // en-fact-40: wikipedia never present, mirror fired (dbpedia) but
    // returned nothing relevant (ndcg 0 in all runs) → fired, not recovered.
    writeRuns(
      dir,
      [
        { id: 'ja-fact-02', backends: [['bing'], ['bing', 'wikidata']], ndcgs: [0.1, 0.7] },
        { id: 'en-fact-40', backends: [['bing'], ['bing', 'dbpedia']], ndcgs: [0, 0] },
      ],
      2,
    )

    // 429 evidence must be attributable to the query — parseQuery429s resolves
    // the q= URL param through ID_BY_QUERY (the REAL query text from
    // eval/queries.ts), so use the actual texts here.
    const log = [
      'Running 500 eval queries',
      '─ run 1/3 ─',
      'https://ja.wikipedia.org/w/api.php?...&q=' +
        encodeURIComponent('人工知能の仕組み') +
        ' ... wikipedia REST rate-limited (429)',
      'https://en.wikipedia.org/w/rest.php/v1/search/page?q=' +
        encodeURIComponent('how does the nervous system work') +
        ' ... wikipedia REST rate-limited (429)',
      '─ run 2/3 ─',
      'https://ja.wikipedia.org/w/api.php?...&q=' +
        encodeURIComponent('人工知能の仕組み') +
        ' ... wikipedia REST rate-limited (429)',
    ].join('\n')
    const s = computeLossReport(dir, log)
    expect(s.neverPresent).toBe(2)
    expect(s.neverPresentMirrorFired).toBe(2)
    expect(s.neverPresentMirrorRecovered).toBe(1) // only ja-fact-02
  })

  // ── S40: log-parsed mirror firing cross-ref ────────────────────────────

  it('cross-references wikidata/dbpedia-lang log recoveries with the never-present set', () => {
    // ja-fact-02: wikipedia never present (both runs [bing] only) + 429
    // evidence + a wikidata recovered event in the log. The run-JSON analysis
    // CANNOT see this recovery (backends stay [bing] — the orchestrator only
    // records 'wikidata' on success, and here the event is log-attributed),
    // which is exactly why S40 parses the log stream.
    writeRuns(dir, [{ id: 'ja-fact-02', backends: [['bing'], ['bing']], ndcgs: [0.1, 0.1] }], 2)
    const log = [
      'Running 500 eval queries × 3 runs (median aggregation)...',
      '  ─ run 1/3 ─',
      'https://ja.wikipedia.org/w/api.php?...&q=' +
        encodeURIComponent('人工知能の仕組み') +
        ' ... wikipedia REST rate-limited (429)',
      '{"level":"warn","message":"[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing):","query":"人工知能の仕組み","language":"ja","backend":"wikidata","count":5}',
      '  ─ run 2/3 ─',
      '{"level":"warn","message":"Wikidata fallback skipped (API quota exhausted):","query":"人工知能の仕組み","language":"ja"}',
    ].join('\n')
    const s = computeLossReport(dir, log)
    expect(s.neverPresent).toBe(1) // ja-fact-02: never present + 429 evidence
    expect(s.neverPresentRecoveredByLog).toBe(1) // wikidata recovered event for it
    expect(s.nonEnMirrorRecoveredLog).toBe(1) // ja-fact-02 is a ja/zh/kr id
    const wd = s.mirrorStats.find((b) => b.backend === 'wikidata')
    expect(wd).toBeDefined()
    expect(wd!.fired).toBe(1)
    expect(wd!.recoveredResults).toBe(5)
    expect(wd!.skipped).toBe(1)
    expect(wd!.successRate).toBeCloseTo(0.5, 3)
  })

  it('reports empty mirror stats without a log (S37 runner path)', () => {
    writeRuns(dir, [{ id: 'ja-fact-02', backends: [['bing'], ['bing']], ndcgs: [0.1, 0.1] }], 2)
    const s = computeLossReport(dir)
    expect(s.mirrorEvents).toEqual([])
    expect(s.mirrorStats).toEqual([])
    expect(s.nonEnMirrorRecoveredLog).toBe(0)
    expect(s.neverPresentRecoveredByLog).toBe(0)
  })
})

describe('gate × wikipedia-429 cross-reference (S75)', () => {
  // en-fact-01 gold = [wikipedia.org, britannica.com] (real gold-standards.json).
  // Pool-less fixtures exercise the S54 stored-ranking fallback on BOTH sides
  // (run files carry ranking.ndcgAt10; the baseline carries ranking too), so
  // the cross-reference sees exactly the numbers the gate sees.
  const baseline = (storedNdcg: number): EvalBaseline => ({
    timestamp: '2026-01-01T00:00:00.000Z',
    report: {
      timestamp: '2026-01-01T00:00:00.000Z',
      totalQueries: 1,
      passedQueries: 1,
      failedQueries: 0,
      passRate: 1,
      avgTimeMs: 100,
      avgResultCount: 5,
      backendCoverage: {},
      latencyPercentiles: { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, max: 0, min: 0 },
      qps: { avgQps: 0, totalQueries: 0, totalDurationMs: 0, byTag: {}, peakQps: 0 },
      results: [
        {
          query: { id: 'en-fact-01', query: 'x' },
          response: null,
          resultCount: 5,
          responseTimeMs: 100,
          backends: ['wikipedia'],
          passed: true,
          failures: [],
          ranking: { ndcgAt10: storedNdcg, mrr: 0, precisionAt10: 0, relevantHits: 0 },
        },
      ],
    },
  })

  let dir: string
  beforeEach(() => {
    dir = makeRunDir()
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('gate-flagged AND both runs wikipedia-absent → flaggedBy429 (dismissable noise)', () => {
    // Baseline 0.613; both runs drop to 0.1/0.05 (>> 0.05) with NO wikipedia
    // in backends → the 2-run gate flags, and every regressed run is 429.
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['bing'], ['bing']], ndcgs: [0.1, 0.05] }], 2)
    const s = computeLossReport(dir, undefined, baseline(0.613))
    expect(s.gate429.flaggedBy429.map((r) => r.id)).toEqual(['en-fact-01'])
    expect(s.gate429.flaggedBy429[0].run429).toEqual([true, true])
    expect(s.gate429.flaggedClean).toHaveLength(0)
    expect(s.gate429.passedWith429).toHaveLength(0)
  })

  it('gate-PASSED but both runs wikipedia-absent and below baseline → passedWith429', () => {
    // The G2 core ask: 2-run stabilization let a wikipedia-429 drop through.
    // run1 drops 0.013 (< 0.05), run2 drops 0.063 (>= 0.05) → only 1 of 2
    // regressed → the gate does NOT flag. But BOTH runs are wikipedia-absent
    // and both score below baseline → the pass is availability luck.
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['bing'], ['bing']], ndcgs: [0.6, 0.55] }], 2)
    const s = computeLossReport(dir, undefined, baseline(0.613))
    expect(s.gate429.flaggedBy429).toHaveLength(0)
    expect(s.gate429.flaggedClean).toHaveLength(0)
    expect(s.gate429.passedWith429.map((r) => r.id)).toEqual(['en-fact-01'])
    expect(s.gate429.passedWith429[0].baselineNdcg).toBe(0.613)
    expect(s.gate429.passedWith429[0].runNdcgs).toEqual([0.6, 0.55])
  })

  it('gate-flagged with a NON-429 regressed run → flaggedClean (genuine candidate)', () => {
    // run1 regresses with wikipedia PRESENT (real drop), run2 regresses with
    // wikipedia absent — the flag is NOT fully explained by availability.
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['wikipedia', 'bing'], ['bing']], ndcgs: [0.2, 0.55] }], 2)
    const s = computeLossReport(dir, undefined, baseline(0.613))
    expect(s.gate429.flaggedBy429).toHaveLength(0)
    expect(s.gate429.flaggedClean.map((r) => r.id)).toEqual(['en-fact-01'])
    expect(s.gate429.flaggedClean[0].run429).toEqual([false, true])
    expect(s.gate429.passedWith429).toHaveLength(0)
  })

  it('no baseline → cross-reference skipped (hasBaseline false, sets empty)', () => {
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['bing'], ['bing']], ndcgs: [0.1, 0.05] }], 2)
    const s = computeLossReport(dir, undefined, null)
    expect(s.gate429.hasBaseline).toBe(false)
    expect(s.gate429.flaggedBy429).toHaveLength(0)
    expect(s.gate429.flaggedClean).toHaveLength(0)
    expect(s.gate429.passedWith429).toHaveLength(0)
  })

  it('single run → stabilization gate not applicable (sets empty)', () => {
    writeRuns(dir, [{ id: 'en-fact-01', backends: [['bing']], ndcgs: [0.1] }], 1)
    const s = computeLossReport(dir, undefined, baseline(0.613))
    expect(s.gate429.hasBaseline).toBe(true)
    expect(s.gate429.runCount).toBe(1)
    expect(s.gate429.flaggedBy429).toHaveLength(0)
    expect(s.gate429.passedWith429).toHaveLength(0)
  })
})

describe('parseMirrorEvents (S40)', () => {
  // NOTE: the fixtures below hardcode REAL eval query texts from
  // eval/queries.ts ('人工知能の仕組み' → ja-fact-02) to verify ID resolution
  // through ID_BY_QUERY. If the 500-query golden set is ever regenerated and
  // these texts change, update the fixtures (same dependency the gold-standards
  // tests already document).
  it('parses recovered events with run attribution + backend/count/language/id', () => {
    const log = [
      'Running 500 eval queries × 3 runs (median aggregation)...',
      '  ─ run 1/3 ─',
      '{"timestamp":"2026-08-08T10:00:00.000Z","level":"warn","message":"[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing):","query":"人工知能の仕組み","language":"ja","backend":"wikidata","count":5}',
      '{"timestamp":"2026-08-08T10:00:01.000Z","level":"warn","message":"[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing):","query":"北海道冬旅行","language":"ja","backend":"dbpedia-lang","count":3}',
      '  ─ run 2/3 ─',
      '{"timestamp":"2026-08-08T10:01:00.000Z","level":"warn","message":"[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing):","query":"人工知能の仕組み","language":"ja","backend":"wikidata","count":5}',
    ].join('\n')
    const events = parseMirrorEvents(log)
    expect(events).toHaveLength(3)
    expect(events[0]).toMatchObject({
      kind: 'recovered',
      backend: 'wikidata',
      run: 1,
      id: 'ja-fact-02',
      count: 5,
      language: 'ja',
    })
    expect(events[1]).toMatchObject({ backend: 'dbpedia-lang', run: 1, count: 3 })
    expect(events[2].run).toBe(2)
  })

  it('parses skips, status-failures and catch-failures with the right backend/kind', () => {
    const log = [
      'Running 500 eval queries × 3 runs (median aggregation)...',
      '  ─ run 1/3 ─',
      '{"level":"warn","message":"Wikidata fallback skipped (API quota exhausted):","query":"九州旅行おすすめ","language":"ja"}',
      '{"level":"warn","message":"dbpedia-lang fallback skipped (endpoint cooldown):","query":"北海道冬旅行"}',
      '{"level":"warn","message":"Wikidata fallback label search failed (status 429)","query":"X","language":"ja"}',
      '{"level":"warn","message":"dbpedia-lang SPARQL failed (status 503)","query":"Y","language":"ja"}',
      '{"level":"warn","message":"Wikidata fallback search failed:","error":"boom"}',
      '{"level":"warn","message":"dbpedia-lang fallback failed:","error":"boom"}',
      // orchestrator catch-all is backend-agnostic → NOT parsed (dbpAbort only)
      '{"level":"warn","message":"[Orchestrator] Wikipedia mirror fallback failed (non-critical):","error":"x"}',
    ].join('\n')
    const events = parseMirrorEvents(log)
    expect(events).toHaveLength(6)
    expect(events[0]).toMatchObject({ kind: 'skipped', backend: 'wikidata', run: 1 })
    expect(events[1]).toMatchObject({ kind: 'skipped', backend: 'dbpedia-lang' })
    expect(events[2]).toMatchObject({ kind: 'status-failure', backend: 'wikidata' })
    expect(events[3]).toMatchObject({ kind: 'status-failure', backend: 'dbpedia-lang' })
    expect(events[4]).toMatchObject({ kind: 'catch-failure', backend: 'wikidata' })
    expect(events[5]).toMatchObject({ kind: 'catch-failure', backend: 'dbpedia-lang' })
  })

  it('aggregates per-backend firing statistics', () => {
    const log = [
      'Running 500 eval queries × 3 runs (median aggregation)...',
      '  ─ run 1/3 ─',
      '{"level":"warn","message":"[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing):","query":"人工知能の仕組み","language":"ja","backend":"wikidata","count":5}',
      '{"level":"warn","message":"[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing):","query":"九州旅行おすすめ","language":"ja","backend":"wikidata","count":2}',
      '{"level":"warn","message":"Wikidata fallback skipped (API quota exhausted):","query":"北海道冬旅行","language":"ja"}',
      '{"level":"warn","message":"Wikidata fallback label search failed (status 429)","query":"X","language":"ja"}',
    ].join('\n')
    const stats = aggregateMirrorStats(parseMirrorEvents(log))
    const wd = stats.find((s) => s.backend === 'wikidata')
    expect(wd).toBeDefined()
    expect(wd!.fired).toBe(2)
    expect(wd!.recoveredResults).toBe(7)
    expect(wd!.recoveredQueries).toBe(2)
    expect(wd!.skipped).toBe(1)
    expect(wd!.statusFailures).toBe(1)
    expect(wd!.attempts).toBe(4)
    expect(wd!.successRate).toBeCloseTo(0.5, 3)
  })
})
