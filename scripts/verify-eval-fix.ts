/**
 * Verify the two failing eval queries (en-fact-01, zh-general-04) after fixes.
 * Runs ONLY those queries against the live orchestrator (like eval runner).
 *
 * Usage: npx tsx scripts/verify-eval-fix.ts
 */
import { EVAL_QUERIES } from '../eval/queries'
import { runEval } from '../eval/runner'
import { formatReport } from '../eval/reporter'

async function main() {
  const targetIds = new Set(['en-fact-01', 'zh-general-04'])
  const queries = EVAL_QUERIES.filter((q) => targetIds.has(q.id))
  console.error(`Running ${queries.length} targeted eval queries: ${queries.map((q) => q.id).join(', ')}\n`)

  const report = await runEval(queries, {})
  console.log(formatReport(report, []))

  const failed = report.results.filter((r) => !r.passed)
  console.error(`\n=== RESULT: ${report.passedQueries}/${report.totalQueries} passed ===`)
  if (failed.length === 0) {
    console.error('✅ BOTH FIXED')
  } else {
    failed.forEach((r) =>
      console.error(
        `❌ ${r.query.id}: ${r.failures.join('; ')} (${r.resultCount} results, backends: ${r.backends.join(', ')})`,
      ),
    )
    process.exit(1)
  }
}

main().catch((err) => {
  console.error('Verification failed:', err)
  process.exit(2)
})
