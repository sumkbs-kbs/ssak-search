#!/usr/bin/env -S npx tsx
/**
 * verify-baseline-equivalence.ts — the third pre-push gate: does the stored
 * baseline's headline NDCG@10 survive recomputation under the CURRENT scoring
 * code?
 *
 * The eval gate (verify-commit-eval.ts) recomputes median NDCG from stored
 * run-*.json pools (S54) and compares PER-QUERY against the baseline. This
 * script checks the AGGREGATE equality: `computeMedianReport` under the
 * current gold/code vs `baselines/latest.json`'s stored avgNdcgAt10.
 *
 *   |Δ| <= SCORING_DRIFT_EPSILON (1e-4)  → PASS  (the stored headline number
 *                                            is reproducible — a behavior-neutral
 *                                            refactor / identical artifacts)
 *   |Δ| >  epsilon                       → DRIFT (the stored baseline was
 *                                            measured under DIFFERENT rules —
 *                                            flag it; S86i's [WARN] explains
 *                                            which scoring files caused it)
 *   no baseline                          → NO_BASELINE (weak signal, not red)
 *   corrupt artifacts                    → ERROR
 *
 * Unlike the S86i guard (which only compares when scoring files changed), this
 * check runs ALWAYS — it is the push-candidate's "do the numbers still mean
 * what the baseline says they mean" assertion.
 *
 * Usage (run from repo root — resolves eval/ relative to cwd):
 *   npx tsx scripts/verify-baseline-equivalence.ts            # eval/
 *   npx tsx scripts/verify-baseline-equivalence.ts <evalDir>  # explicit
 * Exit: 0 PASS/NO_BASELINE · 1 DRIFT · 3 ERROR
 */
import { join, resolve } from 'node:path'
import type { EvalReport, EvalQuery, EvalBaseline } from '../eval/types'
import { computeMedianReport } from '../eval/median'
import { loadGoldStandards } from '../eval/metrics'
import { baselineFromArtifacts, SCORING_DRIFT_EPSILON } from './verify-commit-eval'
import { parseEvalArtifacts } from './verify-jsonc'

export interface BaselineEquivalenceOptions {
  /** Gold map override for tests (defaults to loadGoldStandards() from cwd). */
  gold?: Record<string, string[]>
  /** Drift threshold (defaults to the S86i scoring-drift epsilon 1e-4). */
  epsilon?: number
}

export interface BaselineEquivalenceResult {
  status: 'PASS' | 'DRIFT' | 'NO_BASELINE' | 'ERROR'
  recomputedNdcg: number | null
  baselineNdcg: number | null
  delta: number | null
  epsilon: number
  /** Number of run files aggregated. 1 = stored-vs-stored weak signal. */
  runs: number
  detail: string
}

/**
 * Pure baseline-equivalence check. `evalDir` is the eval root (contains
 * results/ + baselines/). Shares the S86d single-parse path (parseEvalArtifacts)
 * and the S86f derived-baseline helper, so no artifact is ever read twice.
 */
export function checkBaselineEquivalence(
  evalDir: string,
  opts: BaselineEquivalenceOptions = {},
): BaselineEquivalenceResult {
  const epsilon = opts.epsilon ?? SCORING_DRIFT_EPSILON
  const fail = (status: BaselineEquivalenceResult['status'], detail: string): BaselineEquivalenceResult => ({
    status,
    recomputedNdcg: null,
    baselineNdcg: null,
    delta: null,
    epsilon,
    runs: 0,
    detail,
  })

  const artifacts = parseEvalArtifacts(evalDir)
  const corrupt = artifacts.filter((a) => !a.ok)
  if (corrupt.length > 0) {
    const files = corrupt.map((c) => `${c.file}: ${c.reason}`).join('; ')
    return fail('ERROR', `artifact integrity check failed: ${files}`)
  }

  // Numeric-order run files (run-1, run-2, ... run-10) — same rule as runGate.
  const runArtifacts = artifacts
    .filter((a) => /run-(\d+)\.json$/.test(a.file))
    .sort((a, b) => {
      const na = parseInt(a.file.match(/run-(\d+)\.json$/)?.[1] ?? '0', 10)
      const nb = parseInt(b.file.match(/run-(\d+)\.json$/)?.[1] ?? '0', 10)
      return na - nb
    })
  if (runArtifacts.length === 0) return fail('ERROR', 'no run-*.json artifacts found')

  const reports = runArtifacts.map((a) => {
    const raw = a.parsed as { report?: EvalReport } | EvalReport
    return (raw as { report?: EvalReport }).report ?? (raw as EvalReport)
  })
  // NOTE (single-run weak signal): with exactly 1 run file, computeMedianReport
  // returns the run's STORED ranking as-is (median.ts single-run shortcut) —
  // the recompute degenerates to stored-vs-stored and trivially PASSes. That
  // is honest for a single-run baseline save (both sides are the same stored
  // number) but is a WEAK signal; the `runs` field lets callers see it. The
  // eval:median:save / eval:median:ci flows always produce >=2 runs.

  // Query union across ALL runs (a query dropped from one run must not vanish
  // from the median aggregation) — same contract as runGate.
  const seen = new Map<string, EvalQuery>()
  for (const rep of reports) {
    for (const r of rep.results) seen.set(r.query.id, r.query)
  }
  const gold = opts.gold ?? loadGoldStandards()

  let medianReport: EvalReport
  try {
    medianReport = computeMedianReport(reports, [...seen.values()], gold)
  } catch (err) {
    return fail('ERROR', `median aggregation failed: ${(err as Error).message}`)
  }

  const baseline: EvalBaseline | null = baselineFromArtifacts(artifacts, evalDir)
  if (!baseline) return fail('NO_BASELINE', 'no baselines/latest.json to compare against')

  const recomputed = medianReport.ranking?.avgNdcgAt10
  const stored = baseline.report.ranking?.avgNdcgAt10
  if (recomputed === undefined || stored === undefined) {
    return fail('ERROR', 'no comparable avgNdcgAt10 (median report or baseline lacks ranking)')
  }

  const delta = recomputed - stored
  if (Math.abs(delta) > epsilon) {
    return {
      status: 'DRIFT',
      recomputedNdcg: recomputed,
      baselineNdcg: stored,
      delta,
      epsilon,
      runs: reports.length,
      detail: `NDCG@10 recomputed ${recomputed.toFixed(4)} vs stored baseline ${stored.toFixed(4)} (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}, runs ${reports.length}) — stored baseline was measured under different rules`,
    }
  }
  return {
    status: 'PASS',
    recomputedNdcg: recomputed,
    baselineNdcg: stored,
    delta,
    epsilon,
    runs: reports.length,
    detail: `NDCG@10 recomputed ${recomputed.toFixed(4)} == stored baseline ${stored.toFixed(4)} (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(6)}, runs ${reports.length})`,
  }
}

// ── CLI entry ─────────────────────────────────────────────────────────────
if (import.meta.url === 'file://' + resolve(process.argv[1] ?? '')) {
  const arg = process.argv[2]
  const evalDir = arg ? resolve(process.cwd(), arg) : join(process.cwd(), 'eval')
  const r = checkBaselineEquivalence(evalDir)
  const line = `[BASELINE EQ] ${r.status} — ${r.detail}`
  if (r.status === 'ERROR') {
    console.error(line)
    process.exit(3)
  } else if (r.status === 'DRIFT') {
    console.error(line)
    process.exit(1)
  } else {
    console.log(line)
    process.exit(0)
  }
}
