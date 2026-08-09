/**
 * S60: detect NDCG drift caused by gold/rules edits over STORED pools.
 *
 * S54 made gold edits immediately visible to eval analysis: analyze-429-loss
 * and the S58 regression gate recompute NDCG from the saved pools + CURRENT
 * gold. The stored `ranking.ndcgAt10` field in a run file is the recompute
 * under the gold in effect WHEN THE RUN WAS SAVED — S54 verified
 * recompute == stored across 1,500 query-runs (Δ 0.000000), because the
 * runner scores its own pool at eval time. Therefore, for a per-run file:
 *
 *   drift(query) = computeNdcg(pool, CURRENT gold) - stored ranking
 *
 * is PURELY the gold/rules change since the run was saved — no sampling
 * noise, and (unlike the median report) no median-of-N vs representative-pool
 * aggregation mismatch. Run this right after editing eval/gold-standards.json
 * to see which queries would move BEFORE spending ~60 minutes on an
 * eval:median re-run, and to decide whether a baseline refresh is needed.
 *
 * Sources: eval/results/run-*.json (per-run — exact). Falls back to
 * eval/results/latest.json when no run-N files exist (single-run CI; the
 * stored == recompute invariant holds there too).
 *
 * Usage:
 *   npx tsx scripts/detect-gold-drift.ts
 *   npx tsx scripts/detect-gold-drift.ts --gold /tmp/gold-whatif.json   # what-if
 *   npx tsx scripts/detect-gold-drift.ts --threshold 0.05 --json
 */
import { readFileSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { computeNdcg, computeRankingMetrics } from '../eval/metrics'
import type { SearchResult } from '../src/types'

/** Minimal shape of a run-file result row (loose on purpose — artifacts vary). */
export interface RunEntry {
  query?: { id?: string }
  ranking?: { ndcgAt10?: unknown }
  response?: { results?: unknown }
}

export interface QueryDrift {
  id: string
  /** Stored ranking median across runs (the eval-time gold's recompute). Null
   *  when the query had no gold when the run was saved (gold added later). */
  before: number | null
  /** Recomputed median under the CURRENT gold (0 when gold was removed). */
  after: number
  /** median(after − before) per run; null when `before` is null (new gold). */
  medianDelta: number | null
  /** Number of runs with a computable pair (pool + at least one side). */
  runs: number
  /** CURRENT gold domains for the query. */
  gold: string[]
  /** Top-10 pool slots matching the current gold (why it moved). */
  hits: number
}

export interface GoldDriftReport {
  resultsSource: string
  runCount: number
  queryCount: number
  threshold: number
  /** |medianDelta| >= threshold with both sides known. */
  drifted: QueryDrift[]
  /** Query gained gold after the run (before was unscored). */
  newGold: QueryDrift[]
  /** Query lost ALL gold after the run (after is 0). */
  goldRemoved: QueryDrift[]
  /** Mean of drifted medianDelta — aggregate direction of the edit. */
  netMedianDelta: number
  /** Drifted queries whose |medianDelta| >= 0.05. NOTE (S58): the gate itself
   *  is gold-robust — it recomputes both sides under the current gold, so a
   *  gold edit does NOT trigger gate regressions. This list flags queries
   *  whose RECORDED NDCG signal (docs/10, aggregates) shifts enough to matter
   *  for a baseline refresh decision. */
  wouldFlipGate: QueryDrift[]
}

/** Sort-copy median (averages the two middle values on even length). */
function median(vals: number[]): number {
  if (vals.length === 0) return 0
  const s = [...vals].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

/** NDCG regression threshold of the S58 gate (diffBaseline, −5%). */
export const GATE_NDCG_THRESHOLD = 0.05

/**
 * Pure drift computation over per-run result arrays + a gold map.
 *
 * @param runResults  One array of RunEntry per run file (same query set).
 * @param gold         CURRENT gold map (queryId → relevantDomains).
 * @param threshold    |median delta| at/above which a query is "drifted".
 */
export function computeGoldDrift(
  runResults: RunEntry[][],
  gold: Record<string, string[]>,
  threshold = 0.01,
): Omit<GoldDriftReport, 'resultsSource'> {
  const ids = new Set<string>()
  for (const run of runResults) {
    for (const r of run) {
      if (r.query?.id) ids.add(r.query.id)
    }
  }

  const drifted: QueryDrift[] = []
  const newGold: QueryDrift[] = []
  const goldRemoved: QueryDrift[] = []

  for (const id of ids) {
    const currentGold = gold[id] ?? []
    const befores: number[] = []
    const afters: number[] = []
    const deltas: number[] = []
    const hitss: number[] = []
    let runs = 0
    let anyPool = false

    for (const run of runResults) {
      const r = run.find((x) => x.query?.id === id)
      if (!r) continue
      const pool = Array.isArray(r.response?.results) ? (r.response.results as SearchResult[]) : undefined
      if (!pool || pool.length === 0) continue // error run — no pool to recompute
      anyPool = true
      const storedRaw = r.ranking?.ndcgAt10
      const stored = typeof storedRaw === 'number' && Number.isFinite(storedRaw) ? storedRaw : null

      const after = computeNdcg(pool, currentGold, 10)
      afters.push(after)
      // Median across runs for consistency with the delta aggregation.
      hitss.push(computeRankingMetrics(pool, currentGold)?.relevantHits ?? 0)
      if (stored !== null) {
        befores.push(stored)
        deltas.push(after - stored)
      }
      runs++
    }
    if (!anyPool) continue // no run carried a pool — cannot recompute

    const after = median(afters)
    const before = befores.length > 0 ? median(befores) : null
    const medianDelta = deltas.length > 0 ? median(deltas) : null
    const entry: QueryDrift = {
      id,
      before,
      after,
      medianDelta,
      runs,
      gold: currentGold,
      hits: hitss.length > 0 ? Math.round(median(hitss)) : 0,
    }

    if (currentGold.length === 0 && before !== null) {
      // All gold for the query was removed — after is 0 by construction.
      goldRemoved.push(entry)
    } else if (before === null && currentGold.length > 0) {
      // Gold was added after the run — no "before" to compare against.
      newGold.push(entry)
    } else if (medianDelta !== null && Math.abs(medianDelta) >= threshold) {
      drifted.push(entry)
    }
  }

  const sortBy = (a: QueryDrift, b: QueryDrift): number => Math.abs(b.medianDelta ?? 0) - Math.abs(a.medianDelta ?? 0)
  drifted.sort(sortBy)
  newGold.sort((a, b) => b.after - a.after)
  goldRemoved.sort((a, b) => (a.before ?? 0) - (b.before ?? 0))

  const netMedianDelta = drifted.length > 0 ? drifted.reduce((s, d) => s + (d.medianDelta ?? 0), 0) / drifted.length : 0
  const wouldFlipGate = drifted.filter((d) => Math.abs(d.medianDelta ?? 0) >= GATE_NDCG_THRESHOLD)

  return {
    runCount: runResults.length,
    queryCount: ids.size,
    threshold,
    drifted,
    newGold,
    goldRemoved,
    netMedianDelta,
    wouldFlipGate,
  }
}

/** Load all eval/results/run-N.json files (or latest.json when none exist). */
function loadRunResults(resultsDir: string): { source: string; runs: RunEntry[][] } {
  let runFiles: string[] = []
  try {
    runFiles = readdirSync(resultsDir)
      .filter((f) => /^run-\d+\.json$/.test(f))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
  } catch {
    return { source: 'none', runs: [] } // missing/empty dir — nothing to compare
  }
  if (runFiles.length > 0) {
    const runs = runFiles.map((f) => {
      const raw = JSON.parse(readFileSync(resolve(resultsDir, f), 'utf-8')) as {
        report?: { results?: RunEntry[] }
        results?: RunEntry[]
      }
      return raw.report?.results ?? raw.results ?? []
    })
    return { source: `${runFiles.join(', ')}`, runs }
  }
  try {
    const raw = JSON.parse(readFileSync(resolve(resultsDir, 'latest.json'), 'utf-8')) as {
      report?: { results?: RunEntry[] }
      results?: RunEntry[]
    }
    return { source: 'latest.json', runs: [raw.report?.results ?? raw.results ?? []] }
  } catch {
    return { source: 'none', runs: [] }
  }
}

/** Load a gold map from a gold-standards.json file (skips `_`-prefixed keys).
 *  Throws when the file is missing/unreadable — callers must distinguish that
 *  (a footgun: silently returning {} would classify every gold-bearing query
 *  as "gold removed"). */
export function loadGoldFile(path: string): Record<string, string[]> {
  const data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, { relevantDomains?: string[] }>
  const result: Record<string, string[]> = {}
  for (const [key, val] of Object.entries(data)) {
    if (!key.startsWith('_') && val.relevantDomains) result[key] = val.relevantDomains
  }
  return result
}

export interface DriftOptions {
  goldFile?: string
  resultsDir?: string
  threshold?: number
}

/** I/O entry: load artifacts, compute drift, attach the source label. */
export function analyzeGoldDrift(opts: DriftOptions = {}): GoldDriftReport {
  const resultsDir = opts.resultsDir ?? resolve(process.cwd(), 'eval', 'results')
  const goldFile = opts.goldFile ?? resolve(process.cwd(), 'eval', 'gold-standards.json')
  const threshold = opts.threshold ?? 0.01
  let gold: Record<string, string[]>
  try {
    gold = loadGoldFile(goldFile)
  } catch {
    console.error(`::warning::detect-gold-drift: cannot read gold file ${goldFile} — treating gold as empty`)
    gold = {}
  }
  const { source, runs } = loadRunResults(resultsDir)
  return { ...computeGoldDrift(runs, gold, threshold), resultsSource: source }
}

function main(): void {
  const args = process.argv.slice(2)
  const json = args.includes('--json')
  let goldFile: string | undefined
  let resultsDir: string | undefined
  let threshold = 0.01
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--gold') goldFile = args[++i]
    else if (args[i] === '--results-dir') resultsDir = args[++i]
    else if (args[i] === '--threshold') threshold = Number(args[++i]) || 0.01
    else if (args[i] === '--help') {
      console.log(
        'Usage: npx tsx scripts/detect-gold-drift.ts [--gold <path>] [--results-dir <dir>] [--threshold <n>] [--json]',
      )
      console.log('  Detects NDCG drift caused by gold/rules edits: recomputes the saved pools')
      console.log('  under the CURRENT gold and diffs against the stored ranking (the eval-time')
      console.log('  recompute). Run after editing eval/gold-standards.json to preview the move.')
      console.log('  Workflow: edit gold-standards.json → npm run eval:drift → review drifted queries,')
      console.log('  then decide whether to refresh the baseline (eval:median:save). The S58 gate')
      console.log('  is gold-robust, so a gold edit alone does not fail CI.')
      process.exit(0)
    }
  }

  const report = analyzeGoldDrift({ goldFile, resultsDir, threshold })

  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  const goldLabel = goldFile ?? resolve(process.cwd(), 'eval', 'gold-standards.json')
  console.log(`── Gold drift detection (S60) ──────────────────────────────`)
  console.log(`Gold file : ${goldLabel}`)
  console.log(
    `Results   : eval/results/${report.resultsSource} (${report.runCount} run(s) × ${report.queryCount} queries)`,
  )
  console.log(`Threshold : ${report.threshold}`)

  const total = report.drifted.length + report.newGold.length + report.goldRemoved.length
  if (total === 0) {
    console.log(`\nDrift: 0 queries — the stored pools recompute to the same NDCG under the`)
    console.log(`  current gold. No gold/rules change since the run was saved (expected).`)
    return
  }

  console.log(`\nDrifted (|median Δ| >= ${report.threshold}): ${report.drifted.length}`)
  for (const d of report.drifted) {
    console.log(
      `  ${d.id.padEnd(14)} ${d.before?.toFixed(4) ?? '  n/a '} → ${d.after.toFixed(4)}  ` +
        `Δ ${(d.medianDelta ?? 0) >= 0 ? '+' : ''}${(d.medianDelta ?? 0).toFixed(4)}  ` +
        `runs ${d.runs}  hits ${d.hits}  gold [${d.gold.join(', ') || '∅'}]`,
    )
  }
  if (report.goldRemoved.length > 0) {
    console.log(`\nGold REMOVED (after → 0): ${report.goldRemoved.length}`)
    for (const d of report.goldRemoved) {
      console.log(`  ${d.id.padEnd(14)} ${d.before?.toFixed(4) ?? '  n/a '} → 0.0000  runs ${d.runs}`)
    }
  }
  if (report.newGold.length > 0) {
    console.log(`\nGold ADDED after the run (no before): ${report.newGold.length}`)
    for (const d of report.newGold) {
      console.log(`  ${d.id.padEnd(14)}    n/a  → ${d.after.toFixed(4)}  runs ${d.runs}  gold [${d.gold.join(', ')}]`)
    }
  }
  console.log(
    `\nNet NDCG Δ (mean of drifted medians): ${report.netMedianDelta >= 0 ? '+' : ''}${report.netMedianDelta.toFixed(4)}`,
  )
  console.log(`Gate-significant NDCG moves (|Δ| >= ${GATE_NDCG_THRESHOLD}): ${report.wouldFlipGate.length}`)
  for (const d of report.wouldFlipGate) {
    console.log(`  ${d.id.padEnd(14)} Δ ${(d.medianDelta ?? 0) >= 0 ? '+' : ''}${(d.medianDelta ?? 0).toFixed(4)}`)
  }
  console.log(`\nNote: the S58 gate recomputes both sides under the current gold, so a gold edit`)
  console.log(`  does NOT fail CI — the moves above shift the RECORDED NDCG signal (docs/10,`)
  console.log(`  aggregates), which is why a baseline refresh may still be warranted.`)
}

// Run only when executed directly (not when imported by unit tests).
const isDirectRun =
  process.argv[1] && resolve(process.argv[1]) === resolve(process.cwd(), 'scripts', 'detect-gold-drift.ts')
if (isDirectRun) main()
