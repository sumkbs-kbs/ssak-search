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
import { basename } from 'node:path'
import { parseEvalArtifacts } from '../scripts/verify-jsonc'
import type { EvalReport } from './types'

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
 * Parse every run-N.json under an eval dir exactly once (via
 * parseEvalArtifacts), apply the `report ?? raw` fallback, and return entries
 * in NUMERIC run order (run-1, run-2, ... run-10) — parseEvalArtifacts globs
 * alphabetically, which would otherwise order run-10 before run-2.
 */
export function parseRunFiles(evalDir: string): RunFile[] {
  return parseEvalArtifacts(evalDir)
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
