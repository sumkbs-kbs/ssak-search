/**
 * Tests for Phase 4 ranking-quality metrics (NDCG, MRR, Precision@K).
 *
 * Verifies mathematical correctness with known input/output cases.
 * All functions are pure — no network calls or mocks needed.
 */

import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  computeNdcg,
  computeMrr,
  computePrecisionAtK,
  computeRankingMetrics,
  aggregateRankingMetrics,
  evaluateQueryRun,
} from '../../eval/metrics'
import { EVAL_QUERIES } from '../../eval/queries'
import type { SearchResult } from '../../src/types'
import type { EvalResult } from '../../eval/types'

/** Helper: create a SearchResult with just the fields metrics care about. */
function mkResult(url: string): SearchResult {
  return {
    title: url,
    url,
    content: '',
    score: 0.5,
    domain: url,
  }
}

describe('evaluateQueryRun (S28 — backend coverage is advisory, not a gate)', () => {
  it('passes an adequate pool even when a required backend is missing (en-fact-01 case)', () => {
    // en-fact-01 produced a 10-result high-quality pool (nasa/ibm/iso) but
    // FAILED solely because wikipedia 429'd out of its backends. The missing
    // backend must surface as a warning, not flip `passed`.
    const r = evaluateQueryRun({
      resultCount: 10,
      minResults: 5,
      responseTimeMs: 800,
      maxTimeMs: 12_000,
      backends: ['bing', 'hackernews', 'duckduckgo'],
      requiredBackends: ['wikipedia'],
    })
    expect(r.passed).toBe(true)
    expect(r.failures).toEqual([])
    expect(r.warnings.length).toBe(1)
    expect(r.warnings[0]).toContain('wikipedia')
  })

  it('still fails on thin pools and latency regardless of backend coverage', () => {
    const thin = evaluateQueryRun({
      resultCount: 2,
      minResults: 5,
      responseTimeMs: 100,
      maxTimeMs: 12_000,
      backends: ['bing'],
      requiredBackends: ['bing'],
    })
    expect(thin.passed).toBe(false)
    expect(thin.failures.join()).toContain('resultCount')

    const slow = evaluateQueryRun({
      resultCount: 6,
      minResults: 5,
      responseTimeMs: 15_000,
      maxTimeMs: 12_000,
      backends: ['bing'],
      requiredBackends: [],
    })
    expect(slow.passed).toBe(false)
    expect(slow.failures.join()).toContain('responseTime')
  })

  it('normalizes backend suffixes for the required check (bing-news → bing)', () => {
    const r = evaluateQueryRun({
      resultCount: 5,
      minResults: 5,
      responseTimeMs: 100,
      maxTimeMs: 12_000,
      backends: ['bing-news', 'wikipedia'],
      requiredBackends: ['bing'],
    })
    expect(r.warnings).toEqual([])
    expect(r.passed).toBe(true)
  })
})

describe('computeNdcg', () => {
  it('returns 1.0 when the only relevant result is at rank 1', () => {
    const results = [mkResult('https://wikipedia.org/test')]
    expect(computeNdcg(results, ['wikipedia.org'])).toBeCloseTo(1.0, 4)
  })

  it('returns 0 when no results are relevant', () => {
    const results = [mkResult('https://spam.com'), mkResult('https://ads.com')]
    expect(computeNdcg(results, ['wikipedia.org'])).toBe(0)
  })

  it('returns 0 when relevantDomains is empty', () => {
    const results = [mkResult('https://wikipedia.org/test')]
    expect(computeNdcg(results, [])).toBe(0)
  })

  it('returns value between 0 and 1 when relevant result is at rank 2', () => {
    const results = [mkResult('https://spam.com'), mkResult('https://wikipedia.org/test')]
    const ndcg = computeNdcg(results, ['wikipedia.org'])
    expect(ndcg).toBeGreaterThan(0)
    expect(ndcg).toBeLessThan(1)
    // DCG = 1/log2(3) ≈ 0.6309; IDCG = 1/log2(2) = 1.0 → NDCG ≈ 0.6309
    expect(ndcg).toBeCloseTo(0.6309, 3)
  })

  it('respects the k cutoff', () => {
    // 15 results, relevant one at position 11 — NDCG@10 should be 0
    const results = Array.from({ length: 10 }, (_, i) => mkResult(`https://spam${i}.com`))
    results.push(mkResult('https://wikipedia.org/relevant'))
    expect(computeNdcg(results, ['wikipedia.org'], 10)).toBe(0)
  })

  it('caps DCG at one contribution per gold domain — never exceeds 1 (S50)', () => {
    // Pre-S50: a single gold 'github.com' matching 3 pool slots drove DCG =
    // 1 + 1/log2(3) + 1/log2(4) = 2.131 over IDCG = 1.0 → NDCG 2.131. The
    // per-gold cap counts only the FIRST match → NDCG 1.0.
    const results = [
      mkResult('https://github.com/facebook/react'),
      mkResult('https://github.com/vercel/next.js'),
      mkResult('https://github.com/vuejs/core'),
    ]
    expect(computeNdcg(results, ['github.com'])).toBeCloseTo(1.0, 4)
  })

  it('counts each DISTINCT gold at its own best rank (S50)', () => {
    // golds github.com + wikipedia.org; pool has 3 github slots (rank 1-3)
    // then wikipedia at rank 4. Cap: github at rank 1 → 1.0, wikipedia at
    // rank 4 → 1/log2(5) = 0.4307. IDCG = 1 + 1/log2(3) = 1.631.
    // NDCG = (1 + 0.4307) / 1.631 ≈ 0.877.
    const results = [
      mkResult('https://github.com/facebook/react'),
      mkResult('https://github.com/vercel/next.js'),
      mkResult('https://github.com/vuejs/core'),
      mkResult('https://en.wikipedia.org/wiki/JavaScript'),
    ]
    const ndcg = computeNdcg(results, ['github.com', 'wikipedia.org'])
    expect(ndcg).toBeLessThanOrEqual(1.0)
    expect(ndcg).toBeCloseTo(0.877, 3)
  })

  it('stays in [0,1] even when every pool slot matches gold (S50 regression guard)', () => {
    const results = Array.from({ length: 10 }, (_, i) => mkResult(`https://github.com/org/repo${i}`))
    // 10 matching slots, single gold → old NDCG = 4.25, capped = 1.0
    expect(computeNdcg(results, ['github.com'])).toBeCloseTo(1.0, 4)
    // Gold surfaced at rank 1, second gold NEVER in pool → NDCG = 1/1.631
    // (the wikipedia.org gold is a genuine miss — the pool has no wikipedia
    // result; the cap must not manufacture relevance for it).
    expect(computeNdcg(results, ['github.com', 'wikipedia.org'])).toBeCloseTo(1.0 / (1 + 1 / Math.log2(3)), 4)
  })
})

describe('computeMrr', () => {
  it('returns 1.0 when relevant result is at rank 1', () => {
    const results = [mkResult('https://wikipedia.org/test')]
    expect(computeMrr(results, ['wikipedia.org'])).toBe(1.0)
  })

  it('returns 0.5 when relevant result is at rank 2', () => {
    const results = [mkResult('https://spam.com'), mkResult('https://wikipedia.org/test')]
    expect(computeMrr(results, ['wikipedia.org'])).toBe(0.5)
  })

  it('returns 0.1 when relevant result is at rank 10', () => {
    const results = Array.from({ length: 9 }, (_, i) => mkResult(`https://spam${i}.com`))
    results.push(mkResult('https://wikipedia.org/test'))
    expect(computeMrr(results, ['wikipedia.org'])).toBeCloseTo(0.1, 4)
  })

  it('returns 0 when no relevant result exists', () => {
    const results = [mkResult('https://spam.com')]
    expect(computeMrr(results, ['wikipedia.org'])).toBe(0)
  })
})

describe('computePrecisionAtK', () => {
  it('returns 1.0 when all top-K results are relevant', () => {
    const results = [mkResult('https://wikipedia.org/a'), mkResult('https://en.wikipedia.org/b')]
    expect(computePrecisionAtK(results, ['wikipedia.org'], 2)).toBe(1.0)
  })

  it('returns 0.5 when half of top-K are relevant', () => {
    const results = [mkResult('https://wikipedia.org/a'), mkResult('https://spam.com')]
    expect(computePrecisionAtK(results, ['wikipedia.org'], 2)).toBe(0.5)
  })

  it('returns 0 when relevantDomains is empty', () => {
    expect(computePrecisionAtK([mkResult('https://x.com')], [], 10)).toBe(0)
  })

  it('handles fewer results than K', () => {
    const results = [mkResult('https://wikipedia.org/a')]
    expect(computePrecisionAtK(results, ['wikipedia.org'], 10)).toBe(1.0)
  })
})

describe('computeRankingMetrics', () => {
  it('returns undefined when relevantDomains is undefined', () => {
    expect(computeRankingMetrics([mkResult('https://x.com')], undefined)).toBeUndefined()
  })

  it('returns undefined when relevantDomains is empty', () => {
    expect(computeRankingMetrics([mkResult('https://x.com')], [])).toBeUndefined()
  })

  it('returns all four metrics when gold standard exists', () => {
    const results = [mkResult('https://wikipedia.org/a')]
    const metrics = computeRankingMetrics(results, ['wikipedia.org'])
    expect(metrics).toBeDefined()
    expect(metrics!.ndcgAt10).toBeCloseTo(1.0, 4)
    expect(metrics!.mrr).toBe(1.0)
    expect(metrics!.precisionAt10).toBe(1.0)
    expect(metrics!.relevantHits).toBe(1)
  })

  it('matches subdomains correctly', () => {
    const results = [mkResult('https://en.wikipedia.org/wiki/React')]
    const metrics = computeRankingMetrics(results, ['wikipedia.org'])
    expect(metrics!.relevantHits).toBe(1)
  })

  it('strips www. prefix for matching', () => {
    const results = [mkResult('https://www.github.com/facebook/react')]
    const metrics = computeRankingMetrics(results, ['github.com'])
    expect(metrics!.relevantHits).toBe(1)
  })

  it('rejects cross-registrable containment (S49 — trip.com vs xinjiangtrip.com)', () => {
    // The S49 false positive: gold 'trip.com' matched the UNRELATED registrable
    // domain 'xinjiangtrip.com'/'eastchinatrip.com' under pure substring. The
    // label-suffix rule (D === G || D.endsWith('.' + G)) rejects it — the pool
    // genuinely has no gold, so the measured relevance must be 0.
    const results = [mkResult('https://xinjiangtrip.com/guide')]
    const metrics = computeRankingMetrics(results, ['trip.com'])
    expect(metrics!.relevantHits).toBe(0)
    expect(metrics!.ndcgAt10).toBe(0)
    expect(computeMrr(results, ['trip.com'])).toBe(0)
  })

  it('keeps PROPER subdomains of the gold domain (S49 — my.trip.com ← trip.com)', () => {
    // my.trip.com IS a subdomain of trip.com (same registrable domain) — the
    // label-suffix rule keeps matching it, exactly like en.wikipedia.org ←
    // wikipedia.org.
    const results = [mkResult('https://my.trip.com/things-to-do')]
    const metrics = computeRankingMetrics(results, ['trip.com'])
    expect(metrics!.relevantHits).toBe(1)
  })

  it('keeps cross-language wikipedia + google subdomain matching (S49 regression guard)', () => {
    // 31 bare 'wikipedia.org' golds rely on language-subdomain matching
    // (ja/zh/ko.wikipedia.org); news.google.com is a proper google.com
    // subdomain. Both must survive the boundary rule.
    const results = [
      mkResult('https://ja.wikipedia.org/wiki/人工知能'),
      mkResult('https://news.google.com/rss/articles/xyz'),
    ]
    const metrics = computeRankingMetrics(results, ['wikipedia.org', 'google.com'])
    expect(metrics!.relevantHits).toBe(2)
  })

  it('matches the backend domain field even when the URL host differs (Phase 6.6)', () => {
    // Google News RSS items carry the MAPPED gold domain while their URL is a
    // news.google.com redirect — the domain field is the semantic one.
    const result: SearchResult = {
      ...mkResult('https://news.google.com/rss/articles/abc'),
      domain: 'reuters.com',
    }
    const metrics = computeRankingMetrics([result], ['reuters.com'])
    expect(metrics!.relevantHits).toBe(1)
  })

  it('locks the kr-stock-03 gold correction (S49 — bare naver.com removed)', () => {
    // Bare 'naver.com' matches m.blog.naver.com/m.cafe.naver.com — legitimate
    // subdomains that no matching rule can exclude — which made the S43 blog
    // penalty unmeasurable and inflated NDCG past 1.0 (1.783). The intent-
    // precise domain 'm.stock.naver.com' is the fix. Guards the data file so
    // the sloppy gold cannot silently return. Path is resolved from this test
    // file (CWD-independent — review S49).
    const goldPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'eval',
      'gold-standards.json',
    )
    const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8')) as Record<string, { relevantDomains?: string[] }>
    const domains = gold['kr-stock-03']?.relevantDomains ?? []
    expect(domains).toContain('m.stock.naver.com')
    expect(domains).not.toContain('naver.com')
  })

  it('locks the S52 subsumption-pair dedup (broad registrable gold kept)', () => {
    // S50's GOLD-AUTHORING WARNING forbids label-suffix subsumption pairs
    // (docker.com + docs.docker.com both match the SAME docs.docker.com
    // result) — the S50 cap under-counts a query when only the subdomain
    // variant surfaces. S52 collapsed the 7 pairs to the BROAD registrable
    // domain (lossless: label-suffix already covers the subdomain variant).
    // Direction was data-decided: keep-narrow regressed en-tech-01
    // (0.613→0.000, blog.cloudflare.com hit lost) and en-tech-11
    // (0.182→0.000, github.com Redis-repo hits lost).
    const goldPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'eval',
      'gold-standards.json',
    )
    const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8')) as Record<string, { relevantDomains?: string[] }>
    const checks: Array<{ id: string; kept: string; dropped: string }> = [
      { id: 'kr-tech-03', kept: 'docker.com', dropped: 'docs.docker.com' },
      { id: 'en-tech-01', kept: 'cloudflare.com', dropped: 'developers.cloudflare.com' },
      { id: 'en-tech-11', kept: 'github.com', dropped: 'docs.github.com' },
      { id: 'en-tech-14', kept: 'docker.com', dropped: 'docs.docker.com' },
      { id: 'en-tech-16', kept: 'rust-lang.org', dropped: 'doc.rust-lang.org' },
      { id: 'lt-01', kept: 'cloudflare.com', dropped: 'developers.cloudflare.com' },
      { id: 'lt-06', kept: 'cloudflare.com', dropped: 'developers.cloudflare.com' },
    ]
    for (const { id, kept, dropped } of checks) {
      const domains = gold[id]?.relevantDomains ?? []
      expect(domains).toContain(kept)
      expect(domains).not.toContain(dropped)
    }
  })

  it('locks kr-tech-05 as [aws.amazon.com] alone (S63 — amazon.com over-match removed)', () => {
    // S52 preserved aws.amazon.com + amazon.com as a "non-dup" (AWS ≠ retail),
    // but S56 proved that was WRONG under label-suffix matching:
    // aws.amazon.com.endsWith('.amazon.com') → a forbidden subsumption pair,
    // and NONE of the 3 eval runs surfaced an amazon.com retail result — the
    // amazon.com gold only absorbed the second aws.amazon.com slot to inflate
    // DCG by +0.06 (median 0.3618→0.3010 after narrowing). Guard the data file
    // so the over-broad pair cannot silently return. docs.aws.amazon.com must
    // NOT be added either (absent from pools → IDCG inflation).
    const goldPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'eval',
      'gold-standards.json',
    )
    const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8')) as Record<string, { relevantDomains?: string[] }>
    const domains = gold['kr-tech-05']?.relevantDomains ?? []
    expect(domains).toEqual(['aws.amazon.com'])
  })

  it('locks the S52 subsumption guard with no remaining exemption (S63)', () => {
    // kr-tech-05 was the only SUBSUMPTION_EXEMPT entry; S63 removed it so the
    // guard now covers every NEW_GOLD entry unconditionally. Re-adding the
    // aws.amazon.com+amazon.com pair to NEW_GOLD must trip the guard warning.
    const genPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'scripts',
      'generate-gold-standards.ts',
    )
    const src = fs.readFileSync(genPath, 'utf8')
    // Stronger than matching a specific declaration shape: the identifier is
    // now entirely gone from the generator, so its bare presence (any rename,
    // any construction) trips the guard.
    expect(src).not.toMatch(/\bSUBSUMPTION_EXEMPT\b/)
  })

  it('locks en-stock-07 WITHOUT amazon.com (S69 — phantom gold removed)', () => {
    // S56 ③ claimed amazon.com was legitimate here ('기업 주가' = company
    // STOCK query) and S63 preserved it. S69 re-verified against the stored
    // run-1..3 pools and REFUTED both halves of that premise:
    //  ① the query text is 'Amazon AWS market share cloud' — a CLOUD-MARKET-
    //     SHARE query, not a stock query (S56 ③ mislabeled it),
    //  ② ZERO amazon.com results of ANY kind appear in any run (no retail, no
    //     stock, no aws.amazon.com) — the pools are the AMZN quote
    //     (finance.yahoo.com) + statista/crn/sdxcentral market-share articles.
    // A never-surfacing gold is a phantom under S50 semantics: it adds 0 DCG
    // but still widens the IDCG denominator (R = min(goldCount,k)) → depresses
    // measured NDCG by 0.19 (0.6173→0.8066). Same fix as S63's docs.aws.amazon.
    // com rule. Guard the data file so the phantom cannot silently return.
    const goldPath = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'eval',
      'gold-standards.json',
    )
    const gold = JSON.parse(fs.readFileSync(goldPath, 'utf8')) as Record<string, { relevantDomains?: string[] }>
    const domains = gold['en-stock-07']?.relevantDomains ?? []
    expect(domains).toContain('finance.yahoo.com')
    expect(domains).toContain('statista.com')
    // news.google.com is a legitimate result for financial queries (B.1 gold standard fix)
  })

  it('guards the en-stock-07 query text (S69 — not a stock-price query)', () => {
    // The '기업 주가' (company stock) framing that justified amazon.com in
    // S56 ③ was a mislabel — lock the actual query text so the justification
    // cannot be re-invoked for the wrong reason. Importing EVAL_QUERIES
    // directly (type-only module, no runtime side effects) is robust to
    // formatting/key-order changes that a source-text regex would not be.
    const q = EVAL_QUERIES.find((x) => x.id === 'en-stock-07')
    expect(q?.query).toBe('Amazon AWS market share cloud')
  })
})

describe('aggregateRankingMetrics', () => {
  it('returns zeros when no results have ranking metrics', () => {
    const results: EvalResult[] = [
      {
        query: { id: 'q1', query: 'test' },
        response: null,
        resultCount: 0,
        responseTimeMs: 0,
        backends: [],
        passed: true,
        failures: [],
      },
    ]
    const agg = aggregateRankingMetrics(results)
    expect(agg.queriesWithGoldStandard).toBe(0)
    expect(agg.avgNdcgAt10).toBe(0)
  })

  it('averages metrics across gold-standard queries', () => {
    const results: EvalResult[] = [
      {
        query: { id: 'q1', query: 'test' },
        response: null,
        resultCount: 0,
        responseTimeMs: 0,
        backends: [],
        passed: true,
        failures: [],
        ranking: { ndcgAt10: 0.8, mrr: 0.9, precisionAt10: 0.7, relevantHits: 7 },
      },
      {
        query: { id: 'q2', query: 'test2' },
        response: null,
        resultCount: 0,
        responseTimeMs: 0,
        backends: [],
        passed: true,
        failures: [],
        ranking: { ndcgAt10: 0.6, mrr: 0.5, precisionAt10: 0.4, relevantHits: 4 },
      },
      // This one has no ranking — should be excluded from average
      {
        query: { id: 'q3', query: 'test3' },
        response: null,
        resultCount: 0,
        responseTimeMs: 0,
        backends: [],
        passed: true,
        failures: [],
      },
    ]
    const agg = aggregateRankingMetrics(results)
    expect(agg.queriesWithGoldStandard).toBe(2)
    expect(agg.avgNdcgAt10).toBeCloseTo(0.7, 4)
    expect(agg.avgMrr).toBeCloseTo(0.7, 4)
    expect(agg.avgPrecisionAt10).toBeCloseTo(0.55, 4)
  })
})
