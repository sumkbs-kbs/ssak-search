#!/usr/bin/env tsx
/**
 * Chunked full-pool eval runner — same-environment regression measurement.
 *
 * The sandbox's Bing availability degrades absolute NDCG, so the only honest
 * way to measure Phase F/G/H effects locally is the SAME protocol as the
 * Aug-17 chunk baseline: 100-query slices, sequential, memory cache cleared
 * between chunks. Output files match eval/aggregate-chunks.ts expectations.
 *
 * Usage:
 *   npx tsx scripts/run-chunk-eval.ts --from 0 --to 100
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { EVAL_QUERIES } from '../eval/queries'
import { runEval } from '../eval/runner'
import { __clearMemoryCacheForTests } from '../src/lib/orchestrator'

function parseArgs(): { from: number; to: number } {
  const args = process.argv.slice(2)
  let from = 0
  let to = 100
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--from') from = Number(args[++i])
    if (args[i] === '--to') to = Number(args[++i])
  }
  return { from, to }
}

async function main(): Promise<void> {
  const { from, to } = parseArgs()
  const slice = EVAL_QUERIES.slice(from, to)
  console.log(`Running queries [${from}, ${to}) — ${slice.length} queries`)

  __clearMemoryCacheForTests()
  const report = await runEval(slice, {})
  fs.mkdirSync(path.join(process.cwd(), 'eval', 'results'), { recursive: true })
  const outPath = path.join(process.cwd(), 'eval', 'results', `chunk-${from}-${to}.json`)
  fs.writeFileSync(outPath, JSON.stringify({ report }, null, 1), 'utf-8')

  const ndcg = report.ranking?.avgNdcgAt10 ?? 0
  console.log(
    `\nchunk-${from}-${to}: pass=${report.passedQueries}/${report.totalQueries} ndcg=${ndcg.toFixed(4)} -> ${outPath}`,
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
