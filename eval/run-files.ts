/**
 * eval/run-files.ts — shared single-parse loader for stored run-N.json
 * artifacts (S86h).
 *
 * S86e removed the last shared run loader (loadRunFiles) and S86f/S86g
 * unified the OTHER artifact types (baselines, gold). run-N.json parsing was
 * still hand-rolled in ~17 analysis scripts, each re-implementing
 * readdirSync + numeric sort + a `report ?? raw` fallback + its own error
 * handling. This module is the single replacement: it reuses parseEvalArtifacts
 * (the S86d single-parse integrity gate), so every run file is parsed EXACTLY
 * once and corrupt/truncated artifacts are excluded by the same rules the CI
 * gate applies.
 *
 * Contract: `evalDir` is the eval root containing results/ + baselines/ (the
 * same layout parseEvalArtifacts globs) — callers pass 'eval' or an absolute
 * worktree path. Returns [] when no valid run files exist (missing dir, empty
 * results/, all-corrupt); callers keep their own empty-handling policy.
 */
import { basename, join } from 'node:path'
import { parseEvalArtifacts, type EvalArtifact } from '../scripts/verify-jsonc'
import type { EvalReport, EvalQuery, EvalBaseline } from './types'

/** A stored run artifact: file basename, numeric run index, parsed report. */
export interface RunFile {
  /** basename, e.g. "run-1.json" */
  file: string
  /** numeric run index parsed from the file name (1, 2, ...) */
  run: number
  /**
   * `report ?? raw` — the historical loadRunFiles contract. Under the S86d
   * well-formedness gate every accepted artifact has report.results, so this
   * always resolves to `report` today; the fallback is kept defensively in
   * case the gate is ever relaxed to accept bare-format (raw.results) files.
   */
  report: EvalReport
}

const RUN_FILE_RE = /^run-(\d+)\.json$/

/** True when a file basename is a run artifact (run-N.json). */
export function isRunFile(file: string): boolean {
  return RUN_FILE_RE.test(basename(file))
}

/** Numeric run index of a run artifact basename (NaN for non-run files). */
export function runNumber(file: string): number {
  const m = RUN_FILE_RE.exec(basename(file))
  return m ? Number(m[1]) : NaN
}

/**
 * S86k: derive RunFile entries from ALREADY-parsed artifacts (single parse —
 * the gate callers pass their own parseEvalArtifacts output so nothing is
 * re-read/re-parsed). Same contract as the parseRunFiles wrapper below:
 * keep ok run artifacts, numeric order (run-1, run-2, ... run-10 — the
 * alphabetically-globbed artifact order would put run-10 before run-2), and
 * `report ?? raw` (under the gate always resolves to `report`). Shared by
 * parseRunFiles AND the two eval gates (verify-commit-eval.ts runGate /
 * verify-baseline-equivalence.ts) — the numeric-sort + report-extraction
 * contract lives here once.
 */
export function runFilesFromArtifacts(artifacts: readonly EvalArtifact[]): RunFile[] {
  return artifacts
    .filter((a) => a.ok && isRunFile(a.file))
    .sort((a, b) => runNumber(a.file) - runNumber(b.file))
    .map((a) => {
      const raw = a.parsed as { report?: unknown }
      return {
        file: basename(a.file),
        run: runNumber(a.file),
        report: (raw.report ?? raw) as EvalReport,
      }
    })
}

/**
 * Parse every run-N.json under an eval dir exactly once (via
 * parseEvalArtifacts) and derive RunFiles — thin wrapper over
 * runFilesFromArtifacts (S86k). Returns [] when no valid run files exist
 * (missing dir, empty results/, all-corrupt); callers keep their own
 * empty-handling policy.
 */
export function parseRunFiles(evalDir: string): RunFile[] {
  return runFilesFromArtifacts(parseEvalArtifacts(evalDir))
}

/**
 * S86k: artifacts that failed the S86c integrity gate (syntax or the
 * report.results shape check). Shared by both eval gates — a corrupt
 * baselines/latest.json or results/latest.json must be gate ERROR, not a
 * silently-weakened PASS.
 */
export function corruptArtifacts(artifacts: readonly EvalArtifact[]): EvalArtifact[] {
  return artifacts.filter((a) => !a.ok)
}

/**
 * S86f / S86l: derive the baseline from the ALREADY-parsed artifacts — the
 * integrity pass (parseEvalArtifacts) parsed baselines/latest.json once, so
 * re-reading it (the removed loadBaselineFromWorktree / the loadBaseline()
 * call in analyze-429-loss) was a second parse of the same file. Shape is
 * already validated (isEvalArtifactWellFormed requires report.results), so
 * only the timestamp/report extraction remains. A missing artifact (a commit
 * predating baselines, or the file absent) yields null — callers treat null
 * as "no baseline" (weak signal). A corrupt artifact is !ok and is skipped
 * here — consistent with the parseRunFiles "corrupt = absent" contract.
 * Pure and exported for unit tests. Shared by the two eval gates AND
 * scripts/analyze-429-loss.ts (S86l) so every consumer derives the baseline
 * from the same single-parse objects instead of a fresh disk read.
 */
export function baselineFromArtifacts(artifacts: readonly EvalArtifact[], evalDir: string): EvalBaseline | null {
  const file = join(evalDir, 'baselines', 'latest.json')
  const artifact = artifacts.find((a) => a.file === file && a.ok && a.parsed !== undefined)
  if (!artifact) return null
  const raw = artifact.parsed as { timestamp?: string; report?: EvalReport }
  // Defensive: for an ok artifact the shape check already guarantees
  // report.results, so this is unreachable in the gate flows — kept so the
  // helper stays safe if ever fed unvalidated artifacts directly.
  if (!raw.report) return null
  return { timestamp: raw.timestamp ?? '', report: raw.report }
}

/**
 * S86k: union of query IDs across ALL run reports, first occurrence wins — a
 * query dropped from one run (runner error) must not silently vanish from the
 * median aggregation. Shared by both eval gates feeding computeMedianReport.
 */
export function unionQueries(reports: readonly EvalReport[]): EvalQuery[] {
  const seen = new Map<string, EvalQuery>()
  for (const rep of reports) {
    for (const r of rep.results) seen.set(r.query.id, r.query)
  }
  return [...seen.values()]
}
