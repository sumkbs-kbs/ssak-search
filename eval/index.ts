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
import { computeMedianReport } from './median'
import { saveBaseline, compareWithBaseline } from './baseline'
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
}

function parseArgs(): CliArgs {
  const args = process.argv.slice(2)
  const opts: CliArgs = {}

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case '--help': opts.help = true; break
      case '--save': opts.save = true; break
      case '--json': opts.json = true; break
      case '--summary': opts.summary = true; break
      case '--ci': opts.ci = true; opts.json = true; break
      case '--ci-slack': opts.ciSlack = true; opts.ci = true; opts.json = true; break
      case '--cache': opts.cache = true; break
      case '--runs':
        opts.runs = Number(args[++i])
        if (!Number.isInteger(opts.runs) || opts.runs < 1 || opts.runs > 9) {
          console.error('--runs must be an integer between 1 and 9')
          process.exit(1)
        }
        break
      case '--tag':
        opts.tag = args[++i]
        break
    }
  }

  return opts
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
  --tag <tag>  Run only queries with the specified tag (e.g. 'korean', 'english')
  --runs <n>   Run the eval n times (1-9) and report per-query MEDIAN values,
               robust to backend availability noise (default: 1)
`)
    process.exit(0)
  }

  // Filter queries by tag if specified
  const queries = opts.tag
    ? EVAL_QUERIES.filter((q) => q.tags?.includes(opts.tag!))
    : EVAL_QUERIES

  if (queries.length === 0) {
    console.error(`No queries found for tag "${opts.tag}"`)
    process.exit(1)
  }

  const runCount = opts.runs ?? 1
  if (runCount > 1) {
    console.error(`Running ${queries.length} eval queries × ${runCount} runs (median aggregation)...\n`)
  } else {
    console.error(`Running ${queries.length} eval queries...\n`)
  }

  // Single run, or N runs aggregated by per-query median (robust to backend noise)
  let report: EvalReport
  if (runCount > 1) {
    const reports: EvalReport[] = []
    const fs = await import('node:fs')
    const path = await import('node:path')
    const resultsDir = path.join(process.cwd(), 'eval', 'results')
    fs.mkdirSync(resultsDir, { recursive: true })
    for (let i = 1; i <= runCount; i++) {
      console.error(`  ─ run ${i}/${runCount} ─`)
      const rep = await runEval(queries, { measureCache: opts.cache })
      reports.push(rep)
      // Persist each raw run for auditability (run-1.json … run-N.json).
      // Regressions are intentionally NOT computed here — per-run diffs against
      // a moving baseline are ambiguous; the median report is the signal.
      try {
        fs.writeFileSync(
          path.join(resultsDir, `run-${i}.json`),
          JSON.stringify({ report: rep }, null, 2),
          'utf-8',
        )
      } catch (e) {
        console.error(`Failed to write eval/results/run-${i}.json:`, e)
      }
    }
    report = computeMedianReport(reports, queries)
  } else {
    report = await runEval(queries, { measureCache: opts.cache })
  }
  const regressions = compareWithBaseline(report)

  // Save baseline if requested — must run BEFORE output format block
  // so it works with --save alone (human-readable) or --save --ci (JSON)
  if (opts.save) {
    saveBaseline(report)
    console.error(`Baseline saved (${report.timestamp})\n`)
  }

  // Always persist the latest report to eval/results/latest.json so the
  // weekly README updater and CI artifacts can consume it without re-running.
  try {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const resultsDir = path.join(process.cwd(), 'eval', 'results')
    fs.mkdirSync(resultsDir, { recursive: true })
    fs.writeFileSync(
      path.join(resultsDir, 'latest.json'),
      formatReportJSON(report, regressions),
      'utf-8',
    )
  } catch (e) {
    console.error('Failed to write eval/results/latest.json:', e)
  }

  // Output formats
  if (opts.json || opts.ci) {
    const jsonReport = formatReportJSON(report, regressions)

    // Always write eval-results.json in CI mode for artifact upload
    if (opts.ci) {
      try {
        await import('node:fs').then(fs => {
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
      fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY!, summary + '\n')
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
          regressions: regressions.map(d => ({
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
