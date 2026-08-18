/**
 * P1-6 청크 eval 러너 — 600쿼리 전체를 100개씩 분할 실행해 각 청크의
 * 리포트를 eval/results/chunk-N-M.json 으로 저장한다.
 *
 * 턴 타임아웃(600s) 내 완료를 보장하기 위해 한 프로세스당 한 청크만 실행:
 *   npx tsx scripts/run-eval-chunk.ts <startIndex>
 *   (startIndex=0 → 쿼리 0..99, 100 → 100..199, ...)
 *
 * 완료 후 전체 zero-gold 리포트:
 *   npx tsx scripts/report-zero-gold.ts \
 *     --extra eval/results/chunk-0-100.json ... (전 청크) \
 *     --markdown docs/21_ZERO_GOLD_REPORT.md
 */
import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { EVAL_QUERIES } from '../eval/queries'
import { runEval } from '../eval/runner'

const CHUNK = 100
const start = Number(process.argv[2] ?? 0)
if (!Number.isInteger(start) || start < 0 || start >= EVAL_QUERIES.length) {
  console.error(`usage: npx tsx scripts/run-eval-chunk.ts <startIndex 0..${EVAL_QUERIES.length - 1}>`)
  process.exit(1)
}
const end = Math.min(start + CHUNK, EVAL_QUERIES.length)
const queries = EVAL_QUERIES.slice(start, end)
console.error(`[chunk] ${start}..${end} (${queries.length} queries) — 시작 ${new Date().toISOString()}`)

const report = await runEval(queries, {})
const out = `eval/results/chunk-${start}-${end}.json`
writeFileSync(resolve(process.cwd(), out), JSON.stringify({ report }, null, 2), 'utf-8')
console.log(`[chunk] 완료 ${start}..${end} — 저장 ${out} — ${new Date().toISOString()}`)
