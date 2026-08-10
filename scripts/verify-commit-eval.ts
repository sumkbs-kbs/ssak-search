#!/usr/bin/env -S npx tsx
/**
 * verify-commit-eval.ts — offline eval-gate re-verification for a commit
 * worktree (pre-flight companion to scripts/verify-commits-ci.sh --eval).
 *
 * A live `npm run eval:median:ci` takes ~60 min, which is not feasible per
 * commit. But every median:save run persists eval/results/run-1..N.json with
 * the FULL response pools (response.results[]), so the gate can be replayed
 * OFFLINE from those artifacts:
 *
 *   1. Load eval/results/run-*.json (any N >= 1).
 *   2. Rebuild the median report with computeMedianReport() — the same
 *      aggregation eval/index.ts uses (S81 median-NDCG representative pick).
 *   3. Load eval/baselines/latest.json and run diffBaselineStabilized()
 *      (G2/S73) — for a single run file it falls back to diffBaseline().
 *
 * Exit codes (CI-gate contract for verify-commits-ci.sh):
 *   0  PASS — artifacts present and no regressions vs baseline (or no
 *             baseline exists to compare against)
 *   1  FAIL — regressions detected
 *   2  SKIP — no run-*.json artifacts in this commit (the commit predates
 *             median saves or its eval artifacts were not committed)
 *   3  ERROR — artifacts present but unreadable/inconsistent
 *
 * Usage (run from the WORKTREE — resolves eval/ relative to cwd, so the
 * artifact layout is exactly the commit's):
 *   npx tsx scripts/verify-commit-eval.ts            # inside a worktree
 *   npx tsx scripts/verify-commit-eval.ts <dir>      # explicit eval dir
 *
 * NOTE: gold-standards.json is loaded from the worktree (cwd), so gold
 * edits made AFTER the commit are NOT retro-applied. Data provenance: the
 * ARTIFACTS (run-*.json, baselines/, gold-standards.json) are the commit's
 * (resolved via cwd = the worktree), while the gate ALGORITHM (median.ts /
 * baseline.ts / metrics.ts) comes from the CURRENT checkout via relative
 * import — S54/S58-style re-scoring of historical artifacts under current
 * rules (the commit's own copy of the gate code, if any, is not consulted).
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EvalReport, EvalQuery, EvalBaseline, RegressionDiff } from '../eval/types'
import { computeMedianReport } from '../eval/median'
import { diffBaselineStabilized, diffBaseline } from '../eval/baseline'
import { loadGoldStandards } from '../eval/metrics'

export interface GateOutcome {
  status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'
  detail: string
}

export interface GateOptions {
  /** Gold map override for tests (defaults to loadGoldStandards() from cwd). */
  gold?: Record<string, string[]>
}

/** Load run-*.json artifacts from `dir` (must contain run-N.json files). */
export function loadRunFiles(dir: string): { reports: EvalReport[]; queries: EvalQuery[]; files: string[] } {
  const files = readdirSync(dir)
    .filter((f) => /^run-\d+\.json$/.test(f))
    .sort((a, b) => {
      const ma = a.match(/^run-(\d+)\.json$/)
      const mb = b.match(/^run-(\d+)\.json$/)
      const na = ma ? parseInt(ma[1], 10) : 0
      const nb = mb ? parseInt(mb[1], 10) : 0
      return na - nb
    })
  if (files.length === 0) {
    throw new Error('no run-*.json artifacts found')
  }
  const reports = files.map((f) => {
    const raw = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as { report?: EvalReport } | EvalReport
    // Stored shape: { report: EvalReport }. Accept a bare EvalReport too.
    const rep = (raw as { report?: EvalReport }).report ?? (raw as EvalReport)
    if (!rep || !Array.isArray(rep.results)) throw new Error(`${f}: not an EvalReport`)
    return rep
  })
  // Query set: union across ALL runs' results so a query dropped from run-1
  // (runner error) is not silently excluded from the median aggregation
  // (live eval uses the full EVAL_QUERIES set; run files embed full
  // EvalQuery objs, so the union reconstructs it).
  const seen = new Map<string, EvalQuery>()
  for (const rep of reports) {
    for (const r of rep.results) seen.set(r.query.id, r.query)
  }
  const queries = [...seen.values()]
  return { reports, queries, files }
}

/** Load the worktree's own baseline snapshot (eval/baselines/latest.json). */
export function loadBaselineFromWorktree(evalDir: string): EvalBaseline | null {
  try {
    // loadBaseline() from eval/baseline.ts resolves via import.meta.url (the
    // SCRIPT's location), NOT cwd — for a worktree run we must load the
    // WORKTREE's baseline file explicitly.
    const file = join(evalDir, 'baselines', 'latest.json')
    if (!existsSync(file)) return null
    const raw = JSON.parse(readFileSync(file, 'utf-8')) as {
      timestamp?: string
      report?: EvalReport
    }
    if (!raw.report) return null
    return { timestamp: raw.timestamp ?? '', report: raw.report }
  } catch {
    return null
  }
}

/**
 * Replay the eval regression gate from stored artifacts under `evalDir`
 * (the directory containing results/ + baselines/). Pure and injectable —
 * exported for unit tests; the CLI entry point calls it with the resolved
 * eval dir.
 */
export function runGate(evalDir: string, opts: GateOptions = {}): GateOutcome {
  const resultsDir = join(evalDir, 'results')
  if (!existsSync(evalDir) || !existsSync(resultsDir)) {
    return {
      status: 'SKIP',
      detail: 'no eval/results in this commit (artifacts not committed or commit predates median saves)',
    }
  }

  let reports: EvalReport[]
  let queries: EvalQuery[]
  let files: string[]
  try {
    ;({ reports, queries, files } = loadRunFiles(resultsDir))
  } catch (err) {
    return { status: 'ERROR', detail: `could not load run-*.json: ${(err as Error).message}` }
  }

  // Gold is loaded from the WORKTREE (cwd) — the commit's own gold — unless a
  // test injects it.
  const gold = opts.gold ?? loadGoldStandards()

  let medianReport: EvalReport
  try {
    medianReport = computeMedianReport(reports, queries, gold)
  } catch (err) {
    return { status: 'ERROR', detail: `median aggregation failed: ${(err as Error).message}` }
  }

  // Baseline is loaded from the WORKTREE's eval/baselines (commit's snapshot).
  // Compare: >=2 run files → G2 stabilized gate (eval/index.ts contract);
  // single run file → single-run diffBaseline (matches eval:ci --runs 1).
  let regressions: RegressionDiff[] = []
  let baselineTimestamp: string | null = null // A commit WITH run artifacts but WITHOUT a baseline file reports PASS
  // with `baseline: none` — parity with the live gate (no baseline → no
  // regressions). The detail line surfaces it, so an artifact-bearing commit
  // that has never been baselined is visibly a weak signal, not a false fail.
  const baseline = loadBaselineFromWorktree(evalDir)
  if (baseline) {
    baselineTimestamp = baseline.timestamp
    regressions =
      reports.length >= 2 ? diffBaselineStabilized(reports, baseline, gold) : diffBaseline(medianReport, baseline, gold)
  }

  const summary = [
    `artifacts: ${files.join(', ')}`,
    `runs: ${reports.length}`,
    `queries: ${medianReport.totalQueries}`,
    `passRate: ${(medianReport.passRate * 100).toFixed(1)}%`,
    `NDCG@10: ${medianReport.ranking?.avgNdcgAt10 !== undefined ? medianReport.ranking.avgNdcgAt10.toFixed(4) : 'n/a'}`,
    `baseline: ${baselineTimestamp ?? 'none'}`,
    `regressions: ${regressions.length}`,
  ]
  const detail = summary.join(' · ')

  if (regressions.length > 0) {
    const worst = regressions
      .slice(0, 8)
      .map((d) => `${d.queryId}:${d.metric}(${d.delta})`)
      .join(' ')
    return { status: 'FAIL', detail: `${detail} — ${worst}` }
  }
  return { status: 'PASS', detail }
}

// ── CLI entry ─────────────────────────────────────────────────────────────
// Only run as the entry point (import.meta.url guard keeps unit tests from
// executing the gate on import).
if (import.meta.url === 'file://' + resolve(process.argv[1] ?? '')) {
  const arg = process.argv[2]
  const evalDir = arg ? resolve(process.cwd(), arg) : join(process.cwd(), 'eval')
  const outcome = runGate(evalDir)
  if (outcome.status === 'FAIL') {
    console.error(`[EVAL GATE] FAIL — ${outcome.detail}`)
    process.exit(1)
  } else if (outcome.status === 'ERROR') {
    console.error(`[EVAL GATE] ERROR — ${outcome.detail}`)
    process.exit(3)
  } else if (outcome.status === 'SKIP') {
    console.log(`[EVAL GATE] SKIP — ${outcome.detail}`)
    process.exit(2)
  } else {
    console.log(`[EVAL GATE] PASS — ${outcome.detail}`)
    process.exit(0)
  }
}
