/**
 * academic 풀 SO 삽입 회귀 스캔 (S103, 2026-08-11).
 *
 * S100이 academic 라우팅에 stackexchange 태스크를 추가하면서, en-acad/ds 풀에
 * stackoverflow.com 결과가 진입할 수 있게 됐다. 이 스크립트는 저장 run(S101 eval)
 * 풀에 SO 결과 삽입을 시뮬레이션해 **arxiv gold가 밀려나는 쿼리**가 있는지 스캔한다:
 *
 *   S1/S2/S3 — SO 1건을 rank 1/2/3에 삽입 (task 최상위 결과가 상위 진입 가정)
 *   S8       — SO 8건을 끝에 삽입 후 top-10 절단 (최악 — 하위 슬롯을 SO가 점유)
 *
 * 지표: 각 시나리오의 NDCG@10 Δ (S54 실시간 재계산) + arxiv gold의 top-10 잔존.
 * 판정: min NDCG < 현재 - 0.05 또는 arxiv gold top-10 이탈 쿼리를 회귀 리스크로 플래그.
 *
 * Usage: npx tsx scripts/sim-academic-so-regression.ts
 */
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import { EVAL_QUERIES } from '../eval/queries'
import { detectQueryType } from '../src/lib/specialized'
import type { SearchResult } from '../src/types'

const SO = 'stackoverflow.com'
const ARXIV = 'arxiv.org'

const runs = parseRunFiles('eval').map((rf) => rf.report)
if (runs.length === 0) throw new Error('no run files')
const gold = loadGoldStandards() as Record<string, string[]>

const acad = EVAL_QUERIES.filter((q) => detectQueryType(q.query) === 'academic')

interface ScenarioResult {
  label: string
  after: number
  arxivInTop10: boolean
}

function makeSo(title: string): SearchResult {
  return {
    title,
    url: 'https://stackoverflow.com/questions/1',
    content: 'Stack Overflow community answer',
    domain: SO,
    score: 0.99,
  }
}

const med = (a: number[]): number => {
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const arxivCount = (pool: Array<{ domain?: string }>): number =>
  pool.filter((r) => (r.domain ?? '').toLowerCase() === ARXIV).length

function main(): void {
  console.log(`=== academic 풀 SO 삽입 회귀 스캔 (대상 ${acad.length}쿼리 × ${runs.length}run) ===`)
  console.log(`arxiv gold 보유 풀: 82/87 (S101 eval) · SO 포함 풀: 0 (쿼터 스킵) — 순수 삽입 시뮬레이션\n`)

  interface Row {
    cur: number[]
    min: number[]
    arxivLost: boolean
    arxivPresent: boolean
  }
  const rows = new Map<string, Row>()

  for (const q of acad) {
    const id = q.id
    const g = gold[id] ?? []
    const hasArxivGold = g.some((d) => d === ARXIV || d.endsWith(`.${ARXIV}`))
    for (const run of runs) {
      const rq = (run.results ?? []).find((x) => x.query?.id === id)
      if (!rq) continue
      const pool = (rq.response?.results ?? []) as SearchResult[]
      const before = computeNdcg(pool, g, 10)
      const row = rows.get(id) ?? { cur: [], min: [], arxivLost: false, arxivPresent: false }
      row.cur.push(before)
      if (arxivCount(pool) > 0) row.arxivPresent = true

      const scenarios: ScenarioResult[] = []
      for (const rank of [1, 2, 3]) {
        const inserted = [...pool.slice(0, rank - 1), makeSo(`SO rank ${rank}`), ...pool.slice(rank - 1)].slice(0, 10)
        scenarios.push({
          label: `rank ${rank}`,
          after: computeNdcg(inserted, g, 10),
          arxivInTop10: arxivCount(inserted) > 0,
        })
      }
      const filled = [...pool, ...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => makeSo(`SO ${i}`))].slice(0, 10)
      scenarios.push({ label: '8건 끝', after: computeNdcg(filled, g, 10), arxivInTop10: arxivCount(filled) > 0 })

      const minAfter = Math.min(...scenarios.map((s) => s.after))
      row.min.push(minAfter)
      if (hasArxivGold && arxivCount(pool) > 0 && scenarios.some((s) => !s.arxivInTop10)) row.arxivLost = true
      rows.set(id, row)
    }
  }

  const atRisk: Array<[string, number, number, boolean]> = []
  for (const [id, row] of rows) {
    const curM = med(row.cur)
    const minM = med(row.min)
    const drop = curM - minM
    if (drop > 0.05 || row.arxivLost) atRisk.push([id, curM, minM, row.arxivLost])
  }
  atRisk.sort((a, b) => b[1] - b[2] - (a[1] - a[2]))

  console.log(`--- 회귀 리스크 쿼리 (min NDCG 하락 >0.05 또는 arxiv gold top-10 이탈): ${atRisk.length}건 ---`)
  for (const [id, cur, min, lost] of atRisk) {
    console.log(
      `  ${id.padEnd(12)} 현재 ${cur.toFixed(4)} → 최악 ${min.toFixed(4)} (Δ${(cur - min).toFixed(4)}) arxiv이탈=${lost ? 'Y' : 'N'}`,
    )
  }
  if (atRisk.length === 0) console.log('  (없음)')

  console.log(`\n--- 모든 academic 쿼리의 min NDCG 하락 분포 ---`)
  const drops: Array<[string, number]> = []
  for (const [id, row] of rows) drops.push([id, med(row.cur) - med(row.min)])
  drops.sort((a, b) => b[1] - a[1])
  for (const [id, d] of drops) console.log(`  ${id.padEnd(12)} Δ-${d.toFixed(4)}`)
}

main()
