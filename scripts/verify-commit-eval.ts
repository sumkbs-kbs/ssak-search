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
 *   2. Rebuild the median report with computeMedianReportFromRuns() — the
 *      shared wrapper over computeMedianReport (S86l-②) — the same
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
 *
 * S86i scoring-drift guard: because the gate re-scores stored pools under
 * CURRENT code, a commit that changes the SCORING layer (metrics/median/
 * baseline/gold) makes the recomputed-vs-baseline NDCG delta a mixture of
 * "search quality change" and "metric redefinition". When such files are in
 * the commit's diff (passed via --changed-files), the gate compares the
 * recomputed NDCG@10 against the stored baseline NDCG@10 and appends a
 * WARNING to the detail line when they drift beyond noise — a provenance
 * note, never a FAIL (the regression gate stays the authority).
 */
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { EvalReport, RegressionDiff } from '../eval/types'
import { computeMedianReportFromRuns } from '../eval/median'
import { diffBaselineStabilized, diffBaseline } from '../eval/baseline'
import { loadGoldStandards } from '../eval/metrics'
import { runFilesFromArtifacts, corruptArtifacts, baselineFromArtifacts } from '../eval/run-files'
import { parseEvalArtifacts } from './verify-jsonc'

export interface GateOutcome {
  status: 'PASS' | 'FAIL' | 'SKIP' | 'ERROR'
  detail: string
}

export interface GateOptions {
  /** Gold map override for tests (defaults to loadGoldStandards() from cwd). */
  gold?: Record<string, string[]>
  /**
   * S86i: repo-root-relative paths changed in the checked commit (computed by
   * verify-commits-ci.sh via `git diff --name-only` and passed through the
   * CLI's --changed-files flag). Only scoring-layer files are inspected.
   */
  changedFiles?: readonly string[]
}

/**
 * S86i: files whose change ALTERS the meaning of a stored NDCG number.
 * - eval/metrics.ts   — relevance/scoring (computeNdcg / isRelevant / DCG cap)
 * - eval/median.ts    — median aggregation + representative-pick
 * - eval/baseline.ts  — G2 regression rules (diffBaselineStabilized)
 * - eval/gold-standards.json — relevance itself (every consumer's gold map)
 *
 * Deliberately EXCLUDED: eval/run-files.ts + parseEvalArtifacts/verify-jsonc
 * (loading/shape gates — do not change NDCG semantics) and every scripts/ probe
 * / analyzer (consumers only).
 */
export const SCORING_FILE_PATTERNS: readonly string[] = [
  'eval/metrics.ts',
  'eval/median.ts',
  'eval/baseline.ts',
  'eval/gold-standards.json',
]

/**
 * Pure: which of `changedFiles` (repo-root relative paths) touch the scoring
 * layer. Empty for any non-scoring diff. Exported for unit tests.
 */
export function scoringFilesIn(changedFiles: readonly string[]): string[] {
  // Defensive: runGate never passes undefined (it guards before calling), but
  // the helper stays safe if a caller forgets — [] is the correct no-op.
  return (changedFiles ?? []).filter((f) => SCORING_FILE_PATTERNS.includes(f))
}

/**
 * S86i: NDCG@10 drift below this magnitude is aggregation noise (4th-decimal
 * recompute wobble), not a metric redefinition worth warning about.
 */
export const SCORING_DRIFT_EPSILON = 1e-4

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
  // S86k: corrupt filter + run-report derivation + query union now come from
  // the shared eval/run-files.ts helpers (single point of truth with
  // verify-baseline-equivalence.ts). Order preserved: the S86c integrity
  // check runs BEFORE run loading so a corrupt baselines/latest.json is ERROR,
  // and the numeric order + `report ?? raw` contract is identical.
  const corrupt = corruptArtifacts(artifacts)
  if (corrupt.length > 0) {
    const files = corrupt.map((c) => `${c.file}: ${c.reason}`).join('; ')
    return { status: 'ERROR', detail: `artifact integrity check failed: ${files}` }
  }

  const runFiles = runFilesFromArtifacts(artifacts)
  if (runFiles.length === 0) {
    return { status: 'ERROR', detail: 'no run-*.json artifacts found' }
  }
  const reports = runFiles.map((r) => r.report)
  const files = runFiles.map((r) => r.file)

  // Gold is loaded from the WORKTREE (cwd) — the commit's own gold — unless a
  // test injects it.
  const gold = opts.gold ?? loadGoldStandards()

  let medianReport: EvalReport
  try {
    // S86l-②: the query union + gold default live inside the shared wrapper
    // (computeMedianReportFromRuns) — same aggregation, single call site.
    medianReport = computeMedianReportFromRuns(reports, gold)
  } catch (err) {
    return { status: 'ERROR', detail: `median aggregation failed: ${(err as Error).message}` }
  }

  // Baseline is loaded from the WORKTREE's eval/baselines (commit's snapshot)
  // via the shared baselineFromArtifacts (S86f/S86l — derived from the SAME
  // parseEvalArtifacts pass, never a re-read). Compare: >=2 run files → G2 stabilized gate (eval/index.ts contract);
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

  // S86i scoring-drift guard: when the commit's diff touches the scoring
  // layer AND a baseline exists, compare the RECOMPUTED NDCG (current code)
  // against the STORED baseline NDCG (measured under the baseline commit's
  // code). A real drift means the regression deltas below may be metric
  // redefinition rather than search-quality change — surface it as a
  // provenance warning (never a FAIL: the gate stays the authority).
  let scoringNote = ''
  const changedScoring = opts.changedFiles ? scoringFilesIn(opts.changedFiles) : []
  if (baseline && changedScoring.length > 0) {
    const cur = medianReport.ranking?.avgNdcgAt10
    const base = baseline.report.ranking?.avgNdcgAt10
    if (cur !== undefined && base !== undefined) {
      const delta = cur - base
      if (Math.abs(delta) > SCORING_DRIFT_EPSILON) {
        scoringNote = ` · [WARN] scoring-drift: ${changedScoring.join(',')} — NDCG@10 ${cur.toFixed(4)} vs baseline ${base.toFixed(4)} (Δ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}) — regression deltas may be metric redefinition, not search quality`
      } else {
        scoringNote = ` · scoring-files-changed: ${changedScoring.join(',')} (NDCG@10 unchanged ${cur.toFixed(4)})`
      }
    } else {
      scoringNote = ` · scoring-files-changed: ${changedScoring.join(',')} (no comparable NDCG)`
    }
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
  const detail = summary.join(' · ') + scoringNote

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
  // Parse `[evalDir] [--changed-files <file>]`. The changed-files file lists
  // repo-root-relative paths (one per line) — the commit's own diff, computed
  // by verify-commits-ci.sh. An unreadable/missing list degrades to "no diff
  // info" ([]): the gate still runs, just without the S86i scoring warning.
  const args = process.argv.slice(2)
  let evalDirArg: string | undefined
  let changedFilesArg: string | undefined
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--changed-files') changedFilesArg = args[++i]
    else if (evalDirArg === undefined) evalDirArg = args[i]
  }
  const evalDir = evalDirArg ? resolve(process.cwd(), evalDirArg) : join(process.cwd(), 'eval')
  let changedFiles: string[] | undefined
  if (changedFilesArg) {
    try {
      changedFiles = readFileSync(changedFilesArg, 'utf-8')
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0)
    } catch {
      changedFiles = []
    }
  }
  const outcome = runGate(evalDir, changedFiles ? { changedFiles } : {})
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
