/**
 * Wave 1 accuracy simulation — re-rank the stored 500-query pools (run-1..3)
 * with the new ranking pipeline (context-gated BM25 title-field weight) and
 * measure the median NDCG@10 delta vs the pre-Wave-1-equivalent baseline
 * (S14/S48 technique).
 *
 * Usage: npx tsx scripts/sim-wave1-accuracy.ts [--title-weight N|gated]
 *   --title-weight N     fixed weight for ALL contexts (N = 2 reproduces the
 *                        pre-Wave-1 score exactly → Δ ≈ 0)
 *   --title-weight gated production gate: technical=2, non-technical=3
 *                        (the production default)
 *
 * The baseline is re-ranked with titleWeight=2 (pre-Wave-1-equivalent),
 * which isolates the lever's PURE effect instead of attributing
 * ctx-reconstruction noise (authority bonus differences) to the change.
 *
 * Note: the Wave 1 entity-aware boost was measured (+0.001, 17 queries) and
 * REJECTED — the production ranking path no longer consumes entityHints, so
 * this script has no entity axis. See docs/13_AGGRESSIVE_IMPROVEMENT_PLAN.md
 * §3 for the historical measurement.
 */
import {
  recomputeScores,
  sortResults,
  applyQualityThreshold,
  TITLE_WEIGHT_TECHNICAL,
  TITLE_WEIGHT_NON_TECHNICAL,
} from '../src/lib/search/ranking'
import { computeNdcg } from '../eval/metrics'
import { detectQueryType } from '../src/lib/specialized'
import { setBm25TitleWeight } from '../src/lib/retrieval/bm25'
import { setQueryExpansionEnabled } from '../src/lib/understanding/query-expander'
import * as fs from 'fs'
import type { SearchContext } from '../src/lib/search/context'

// ── gold ──
const gold = JSON.parse(fs.readFileSync('eval/gold-standards.json', 'utf8')) as Record<
  string,
  { relevantDomains?: string[] }
>

// Simulated BASELINE = pre-Wave-1-equivalent settings: titleWeight=2 (the old
// title+content+title behavior), which the sim's repro run confirms is Δ≈0.
const BASELINE_TITLE_WEIGHT = 2

/** Re-rank a pool with an explicit title weight; returns ranked results. */
function rerank(pool: Array<Record<string, unknown>>, ctx: SearchContext, titleWeight: number): typeof pool {
  setBm25TitleWeight(titleWeight)
  return applyQualityThreshold(
    sortResults(recomputeScores(pool as never, ctx, titleWeight), ctx),
    ctx,
  ) as unknown as typeof pool
}

// Enable/disable the Wave 2 query-expansion hook for a re-rank pass.
function setExpansion(on: boolean): void {
  setQueryExpansionEnabled(on)
}

function hasCJKScript(text: string): 'ko' | 'zh' | 'ja' | 'en' {
  if (/[\uAC00-\uD7A3]/.test(text)) return 'ko'
  if (/[\u3040-\u30FF]/.test(text)) return 'ja'
  if (/[\u4E00-\u9FFF]/.test(text)) return 'zh'
  return 'en'
}

function buildCtx(query: string, topic: string | undefined, maxResults = 10): SearchContext {
  const lang = hasCJKScript(query)
  const queryType = detectQueryType(query)
  const isNews = topic === 'news' || queryType === 'news'
  const isFinance = topic === 'finance' || queryType === 'financial'
  return {
    query,
    request: { query, topic: topic ?? 'general', max_results: maxResults },
    env: undefined,
    korean: lang === 'ko',
    chinese: lang === 'zh',
    japanese: lang === 'ja',
    queryType,
    sources: {} as never,
    entityHints: undefined,
    isNews,
    isFinance,
    focus: 'all',
    hasExplicitFocus: false,
    overFetch: Math.max(maxResults * 3, 30),
    maxResults,
    bingLang: undefined,
    bingRegion: undefined,
    bingTimeRange: undefined,
    effectiveWikiLang: lang,
    spaceFileContext: '',
    experimentVariant: 'control',
  } as SearchContext
}

function median(a: number, b: number): number {
  return (a + b) / 2
}

// CLI: --title-weight N|gated (default gated = production gate)
const TW_ARG = process.argv.indexOf('--title-weight')
const TW_RAW = TW_ARG >= 0 ? (process.argv[TW_ARG + 1] ?? 'gated') : 'gated'
// CLI: --expansion on|off (default off — Wave 2 query-expansion lever)
const EXP_IDX = process.argv.indexOf('--expansion')
const EXPANSION_ON = EXP_IDX >= 0 ? process.argv[EXP_IDX + 1] === 'on' : false

/** Title weight for a context under the requested mode. */
function titleWeightFor(queryType: string): number {
  if (TW_RAW === 'gated') {
    // mirrors production ranking.ts: technical=2, else=3
    return queryType === 'technical' ? TITLE_WEIGHT_TECHNICAL : TITLE_WEIGHT_NON_TECHNICAL
  }
  return Number(TW_RAW) || 2
}

type RunData = {
  results?: Array<{ query?: { id?: string; query?: string; topic?: string }; response?: { results?: unknown } }>
}
const runs: RunData[] = []
for (const n of [1, 2, 3]) {
  const path = `eval/results/run-${n}.json`
  if (!fs.existsSync(path)) continue // run-3 was cleaned in S80 (--runs 2 session)
  const r = JSON.parse(fs.readFileSync(path, 'utf8')) as { report?: RunData }
  runs.push((r.report ?? r) as RunData)
}
if (runs.length === 0) throw new Error('no run-*.json files found')

type RunResult = NonNullable<RunData['results']>[number]
function runQuery(run: RunData, qid: string): RunResult {
  const q = (run.results ?? []).find((x) => x.query?.id === qid)
  if (!q) throw new Error(`missing ${qid} in run`)
  return q
}

const deltas: Record<string, { before: number; after: number; perRun: number[]; tag: string }> = {}
for (const [qid, g] of Object.entries(gold)) {
  const gs = g.relevantDomains
  if (!gs || gs.length === 0) continue
  const per = runs.map((run) => {
    try {
      const q = runQuery(run, qid)
      const rawPool = q?.response?.results
      const pool = Array.isArray(rawPool) ? (rawPool as Array<Record<string, unknown>>) : []
      if (pool.length === 0) return null
      const ctx = buildCtx(String(q?.query?.query ?? qid), q?.query?.topic, 10)
      // BASELINE: re-rank with the pre-Wave-1-equivalent config, expansion OFF
      setExpansion(false)
      const before = computeNdcg(rerank(pool, ctx, BASELINE_TITLE_WEIGHT).slice(0, 10) as never, gs, 10)
      // AFTER: re-rank with the lever config under test (expansion per CLI)
      setExpansion(EXPANSION_ON)
      const after = computeNdcg(rerank(pool, ctx, titleWeightFor(ctx.queryType)).slice(0, 10) as never, gs, 10)
      return { before, after }
    } catch {
      return null
    }
  })
  const valid = per.filter((p): p is { before: number; after: number } => p !== null)
  if (valid.length === 0) continue
  const before = valid.length === 2 ? median(valid[0].before, valid[1].before) : valid[0].before
  const after = valid.length === 2 ? median(valid[0].after, valid[1].after) : valid[0].after
  if (Math.abs(after - before) > 1e-9) {
    deltas[qid] = { before, after, perRun: valid.map((p) => p.after - p.before), tag: '' }
  }
}

const tagById = new Map<string, string>()
for (const run of runs) {
  for (const q of run.results ?? []) {
    if (q.query?.id && !tagById.has(q.query.id)) {
      tagById.set(q.query.id, (q.query as { tags?: string[] }).tags?.join('+') ?? '')
    }
  }
}

const rows = Object.entries(deltas).map(([qid, d]) => ({ qid, ...d, tag: tagById.get(qid) ?? '' }))
let sumBefore = 0,
  sumAfter = 0
for (const r of rows) {
  sumBefore += r.before
  sumAfter += r.after
}
const n = rows.length
console.log(`affected queries: ${n}/${Object.keys(gold).length}`)
if (n > 0) {
  console.log(
    `affected-only mean NDCG: before ${(sumBefore / n).toFixed(4)} → after ${(sumAfter / n).toFixed(4)} (Δ ${((sumAfter - sumBefore) / n).toFixed(4)})`,
  )
} else {
  console.log('no affected queries — the config under test equals the baseline')
  process.exit(0)
}

// By-tag aggregation (sum of per-query deltas, like the S-series convention).
const byTag = new Map<string, { before: number; after: number }>()
for (const r of rows) {
  const t = r.tag || '(untagged)'
  const cur = byTag.get(t) ?? { before: 0, after: 0 }
  cur.before += r.before
  cur.after += r.after
  byTag.set(t, cur)
}
console.log('\n=== by-tag cumulative Δ (sum of per-query NDCG) ===')
for (const [t, v] of [...byTag.entries()].sort((a, b) => b[1].after - b[1].before - (a[1].after - a[1].before))) {
  const d = v.after - v.before
  if (Math.abs(d) > 0.001)
    console.log(`${t.padEnd(28)} ${v.before.toFixed(3)} → ${v.after.toFixed(3)}  Δ${d >= 0 ? '+' : ''}${d.toFixed(4)}`)
}

// Worst losses (regression risk) and best gains
const losses = [...rows].sort((a, b) => a.after - a.before - (b.after - b.before))
const gains = [...rows].sort((a, b) => b.after - b.before - (a.after - a.before))
console.log('\n=== worst LOSSES (must review) ===')
for (const r of losses.slice(0, 12)) {
  console.log(
    `${r.qid.padEnd(14)} ${r.before.toFixed(3)}→${r.after.toFixed(3)} Δ${(r.after - r.before).toFixed(4)}  [${r.tag}]`,
  )
}
console.log('\n=== best GAINS ===')
for (const r of gains.slice(0, 12)) {
  console.log(
    `${r.qid.padEnd(14)} ${r.before.toFixed(3)}→${r.after.toFixed(3)} Δ+${(r.after - r.before).toFixed(4)}  [${r.tag}]`,
  )
}
