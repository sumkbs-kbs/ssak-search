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
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EvalReport, EvalQuery, EvalBaseline, RegressionDiff } from '../eval/types'
import { computeMedianReport } from '../eval/median'
import { diffBaselineStabilized, diffBaseline } from '../eval/baseline'
import { loadGoldStandards } from '../eval/metrics'
import { parseEvalArtifacts } from './verify-jsonc'

export interface GateOutcome {
  status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'
  detail: string
}

export interface GateOptions {
  /** Gold map override for tests (defaults to loadGoldStandards() from cwd). */
  gold?: Record<string, string[]>
}

/**
 * S86f: derive the worktree baseline from the ALREADY-parsed artifacts — the
 * integrity pass (parseEvalArtifacts) parsed baselines/latest.json once, so
 * re-reading it (the removed loadBaselineFromWorktree) was a second ~3.4 MB
 * parse per commit. Shape is already validated (isEvalArtifactWellFormed
 * requires report.results), so only the timestamp/report extraction remains.
 * A missing artifact (commit predates baselines, or the file is absent)
 * yields null — the gate then reports `baseline: none` (PASS, weak signal).
 * Pure and exported for unit tests.
 */
export function baselineFromArtifacts(
  artifacts: ReadonlyArray<{ file: string; ok: boolean; parsed?: unknown }>,
  evalDir: string,
): EvalBaseline | null {
  const file = join(evalDir, 'baselines', 'latest.json')
  const artifact = artifacts.find((a) => a.file === file && a.ok && a.parsed !== undefined)
  if (!artifact) return null
  const raw = artifact.parsed as { timestamp?: string; report?: EvalReport }
  // Defensive: for an ok artifact the shape check already guarantees
  // report.results, so this is unreachable in the runGate flow — kept so the
  // helper stays safe if ever fed unvalidated artifacts directly.
  if (!raw.report) return null
  return { timestamp: raw.timestamp ?? '', report: raw.report }
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

  // S86c: artifact integrity pre-check — BEFORE loading run files, validate
  // EVERY *.json under results/ + baselines/ (syntax + report.results shape,
  // the verify-jsonc.ts --eval semantics). Corrupt artifacts are gate ERROR
  // (exit 3), not SKIP and not a silently-weakened PASS:
  //  - a corrupt baselines/latest.json previously loaded as null via the
  //    removed loadBaselineFromWorktree's try/catch → "baseline: none" → PASS
  //  - a corrupt results/latest.json was never read by the removed
  //    loadRunFiles path at all
  // This surfaces both as ERROR with the offending files.
  //
  // S86d: parseEvalArtifacts parses every artifact EXACTLY ONCE and returns
  // the parsed values — the run reports below are built from those objects,
  // so the gate no longer re-reads/re-parses the ~3.4 MB run files (the old
  // loadRunFiles path). 1019 ms → 38 ms on the real artifact set. S86e:
  // loadRunFiles is removed — runGate is the only run-loading path.
  const artifacts = parseEvalArtifacts(evalDir)
  const corrupt = artifacts.filter((a) => !a.ok)
  if (corrupt.length > 0) {
    const files = corrupt.map((c) => `${c.file}: ${c.reason}`).join('; ')
    return { status: 'ERROR', detail: `artifact integrity check failed: ${files}` }
  }

  // Build the run report list from the ALREADY-parsed artifacts (no re-read).
  // Numeric order (run-1, run-2, ... run-10) — parseEvalArtifacts globs
  // alphabetically, and the removed loadRunFiles path sorted numerically
  // (deterministic detail line + report ordering for the stabilized gate).
  const runArtifacts = artifacts
    .filter((a) => /run-(\d+)\.json$/.test(a.file))
    .sort((a, b) => {
      const na = parseInt(a.file.match(/run-(\d+)\.json$/)?.[1] ?? '0', 10)
      const nb = parseInt(b.file.match(/run-(\d+)\.json$/)?.[1] ?? '0', 10)
      return na - nb
    })
  if (runArtifacts.length === 0) {
    return { status: 'ERROR', detail: 'no run-*.json artifacts found' }
  }
  const reports = runArtifacts.map((a) => {
    const raw = a.parsed as { report?: EvalReport } | EvalReport
    return (raw as { report?: EvalReport }).report ?? (raw as EvalReport)
  })
  const files = runArtifacts.map((a) => a.file.split('/').pop() ?? a.file)

  // Query set: union across ALL runs' results so a query dropped from run-1
  // (runner error) is not silently excluded from the median aggregation.
  const seen = new Map<string, EvalQuery>()
  for (const rep of reports) {
    for (const r of rep.results) seen.set(r.query.id, r.query)
  }
  const queries = [...seen.values()]

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
  const baseline = baselineFromArtifacts(artifacts, evalDir)
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
