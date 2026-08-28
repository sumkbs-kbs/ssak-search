/**
 * Search Quality Eval Harness — CLI entry point.
 *
 * Usage:
 *   npx tsx eval/index.ts                  # run all queries, compare with baseline
 *   npx tsx eval/index.ts --save           # run and save new baseline
 *   npx tsx eval/index.ts --json           # output JSON report
 *   npx tsx eval/index.ts --tag korean     # run only korean-tagged queries
 *   npx tsx eval/index.ts --help           # show help
 */

import type { EvalReport } from './types'
import { EVAL_QUERIES } from './queries'
import { runEval } from './runner'
// Wave 5 (B3): the median-of-3 runs share one isolate; the memory cache TTL
// (1800s/300s) now exceeds the inter-run gap, so each run must clear the
// tier-0 map or runs 2..N would replay run 1's cached responses. Static
// import — runner.ts already imports executeSearch from the same module, so
// there is no circularity (review Wave 5).
import { __clearMemoryCacheForTests } from '../src/lib/orchestrator'
import { computeMedianReport, resolveCacheMeasurement } from './median'
import { saveBaseline, loadBaseline, diffBaseline, diffBaselineStabilized } from './baseline'
import { formatReport, formatReportJSON, formatReportSummary } from './reporter'

interface CliArgs {
  help?: boolean
  save?: boolean
  json?: boolean
  summary?: boolean
  ci?: boolean
  ciSlack?: boolean
  cache?: boolean
  tag?: string
  /** Run the eval N times and report per-query MEDIAN values (default: 1) */
  runs?: number
  /**
   * Deterministic stratified sample of N queries (language-stratified, evenly
   * spaced) — a CI-able quality gate. The full 608-query suite runs 16min+,
   * too slow to gate deploys, so regressions went unmeasured.
   */
  sample?: number
  /**
   * S37: after a median run (--runs > 1), compute the S34 wikipedia-429
   * weighted NDCG loss from the persisted run-*.json and emit a GitHub
   * Actions `::warning::` annotation when it exceeds this threshold
   * (default 5.0). Disable with --loss-threshold 0.
   */
  lossThreshold?: number
  /** Independent gold corpus path (--gold) — scored fail-loud, never co-mixed
   *  with the curated default (T2). */
  gold?: string
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const opts: CliArgs = {}

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help':
        opts.help = true
        break
      case '--save':
        opts.save = true
        break
      case '--json':
        opts.json = true
        break
      case '--summary':
        opts.summary = true
        break
      case '--ci':
        opts.ci = true
        opts.json = true
        break
      case '--ci-slack':
        opts.ciSlack = true
        opts.ci = true
        opts.json = true
        break
      case '--cache':
        opts.cache = true
        break
      case '--runs':
        opts.runs = Number(args[++i])
        if (!Number.isInteger(opts.runs) || opts.runs < 1 || opts.runs > 9) {
          console.error('--runs must be an integer between 1 and 9')
          process.exit(1)
        }
        break
      case '--loss-threshold':
        opts.lossThreshold = Number(args[++i])
        if (!Number.isFinite(opts.lossThreshold) || opts.lossThreshold < 0) {
          console.error('--loss-threshold must be a non-negative number (0 disables the warning)')
          process.exit(1)
        }
        break
      case '--tag':
        opts.tag = args[++i]
        break
      case '--sample': {
        const n = Number(args[++i])
        if (!Number.isInteger(n) || n < 2 || n > 100) {
          console.error('--sample must be an integer between 2 and 100')
          process.exit(1)
        }
        opts.sample = n
        break
      }
      case '--gold': {
        const p = args[++i]
        if (!p || p.startsWith('--')) {
          console.error('--gold requires a path argument (e.g. eval/gold-independent/gold-independent.json)')
          process.exit(1)
        }
        opts.gold = p
        break
      }
    }
  }

  return opts
}

const SAMPLE_LANGUAGE_TAGS = ['korean', 'english', 'japanese', 'chinese'] as const

/**
 * Deterministic stratified sample: group by language tag, allocate
 * proportionally (min 1 per non-empty stratum), pick evenly spaced entries.
 * No randomness — the same invocation always samples the same queries, so a
 * failing gate reruns identically.
 */
function stratifiedSample<T extends { tags?: string[] }>(pool: T[], n: number): T[] {
  const groups = new Map<string, T[]>()
  for (const q of pool) {
    const lang = q.tags?.find((t) => (SAMPLE_LANGUAGE_TAGS as readonly string[]).includes(t)) ?? 'other'
    const list = groups.get(lang) ?? []
    list.push(q)
    groups.set(lang, list)
  }
  const langs = [...groups.keys()].sort()
  const sizes = new Map<string, number>(langs.map((l) => [l, groups.get(l)?.length ?? 0]))
  const alloc = new Map<string, number>()
  let remaining = Math.min(n, pool.length)
  for (const lang of langs) {
    const size = sizes.get(lang) ?? 0
    const share = Math.max(1, Math.floor((size / pool.length) * n))
    const take = Math.min(share, size, remaining)
    alloc.set(lang, take)
    remaining -= take
  }
  let progressed = true
  while (remaining > 0 && progressed) {
    progressed = false
    for (const lang of langs) {
      if (remaining === 0) break
      if ((alloc.get(lang) ?? 0) < (sizes.get(lang) ?? 0)) {
        alloc.set(lang, (alloc.get(lang) ?? 0) + 1)
        remaining--
        progressed = true
      }
    }
  }
  const out: T[] = []
  for (const lang of langs) {
    const list = groups.get(lang) ?? []
    const take = alloc.get(lang) ?? 0
    if (take <= 0 || list.length === 0) continue
    const stride = list.length / take
    for (let i = 0; i < take; i++) out.push(list[Math.floor(i * stride)])
  }
  return out
}

async function main() {
  const opts = parseArgs()

  if (opts.help) {
    console.log(`
Usage: npx tsx eval/index.ts [options]

Options:
  --help       Show this help
  --save       Save results as new baseline
  --json       Output JSON report (default: human-readable)
  --summary    Output GitHub Summary markdown (to stderr for logging)
  --ci         CI mode: JSON output + exit code only (for automation)
  --cache      Measure cache hit rate (re-runs all queries once — doubles runtime)
               NOTE: with --runs >= 3 the cache measurement is SKIPPED (S77
               guard — cache+median is a 4-pass budget that risks the CI step
               timeout in a wide wikipedia-429 window). Use --runs 1-2 for it.
  --tag <tag>  Run only queries with the specified tag (e.g. 'korean', 'english')
  --runs <n>   Run the eval n times (1-9) and report per-query MEDIAN values,
               robust to backend availability noise (default: 1)
  --sample <n> Deterministic stratified sample of n queries (2-100,
               language-stratified) — a CI-able gate when the full suite
               is too slow to block a deploy
  --loss-threshold <n>
               S37: after a median run, warn (::warning::) when the S34
               wikipedia-429 weighted NDCG loss exceeds n (default 5.0;
               0 disables)
`)
    process.exit(0)
  }

  // Filter queries by tag if specified
  const tag = opts.tag
  const tagged = tag ? EVAL_QUERIES.filter((q) => q.tags?.includes(tag)) : EVAL_QUERIES

  if (tagged.length === 0) {
    console.error(`No queries found for tag "${opts.tag}"`)
    process.exit(1)
  }

  const queries = opts.sample ? stratifiedSample(tagged, opts.sample) : tagged
  if (opts.sample) {
    const langs = new Map<string, number>()
    for (const q of queries) {
      const lang =
        q.tags?.find((t) => t === 'korean' || t === 'english' || t === 'japanese' || t === 'chinese') ?? 'other'
      langs.set(lang, (langs.get(lang) ?? 0) + 1)
    }
    console.error(
      `Sampling ${queries.length}/${tagged.length} queries (stratified: ${[...langs.entries()]
        .map(([l, n]) => `${l}=${n}`)
        .join(', ')})\n`,
    )
  }

  const runCount = opts.runs ?? 1
  if (runCount > 1) {
    console.error(`Running ${queries.length} eval queries × ${runCount} runs (median aggregation)...\n`)
  } else {
    console.error(`Running ${queries.length} eval queries...\n`)
  }

  // S77 (S74 잔여 ①): --cache + --runs >= 3 is a 4-pass budget (~70-100min)
  // that can exceed the CI step timeout in a wide 429 window — guard skips
  // cache for median-of-3+ and prints an actionable warning.
  const cachePlan = resolveCacheMeasurement(!!opts.cache, runCount)
  if (cachePlan.warn) console.error(`⚠️ ${cachePlan.warn}\n`)
  // S77: also surface as a GitHub Actions annotation (S37 convention) so a
  // manual dispatch that hits the guard is visible in the Actions UI.
  if (cachePlan.warn && process.env.GITHUB_ACTIONS) console.error(`::warning::${cachePlan.warn}`)

  // Single run, or N runs aggregated by per-query median (robust to backend noise)
  let report: EvalReport
  // S78: `reports` is HOISTED to this scope — it was block-scoped inside the
  // runCount > 1 branch, so the S73 gate's diffBaselineStabilized(reports,
  // ...) reference below hit a ReferenceError at runtime. eval/ is NOT in
  // tsconfig's include set, so tsc never type-checked eval/index.ts and the
  // scope bug passed every gate until the S78 smoke test caught it.
  const reports: EvalReport[] = []
  if (runCount > 1) {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const resultsDir = path.join(process.cwd(), 'eval', 'results')
    fs.mkdirSync(resultsDir, { recursive: true })
    for (let i = 1; i <= runCount; i++) {
      console.error(`  ─ run ${i}/${runCount} ─`)
      // S74: cache is measured on run 1 ONLY. computeMedianReport keeps
      // `cache: reports[0].cache` — runs 2..N's warm pass is discarded work
      // (500 extra queries per run for a metric that never surfaces). With
      // schedule mode (--cache + --runs 2, S73 G2) this costs 2 cold + 1 warm
      // pass (~51 min measured budget) instead of 2×(cold+warm) (~54 min),
      // and it keeps the cache metric identical to the single-run semantics.
      // S77: cachePlan.measure is false for runs >= 3 (the timeout guard), so
      // a --cache --runs 3 dispatch runs 3 cold passes with NO cache metric.
      const rep = await runEval(queries, { measureCache: cachePlan.measure && i === 1, goldPath: opts.gold })
      reports.push(rep)
      // Wave 5 (B3): the memory cache TTL (1800s/300s) now exceeds the
      // inter-run gap (~20 min on the 500×3 median) — without clearing, runs
      // 2..N would be served ENTIRELY from run 1's cache, making the median
      // a copy of run 1 (0 latency, identical results). The median must
      // aggregate independent cold runs; clear the isolate-level map between
      // runs (the S80 interleaved warm pass lives INSIDE runEval and is
      // unaffected — this clears only after each run completes).
      __clearMemoryCacheForTests()
      // Persist each raw run for auditability (run-1.json … run-N.json).
      // Regressions are intentionally NOT computed here — per-run diffs against
      // a moving baseline are ambiguous; the median report is the signal.
      // Same full-pool-only contract as latest.json: tag AND sample subsets
      // must not clobber the official median artifacts (sample writes
      // sample-run-N.json instead).
      const runFile = opts.sample ? `sample-run-${i}.json` : `run-${i}.json`
      if (!opts.tag) {
        try {
          fs.writeFileSync(path.join(resultsDir, runFile), JSON.stringify({ report: rep }, null, 2), 'utf-8')
        } catch (e) {
          console.error(`Failed to write eval/results/${runFile}:`, e)
        }
      }
    }
    report = computeMedianReport(reports, queries)
  } else {
    // S77: use cachePlan.measure (not opts.cache) so the single-run path is
    // consistent with the guarded multi-run path — identical today (runs=1 →
    // measure when cache requested) but robust to future policy changes.
    report = await runEval(queries, { measureCache: cachePlan.measure, goldPath: opts.gold })
  }

  // G2 (S73): with >=2 runs the regression gate requires at least 2 runs to
  // AGREE on each regression (single-run pool noise was ~13% of queries, S67
  // G2). diffBaselineStabilized flags ndcgAt10/resultCount/responseTime/
  // passStatus only when both CI runs (or a majority of median runs) show it.
  //
  // The baseline is loaded ONCE so the gate AND the S37/S75 loss report
  // cross-reference the SAME snapshot — with --save the baseline file is
  // overwritten below, so the loss report must not self-compare against the
  // just-written baseline.
  const baselineSnapshot = loadBaseline()
  const regressions =
    runCount >= 2
      ? baselineSnapshot
        ? diffBaselineStabilized(reports, baselineSnapshot)
        : []
      : baselineSnapshot
        ? diffBaseline(report, baselineSnapshot)
        : []

  // Save baseline if requested — must run BEFORE output format block
  // so it works with --save alone (human-readable) or --save --ci (JSON)
  if (opts.save) {
    saveBaseline(report)
    console.error(`Baseline saved (${report.timestamp})\n`)
  }

  // Persist the latest FULL-POOL report to eval/results/latest.json so the
  // weekly README updater and CI artifacts can consume it without re-running.
  // Phase H fix: --tag runs are diagnostic subsets — persisting them here let
  // an 18-query conversational report overwrite the official 921-query
  // artifact, which the absolute NDCG gate (verify-ndcg-gate.ts) then judges
  // out of context. Full-pool runs only; tag AND sample runs keep stdout as
  // their record (a 12-query --sample once clobbered latest.json the same
  // way — sample reports go to sample-latest.json for auditability instead).
  if (opts.sample) {
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const resultsDir = path.join(process.cwd(), 'eval', 'results')
      fs.mkdirSync(resultsDir, { recursive: true })
      fs.writeFileSync(path.join(resultsDir, 'sample-latest.json'), formatReportJSON(report, regressions), 'utf-8')
    } catch (e) {
      console.error('Failed to write eval/results/sample-latest.json:', e)
    }
  } else if (!opts.tag) {
    try {
      const fs = await import('node:fs')
      const path = await import('node:path')
      const resultsDir = path.join(process.cwd(), 'eval', 'results')
      fs.mkdirSync(resultsDir, { recursive: true })
      fs.writeFileSync(path.join(resultsDir, 'latest.json'), formatReportJSON(report, regressions), 'utf-8')
    } catch (e) {
      console.error('Failed to write eval/results/latest.json:', e)
    }
  }

  // S37: post-median S34 wikipedia-429 loss report. Only meaningful for a
  // median run (--runs > 1) — that is the mode that persists run-1..N.json
  // AND is the one whose NDCG signal is polluted by wikipedia 429 flapping
  // (single-run eval has no run-N files). Runs after the run-*.json + latest
  // writes so the computed loss reflects exactly the artifacts the workflow
  // will upload. Emits a GitHub Actions `::warning::` annotation when the
  // weighted loss exceeds the threshold (default 5.0) — a WARNING, not a
  // failure: wikipedia 429 availability noise is not a ranking regression
  // (S33 verdict: REGRESSION 0), so the gate flags it for review without
  // blocking the run.
  if (runCount > 1 && (opts.lossThreshold ?? 5.0) > 0) {
    try {
      const { computeLossReport } = await import('../scripts/analyze-429-loss')
      // S75: pass the gate-time baseline so the cross-reference classifies
      // flags/passes against what the gate actually compared (a --save run
      // would otherwise self-compare against the baseline just written).
      const loss = computeLossReport(undefined, undefined, baselineSnapshot)
      const threshold = opts.lossThreshold ?? 5.0
      // NOTE: no log is captured in-process, so never-present+429 is reported
      // as 0 — that is UNMEASURED (needs the eval log), not actually zero. The
      // weighted-loss gate below does NOT depend on it (run-*.json only).
      console.error(
        `S37 wikipedia-429 loss report (median run): weighted ${loss.weightedLoss.toFixed(3)} · gain-sum ${loss.sumGain.toFixed(3)} · affected ${loss.nGain}/${loss.attributableCount} · coverable(EN+gold-wiki) ${loss.coverable} · still-vulnerable ${loss.stillVulnerable} · mirror-recovered(S39) ${loss.mirrorRecoveredRuns} runs/${loss.mirrorRecoveredQueries} queries · mirror-still-lost ${loss.mirrorStillLostRuns} runs/${loss.mirrorStillLostQueries} queries · never-present+429 ${loss.neverPresent}(log uncaptured — rerun scripts/analyze-429-loss.ts <log>) · gate×429(S75): flagged-by-429 ${loss.gate429.flaggedBy429.length} · clean-flags ${loss.gate429.flaggedClean.length} · passed-with-429 ${loss.gate429.passedWith429.length}`,
      )
      if (loss.weightedLoss > threshold) {
        console.error(
          `::warning::S37 wikipedia-429 weighted NDCG loss ${loss.weightedLoss.toFixed(3)} exceeds threshold ${threshold} — review scripts/analyze-429-loss.ts output; this is availability noise, not necessarily a ranking regression`,
        )
      }
    } catch (e) {
      console.error('S37 wikipedia-429 loss report failed (non-critical):', e)
    }
  }

  // Output formats
  if (opts.json || opts.ci) {
    const jsonReport = formatReportJSON(report, regressions)

    // Always write eval-results.json in CI mode for artifact upload
    if (opts.ci) {
      try {
        await import('node:fs').then((fs) => {
          fs.writeFileSync('eval-results.json', jsonReport, 'utf-8')
        })
      } catch (e) {
        console.error('Failed to write eval-results.json:', e)
      }
    }

    console.log(jsonReport)
  } else {
    console.log(formatReport(report, regressions))
  }

  // GitHub Summary (GITHUB_STEP_SUMMARY environment variable)
  if (opts.summary || (opts.ci && process.env.GITHUB_STEP_SUMMARY)) {
    const summary = formatReportSummary(report, regressions)
    try {
      const fs = await import('node:fs')
      const stepSummary = process.env.GITHUB_STEP_SUMMARY
      if (stepSummary) {
        fs.appendFileSync(stepSummary, summary + '\n')
      } else {
        // Not in GitHub Actions env — print to stderr instead (the original
        // relied on appendFileSync(undefined) throwing into the catch; an
        // explicit else keeps that fallback without the non-null assertion).
        console.error(summary)
      }
    } catch {
      // Not in GitHub Actions env, print to stderr instead
      console.error(summary)
    }
  }

  // Exit with non-zero if any query failed OR if regressions detected
  const hasFailures = report.failedQueries > 0
  const hasRegressions = regressions.length > 0

  if (hasFailures) {
    console.error(`\n❌ ${report.failedQueries} queries failed`)
  }
  if (hasRegressions) {
    console.error(`\n⚠️ ${regressions.length} regressions detected`)
  }

  // Send Slack alert on regression/failure (--ci-slack mode)
  if (opts.ciSlack && (hasFailures || hasRegressions)) {
    try {
      const slackWebhook = process.env.SLACK_WEBHOOK
      if (slackWebhook) {
        const { buildSlackPayload } = await import('./metrics')
        const payload = buildSlackPayload({
          passRate: report.passRate,
          failedQueries: report.failedQueries,
          regressions: regressions.map((d) => ({
            queryId: d.queryId,
            metric: d.metric,
            baseline: d.baseline,
            current: d.current,
          })),
          avgTimeMs: report.avgTimeMs,
          p95: report.latencyPercentiles.p95,
          avgQps: report.qps.avgQps,
          timestamp: report.timestamp,
        })

        const response = await fetch(slackWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        })

        if (response.ok) {
          console.error('\n🔔 Slack alert sent')
        } else {
          console.error(`\n⚠️ Slack alert failed: ${response.status}`)
        }
      } else {
        console.warn('\n⚠️ SLACK_WEBHOOK not set, skipping alert')
      }
    } catch (err) {
      console.error('\n⚠️ Slack alert error:', err)
    }
  }

  if (hasFailures || hasRegressions) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Eval failed:', err)
  process.exit(2)
})
