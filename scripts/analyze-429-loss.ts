/**
 * S34: quantify NDCG loss from wikipedia 429 noise — composition-controlled.
 *
 * The naive "NDCG when wikipedia present minus when absent" over-attributes:
 * a wikipedia-absent run may have also lost bing/github/arxiv (broader fanout
 * failure). The ONLY runs that isolate wikipedia's contribution are pairs with
 * an IDENTICAL other-backend composition. So we:
 *
 *   1. For each query, group runs by their backends-without-wikipedia (sorted).
 *   2. Within each composition group, compare NDCG when wikipedia is present
 *      vs when it is absent. That difference is attributable to wikipedia.
 *   3. Queries whose absent-runs never share a composition with a present run
 *      cannot be attributed to wikipedia alone → "unattributable (co-failure)".
 *
 * The weighted loss is sum over absent-runs of max(0, presentAvg - absentNdcg)
 * restricted to runs whose composition has a wikipedia-present twin.
 *
 * S37 (2026-08-08): refactored for runner integration — the computation is
 * extracted into `computeLossReport()` so eval/index.ts can run it AFTER a
 * median eval completes and warn when the weighted loss exceeds a threshold
 * (GitHub Actions `::warning::` annotation). The CLI is now a thin wrapper
 * over the same function. `--threshold <n>` warns (does not fail) when the
 * weighted loss sum exceeds n (default 5.0).
 *
 * S39 (2026-08-08): S35/S36/S38 mirror fallbacks (dbpedia / wikidata /
 * dbpedia-lang) fire INSIDE the orchestrator when wikipedia is absent, so the
 * absent run's backend list GAINS a mirror backend. The composition key must
 * therefore IGNORE mirror backends too — otherwise a mirror-recovered run
 * ("bing+hackernews+dbpedia") never pairs with its wikipedia-present twin
 * ("bing+hackernews") and the whole S35 recovery is invisible to the report.
 * With the mirrors excluded from the composition, each wikipedia-absent run is
 * classified as:
 *   - mirror-recovered: a mirror backend fired AND the run's NDCG is within
 *     tolerance of the present baseline (loss ≤ max(0.1, 0.2·presentAvg)) —
 *     the mirror reconstructed the wikipedia gold URL and the loss is ~0
 *   - mirror-still-lost: the mirror fired but gold was NOT recovered (loss
 *     above tolerance) — the mirror itself failed or returned nothing relevant
 *   - no-mirror: no mirror fired — the classic S34 wikipedia-429 loss
 * The weighted loss is split accordingly so `npm run eval:loss` reports what
 * the mirror actually recovered vs what is still vulnerable.
 *
 * S40 (2026-08-08): S36/S38 firing-rate extraction — the run-JSON analysis
 * above can only OBSERVE a mirror that recovered gold (the orchestrator only
 * records 'dbpedia'/'wikidata'/'dbpedia-lang' in usedBackends when
 * mirrorResults.length > 0). A wikidata/dbpedia-lang attempt that was
 * rate-guard-skipped or errored is INVISIBLE to the JSONs. The log carries
 * the full event stream, so we now parse it directly:
 *   - '[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold'
 *     → recovered event (backend + count of reconstructed gold URLs)
 *   - 'Wikidata fallback skipped (API quota exhausted)' /
 *     'dbpedia-lang fallback skipped (endpoint cooldown)' → skipped
 *     (the fallback ATTEMPTED to engage but its own rate guard gated it)
 *   - 'Wikidata fallback label search/sitelink fetch failed (status N)' /
 *     'dbpedia-lang SPARQL failed (status N)' → status-failure
 *   - 'Wikidata fallback search failed' / 'dbpedia-lang fallback failed'
 *     → catch-failure
 * Each event is attributed to its eval run via the ─ run N/M ─ markers and to
 * its query id via ID_BY_QUERY, then aggregated per backend into a firing
 * table (fired events / recovered results / skips / failures → success rate)
 * and cross-referenced with the never-present set (the mirrors' PRIMARY
 * target). This answers "언제 발동했고 몇 건 gold를 복원했는지" for the
 * S36 (wikidata) / S38 (dbpedia-lang) tiers, which the JSON-only analysis
 * cannot.
 */
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { computeNdcg, recomputeNdcgAt10 } from '../eval/metrics'
import { loadBaseline, diffBaselineStabilized } from '../eval/baseline'
import { EVAL_QUERIES } from '../eval/queries'
import type { SearchResult } from '../src/types'
import type { EvalReport, EvalBaseline } from '../eval/types'

const ID_BY_QUERY = new Map<string, string>()
for (const q of EVAL_QUERIES) ID_BY_QUERY.set(q.query, q.id)

const DEFAULT_RESULTS_DIR = resolve(process.cwd(), 'eval', 'results')
const GOLD_PATH = resolve(process.cwd(), 'eval', 'gold-standards.json')

/** S35/S36/S38 wikipedia mirror backends — excluded from the composition key. */
const MIRROR_BACKENDS = ['dbpedia', 'wikidata', 'dbpedia-lang']

export interface RunInfo {
  backends: string[]
  ndcg: number
}

export interface LossRow {
  id: string
  gain: number // presentAvg - absentAvg within the same composition
  weighted: number
  presentN: number
  absentN: number
  comp: string
  goldWiki: boolean
  tags: string[]
  c429: number
  mirrorFired: number // absent runs where a mirror backend fired
  mirrorRecovered: number // of those, gold recovered (loss within tolerance)
  mirrorStillLost: number // of those, gold still lost
}

/** One mirror-fallback event parsed from the eval log (S40). */
export interface MirrorEvent {
  /** eval run number (1..N) from the ─ run N/M ─ markers; 0 = unattributed. */
  run: number
  /** eval query id (via ID_BY_QUERY); falls back to the raw query text. */
  id: string
  backend: string // 'dbpedia' | 'wikidata' | 'dbpedia-lang' | 'unknown'
  kind: 'recovered' | 'skipped' | 'status-failure' | 'catch-failure'
  query: string
  /** reconstructed wikipedia gold URLs for recovered events; 0 otherwise. */
  count: number
  language?: string
}

/** Per-backend firing statistics aggregated from MirrorEvents (S40). */
export interface BackendMirrorStats {
  backend: string
  /** recovered events — the only log-observable "fired AND succeeded". */
  fired: number
  /** Σ count across recovered events (reconstructed gold URLs). */
  recoveredResults: number
  /** distinct query ids with ≥1 recovered event. */
  recoveredQueries: number
  skipped: number
  statusFailures: number
  catchFailures: number
  /** fired + skipped + statusFailures + catchFailures. */
  attempts: number
  /**
   * fired / attempts (0 when attempts = 0). NOTE: skips are rate-guard
   * BLOCKED non-attempts (the fallback never reached the API), so a low rate
   * means "gated under load", not necessarily "the fallback is broken" —
   * statusFailures/catchFailures are the actual call-level failures.
   */
  successRate: number
}

/** S75: gate verdict × wikipedia-429 availability cross-reference. */
export interface Gate429CrossRef {
  /** baseline found on disk (or injected by the runner) */
  hasBaseline: boolean
  runCount: number
  /** gate-flagged ndcgAt10 regressions where EVERY regressed run was wikipedia-absent */
  flaggedBy429: Gate429Row[]
  /** gate-flagged regressions with >=1 NON-429 regressed run (genuine candidates) */
  flaggedClean: Gate429Row[]
  /** gate-passed but ALL runs wikipedia-absent AND all below baseline */
  passedWith429: Gate429Row[]
}

export interface LossSummary {
  runCount: number
  attributableCount: number // queries with a same-composition present/absent pair
  nGain: number // queries with gain > 0.001
  sumGain: number // per-query gain sum (same-composition presentAvg − absentAvg)
  weightedLoss: number // Σ max(0, presentAvg − absentNdcg)
  singlePairWeighted: number
  multiObsWeighted: number
  coverable: number // gold≈wikipedia (S28 EN DBpedia + S36 non-EN Wikidata + S38 ja 2nd tier)
  stillVulnerable: number // gold ≠ wikipedia — mirrors reconstruct only wikipedia URLs
  nonEnCount: number
  neverPresent: number // wikipedia never present + 429 evidence
  wikiGoldNever: number // of those, gold≈wikipedia (directly DBpedia-covered)
  wikiGoldNeverNdcg: number | null
  dbpAbort: number // mirror fallback aborted/errored in the last eval block
  dbpStatus: number
  mirrorRecoveredLog: number // 'Wikipedia mirror fallback recovered' log lines (last block)
  // S39: mirror-fallback recovery split
  mirrorFiredRuns: number // wikipedia-absent runs where a mirror fired
  mirrorRecoveredRuns: number // of those, gold recovered
  mirrorStillLostRuns: number // of those, gold still lost
  mirrorRecoveredQueries: number // distinct queries with ≥1 recovered run
  mirrorStillLostQueries: number // distinct queries with ≥1 still-lost run
  weightedRecovered: number // weighted loss of recovered runs (≈0)
  weightedStillLost: number // weighted loss of still-lost mirror runs
  weightedNoMirror: number // weighted loss of absent runs without any mirror
  neverPresentMirrorFired: number // never-present queries where a mirror fired in ≥1 run
  neverPresentMirrorRecovered: number // of those, any run NDCG > 0 (gold URL present)
  // S40: log-parsed mirror firing stream + per-backend aggregates
  mirrorEvents: MirrorEvent[]
  mirrorStats: BackendMirrorStats[]
  nonEnMirrorRecoveredLog: number // distinct ja/zh/kr ids with a wikidata/dbpedia-lang recovered event
  neverPresentRecoveredByLog: number // never-present ids with ANY log recovered event
  // S75: S73 2-run gate × wikipedia-429 cross-reference
  gate429: Gate429CrossRef
  rows: LossRow[] // sorted by gain desc
}

/**
 * Load one run file as query-id → { backends, ndcg }.
 *
 * S54 (2026-08-08): the stored `ranking.ndcgAt10` field in run-*.json can be
 * STALE relative to the current metric rules — S50's DCG cap (NDCG∈[0,1]) and
 * S49's label-suffix matcher changed the definition, and gold edits (S49
 * kr-stock-03, S52 subsumption dedup) shift relevance after a run was saved.
 * The stored field is only valid for the gold+rules that were live when that
 * run was written. Instead of trusting it, we RECOMPUTE NDCG live from the
 * run's own response.results (the actual pool the orchestrator produced —
 * url/domain fields are serialized per result) against the CURRENT gold via
 * computeNdcg. This makes every consumer of this report automatically
 * consistent with the newest metric semantics and gold set.
 *
 * Legacy fallback: run files that predate result serialization (or test
 * fixtures that write only backends+ranking) have no response.results — those
 * fall back to the stored ranking field so old artifacts remain analyzable.
 */
function loadRuns(resultsDir: string, gold: Map<string, string[]>): Array<Map<string, RunInfo>> {
  const files = readdirSync(resultsDir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(resolve(resultsDir, f), 'utf8'))
    const results: Array<{
      query?: { id?: string }
      backends?: unknown
      ranking?: Record<string, unknown>
      response?: { results?: unknown }
    }> = raw.report?.results ?? raw.results ?? []
    const m = new Map<string, RunInfo>()
    for (const q of results) {
      if (!q.query?.id) continue // unattributed result rows are not eval queries
      const goldDomains = gold.get(q.query.id) ?? []
      const respResults = q.response?.results
      const pool = Array.isArray(respResults) ? (respResults as SearchResult[]) : undefined
      // S54: live recompute — the pool is the run's own output, so its
      // ranking under CURRENT rules is exact (computeNdcg returns 0 when the
      // gold set is empty — review S54: the old `goldDomains.length > 0`
      // guard would have trusted a STALE stored value after a gold edit that
      // deletes a query's domains; recompute is correct in that edge too).
      // Only the legacy fallback (no serialized pool) reads the stored field.
      let ndcg: number
      if (pool && pool.length > 0) {
        ndcg = computeNdcg(pool, goldDomains, 10)
      } else {
        const ndcgRaw = q.ranking?.ndcgAt10 ?? q.ranking?.ndcg10 ?? 0
        ndcg = typeof ndcgRaw === 'number' && Number.isFinite(ndcgRaw) ? ndcgRaw : 0
      }
      m.set(q.query.id, {
        backends: Array.isArray(q.backends) ? q.backends : [],
        ndcg,
      })
    }
    return m
  })
}

/**
 * Load each run-*.json as a FULL EvalReport (S75 — the S73 gate cross-ref
 * needs the per-run response pools + ranking fields, not just backends/ndcg).
 */
function loadRunReports(resultsDir: string): EvalReport[] {
  const files = readdirSync(resultsDir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  const out: EvalReport[] = []
  for (const f of files) {
    try {
      const raw = JSON.parse(readFileSync(resolve(resultsDir, f), 'utf8'))
      if (raw?.report?.results) out.push(raw.report as EvalReport)
    } catch {
      /* malformed run file — skip (loadRuns already surfaces the hard failure) */
    }
  }
  return out
}

/**
 * Split the log into the LAST eval block (after the last `Running N eval
 * queries` header — median logs append across sessions) + the ─ run N/M ─
 * markers within it (S40: shared by parseQuery429s and parseMirrorEvents).
 */
function parseBlock(logText: string): { block: string[]; markers: { line: number; run: number }[] } {
  const lines = logText.split('\n')
  let blockStart = 0
  lines.forEach((l, i) => {
    if (l.includes('Running') && l.includes('eval queries')) blockStart = i
  })
  const block = lines.slice(blockStart)
  const markers: { line: number; run: number }[] = []
  block.forEach((l, i) => {
    const m = l.match(/─ run (\d+)\/(\d+) ─/)
    if (m) markers.push({ line: i, run: Number(m[1]) })
  })
  return { block, markers }
}

function runAtLine(markers: { line: number; run: number }[], line: number): number | undefined {
  let current: number | undefined
  for (const mk of markers) {
    if (mk.line <= line) current = mk.run
    else break
  }
  return current
}

/** Same attribution as S33 — only the last run block, `query` field or q= URL. */
function parseQuery429s(logText: string): Map<string, { runs: Set<number>; count: number }> {
  const { block, markers } = parseBlock(logText)

  const perQuery = new Map<string, { runs: Set<number>; count: number }>()
  block.forEach((l, idx) => {
    if (!l.includes('429') && !l.includes('rate-limited')) return
    if (!/wikipedia|rest\.php|w\/api\.php/i.test(l)) return
    let query: string | undefined
    try {
      const parsed = JSON.parse(l)
      if (typeof parsed.query === 'string') query = parsed.query
    } catch {
      /* non-JSON */
    }
    if (!query) {
      const m = l.match(/[?&]q=([^&"\s]+)/i)
      if (m) {
        try {
          query = decodeURIComponent(m[1])
        } catch {
          query = m[1]
        }
      }
    }
    if (!query) return
    const id = ID_BY_QUERY.get(query) ?? query
    const run = runAtLine(markers, idx) ?? 0
    let agg = perQuery.get(id)
    if (!agg) {
      agg = { runs: new Set(), count: 0 }
      perQuery.set(id, agg)
    }
    agg.count += 1
    if (run > 0) agg.runs.add(run)
  })
  return perQuery
}

function loadGold(): Map<string, string[]> {
  const g = JSON.parse(readFileSync(GOLD_PATH, 'utf8'))
  const out = new Map<string, string[]>()
  for (const [k, v] of Object.entries(g)) {
    if (k.startsWith('_')) continue
    const domains = (v as { relevantDomains?: unknown } | undefined)?.relevantDomains ?? []
    if (Array.isArray(domains)) out.set(k, domains)
  }
  return out
}

const avg = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0)

/** Last `Running N eval queries` block — the median log appends across sessions. */
function lastBlock(logText: string): string {
  return parseBlock(logText).block.join('\n')
}

/**
 * Parse the S36/S38 mirror-fallback event stream from the eval log (S40).
 *
 * The orchestrator logs a recovered event ONLY when the mirror produced
 * results (backend + count of reconstructed wikipedia URLs); the specialized
 * backends log skips (their own rate guards gating the attempt) and status /
 * catch failures. Together these are the ONLY complete record of when a
 * wikidata/dbpedia-lang fallback ATTEMPTED to engage and what it recovered —
 * the run JSONs can only ever show the successful subset (usedBackends only
 * gains 'wikidata'/'dbpedia-lang' on success). The orchestrator's
 * backend-agnostic catch-all ('[Orchestrator] Wikipedia mirror fallback
 * failed') is deliberately NOT parsed here — it is already counted by the
 * dbpAbort field and carries no backend attribution.
 *
 * Returns events with run attribution (─ run N/M ─ markers) and query id
 * resolution (ID_BY_QUERY, falling back to the raw query text).
 */
export function parseMirrorEvents(logText: string): MirrorEvent[] {
  const { block, markers } = parseBlock(logText)
  const out: MirrorEvent[] = []
  for (const [idx, l] of block.entries()) {
    let kind: MirrorEvent['kind'] | undefined
    let backend: string | undefined
    if (l.includes('Wikipedia mirror fallback recovered wikipedia gold')) {
      kind = 'recovered'
    } else if (l.includes('Wikidata fallback skipped (API quota exhausted)')) {
      kind = 'skipped'
      backend = 'wikidata'
    } else if (l.includes('dbpedia-lang fallback skipped (endpoint cooldown)')) {
      kind = 'skipped'
      backend = 'dbpedia-lang'
    } else if (
      l.includes('Wikidata fallback label search failed (status') ||
      l.includes('Wikidata fallback sitelink fetch failed (status')
    ) {
      kind = 'status-failure'
      backend = 'wikidata'
    } else if (l.includes('dbpedia-lang SPARQL failed (status')) {
      kind = 'status-failure'
      backend = 'dbpedia-lang'
    } else if (l.includes('Wikidata fallback search failed')) {
      // catch-all has NO query/backend JSON fields — infer from the message
      kind = 'catch-failure'
      backend = 'wikidata'
    } else if (l.includes('dbpedia-lang fallback failed')) {
      kind = 'catch-failure'
      backend = 'dbpedia-lang'
    } else {
      continue
    }

    let query: string | undefined
    let count = 0
    let language: string | undefined
    try {
      const parsed = JSON.parse(l)
      if (typeof parsed.query === 'string') query = parsed.query
      if (typeof parsed.backend === 'string') backend = parsed.backend
      if (typeof parsed.count === 'number' && Number.isFinite(parsed.count)) count = parsed.count
      if (typeof parsed.language === 'string') language = parsed.language
    } catch {
      /* non-JSON line — keep string-derived fields */
    }
    if (!backend) {
      // Non-JSON fallback (test fixtures / old loggers). 'dbpedia-lang' MUST
      // be checked before bare 'dbpedia' — the former contains the latter.
      // Case-insensitive: the logger uses 'Wikidata' (capitalized) in the
      // message while JSON payloads use lowercase 'wikidata'.
      const lower = l.toLowerCase()
      if (lower.includes('dbpedia-lang')) backend = 'dbpedia-lang'
      else if (lower.includes('"backend":"dbpedia"') || lower.includes('backend: "dbpedia"')) backend = 'dbpedia'
      else if (lower.includes('wikidata')) backend = 'wikidata'
      else if (lower.includes('dbpedia')) backend = 'dbpedia'
      else backend = 'unknown'
    }
    if (!query) {
      const m = l.match(/[?&]q=([^&"\s]+)/i)
      if (m) {
        try {
          query = decodeURIComponent(m[1])
        } catch {
          query = m[1]
        }
      }
    }
    const id = query ? (ID_BY_QUERY.get(query) ?? query) : ''
    out.push({
      run: runAtLine(markers, idx) ?? 0,
      id,
      backend,
      kind,
      query: query ?? '',
      count,
      ...(language ? { language } : {}),
    })
  }
  return out
}

/** Aggregate the parsed event stream into per-backend firing statistics. */
export function aggregateMirrorStats(events: readonly MirrorEvent[]): BackendMirrorStats[] {
  const byBackend = new Map<string, BackendMirrorStats>()
  for (const ev of events) {
    let s = byBackend.get(ev.backend)
    if (!s) {
      s = {
        backend: ev.backend,
        fired: 0,
        recoveredResults: 0,
        recoveredQueries: 0,
        skipped: 0,
        statusFailures: 0,
        catchFailures: 0,
        attempts: 0,
        successRate: 0,
      }
      byBackend.set(ev.backend, s)
    }
    s.attempts += 1
    if (ev.kind === 'recovered') {
      s.fired += 1
      s.recoveredResults += ev.count
    } else if (ev.kind === 'skipped') {
      s.skipped += 1
    } else if (ev.kind === 'status-failure') {
      s.statusFailures += 1
    } else {
      s.catchFailures += 1
    }
  }
  const stats = [...byBackend.values()].sort((a, b) => a.backend.localeCompare(b.backend))
  for (const s of stats) {
    s.successRate = s.attempts > 0 ? s.fired / s.attempts : 0
    const recoveredIds = new Set(
      events.filter((e) => e.backend === s.backend && e.kind === 'recovered').map((e) => e.id),
    )
    s.recoveredQueries = recoveredIds.size
  }
  return stats
}

/**
 * A wikipedia-absent run "recovered" its gold when its NDCG is within
 * tolerance of the wikipedia-present baseline of the same composition:
 * loss ≤ max(0.1, 0.2·presentAvg) AND presentAvg ≥ 0.1.
 *
 * The presentAvg ≥ 0.1 gate (review S39) stops the 0.1 floor from inflating
 * recovery counts on near-zero baselines: if wikipedia itself only scored
 * 0.05, there was no gold signal for the mirror to recover — a mirror run
 * at 0.0 is "no signal", not a recovery. 0.1 is the loss floor (present
 * baselines near 0 are noise); 20% of the baseline absorbs normal cross-run
 * variance while still flagging a mirror that returned nothing relevant
 * (e.g. en-fact-02 present 1.47 → mirror run 0.00 is NOT recovered).
 */
function isRecovered(loss: number, presentAvg: number): boolean {
  return presentAvg >= 0.1 && loss <= Math.max(0.1, presentAvg * 0.2)
}

/** One query's S73-gate × wikipedia-429 cross-reference row (S75). */
export interface Gate429Row {
  id: string
  goldWiki: boolean
  /** baseline NDCG recomputed under CURRENT gold (S54) — rows with an
   *  uncomputable baseline are skipped, so this is always a number */
  baselineNdcg: number
  /** per run: the run's recomputed NDCG */
  runNdcgs: number[]
  /** per run: wikipedia missing from the run's backends (429 → mirror/absent) */
  run429: boolean[]
  /** per run: baseline − ndcg > 0.05 — the S73 gate's per-run regression test */
  runRegressed: boolean[]
  /** S34 composition-controlled weighted loss for this query (0 if unattributable) */
  weighted: number
  /** wikipedia-429 log evidence count (0 without a log) */
  c429: number
  tags: string[]
}

/**
 * Gate × wikipedia-429 cross-reference (S75).
 *
 * S73's diffBaselineStabilized flags a query only when >= minAgree runs agree
 * on a >= 0.05 NDCG drop — but a drop caused by wikipedia 429 (backend absent
 * in every regressed run) is availability noise, NOT a ranking regression. And
 * the reverse: stabilization can let a wikipedia-429 drop THROUGH the gate
 * (the runs agree on wikipedia absence but not on the 0.05 threshold). This
 * classification surfaces both so a reviewer can tell 429 noise from real
 * regressions in the S37 loss report:
 *   - flaggedBy429  — gate-flagged AND every regressed run was wikipedia-absent
 *                     → the flag is explained by availability (dismissable)
 *   - flaggedClean   — gate-flagged with >=1 NON-429 regressed run → genuine
 *                     ranking-regression candidate. NOTE: this is a coarse
 *                     label — a barely-over-threshold (0.051) non-429 run
 *                     labels the flag "genuine" even when a 429 run dropped
 *                     far more; judge from the per-run detail rows (run429 /
 *                     runNdcgs) when the cause is mixed.
 *   - passedWith429  — gate-passed BUT every run was wikipedia-absent AND every
 *                     run scored below baseline → the 2-run stabilization
 *                     masked a wikipedia-429 NDCG drop (pass is availability
 *                     luck, not quality — the reviewer must look)
 */
export function crossReferenceGate429(
  reports: EvalReport[],
  baseline: EvalBaseline | null,
  runs: ReadonlyArray<ReadonlyMap<string, RunInfo>>,
  gold: ReadonlyMap<string, string[]>,
  lossRows: readonly LossRow[],
  c429ById: ReadonlyMap<string, { runs: Set<number>; count: number }>,
): Gate429CrossRef {
  const base: Gate429CrossRef = {
    hasBaseline: baseline !== null,
    runCount: runs.length,
    flaggedBy429: [],
    flaggedClean: [],
    passedWith429: [],
  }
  if (!baseline || runs.length < 2 || reports.length < 2) return base

  const goldRec: Record<string, string[]> = Object.fromEntries(gold)
  const flagged = new Set(
    diffBaselineStabilized(reports, baseline, goldRec)
      .filter((d) => d.metric === 'ndcgAt10')
      .map((d) => d.queryId),
  )
  const weightedById = new Map(lossRows.map((r) => [r.id, r.weighted]))

  const allIds = new Set<string>()
  for (const r of runs) for (const id of r.keys()) allIds.add(id)
  for (const id of allIds) {
    const bres = baseline.report.results.find((r) => r.query.id === id)
    if (!bres) continue
    const bndcg = recomputeNdcgAt10(bres, goldRec[id])
    if (bndcg === undefined) continue
    const infos = runs.map((r) => r.get(id)).filter((x): x is RunInfo => x !== undefined)
    if (infos.length < 2) continue
    const runNdcgs = infos.map((i) => i.ndcg)
    const run429 = infos.map((i) => !i.backends.includes('wikipedia'))
    const runRegressed = runNdcgs.map((n) => bndcg - n > 0.05)
    const goldDomains = gold.get(id) ?? []
    const row: Gate429Row = {
      id,
      goldWiki: goldDomains.some((d) => d.includes('wikipedia.org')),
      baselineNdcg: bndcg,
      runNdcgs,
      run429,
      runRegressed,
      weighted: weightedById.get(id) ?? 0,
      c429: c429ById.get(id)?.count ?? 0,
      tags: EVAL_QUERIES.find((q) => q.id === id)?.tags ?? [],
    }
    if (flagged.has(id)) {
      const regressedIdx = runRegressed.map((r, i) => (r ? i : -1)).filter((i) => i >= 0)
      if (regressedIdx.length > 0 && regressedIdx.every((i) => run429[i])) {
        base.flaggedBy429.push(row)
      } else {
        base.flaggedClean.push(row)
      }
    } else if (run429.every(Boolean) && runNdcgs.every((n) => n < row.baselineNdcg)) {
      base.passedWith429.push(row)
    }
  }

  const byWeight = (a: Gate429Row, b: Gate429Row) => b.weighted - a.weighted
  base.flaggedBy429.sort(byWeight)
  base.flaggedClean.sort(byWeight)
  base.passedWith429.sort(byWeight)
  return base
}

/**
 * Compute the S34 wikipedia-429 loss summary from eval/results/run-*.json.
 *
 * `logText` is optional (S37): the weighted-loss core is fully derived from
 * the run JSONs (backends + NDCG); the log only adds the per-query 429
 * evidence and mirror-fallback abort counts. When omitted, those are zeroed
 * and the never-present analysis degrades to "no 429 evidence".
 *
 * S39: mirror backends (S35 dbpedia / S36 wikidata / S38 dbpedia-lang) are
 * excluded from the composition key, so a wikipedia-absent run that fired the
 * mirror pairs with its wikipedia-present twin. Each absent run is then
 * classified as mirror-recovered / mirror-still-lost / no-mirror.
 */
export function computeLossReport(
  resultsDir: string = DEFAULT_RESULTS_DIR,
  logText?: string,
  baseline?: EvalBaseline | null,
): LossSummary {
  // S54: gold is loaded FIRST — loadRuns recomputes NDCG against it.
  const gold = loadGold()
  const runs = loadRuns(resultsDir, gold)
  const perQuery429 = logText ? parseQuery429s(logText) : new Map<string, { runs: Set<number>; count: number }>()

  // ── group runs per query by other-backend composition ──────────────────
  interface AbsentRun {
    ndcg: number
    hasMirror: boolean
  }
  interface CompGroup {
    comp: string
    present: number[] // ndcgs of runs WITH wikipedia
    absent: AbsentRun[] // ndcgs of runs WITHOUT wikipedia (+ mirror flag)
  }
  interface QueryAgg {
    groups: CompGroup[]
    hasPresent: boolean
    anyAttributable: boolean
  }
  const agg = new Map<string, QueryAgg>()
  const allIds = new Set<string>()
  for (const r of runs) for (const id of r.keys()) allIds.add(id)
  for (const id of allIds) {
    const byComp = new Map<string, CompGroup>()
    for (const r of runs) {
      const info = r.get(id)
      if (!info) continue
      if (info.backends.length === 1 && info.backends[0] === 'failed') continue // total failure
      // S39: the mirror backends are wikipedia-standins (they fire ONLY when
      // wikipedia is absent), so they must not fragment the composition —
      // "bing+hackernews+dbpedia" must pair with "bing+hackernews"+wikipedia.
      const hasMirror = info.backends.some((b) => MIRROR_BACKENDS.includes(b))
      const others = info.backends
        .filter((b) => b !== 'wikipedia' && !MIRROR_BACKENDS.includes(b))
        .sort()
        .join('+')
      let g = byComp.get(others)
      if (!g) {
        g = { comp: others, present: [], absent: [] }
        byComp.set(others, g)
      }
      if (info.backends.includes('wikipedia')) g.present.push(info.ndcg)
      else g.absent.push({ ndcg: info.ndcg, hasMirror })
    }
    const groups = [...byComp.values()]
    agg.set(id, {
      groups,
      hasPresent: groups.some((g) => g.present.length > 0),
      anyAttributable: groups.some((g) => g.present.length > 0 && g.absent.length > 0),
    })
  }

  // ── attributable rows ───────────────────────────────────────────────────
  const outRows: LossRow[] = []
  let sumGain = 0
  let wLoss = 0
  let nGain = 0
  let mirrorFiredRuns = 0
  let mirrorRecoveredRuns = 0
  let mirrorStillLostRuns = 0
  let weightedRecovered = 0
  let weightedStillLost = 0
  let weightedNoMirror = 0
  const recoveredQueries = new Set<string>()
  const stillLostQueries = new Set<string>()
  for (const id of allIds) {
    const qa = agg.get(id)
    if (!qa || !qa.anyAttributable) continue
    let gain = 0
    let w = 0
    let presentN = 0
    let absentN = 0
    let comp = ''
    let rowMirrorFired = 0
    let rowMirrorRecovered = 0
    let rowMirrorStillLost = 0
    for (const g of qa.groups) {
      if (g.present.length === 0 || g.absent.length === 0) continue
      const pAvg = avg(g.present)
      for (const a of g.absent) {
        const loss = Math.max(0, pAvg - a.ndcg)
        w += loss
        if (a.hasMirror) {
          mirrorFiredRuns++
          rowMirrorFired++
          if (isRecovered(loss, pAvg)) {
            mirrorRecoveredRuns++
            rowMirrorRecovered++
            weightedRecovered += loss
            recoveredQueries.add(id)
          } else {
            mirrorStillLostRuns++
            rowMirrorStillLost++
            weightedStillLost += loss
            stillLostQueries.add(id)
          }
        } else {
          weightedNoMirror += loss
        }
      }
      gain += pAvg - avg(g.absent.map((a) => a.ndcg))
      presentN += g.present.length
      absentN += g.absent.length
      comp = g.comp
    }
    if (gain > 0.001) nGain++
    sumGain += gain
    wLoss += w
    const goldDomains = gold.get(id) ?? []
    outRows.push({
      id,
      gain,
      weighted: w,
      presentN,
      absentN,
      comp,
      goldWiki: goldDomains.some((d) => d.includes('wikipedia.org')), // substring matcher: 'wikipedia.org' covers en.wikipedia.org
      tags: EVAL_QUERIES.find((q) => q.id === id)?.tags ?? [],
      c429: perQuery429.get(id)?.count ?? 0,
      mirrorFired: rowMirrorFired,
      mirrorRecovered: rowMirrorRecovered,
      mirrorStillLost: rowMirrorStillLost,
    })
  }
  outRows.sort((a, b) => b.gain - a.gain)

  // ── per-query sample split ──
  const singlePair = outRows.filter((r) => r.presentN === 1 && r.absentN === 1)
  const multiObs = outRows.filter((r) => r.presentN + r.absentN >= 3)

  // ── Mirror coverage cross-ref (S28 EN / S36 non-EN / S38 ja 2nd tier) ──
  // S34 originally counted only EN+gold≈wikipedia as coverable (DBpedia
  // Lookup is EN-only). S36 (Wikidata non-EN) and S38 (ja.dbpedia.org 2nd
  // tier) closed that gap — the mirrors now reconstruct wikipedia URLs for
  // EVERY language, so any gold≈wikipedia query is coverable. Queries whose
  // gold is NOT wikipedia (baike.baidu.com, zhihu, velog…) stay vulnerable
  // — mirrors only ever emit wikipedia.org URLs.
  const affected = outRows.filter((r) => r.gain > 0.001)
  const isNonEn = (id: string) => /^(zh|ja|kr)-/.test(id)
  const coverable = affected.filter((r) => r.goldWiki)
  const nonEn = affected.filter((r) => isNonEn(r.id))

  // ── never-present + 429 evidence (DBpedia target set) ──
  const neverPresent = [...allIds].filter((id) => {
    const qa = agg.get(id)
    return !qa?.hasPresent && (perQuery429.get(id)?.count ?? 0) > 0
  })
  const wikiGoldNever = neverPresent.filter((id) => (gold.get(id) ?? []).some((d) => d.includes('wikipedia.org')))
  const wikiGoldNeverNdcg = wikiGoldNever.map((id) => {
    const ndcgs: number[] = []
    for (const r of runs) {
      const i = r.get(id)
      if (i) ndcgs.push(i.ndcg)
    }
    return avg(ndcgs)
  })

  // ── S39: never-present mirror recovery split ────────────────────────────
  // The attributable rows above only cover queries with ≥1 wikipedia-present
  // run (a present baseline to measure loss against). But the S35/S36/S38
  // fallbacks' PRIMARY target is the never-present set — queries where
  // wikipedia was ABSENT IN EVERY run (S34's "27 aborts"). Those queries have
  // no present twin, so they are invisible to the composition comparison.
  // Here we classify them directly from the run JSONs: did a mirror backend
  // fire, and did the run score any NDCG (gold URL present) at all? A
  // mirror-fired run with NDCG > 0 means the mirror reconstructed the gold
  // wikipedia URL despite wikipedia being entirely absent.
  const neverPresentMirrorFired: string[] = []
  const neverPresentMirrorRecovered: string[] = []
  for (const id of neverPresent) {
    let fired = false
    let recovered = false
    for (const r of runs) {
      const i = r.get(id)
      if (!i) continue
      const hasMirror = i.backends.some((b) => MIRROR_BACKENDS.includes(b))
      if (hasMirror) fired = true
      if (hasMirror && i.ndcg > 0) recovered = true
    }
    if (fired) neverPresentMirrorFired.push(id)
    if (recovered) neverPresentMirrorRecovered.push(id)
  }

  // Mirror fallback log evidence — restricted to the last eval block.
  // S34 matched the OLD in-wikipediaSearch message
  // ("Wikipedia DBpedia lookup fallback failed"); S35 promoted the mirror to
  // the orchestrator, which logs "[Orchestrator] Wikipedia mirror fallback
  // failed (non-critical)" on error and "[Orchestrator] Wikipedia mirror
  // fallback recovered wikipedia gold" on success. Both message families are
  // counted so old and new logs both report accurately.
  //
  // dbpStatus counts ONLY status-code failures (the old "failed (status N)"
  // message) — the orchestrator's catch-all "failed (non-critical)" is NOT a
  // status-code failure, so it counts toward dbpAbort only (review S39: the
  // two fields are disjoint, not a subset/superset pair).
  const block = logText ? lastBlock(logText) : ''
  const dbpAbort = logText
    ? (block.match(/Wikipedia DBpedia lookup fallback failed:|Wikipedia mirror fallback failed/g) ?? []).length
    : 0
  const dbpStatus = logText ? (block.match(/Wikipedia DBpedia lookup fallback failed \(status/g) ?? []).length : 0
  const mirrorRecoveredLog = logText
    ? (block.match(/Wikipedia mirror fallback recovered wikipedia gold/g) ?? []).length
    : 0

  // ── S40: mirror-fallback firing stream (from the log, run-attributed) ──
  // The run-JSON split above can only observe recovered mirrors (usedBackends
  // gains 'wikidata'/'dbpedia-lang' only on success). The log carries the
  // full event stream — recovered + skips (rate-guard gated) + status/catch
  // failures — which is the only complete record of WHEN the S36 (wikidata)
  // / S38 (dbpedia-lang) tiers engaged and how much gold they reconstructed.
  const mirrorEvents = logText ? parseMirrorEvents(logText) : []
  const mirrorStats = aggregateMirrorStats(mirrorEvents)
  const nonEnMirrorRecovered = new Set(
    mirrorEvents
      .filter(
        (e) => e.kind === 'recovered' && (e.backend === 'wikidata' || e.backend === 'dbpedia-lang') && isNonEn(e.id),
      )
      .map((e) => e.id),
  )
  const neverPresentRecoveredByLog = neverPresent.filter((id) =>
    mirrorEvents.some((e) => e.id === id && e.kind === 'recovered'),
  ).length

  // S75: S73 2-run gate × wikipedia-429 cross-reference. The baseline is
  // injected when the runner has one loaded (eval/index.ts passes the SAME
  // snapshot the gate compared against — a --save run must NOT self-compare
  // against the baseline it is about to write); the CLI defaults to disk.
  // NOTE: for a historical --results-dir the disk baseline may postdate the
  // analyzed runs — the cross-ref then compares era-mismatched snapshots
  // (acceptable for trend analysis; pass a baseline explicitly for precision).
  const baselineSnapshot = baseline === undefined ? loadBaseline() : baseline
  const reports = loadRunReports(resultsDir)
  const gate429 = crossReferenceGate429(reports, baselineSnapshot, runs, gold, outRows, perQuery429)

  return {
    runCount: runs.length,
    attributableCount: outRows.length,
    nGain,
    sumGain,
    weightedLoss: wLoss,
    singlePairWeighted: singlePair.reduce((s, r) => s + r.weighted, 0),
    multiObsWeighted: multiObs.reduce((s, r) => s + r.weighted, 0),
    coverable: coverable.length,
    stillVulnerable: affected.length - coverable.length,
    nonEnCount: nonEn.length,
    neverPresent: neverPresent.length,
    wikiGoldNever: wikiGoldNever.length,
    wikiGoldNeverNdcg: wikiGoldNeverNdcg.length ? avg(wikiGoldNeverNdcg) : null,
    dbpAbort,
    dbpStatus,
    mirrorRecoveredLog,
    mirrorFiredRuns,
    mirrorRecoveredRuns,
    mirrorStillLostRuns,
    mirrorRecoveredQueries: recoveredQueries.size,
    mirrorStillLostQueries: stillLostQueries.size,
    weightedRecovered,
    weightedStillLost,
    weightedNoMirror,
    neverPresentMirrorFired: neverPresentMirrorFired.length,
    neverPresentMirrorRecovered: neverPresentMirrorRecovered.length,
    mirrorEvents,
    mirrorStats,
    nonEnMirrorRecoveredLog: nonEnMirrorRecovered.size,
    neverPresentRecoveredByLog,
    gate429,
    rows: outRows,
  }
}

// ── CLI ───────────────────────────────────────────────────────────────────
function parseCli(): { logPath?: string; threshold: number; resultsDir: string } {
  const args = process.argv.slice(2)
  let logPath: string | undefined
  let threshold = 5.0
  let resultsDir = DEFAULT_RESULTS_DIR
  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--threshold':
        threshold = Number(args[++i])
        break
      case '--results-dir':
        resultsDir = resolve(process.cwd(), args[++i])
        break
      case '--help':
        console.log(`Usage: npx tsx scripts/analyze-429-loss.ts [logPath] [--threshold <n>] [--results-dir <dir>]

Computes the S34 composition-controlled NDCG loss from wikipedia 429 noise,
split into mirror-recovered (S35/S36/S38) vs still-lost runs.

  logPath        Path to the eval:median log (default: /tmp/eval-median.log).
                 Optional — the weighted-loss core works from run-*.json alone.
  --threshold <n>  Warn (::warning::) when weighted loss exceeds n (default 5.0).
  --results-dir    Directory with run-*.json (default: eval/results).
`)
        process.exit(0)
        break // unreachable — satisfies no-fallthrough (process.exit is not a recognized terminator)
      default:
        if (!logPath) logPath = args[i]
    }
  }
  return { logPath, threshold, resultsDir }
}

function main(): void {
  const { logPath, threshold, resultsDir } = parseCli()
  const logText = logPath ? readFileSync(logPath, 'utf8') : undefined
  const s = computeLossReport(resultsDir, logText)

  console.log(`=== S34: wikipedia-429 NDCG loss — composition-controlled (runs: ${s.runCount}) ===`)
  console.log(`queries with a same-composition present/absent pair: ${s.attributableCount}`)
  console.log(`queries with gain>0: ${s.nGain}`)
  console.log(`per-query gain sum (same-composition presentAvg − absentAvg): ${s.sumGain.toFixed(3)}`)
  console.log(`weighted loss sum (Σ max(0, presentAvg − absentNdcg)): ${s.weightedLoss.toFixed(3)}`)

  console.log('\nTop 25 attributable-loss queries:')
  for (const r of s.rows.slice(0, 25)) {
    console.log(
      `  ${r.id.padEnd(18)} Δ+${r.gain.toFixed(3).padStart(6)}  P:${r.presentN} A:${r.absentN}  goldWiki:${r.goldWiki ? 'Y' : 'N'}  [${r.tags.join(',')}]  429×${r.c429}  comp:${r.comp || '∅'}`,
    )
  }

  const singlePair = s.rows.filter((r) => r.presentN === 1 && r.absentN === 1)
  const multiObs = s.rows.filter((r) => r.presentN + r.absentN >= 3)
  console.log(
    `\nsample split: single-pair (P:1 A:1, high variance) ${singlePair.length} queries · multi-observation ${multiObs.length} queries`,
  )
  console.log(
    `  single-pair weighted loss: ${s.singlePairWeighted.toFixed(3)} · multi-obs weighted loss: ${s.multiObsWeighted.toFixed(3)}`,
  )

  const affected = s.rows.filter((r) => r.gain > 0.001)
  const goldWikiAffected = affected.filter((r) => r.goldWiki)
  console.log(`\nMirror coverage (S28 EN DBpedia / S36 non-EN Wikidata / S38 ja 2nd tier):`)
  console.log(
    `  attributable affected: ${affected.length} · gold≈wikipedia: ${goldWikiAffected.length} · mirror-CAN-cover: ${s.coverable} · still vulnerable (gold≠wikipedia): ${s.stillVulnerable}`,
  )

  // S39: mirror-fallback recovery split — what S35/S36/S38 actually recovered.
  console.log(`\nMirror-fallback recovery (S39, mirrors excluded from composition):`)
  console.log(
    `  wikipedia-absent runs where a mirror fired: ${s.mirrorFiredRuns} (of ${s.weightedLoss.toFixed(3)} total weighted loss)`,
  )
  console.log(
    `    recovered gold: ${s.mirrorRecoveredRuns} runs / ${s.mirrorRecoveredQueries} queries — weighted loss ${s.weightedRecovered.toFixed(3)} (≈0 by definition)`,
  )
  console.log(
    `    still lost (mirror fired but gold NOT recovered): ${s.mirrorStillLostRuns} runs / ${s.mirrorStillLostQueries} queries — weighted loss ${s.weightedStillLost.toFixed(3)}`,
  )
  console.log(
    `    no mirror fired: weighted loss ${s.weightedNoMirror.toFixed(3)} (the classic S34 wikipedia-429 loss)`,
  )
  console.log('Still-lost mirror queries (gold≈wikipedia but the mirror did NOT recover it):')
  const gold = loadGold()
  for (const r of s.rows.filter((r) => r.mirrorStillLost > 0).slice(0, 20)) {
    console.log(
      `    ${r.id.padEnd(18)} Δ+${r.gain.toFixed(3)}  mirror:${r.mirrorFired} (rec ${r.mirrorRecovered}/lost ${r.mirrorStillLost})  gold:[${(gold.get(r.id) ?? []).slice(0, 3).join(',')}]`,
    )
  }
  console.log('\nStill-vulnerable top 20 (gold is NOT a wikipedia.org domain — mirrors cannot help):')
  for (const r of s.rows.filter((r) => !r.goldWiki && r.gain > 0.001).slice(0, 20)) {
    console.log(
      `    ${r.id.padEnd(18)} Δ+${r.gain.toFixed(3)}  429×${r.c429}  gold:[${(gold.get(r.id) ?? []).slice(0, 3).join(',')}]`,
    )
  }
  console.log(`\nNon-EN attributable (all now mirror-coverable via Wikidata S36): ${s.nonEnCount}`)

  console.log(`\nNever-present wikipedia with 429 evidence: ${s.neverPresent} (DBpedia fallback target set)`)
  console.log(`  of those, gold=en.wikipedia.org: ${s.wikiGoldNever} (directly DBpedia-covered)`)
  console.log(`  their avg NDCG (all runs): ${s.wikiGoldNeverNdcg !== null ? s.wikiGoldNeverNdcg.toFixed(3) : 'n/a'}`)
  console.log(
    `  mirror fired in ≥1 run: ${s.neverPresentMirrorFired} queries · of those, mirror-recovered (NDCG>0): ${s.neverPresentMirrorRecovered} queries · still 0 NDCG: ${s.neverPresentMirrorFired - s.neverPresentMirrorRecovered} queries`,
  )

  console.log(
    `\nMirror fallback log evidence (last eval block only): aborted/errored ×${s.dbpAbort} (status-code failures ×${s.dbpStatus}), recovered ×${s.mirrorRecoveredLog}`,
  )

  // S40: per-backend firing table + wikidata/dbpedia-lang event detail.
  console.log('\nMirror-fallback firing (S40, from log, run-attributed):')
  if (s.mirrorStats.length === 0) {
    console.log('  no log events parsed (no logText given — rerun with the eval log path)')
  } else {
    for (const b of s.mirrorStats) {
      console.log(
        `  ${b.backend.padEnd(12)} fired ${String(b.fired).padStart(4)} events / ${String(b.recoveredResults).padStart(4)} gold results / ${String(b.recoveredQueries).padStart(3)} queries · skipped ${String(b.skipped).padStart(4)} · status-fail ${String(b.statusFailures).padStart(3)} · catch-fail ${String(b.catchFailures).padStart(3)} → success ${(b.successRate * 100).toFixed(0).padStart(3)}% (attempts ${b.attempts})`,
      )
    }
    console.log(
      `  non-EN (ja/zh/kr) queries recovered by wikidata/dbpedia-lang: ${s.nonEnMirrorRecoveredLog} · never-present queries with a log recovery: ${s.neverPresentRecoveredByLog} (these are typically EN dbpedia events — the non-EN tiers are the column immediately above)`,
    )
    const firedDetail = s.mirrorEvents.filter(
      (e) => e.kind === 'recovered' && (e.backend === 'wikidata' || e.backend === 'dbpedia-lang'),
    )
    if (firedDetail.length > 0) {
      console.log('  wikidata/dbpedia-lang recovered events (query @ run, +gold results):')
      for (const e of firedDetail.slice(0, 25)) {
        console.log(
          `    ${e.id.padEnd(18)} run ${e.run}  +${e.count}  [${e.backend}]${e.language ? '  lang:' + e.language : ''}`,
        )
      }
      if (firedDetail.length > 25) console.log(`    … and ${firedDetail.length - 25} more`)
    } else {
      console.log(
        '  wikidata/dbpedia-lang: NO recovered events in the log — the non-EN tiers never successfully fired (skips/status-failures only, see table above). This is the S36 rate-guard gate under eval load.',
      )
    }
  }
  console.log(
    `\nNote: queries with wikipedia flapping but NO same-composition pair are excluded (unattributable co-failure) — the attributable numbers above are a conservative lower bound. The never-present mirror split above covers the queries wikipedia never served.`,
  )

  // S75: S73 2-run gate × wikipedia-429 cross-reference — tells the reviewer
  // whether gate flags are 429 noise and whether gate passes masked a 429 drop.
  console.log('\nGate × wikipedia-429 cross-reference (S75, S73 2-run stabilization):')
  if (!s.gate429.hasBaseline) {
    console.log('  no baseline on disk — cross-reference skipped')
  } else if (s.gate429.runCount < 2) {
    console.log('  fewer than 2 runs — stabilization gate not applicable')
  } else {
    console.log(
      `  gate-flagged AND every regressed run wikipedia-absent (429-explainable flags): ${s.gate429.flaggedBy429.length}`,
    )
    console.log(
      `  gate-flagged with a NON-429 regressed run (genuine regression candidates): ${s.gate429.flaggedClean.length}`,
    )
    console.log(
      `  gate-PASSED but ALL runs wikipedia-absent and below baseline (stabilization masked a 429 drop): ${s.gate429.passedWith429.length}`,
    )
    const fmt = (r: Gate429Row) =>
      `    ${r.id.padEnd(18)} base:${r.baselineNdcg.toFixed(3)}  runs:[${r.runNdcgs
        .map((n, i) => `${r.run429[i] ? '429' : 'wiki'}${n.toFixed(2)}`)
        .join(' ')}]  S34w:${r.weighted.toFixed(3)} 429×${r.c429} [${r.tags.join(',')}]`
    if (s.gate429.flaggedBy429.length) {
      console.log('  flagged-by-429 (dismissable availability noise — verify on next run):')
      for (const r of s.gate429.flaggedBy429.slice(0, 15)) console.log(fmt(r))
    }
    if (s.gate429.flaggedClean.length) {
      console.log('  GENUINE regression candidates (at least one non-429 regressed run):')
      for (const r of s.gate429.flaggedClean.slice(0, 15)) console.log(fmt(r))
    }
    if (s.gate429.passedWith429.length) {
      console.log('  passed-with-429 (gate pass is availability luck — 429 drop masked by stabilization):')
      for (const r of s.gate429.passedWith429.slice(0, 15)) console.log(fmt(r))
    }
  }

  // S37: workflow warning when the weighted loss exceeds the threshold.
  if (s.weightedLoss > threshold) {
    console.error(
      `::warning::S34 wikipedia-429 weighted NDCG loss ${s.weightedLoss.toFixed(3)} exceeds threshold ${threshold} — see scripts/analyze-429-loss.ts`,
    )
  } else {
    console.error(`Weighted loss ${s.weightedLoss.toFixed(3)} within threshold ${threshold} — no warning.`)
  }
}

// Run only when executed directly (not when imported by eval/index.ts).
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), 'scripts', 'analyze-429-loss.ts')
if (isDirectRun) main()
