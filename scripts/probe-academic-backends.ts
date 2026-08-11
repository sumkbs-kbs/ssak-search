/**
 * Academic-tag backend presence probe (P1 ⑤, 2026-08-10).
 *
 * 학술 태그가 최악 (0.1414, 16/26 zero) — arxiv/semanticscholar/paperswithcode
 * gold 쿼리에서 arxiv·google-scholar 백엔드가 실제로 발동하는지 저장 run에서
 * 실측한다. 라우팅 문제인지(백엔드 미발동) 회수 문제인지(발동하나 gold 미회수)를
 * 구분한다.
 *
 * Usage: npx tsx scripts/probe-academic-backends.ts
 */
import { EVAL_QUERIES } from '../eval/queries'
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards } from '../eval/metrics'

const gold = loadGoldStandards() as Record<string, string[]>
const runs = parseRunFiles('eval').map((rf) => rf.report)
const acad = EVAL_QUERIES.filter((q) => (q.tags ?? []).includes('academic'))

console.log('academic queries:', acad.length, acad.map((q) => q.id).join(', '))
let noArxiv = 0
let noScholar = 0
let noGold = 0
for (const q of acad) {
  const id = q.id
  const rows: string[] = []
  for (const run of runs) {
    const rq = (run.results ?? []).find((x) => x.query?.id === id)
    if (!rq) {
      rows.push('MISSING')
      continue
    }
    const bs = (rq.backends ?? []) as string[]
    const pool = (rq.response?.results ?? []) as Array<{ domain?: string }>
    const g = gold[id] ?? []
    const hit = pool.some((r) => {
      const d = (r.domain ?? '').toLowerCase()
      return g.some((x) => d === x || d.endsWith('.' + x))
    })
    if (!bs.includes('arxiv')) noArxiv++
    if (!bs.includes('google-scholar')) noScholar++
    if (!hit) noGold++
    rows.push(
      `arxiv=${bs.includes('arxiv') ? 'Y' : 'N'} scholar=${bs.includes('google-scholar') ? 'Y' : 'N'} pool=${pool.length} goldHit=${hit}`,
    )
  }
  console.log(id.padEnd(14), '|', rows.join(' | '))
}
console.log(
  '\nrun 합계: arxiv 미발동',
  noArxiv,
  '· scholar 미발동',
  noScholar,
  '· gold 미회수',
  noGold,
  `(총 ${acad.length * runs.length} run)`,
)
