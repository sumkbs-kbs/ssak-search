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
 * G2 (S67/S73): 2-run-stabilized regression comparison against the stored
 * baseline. A query is flagged ONLY when enough independent runs agree on the
 * regression — for CI (2 runs) BOTH runs must show it; for median runs (>=3)
 * a majority (>=2) must. Single-run eval noise was ~13% of queries (S67 G2
 * measured on the S68 snapshot): one run's pool composition varies with which
 * backends succeed that run, so a single-run dip is as often noise as signal.
 *
 * Semantics per metric:
 *   - ndcgAt10       — a run counts as regressed when its recomputed NDCG
 *                      (S54 path) drops >= 0.05 below the baseline's; flag
 *                      when >= minAgree runs agree. Reported `current`/`delta`
 *                      use the WORST agreeing run (conservative, truthful).
 *   - resultCount    — run counts as regressed when its count < baseline's.
 *   - responseTimeMs — run counts as regressed when > baseline's * 1.3.
 *   - passStatus     — run counts as regressed when baseline passed and it
 *                      failed.
 *
 * Runs whose NDCG is not computable (no pool AND no stored ranking) never
 * count toward agreement. With <2 runs this falls back to the single-run
 * diffBaseline (keeps `eval:ci` single-run behavior unchanged).
 *
 * @param gold  CURRENT gold map (queryId → relevantDomains) — injected for
 *              tests, defaults to eval/gold-standards.json (same as S58).
 */
export function diffBaselineStabilized(
  currents: EvalReport[],
  baseline: EvalBaseline,
  gold: Record<string, string[]> = loadGoldStandards(),
): RegressionDiff[] {
  if (currents.length < 2) return diffBaseline(currents[0], baseline, gold)
  // 2 runs: BOTH must agree; >=3 runs: a majority (>=2) must agree.
  const minAgree = Math.min(2, currents.length)
  const diffs: RegressionDiff[] = []

  for (const baselineResult of baseline.report.results) {
    const id = baselineResult.query.id
    const currentResults = currents
      .map((rep) => rep.results.find((r) => r.query.id === id))
      .filter((r): r is NonNullable<typeof r> => r !== undefined)
    if (currentResults.length < minAgree) continue

    // ── NDCG@10 (S54 recompute path, both sides under CURRENT gold) ──
    const baselineNdcg = recomputeNdcgAt10(baselineResult, gold[id])
    if (baselineNdcg !== undefined) {
      const regressed = currentResults.filter((cr) => {
        const n = recomputeNdcgAt10(cr, gold[id])
        return n !== undefined && baselineNdcg - n > 0.05
      })
      if (regressed.length >= minAgree) {
        const worst = Math.min(
          ...currentResults.map((cr) => recomputeNdcgAt10(cr, gold[id])).filter((n): n is number => n !== undefined),
        )
        diffs.push({
          queryId: id,
          metric: 'ndcgAt10',
          baseline: baselineNdcg.toFixed(4),
          current: worst.toFixed(4),
          delta: (worst - baselineNdcg).toFixed(4),
          regressed: true,
        })
      }
    }

    // ── resultCount (lower = worse) ──
    const countRegressed = currentResults.filter((cr) => cr.resultCount < baselineResult.resultCount)
    if (countRegressed.length >= minAgree) {
      const worst = Math.min(...currentResults.map((cr) => cr.resultCount))
      diffs.push({
        queryId: id,
        metric: 'resultCount',
        baseline: baselineResult.resultCount,
        current: worst,
        delta: worst - baselineResult.resultCount,
        regressed: true,
      })
    }

    // ── responseTimeMs (higher = worse) ──
    const rtRegressed = currentResults.filter((cr) => cr.responseTimeMs > baselineResult.responseTimeMs * 1.3)
    if (rtRegressed.length >= minAgree) {
      const worst = Math.max(...currentResults.map((cr) => cr.responseTimeMs))
      diffs.push({
        queryId: id,
        metric: 'responseTimeMs',
        baseline: baselineResult.responseTimeMs,
        current: worst,
        delta: `${Math.round((worst / baselineResult.responseTimeMs - 1) * 100)}%`,
        regressed: true,
      })
    }

    // ── passStatus (pass → fail) ──
    if (baselineResult.passed) {
      const passRegressed = currentResults.filter((cr) => !cr.passed)
      if (passRegressed.length >= minAgree) {
        diffs.push({
          queryId: id,
          metric: 'passStatus',
          baseline: 'pass',
          current: 'fail',
          delta: 'pass→fail',
          regressed: true,
        })
      }
    }
  }

  return diffs
}

/**
 * Load the stored baseline and run the G2 stabilized comparison (>=2 runs).
 * Empty when no baseline exists (same contract as compareWithBaseline).
 *
 * NOTE (S75): eval/index.ts no longer uses this wrapper — it loads the
 * baseline ONCE and passes the same snapshot to the gate AND the S37 loss
 * report (a --save run must not self-compare). Kept as public API for
 * callers that want the disk-default behavior.
 */
export function compareWithBaselineStabilized(currents: EvalReport[]): RegressionDiff[] {
  const baseline = loadBaseline()
  if (!baseline) return []
  return diffBaselineStabilized(currents, baseline)
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
 * its `response` is ONE representative run's pool. S81 changed the
 * representative pick from median-latency to MEDIAN-NDCG so the saved pool is
 * the run whose recomputed NDCG sits at the median — the BASELINE ANCHOR now
 * sits at the median quality level instead of an arbitrary (quality-
 * uncorrelated) latency pick. Pool-recomputed and stored-ranking NDCG can
 * still differ (the pick changed 376/500 queries on the S68 snapshot), but
 * the anchor is no longer biased high (S76: 22/500 phantom self-comparison
 * flags → 0). Using the stored
 * value on one side and the pool on the other makes a report inconsistent
 * with itself (diffBaseline(report, report) ≠ 0); recomputing BOTH sides from
 * their pools is self-consistent and unbiased. The measured quantity shifts
 * from "stored median-of-N NDCG" to "saved-pool NDCG under current gold" on
 * both sides — deterministic and comparable across gold/rules changes. On a
 * CI single run the pool recompute equals the stored value (the runner scored
 * its own pool), so behavior is unchanged there; the baseline side is where
 * staleness is corrected.
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
