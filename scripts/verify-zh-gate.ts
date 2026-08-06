/**
 * Direct verification that the 5 zh queries relaxed to minResults: 3 return
 * at least 3 results (evidence behind the gate calibration).
 * Usage: npx tsx scripts/verify-zh-gate.ts
 */
import { executeSearch } from '../src/lib/orchestrator'

const QUERIES: Array<[string, string]> = [
  ['zh-tech-04', 'Python 数据分析入门'],
  ['zh-tech-06', 'Kubernetes 部署指南'],
  ['zh-tech-08', '数据库索引原理'],
  ['zh-general-12', '考研复习计划'],
  ['xl-04', 'Gemini vs ChatGPT 性能'],
]

let allOk = true
for (const [id, query] of QUERIES) {
  const r = await executeSearch({ query, max_results: 10, include_answer: false }, { env: {} })
  const count = r.results?.length ?? 0
  const ok = count >= 3
  if (!ok) allOk = false
  console.log(`${id.padEnd(14)} count: ${count} | backend: ${r.backend} | ${ok ? '✅ >= 3' : '❌ < 3'}`)
}
console.log(allOk ? '\nAll 5 queries meet minResults: 3 ✅' : '\nSome queries below gate ❌')
process.exit(allOk ? 0 : 1)
