import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalReport, EvalBaseline, RegressionDiff } from './types'
import { diffBaseline } from './runner'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const BASELINE_DIR = join(__dirname, 'baselines')
const LATEST_FILE = join(BASELINE_DIR, 'latest.json')

/**
 * Save an eval report as the new baseline.
 */
export function saveBaseline(report: EvalReport): void {
  if (!existsSync(BASELINE_DIR)) {
    mkdirSync(BASELINE_DIR, { recursive: true })
  }

  const baseline: EvalBaseline = {
    timestamp: report.timestamp,
    report,
  }

  writeFileSync(LATEST_FILE, JSON.stringify(baseline, null, 2), 'utf-8')
}

/**
 * Load the most recent baseline, or null if none exists.
 */
export function loadBaseline(): EvalBaseline | null {
  if (!existsSync(LATEST_FILE)) return null

  try {
    const raw = readFileSync(LATEST_FILE, 'utf-8')
    return JSON.parse(raw) as EvalBaseline
  } catch {
    return null
  }
}

/**
 * Compare a report against the stored baseline.
 * Returns regressions if a baseline exists, empty array otherwise.
 */
export function compareWithBaseline(report: EvalReport): RegressionDiff[] {
  const baseline = loadBaseline()
  if (!baseline) return []
  return diffBaseline(report, baseline)
}
