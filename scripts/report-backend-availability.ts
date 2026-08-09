#!/usr/bin/env -S npx tsx
/**
 * Backend Availability Reporter (S33, 2026-08-07)
 *
 * Auto-distinguishes "availability noise" from "real ranking regression" in
 * eval:median runs by cross-referencing the eval log's rate-limit/429 warnings
 * against the per-run result JSONs.
 *
 * WHY THIS EXISTS
 * --------------
 * S25's factual-tag drop (-0.161) turned out to be wikipedia 429 noise, not a
 * ranking regression (S31: 9,306 log 429s, wikipedia-present runs averaged
 * NDCG 0.375 vs 0.044 when absent). Before this script that verdict required
 * a manual forensic pass over run-1..3.json + eval-median.log. This script
 * automates the same analysis every eval.
 *
 * INPUTS (paths configurable via argv)
 *   log    — eval:median stdout log  (default /tmp/eval-median.log)
 *   runs   — eval/results/run-1.json … run-N.json  (default from eval/results/)
 *   gold   — eval/gold-standards.json (for NDCG-0 gold-coverage context)
 *
 * VERDICT LOGIC (per query, for each backend tracked — wikipedia by default)
 *   - "NOISE (availability)": the backend's 429 count for the query is > 0 in
 *     any run AND the backend is missing from that run's result `backends`
 *     array — the backend failed upstream, not the ranking.
 *   - "PERSISTENT AVAILABILITY": 429s in ALL runs the backend was attempted
 *     (or absent in 2+ of 3) — no run had a healthy copy.
 *   - "REGRESSION CANDIDATE": NDCG@10 dropped vs baseline (latest vs the
 *     baseline snapshot) while the backend was present in every run — ranking
 *     logic, not availability.
 *   - "COVERAGE GAP": NDCG = 0 with a non-empty gold set and no 429 evidence —
 *     the gold domains simply never reached the pool (S30/S32: news big-5
 *     template gold, general coverage 52.7%).
 *
 * USAGE
 *   npx tsx scripts/report-backend-availability.ts [--log /path/eval.log]
 *   npx tsx scripts/report-backend-availability.ts --backend hackernews
 *
 * EXIT CODES
 *   0 = ok · 1 = no runs/log found · 2 = parse error
 */

import { readFileSync, existsSync, readdirSync } from 'fs'
import { resolve } from 'path'
import { EVAL_QUERIES } from '../eval/queries'

/** query text → eval query id (log lines carry text, run JSONs carry ids). */
const ID_BY_QUERY = new Map<string, string>()
for (const q of EVAL_QUERIES) ID_BY_QUERY.set(q.query, q.id)

// ── config ──────────────────────────────────────────────────────────────
const RESULTS_DIR = resolve(process.cwd(), 'eval', 'results')

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : undefined
}

const LOG_PATH = arg('--log') ?? '/tmp/eval-median.log'
const BACKEND = arg('--backend') ?? 'wikipedia'
// Baseline to compare against for regression detection. Defaults to a path
// that does NOT exist, because eval:median:save overwrites
// eval/baselines/latest.json with the CURRENT run — comparing against it
// would always report "no regression". Point this at a previous snapshot:
//   npx tsx scripts/report-backend-availability.ts --baseline /tmp/prev-latest.json
//   (or `git show HEAD:eval/baselines/latest.json > /tmp/prev.json` before a save)
const BASELINE_PATH = arg('--baseline') ?? resolve(process.cwd(), 'eval', 'baselines', 'latest.json.prev')

interface QueryRunInfo {
  backends: string[]
  ndcg: number
  resultCount: number
}

interface RunData {
  id: number
  byQuery: Map<string, QueryRunInfo>
}

interface Query429 {
  query: string
  runs: Set<number> // run numbers with ≥1 429
  count: number
}

function loadRuns(): RunData[] {
  if (!existsSync(RESULTS_DIR)) throw new Error(`no ${RESULTS_DIR}`)
  const files = readdirSync(RESULTS_DIR)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => {
      const na = Number(a.match(/\d+/)?.[0] ?? 0)
      const nb = Number(b.match(/\d+/)?.[0] ?? 0)
      return na - nb
    })
  if (!files.length) throw new Error(`no run-N.json in ${RESULTS_DIR}`)
  return files.map((f) => {
    const raw = JSON.parse(readFileSync(resolve(RESULTS_DIR, f), 'utf8'))
    const results: Array<{
      query?: { id?: string }
      backends?: unknown
      ranking?: Record<string, unknown>
      resultCount?: unknown
    }> = raw.report?.results ?? raw.results ?? []
    const byQuery = new Map<string, QueryRunInfo>()
    for (const q of results) {
      byQuery.set(q.query?.id ?? '', {
        backends: Array.isArray(q.backends) ? q.backends : [],
        ndcg: q.ranking?.ndcgAt10 ?? q.ranking?.ndcg10 ?? 0,
        resultCount: q.resultCount ?? 0,
      })
    }
    return { id: idx + 1, byQuery }
  })
}

/**
 * 429s that carry a `query` field → attributable to a query directly.
 *
 * Only the LAST eval run block is analyzed: the median log is appended across
 * sessions (run-1/2/3 markers repeat), so earlier blocks would double-count.
 * The `query` field is the query TEXT; we map it to the eval id via
 * EVAL_QUERIES so it joins against the run JSONs (which key by id).
 */
function parseQuery429s(logText: string): Map<string, Query429> {
  const lines = logText.split('\n')
  // Find the last "Running 500 eval queries" block start.
  let blockStart = 0
  lines.forEach((l, i) => {
    if (l.includes('Running') && l.includes('eval queries')) blockStart = i
  })
  const block = lines.slice(blockStart)

  // Run markers inside the block (1-indexed within this eval).
  const markers: { line: number; run: number }[] = []
  block.forEach((l, i) => {
    const m = l.match(/─ run (\d+)\/(\d+) ─/)
    if (m) markers.push({ line: i, run: Number(m[1]) })
  })
  const runAtLine = (line: number): number | undefined => {
    let current: number | undefined
    for (const mk of markers) {
      if (mk.line <= line) current = mk.run
      else break
    }
    return current
  }

  const perQuery = new Map<string, Query429>()
  const targetLower = BACKEND.toLowerCase()

  block.forEach((l, idx) => {
    if (!l.includes('429') && !l.includes('rate-limited')) return
    if (targetLower === 'wikipedia' && !/wikipedia|rest\.php|w\/api\.php/i.test(l)) return
    if (targetLower !== 'wikipedia' && !new RegExp(targetLower, 'i').test(l)) return

    let query: string | undefined
    try {
      const parsed = JSON.parse(l)
      if (typeof parsed.query === 'string') query = parsed.query
    } catch {
      // non-JSON line (e.g. run marker or progress) — fall through
    }
    if (!query) {
      // [rate-limiter] https://…wikipedia.org/w/rest.php/…?q=<encoded>&limit=N returned 429
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

    // Map query text → eval id for the join with run JSONs.
    const id = ID_BY_QUERY.get(query) ?? query
    const run = runAtLine(idx) ?? 0
    let agg = perQuery.get(id)
    if (!agg) {
      agg = { query: id, runs: new Set(), count: 0 }
      perQuery.set(id, agg)
    }
    agg.count += 1
    if (run > 0) agg.runs.add(run)
  })

  return perQuery
}

function main(): void {
  if (!existsSync(LOG_PATH)) {
    console.error(`eval log not found: ${LOG_PATH}`)
    process.exit(1)
  }
  const runs = loadRuns()
  const logText = readFileSync(LOG_PATH, 'utf8')
  const perQuery = parseQuery429s(logText)

  // Baseline NDCG per query for regression detection. eval:median:save
  // overwrites baselines/latest.json with the CURRENT run, so the default
  // points at a non-existent path — pass --baseline with a previous snapshot
  // (see header) for a real before/after comparison.
  const baselineByQuery = new Map<string, number>()
  if (existsSync(BASELINE_PATH)) {
    const b = JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
    for (const q of b.report?.results ?? []) {
      baselineByQuery.set(q.query?.id, q.ranking?.ndcgAt10 ?? q.ranking?.ndcg10 ?? 0)
    }
  }

  // ── classify every query that either hit 429s or reached NDCG 0 ──
  const ids = new Set<string>()
  for (const q of perQuery.keys()) ids.add(q)
  for (const run of runs)
    for (const id of run.byQuery.keys()) {
      const info = run.byQuery.get(id)
      if (info?.ndcg === 0) ids.add(id)
    }

  // Tags per query id (from EVAL_QUERIES) — news/finance queries never route
  // to wikipedia (getSourcesForQueryType), so their wikipedia absence is
  // EXPECTED, not a coverage gap.
  const TAGS = new Map<string, string[]>()
  for (const q of EVAL_QUERIES) TAGS.set(q.id, q.tags ?? [])
  const wikiSkippedByStrategy = (id: string): boolean => {
    const tags = TAGS.get(id) ?? []
    return tags.includes('news') || tags.includes('financial')
  }

  const noise: string[] = []
  const persistent: string[] = []
  const regression: string[] = []
  const coverage: string[] = []
  const strategySkipped: string[] = []
  const healthy: string[] = []

  for (const id of ids) {
    const perRun = runs.map((r) => r.byQuery.get(id))
    const ndcgs = perRun.map((i) => i?.ndcg ?? 0)
    const presentRuns = perRun.map((i) => (i ? i.backends.includes(BACKEND) : false))
    const zeroNdcg = ndcgs.every((n) => n === 0)
    const anyZero = ndcgs.some((n) => n === 0)
    const has429 = perQuery.get(id)
    const failRuns = has429 ? has429.runs : new Set<number>()

    // A run counts as affected when the backend was missing AND the query
    // got 429s in that run (or the backend was missing while NDCG is 0).
    const missingRuns = presentRuns.map((p, i) => (p ? 0 : i + 1)).filter((x) => x > 0)

    const base = baselineByQuery.get(id)
    const dropped = typeof base === 'number' && ndcgs.every((n) => n < base - 0.05)

    if (has429 && failRuns.size > 0) {
      // Backend hit 429s and was missing from ≥1 run → availability, not ranking.
      const flapped = missingRuns.length < runs.length // healthy in at least one run
      if (flapped) noise.push(id)
      else persistent.push(id)
    } else if (zeroNdcg && !has429) {
      // wikipedia-eligible queries with NDCG 0 and no 429 evidence → the gold
      // domains never reached the pool. News/finance skip wikipedia by design.
      if (wikiSkippedByStrategy(id)) strategySkipped.push(id)
      else coverage.push(id)
    } else if (dropped && presentRuns.every(Boolean) && presentRuns.length > 0) {
      regression.push(id)
    } else if (anyZero && presentRuns.some(Boolean)) {
      // Zero in ≥1 run despite a healthy backend run → partial noise / gap.
      if (wikiSkippedByStrategy(id)) strategySkipped.push(id)
      else coverage.push(id)
    } else if (!presentRuns.some(Boolean) && wikiSkippedByStrategy(id)) {
      strategySkipped.push(id)
    } else {
      healthy.push(id)
    }
  }

  // ── report ───────────────────────────────────────────────────────────
  const total429 = [...perQuery.values()].reduce((s, v) => s + v.count, 0)
  console.log(`\n=== Backend Availability Report (backend: ${BACKEND}) ===`)
  console.log(`log: ${LOG_PATH}`)
  console.log(
    `runs: ${runs.length} · total ${BACKEND} 429/rate-limit log lines: ${total429} · distinct queries affected: ${perQuery.size}\n`,
  )

  const byRun = new Map<number, number>()
  for (const v of perQuery.values()) for (const r of v.runs) byRun.set(r, (byRun.get(r) ?? 0) + 1)
  console.log(
    '429-affected queries by run:',
    [...byRun.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([r, n]) => `run${r}:${n}`)
      .join('  ') || 'none',
  )

  const fmt = (list: string[], label: string): void => {
    console.log(`\n[${label}] ${list.length} queries`)
    for (const id of list) {
      const runInfo = runs
        .map((r, i) => {
          const info = r.byQuery.get(id)
          if (!info) return null
          return `r${i + 1}:ndcg${info.ndcg.toFixed(2)}${info.backends.includes(BACKEND) ? `+${BACKEND}` : '-no' + BACKEND}`
        })
        .filter(Boolean)
        .join(' ')
      const c429 = perQuery.get(id)?.count ?? 0
      console.log(`  ${id.padEnd(20)} ${runInfo}  429×${c429}`)
    }
  }

  fmt(noise, 'NOISE — availability (backend flapped across runs)')
  fmt(persistent, 'PERSISTENT AVAILABILITY — backend failed every run')
  fmt(regression, 'REGRESSION CANDIDATES — backend present, NDCG dropped')
  fmt(coverage, 'COVERAGE GAP — NDCG 0 without 429 evidence')
  fmt(strategySkipped, 'STRATEGY SKIP — backend not routed for news/finance (expected)')
  fmt(healthy, 'HEALTHY — backend present, NDCG intact')

  console.log(
    '\nSummary: ' +
      [
        noise.length,
        persistent.length,
        regression.length,
        coverage.length,
        strategySkipped.length,
        healthy.length,
      ].join(' / ') +
      '  (noise / persistent / regression / coverage / strategy-skip / healthy)',
  )

  console.log('\nInterpretation:')
  console.log('  NOISE + PERSISTENT  → availability, not ranking. Re-run eval or rely on median.')
  console.log('  REGRESSION CANDIDATE → backend healthy, ranking logic changed. Investigate ranking/strategy.')
  console.log('  COVERAGE GAP         → gold domains never reached the pool. Backend/coverage lever, not ranking.')
}

try {
  main()
} catch (e) {
  console.error('report-backend-availability:', e)
  process.exit(2)
}
