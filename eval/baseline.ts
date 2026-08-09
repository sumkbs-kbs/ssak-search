import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalReport, EvalBaseline, RegressionDiff } from './types'
import { recomputeNdcgAt10, loadGoldStandards } from './metrics'

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

/**
 * S58: NDCG regression detection is now gold/rules-robust.
 *
 * The old gate compared the STORED `ranking.ndcgAt10` fields of the current
 * report and the baseline snapshot. Those fields are snapshots from their
 * respective eval times: when gold is edited (S49/S52) or scoring rules change
 * (S50 DCG cap), the baseline's stored values are stale and a "regression" is
 * an artifact of the metric change, not of search quality (S53: 410-regression
 * warning after the baseline rule reset). Following the S54 principle, BOTH
 * sides are recomputed from their SAVED pools with the CURRENT gold:
 *
 *   recomputeNdcgAt10(result, currentGold) — pool + current rules is exact;
 *   the stored field is only a legacy fallback for artifacts without a pool.
 *
 * Why symmetric recompute rather than "keep the fresh current side stored":
 * the current side of a MEDIAN report carries the median-of-N ranking while
 * its `response` is ONE representative (median-latency) run's pool — the two
 * disagree on ~24/500 queries by ≥0.05 (measured on the S55 snapshot). Using
 * the stored value on one side and the pool on the other makes a report
 * inconsistent with itself (diffBaseline(report, report) ≠ 0); recomputing
 * BOTH sides from their pools is self-consistent and unbiased. The measured
 * quantity shifts from "stored median-of-N NDCG" to "saved-pool NDCG under
 * current gold" on both sides — deterministic and comparable across
 * gold/rules changes. On a CI single run the pool recompute equals the stored
 * value (the runner scored its own pool), so behavior is unchanged there; the
 * baseline side is where staleness is corrected.
 * resultCount / responseTimeMs / passStatus are runtime measurements (not
 * gold-dependent) and stay on their stored values.
 *
 * @param gold  CURRENT gold map (queryId → relevantDomains). Defaults to
 *              loading eval/gold-standards.json; tests pass it explicitly so
 *              the comparison is injectable and cwd-independent.
 */
export function diffBaseline(
  current: EvalReport,
  baseline: EvalBaseline,
  gold: Record<string, string[]> = loadGoldStandards(),
): RegressionDiff[] {
  const diffs: RegressionDiff[] = []

  for (const currentResult of current.results) {
    const baselineResult = baseline.report.results.find((r) => r.query.id === currentResult.query.id)
    if (!baselineResult) continue

    // Compare result count
    if (currentResult.resultCount < baselineResult.resultCount) {
      diffs.push({
        queryId: currentResult.query.id,
        metric: 'resultCount',
        baseline: baselineResult.resultCount,
        current: currentResult.resultCount,
        delta: currentResult.resultCount - baselineResult.resultCount,
        regressed: true,
      })
    }

    // Compare response time (higher = worse)
    if (currentResult.responseTimeMs > baselineResult.responseTimeMs * 1.3) {
      diffs.push({
        queryId: currentResult.query.id,
        metric: 'responseTimeMs',
        baseline: baselineResult.responseTimeMs,
        current: currentResult.responseTimeMs,
        delta: `${Math.round((currentResult.responseTimeMs / baselineResult.responseTimeMs - 1) * 100)}%`,
        regressed: true,
      })
    }

    // Compare pass/fail
    if (baselineResult.passed && !currentResult.passed) {
      diffs.push({
        queryId: currentResult.query.id,
        metric: 'passStatus',
        baseline: 'pass',
        current: 'fail',
        delta: 'pass→fail',
        regressed: true,
      })
    }

    // NDCG@10 — S58: recompute BOTH sides from their saved pools under the
    // CURRENT gold (self-consistent: a report compared against itself is 0;
    // a baseline saved under old gold/rules is re-scored before comparing).
    const currentNdcg = recomputeNdcgAt10(currentResult, gold[currentResult.query.id])
    const baselineNdcg = recomputeNdcgAt10(baselineResult, gold[baselineResult.query.id])
    if (currentNdcg !== undefined && baselineNdcg !== undefined) {
      const ndcgDelta = currentNdcg - baselineNdcg
      if (ndcgDelta < -0.05) {
        diffs.push({
          queryId: currentResult.query.id,
          metric: 'ndcgAt10',
          baseline: baselineNdcg.toFixed(4),
          current: currentNdcg.toFixed(4),
          delta: ndcgDelta.toFixed(4),
          regressed: true,
        })
      }
    }
  }

  return diffs
}
