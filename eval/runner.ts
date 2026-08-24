import type { EvalQuery, EvalResult, EvalReport, CacheHitMetrics } from './types'
import type { SearchResponse } from '../src/types'
import { executeSearch } from '../src/lib/orchestrator'
import { detectQueryType, getSourcesForQueryType } from '../src/lib/specialized'
import {
  calculateLatencyPercentiles,
  calculateQPS,
  computeRankingMetrics,
  aggregateRankingMetrics,
  computeCacheHitRate,
  evaluateQueryRun,
  loadGoldStandards,
} from './metrics'

/**
 * Wait until wikipedia's REST search endpoint stops 429ing, with a bounded
 * polling loop.
 *
 * WHY: a 500×3 median eval fires hundreds of wikipedia requests per run. When
 * the previous eval (or any burst) leaves the shared IP in wikipedia's 429
 * window, the NEXT eval starts already-blocked: run 1's wikipedia searches all
 * 429 → empty results are NOT cached → runs 2-3 re-hit the block and en-fact-01
 * (requiredBackends: ['wikipedia']) fails on availability noise, not quality.
 * This gate pauses startup until the IP window recovers, so consecutive evals
 * don't poison each other.
 *
 * Disabled when EVAL_QUERY_DELAY_MS=0 (user explicitly opted out of wikipedia
 * pacing — assume they know the upstream state).
 */
export async function waitForWikipediaAvailable(maxWaitMs = 180_000, pollIntervalMs = 10_000): Promise<void> {
  const probeUrl = 'https://en.wikipedia.org/w/rest.php/v1/search/page?q=probe&limit=1'
  const deadline = Date.now() + maxWaitMs

  for (;;) {
    let ok = false
    try {
      const resp = await fetch(probeUrl, {
        headers: { 'User-Agent': 'SearchAPI/1.0 (eval harness)' },
        signal: AbortSignal.timeout(8_000),
      })
      ok = resp.ok
    } catch {
      ok = false // network error — treat as not-ready, keep polling
    }

    if (ok) return
    if (Date.now() >= deadline) {
      console.warn(`[eval] wikipedia still rate-limited after ${maxWaitMs}ms — proceeding anyway`)
      return
    }
    console.error(`[eval] wikipedia 429 — waiting ${pollIntervalMs / 1000}s for rate-limit window to recover...`)
    await new Promise((r) => setTimeout(r, pollIntervalMs))
  }
}
/**
 * Run the eval harness against the orchestrator directly.
 *
 * @param queries  Subset of queries to run (defaults to all)
 * @param config   Optional overrides (env bindings, etc.)
 * @returns        Full eval report
 */
export async function runEval(
  queries: EvalQuery[],
  config: {
    jinaApiKey?: string
    ai?: Ai
    env?: Record<string, unknown>
    /** Run every query twice — cold then an IMMEDIATE warm re-run (S80
     *  interleave) — and measure the cache hit rate of the warm pass */
    measureCache?: boolean
    /** S80-①: skip the warm re-run for queries whose COLD run failed
     *  (default true). A failed cold stores no cache entry, so the warm run
     *  is a guaranteed miss that would only re-fan-out to the network —
     *  during a wikipedia 429 window that's an extra hammer on an already
     *  rate-limited upstream, for zero information. Skipped queries are
     *  excluded from the hitRate denominator and counted in
     *  CacheHitMetrics.skipped. Set false to keep the legacy behavior
     *  (warm run always fires, failed cold → long warm time → miss). */
    skipWarmOnColdError?: boolean
  } = {},
): Promise<EvalReport> {
  const results: EvalResult[] = []
  const runStartTime = Date.now()
  const goldStandards = loadGoldStandards()

  // If a wikipedia-dependent query set is being evaluated, wait for the
  // wikipedia IP rate-limit window to recover before the first run — otherwise
  // a block left by a PREVIOUS eval silently fails en-fact-01 (and any other
  // requiredBackends: ['wikipedia'] query) for all 3 runs. Skipped when no
  // wikipedia-routing query is in the set.
  if (queries.some((q) => getSourcesForQueryType(detectQueryType(q.query)).useWikipedia)) {
    await waitForWikipediaAvailable()
  }

  const buildRequest = (q: EvalQuery): Parameters<typeof executeSearch>[0] => ({
    query: q.query,
    topic: q.topic,
    max_results: 10,
    include_answer: false,
  })

  const buildConfig = () => ({
    jinaApiKey: config.jinaApiKey,
    ai: config.ai,
    // EVAL_MODE lets the rate limiter disable its wikipedia burst window — the
    // harness already paces queries (EVAL_QUERY_DELAY_MS) to keep free no-key
    // backends (wikipedia) under their upstream burst limit, and a second
    // per-minute window in the local fallback would starve later queries of
    // wikipedia entirely (en-fact-01 regression: 3/3 runs missing the
    // requiredBackends wikipedia during the 500×3 median eval). Production
    // traffic (DO binding) and local dev are unaffected — this flag is only
    // visible inside the eval process.
    env: {
      ...(config.env as Record<string, unknown> | undefined),
      EVAL_MODE: 'true',
    } as Parameters<typeof executeSearch>[1]['env'],
  })

  // Inter-query pacing. wikipedia — the free, no-key backend that backs most
  // factual/general/academic queries (search + knowledge-panel chain ≈ 2-6
  // requests per query) — hard-rate-limits (429) after ~17 rapid requests and
  // stays blocked for a minute or more. A 180-query benchmark fired back-to-back
  // trips that limit, so wikipedia-dependent queries (en-fact-01's required
  // backend check, zh-general-04's result count) failed intermittently on
  // availability noise rather than search quality. Real user traffic is spaced
  // by human latency; the benchmark should model that. Pacing applies AFTER the
  // per-query timing window, so responseTimeMs/QPS-by-tag metrics are unaffected
  // (only total wall-clock grows). Override with EVAL_QUERY_DELAY_MS=0 to disable.
  //
  // 1200ms (was 400ms): the wikipediaSearch task (REST + Action API) AND the
  // knowledge-panel chain (summary + infobox) both hit wikipedia per query —
  // ≈2-4 requests/query. At 400ms pacing that sustained ≈300-600 req/min
  // against wikipedia's ~200/min anonymous limit, so the eval itself tripped
  // upstream 429s (36 REST-429 logs in a single factual run) and wikipedia
  // dropped out of backends entirely — en-fact-01 failed with
  // requiredBackends=[wikipedia] even though the search quality was fine.
  // 1200ms caps sustained wikipedia load at ≈100-200 req/min, inside the
  // limit, with EVAL_MODE disabling the local rate window so the harness's
  // own pacing is the single throttle.
  //
  // The 1200ms pace applies ONLY to queries that actually route to wikipedia
  // (useWikipedia=true per detectQueryType). News/finance/other queries never
  // touch wikipedia, so they keep the faster 400ms pace — otherwise the
  // 500-query×3-run eval would burn ~30 min of pure sleep on queries that
  // don't need it. Override with EVAL_QUERY_DELAY_MS=0 to disable entirely.
  // Parse the pacing override ONCE. The documented contract is
  // EVAL_QUERY_DELAY_MS=0 DISABLES pacing — but the old `Number(x) || 1200`
  // treated '0' as falsy and silently fell back to 1200ms (S80 test caught
  // it: EVAL_QUERY_DELAY_MS=0 still slept 400ms/news-query). Only an explicit
  // number is honored: non-numeric strings ('abc') and unset keep the
  // defaults (note: Number('') = 0, so an empty string disables pacing — ''
  // was never a documented value, only '0' is).
  const delayOverride = process.env.EVAL_QUERY_DELAY_MS === undefined ? NaN : Number(process.env.EVAL_QUERY_DELAY_MS)
  const useOverride = Number.isFinite(delayOverride)
  const wikiPaceMs = useOverride ? Math.max(0, delayOverride) : 1200
  const fastPaceMs = useOverride ? Math.max(0, delayOverride) : 400
  // arXiv paces at ~30 req/min anonymous (live-verified 2026-08-13: rapid
  // academic-query bursts trip export.arxiv.org to HTTP 429 for ~1min, no
  // Retry-After header). The wikipedia pace (1200ms = 50/min) is NOT enough
  // for arxiv — a back-to-back academic batch (17 en-acad + ds-* queries)
  // starves the later queries of the arxiv backend entirely (run-1 snapshot:
  // en-acad-08..17 all absent, NDCG 0.000). 2200ms caps sustained arxiv load
  // at ~27/min, inside the anonymous limit. Arxiv queries are a strict subset
  // of wikipedia-routing ones (academic useWikipedia=true), so this is the
  // ONLY pace that needs the longer window.
  const arxivPaceMs = useOverride ? Math.max(0, delayOverride) : 2200
  // S75 (2026-08-13): github Search API paces at ~10 req/min anonymous
  // (live-verified 2026-08-13: a technical-tag eval burst starves the github
  // backend — 403 on the 11th+ consecutive call, S23 cooldown then skips it
  // for the rest of the run, dropping the github.com gold that 250/1500
  // query-runs rely on). githubSearch + githubIssuesSearch share the same
  // budget, so 6000ms (≈10/min) keeps BOTH inside the limit when the issues
  // backend fires. github-routing queries are a strict subset of
  // wikipedia-routing ones (technical/academic useWikipedia=true), so the
  // longer window only applies to the queries that need it.
  const githubPaceMs = useOverride ? Math.max(0, delayOverride) : 6000

  // S80 (2026-08-09): INTERLEAVED warm pass. The old design ran the warm pass
  // AFTER the entire cold pass — for a 500-query eval the cold pass takes ~23
  // min, but the orchestrator's in-process cache TTL is only 120s (general) /
  // 30s (news/finance), so EVERY entry had expired by warm-pass time → hitRate
  // structurally ~0% (S79 measured 0.0247, 2/81 on a korean subset). Re-running
  // the SAME query immediately after its cold run (a few ms later, well within
  // the TTL) measures the cache as real repeat traffic experiences it: a warm
  // hit resolves in ~1-5ms from the in-process map instead of a full fan-out.
  // The warm run is excluded from totalDurationMs below so QPS/latency metrics
  // keep measuring the cold pass only (same semantics as the old post-loop
  // pass, which also ran outside the measured window).
  const coldTimesMs: number[] = []
  const warmTimesMs: number[] = []
  let totalWarmMs = 0
  // S80-①: warm re-runs skipped because their cold run failed (no cache
  // entry was stored → a warm run is a guaranteed miss). Reported in
  // CacheHitMetrics.skipped so the report shows how many queries were
  // excluded from the hitRate denominator.
  let skippedWarmRuns = 0
  // Default true — see the config option doc above for the rationale.
  const skipWarmOnColdError = config.skipWarmOnColdError ?? true

  for (const q of queries) {
    const startTime = Date.now()
    let response: SearchResponse | null = null
    let error: string | undefined
    let resultCount = 0
    let backends: string[] = []
    const failures: string[] = []
    const warnings: string[] = []

    try {
      response = await executeSearch(buildRequest(q), buildConfig())

      resultCount = response.results?.length ?? 0
      backends = response.backend ? response.backend.split('+').filter(Boolean) : []

      const minResults = q.minResults ?? 5
      const maxTimeMs = q.maxTimeMs ?? 10_000
      const elapsed = Date.now() - startTime

      // S28: quality gates (resultCount + latency) decide pass/fail; missing
      // required backends are availability warnings, not failures (see
      // evaluateQueryRun). A wikipedia 429 must not fail a 10-result pool.
      const evaluation = evaluateQueryRun({
        resultCount,
        minResults,
        responseTimeMs: elapsed,
        maxTimeMs,
        backends,
        requiredBackends: q.requiredBackends ?? [],
      })
      failures.push(...evaluation.failures)
      warnings.push(...evaluation.warnings)
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      failures.push(`error: ${error}`)
    }

    const coldTimeMs = Date.now() - startTime
    results.push({
      query: q,
      response,
      error,
      resultCount,
      responseTimeMs: coldTimeMs,
      backends,
      passed: failures.length === 0,
      failures,
      warnings,
      // Phase 4: compute ranking metrics if a gold standard exists for this query
      ranking: response?.results ? computeRankingMetrics(response.results, goldStandards[q.id]) : undefined,
    })

    // S80: interleaved warm run — immediately after THIS query's cold run,
    // while the orchestrator's in-process cache entry (set at the end of the
    // cold executeSearch) is still within its 120s/30s TTL. Cache hits resolve
    // in a few ms.
    //
    // S80-①: a COLD FAILURE (executeSearch threw → `error` is set, response
    // is null) means the orchestrator stored NO cache entry — the warm re-run
    // is a guaranteed miss that would only re-fan-out to the network
    // (re-hammering a possibly rate-limited upstream like wikipedia for zero
    // information). skipWarmOnColdError (default true) skips it: the query is
    // excluded from the hitRate denominator and counted in skippedWarmRuns.
    // With the flag false, the legacy behavior is preserved — the warm run
    // fires anyway and its long latency counts as a miss.
    const coldFailed = error !== undefined
    if (config.measureCache) {
      if (skipWarmOnColdError && coldFailed) {
        skippedWarmRuns++
      } else {
        const warmStart = Date.now()
        try {
          await executeSearch(buildRequest(q), buildConfig())
        } catch {
          // Cache is measured on latency alone — search failures just
          // contribute a long warm time (counted as a miss)
        }
        const warmMs = Date.now() - warmStart
        totalWarmMs += warmMs
        coldTimesMs.push(coldTimeMs)
        warmTimesMs.push(warmMs)
      }
    }

    // Pacing AFTER measurement — lets free no-key backends (wikipedia) recover
    // their rate-limit window between queries instead of being hammered.
    // Only queries that route to wikipedia need the slow pace (see above);
    // the wikipediaSearch in-process result cache already collapses the
    // 3-run eval's wikipedia load to run 1, so this is just burst protection
    // for that first run.
    const srcs = getSourcesForQueryType(detectQueryType(q.query))
    const usesWikipedia = srcs.useWikipedia
    // arXiv rate limit (30/min) is tighter than wikipedia's — arxiv-routing
    // queries get the longest pace so the backend survives the whole batch.
    // GitHub's anonymous Search API limit (10/min) is tighter STILL — a
    // technical-tag burst 403s past ~10 calls and drops the github backend
    // for the rest of the run (S75), so github-routing queries get the
    // longest pace of all.
    const paceMs = srcs.useArxiv ? arxivPaceMs : srcs.useGitHub ? githubPaceMs : usesWikipedia ? wikiPaceMs : fastPaceMs
    if (paceMs > 0) {
      await new Promise((r) => setTimeout(r, paceMs))
    }
  }

  // totalDurationMs EXCLUDES the interleaved warm runs (S80) so QPS keeps
  // measuring the cold pass — identical semantics to the old post-loop warm
  // pass, which also ran outside the measured window.
  const totalDurationMs = Date.now() - runStartTime - totalWarmMs

  // Cache hit-rate measurement — computed from the interleaved cold/warm
  // pairs collected per query above (S80). S80-①: skipped warm runs (cold
  // failures) are reported separately so the denominator is transparent:
  // hitRate = hits / (hits + misses), and hits + misses = measuredPairs
  // (not totalQueries when cold runs failed).
  let cache: CacheHitMetrics | undefined
  if (config.measureCache && queries.length > 0) {
    cache = computeCacheHitRate(coldTimesMs, warmTimesMs, 200, skippedWarmRuns)
  }

  // Aggregate statistics
  const passedQueries = results.filter((r) => r.passed).length
  const totalTimeMs = results.reduce((sum, r) => sum + r.responseTimeMs, 0)
  const totalResults = results.reduce((sum, r) => sum + r.resultCount, 0)

  // Backend coverage across all queries
  const backendCoverage: Record<string, number> = {}
  for (const r of results) {
    for (const b of r.backends) {
      const norm = b.split('-')[0]
      backendCoverage[norm] = (backendCoverage[norm] ?? 0) + 1
    }
  }

  // Latency percentiles (p50, p75, p90, p95, p99)
  const responseTimesMs = results.map((r) => r.responseTimeMs)
  const latencyPercentiles = calculateLatencyPercentiles(responseTimesMs)

  // QPS metrics including per-tag breakdown
  const allTags = results.map((r) => r.query.tags ?? [])
  const qps = calculateQPS(responseTimesMs, allTags, totalDurationMs)

  // Phase 4: aggregate ranking metrics across gold-standard queries
  const ranking = aggregateRankingMetrics(results)

  return {
    timestamp: new Date().toISOString(),
    totalQueries: queries.length,
    passedQueries,
    failedQueries: queries.length - passedQueries,
    passRate: queries.length > 0 ? passedQueries / queries.length : 0,
    avgTimeMs: queries.length > 0 ? Math.round(totalTimeMs / queries.length) : 0,
    avgResultCount: queries.length > 0 ? Math.round((totalResults / queries.length) * 10) / 10 : 0,
    backendCoverage,
    latencyPercentiles,
    qps,
    cache,
    ranking,
    results,
  }
}
