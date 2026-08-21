#!/usr/bin/env tsx
/**
 * NDCG@10 Absolute Threshold Gate — CI quality gate.
 *
 * Checks that the latest eval report's NDCG@10 is above the configured
 * threshold. Exit 0 = PASS, exit 1 = FAIL.
 *
 * Usage:
 *   npx tsx scripts/verify-ndcg-gate.ts                    # uses default threshold 0.58
 *   npx tsx scripts/verify-ndcg-gate.ts --threshold 0.70   # target threshold
 *   npx tsx scripts/verify-ndcg-gate.ts --report path.json  # custom report path
 *
 * Exit codes:
 *   0 = PASS (NDCG@10 >= threshold)
 *   1 = FAIL (NDCG@10 < threshold)
 *   2 = SKIP (no report found)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'

const DEFAULT_THRESHOLD = 0.58
const DEFAULT_REPORT = path.join(process.cwd(), 'eval', 'results', 'latest.json')

function parseArgs() {
  const args = process.argv.slice(2)
  let threshold = DEFAULT_THRESHOLD
  let reportPath = DEFAULT_REPORT

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--threshold' && args[i + 1]) {
      threshold = parseFloat(args[i + 1])
      i++
    } else if (args[i] === '--report' && args[i + 1]) {
      reportPath = args[i + 1]
      i++
    }
  }

  return { threshold, reportPath }
}

function main() {
  const { threshold, reportPath } = parseArgs()

  // Check if report exists
  if (!fs.existsSync(reportPath)) {
    console.log(`⚠️ SKIP: No eval report found at ${reportPath}`)
    process.exit(2)
  }

  let report: any
  try {
    const raw = JSON.parse(fs.readFileSync(reportPath, 'utf-8'))
    report = raw.report || raw
  } catch (err) {
    console.error(`❌ ERROR: Failed to parse report: ${err}`)
    process.exit(1)
  }

  const ranking = report.ranking
  if (!ranking || typeof ranking.avgNdcgAt10 !== 'number') {
    console.error('❌ FAIL: Report has no ranking.avgNdcgAt10 metric')
    process.exit(1)
  }

  const ndcg = ranking.avgNdcgAt10
  const queries = ranking.queriesWithGoldStandard || report.totalQueries
  const passRate = report.passRate ? (report.passRate * 100).toFixed(1) : 'N/A'
  const delta = ndcg - threshold

  console.log('═══ NDCG@10 Quality Gate ═══')
  console.log(`  Report:        ${path.basename(reportPath)}`)
  console.log(`  Timestamp:     ${report.timestamp}`)
  console.log(`  Total Queries: ${report.totalQueries}`)
  console.log(`  Gold Queries:  ${queries}`)
  console.log(`  Pass Rate:     ${passRate}%`)
  console.log(`  NDCG@10:       ${ndcg.toFixed(4)}`)
  console.log(`  Threshold:     ${threshold}`)
  console.log(`  Delta:         ${delta >= 0 ? '+' : ''}${delta.toFixed(4)}`)
  console.log('')

  if (ndcg >= threshold) {
    console.log(`✅ PASS: NDCG@10 ${ndcg.toFixed(4)} >= ${threshold} (delta: +${delta.toFixed(4)})`)
    process.exit(0)
  } else {
    console.error(`❌ FAIL: NDCG@10 ${ndcg.toFixed(4)} < ${threshold} (delta: ${delta.toFixed(4)})`)
    console.error(`   Regressed below quality gate threshold.`)
    console.error(`   Run 'npx tsx eval/index.ts --save' after investigation to update baseline.`)
    process.exit(1)
  }
}

main()
