#!/usr/bin/env node
/**
 * Self-Index Eval Harness — BM25 + Vectorize RRF benchmark CLI.
 *
 * Usage:
 *   npx tsx eval/index-self.ts                # run all self-index queries
 *   npx tsx eval/index-self.ts --save         # save new baseline
 *   npx tsx eval/index-self.ts --json         # JSON report
 *   npx tsx eval/index-self.ts --tag bm25     # run only BM25-tagged queries
 *   npx tsx eval/index-self.ts --help         # show help
 */

import { SELF_INDEX_QUERIES } from './queries-self'
import { runSelfIndexEval, diffSelfIndexBaseline } from './runner-self'
import { saveSelfIndexBaseline, loadSelfIndexBaseline, compareWithSelfIndexBaseline } from './baseline-self'
import { formatReport, formatReportJSON, formatReportSummary } from './reporter'

interface CliArgs {
  help?: boolean
  save?: boolean
  json?: boolean
  summary?: boolean
  ci?: boolean
  tag?: string
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
Usage: npx tsx eval/index-self.ts [options]

Benchmark BM25 + Vectorize RRF search quality.

Options:
  --help       Show this help
  --save       Save results as new baseline
  --json       Output JSON report (default: human-readable)
  --summary    Output GitHub Summary markdown (to stderr for logging)
  --ci         CI mode: JSON output + exit code only (for automation)
  --tag <tag>  Run only queries with the specified tag (e.g. 'bm25', 'rrf', 'integration')
               Available tags: bm25, keyword, title-weight, korean, stop-words, partial,
               tf-saturation, long-doc, rrf, hybrid, integration, edge-case, pipeline
`)
    process.exit(0)
  }

  // Filter queries by tag if specified
  let queries = SELF_INDEX_QUERIES
  if (opts.tag) {
    queries = SELF_INDEX_QUERIES.filter((q) => q.tags?.includes(opts.tag!))
    if (queries.length === 0) {
      console.error(`No self-index queries found for tag "${opts.tag}"`)
      process.exit(1)
    }
  }

  console.error(`\n  🔍 Self-Index Eval: ${queries.length} queries`)
  console.error(`  ${'─'.repeat(45)}`)

  const report = await runSelfIndexEval(queries)

  // Compare with self-index baseline (separate from orchestrator baseline)
  const regressions = compareWithSelfIndexBaseline(report, diffSelfIndexBaseline)

  // Save baseline if requested
  if (opts.save) {
    saveSelfIndexBaseline(report)
    console.error(`  ✓ Self-index baseline saved (${report.timestamp})\n`)
  }

  // Output formats
  if (opts.json || opts.ci) {
    const jsonReport = formatReportJSON(report, regressions)

    if (opts.ci) {
      try {
        const fs = await import('node:fs')
        fs.writeFileSync('eval-self-results.json', jsonReport, 'utf-8')
      } catch (e) {
        console.error('Failed to write eval-self-results.json:', e)
      }
    }

    console.log(jsonReport)
  } else {
    console.log(formatReport(report, regressions))
  }

  // GitHub Summary
  if (opts.summary) {
    const summary = formatReportSummary(report, regressions)
    try {
      const fs = await import('node:fs')
      if (process.env.GITHUB_STEP_SUMMARY) {
        fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY!, summary + '\n')
      }
    } catch {
      console.error(summary)
    }
  }

  // Exit with non-zero on failures or regressions
  const hasFailures = report.failedQueries > 0
  const hasRegressions = regressions.length > 0

  if (hasFailures) {
    console.error(`\n  ❌ ${report.failedQueries}/${report.totalQueries} queries failed`)
  }
  if (hasRegressions) {
    console.error(`\n  ⚠️  ${regressions.length} regressions detected`)
  }

  if (hasFailures || hasRegressions) {
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Self-index eval failed:', err)
  process.exit(2)
})
