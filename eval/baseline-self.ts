/**
 * Self-Index Eval Baseline — separate from orchestrator eval baseline.
 *
 * Uses eval/baselines/self-latest.json to avoid colliding with the
 * orchestrator eval's eval/baselines/latest.json.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalReport, EvalBaseline, RegressionDiff } from './types'
import { diffBaseline } from './runner'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const BASELINE_DIR = join(__dirname, 'baselines')
const SELF_LATEST_FILE = join(BASELINE_DIR, 'self-latest.json')

/**
 * Save a self-index eval report as the new baseline.
 */
export function saveSelfIndexBaseline(report: EvalReport): void {
  if (!existsSync(BASELINE_DIR)) {
    mkdirSync(BASELINE_DIR, { recursive: true })
  }

  const baseline: EvalBaseline = {
    timestamp: report.timestamp,
    report,
  }

  writeFileSync(SELF_LATEST_FILE, JSON.stringify(baseline, null, 2), 'utf-8')
}

/**
 * Load the most recent self-index baseline, or null if none exists.
 */
export function loadSelfIndexBaseline(): EvalBaseline | null {
  if (!existsSync(SELF_LATEST_FILE)) return null

  try {
    const raw = readFileSync(SELF_LATEST_FILE, 'utf-8')
    return JSON.parse(raw) as EvalBaseline
  } catch {
    return null
  }
}

/**
 * Compare a self-index eval report against the stored baseline.
 */
export function compareWithSelfIndexBaseline(
  report: EvalReport,
  diffFn: (current: EvalReport, baseline: EvalBaseline) => RegressionDiff[],
): RegressionDiff[] {
  const baseline = loadSelfIndexBaseline()
  if (!baseline) return []
  return diffFn(report, baseline)
}
