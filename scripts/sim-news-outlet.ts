/**
 * 뉴스 아웃렛 site: 보강 백엔드 시뮬레이션 (P1 ⑤, 2026-08-10).
 *
 * 설계: 뉴스 컨텍스트 쿼리에 대해 큐레이트 아웃렛 목록의 `site:<outlet> <query>`
 * Google News RSS 검색(메커니즘 라이브 확정 — site: 제한 10/10 존중)을 발사해
 * gold 아웃렛 결과를 풀에 보강한다. 이 스크립트는 저장 풀(run-1..3)에
 * "gold 아웃렛 1건이 rank R에 진입"을 시뮬레이션해 NDCG@10 Δ를 측정한다.
 *
 *   R=1: outlet 태스크의 최상위 결과가 rank 1 (낙관적)
 *   R=2/3: 하위 rank (보수적 — 뉴스 백엔드 결과들이 위를 차지)
 *
 * 대상: gold에 NEWS_OUTLET 도메인을 포함한 쿼리 중 해당 아웃렛이 풀에 전무한
 * 쿼리 (COVERAGE 갭). RANKING 문제(풀에 gold 있음)는 대상 아님.
 * gold 1위 아웃렛 하나만 삽입 (보수적 — 태스크의 아웃렛 예산은 유한).
 *
 * Usage: npx tsx scripts/sim-news-outlet.ts
 */
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import type { SearchResult } from '../src/types'

const NEWS_OUTLETS = [
  'reuters.com',
  'nytimes.com',
  'theverge.com',
  'bbc.com',
  'apnews.com',
  'techcrunch.com',
  'cnn.com',
  'theguardian.com',
  'wired.com',
  'bloomberg.com',
  'cnbc.com',
  'wsj.com',
  'finance.yahoo.com',
  'seekingalpha.com',
  'marketwatch.com',
  'ft.com',
  'axios.com',
  'politico.com',
  'nikkei.com',
  'nhk.or.jp',
  'businessinsider.com',
  'washingtonpost.com',
]

/** First gold outlet that is ABSENT from the pool. */
function missingOutlet(pool: SearchResult[], g: string[]): string | null {
  const present = new Set(pool.map((r) => (r.domain ?? '').toLowerCase()))
  for (const gd of g) {
    if (!NEWS_OUTLETS.some((o) => gd === o || gd.endsWith('.' + o))) continue
    const hit = [...present].some((d) => d === gd || d.endsWith('.' + gd))
    if (!hit) return gd
  }
  return null
}

function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

const runs = parseRunFiles('eval').map((rf) => rf.report)
if (runs.length === 0) throw new Error('no run files')
const gold = loadGoldStandards()

const results = new Map<string, { per: number[][]; tag: string; outlet: string }>() // per[rankIdx][runDelta]

for (const run of runs) {
  for (const q of run.results ?? []) {
    const id = q.query?.id ?? ''
    if (!id) continue
    const g = gold[id]
    if (!g || g.length === 0) continue
    const pool = (q.response?.results ?? []) as SearchResult[]
    const outlet = missingOutlet(pool, g)
    if (!outlet) continue

    const before = computeNdcg(pool, g, 10)
    const fake: SearchResult = {
      title: `${outlet} coverage`,
      url: `https://${outlet}/`,
      content: `News article from ${outlet} matching ${q.query?.query ?? id}`,
      domain: outlet,
      score: 0.99,
    } as SearchResult

    for (let rank = 1; rank <= 3; rank++) {
      const inserted = [...pool.slice(0, rank - 1), fake, ...pool.slice(rank - 1)].slice(0, 10)
      const after = computeNdcg(inserted, g, 10)
      const row = results.get(id) ?? { per: [[], [], []], tag: '', outlet }
      row.per[rank - 1].push(after - before)
      results.set(id, row)
    }
  }
}

const tagsById = new Map<string, string>()
for (const run of runs) {
  for (const q of run.results ?? []) {
    const id = q.query?.id ?? ''
    if (id && !tagsById.has(id)) tagsById.set(id, ((q.query as { tags?: string[] })?.tags ?? []).join('+'))
  }
}

console.log(`=== 뉴스 아웃렛 site: 보강 시뮬레이션 (대상: gold 아웃렛 풀 부재 쿼리) ===`)
console.log(`대상 쿼리: ${results.size}건 (${[...results.keys()].join(', ')})\n`)

for (let rank = 1; rank <= 3; rank++) {
  const deltas: number[] = []
  for (const row of results.values()) deltas.push(median(row.per[rank - 1]))
  const sum = deltas.reduce((s, x) => s + x, 0)
  console.log(
    `rank ${rank} 삽입: 평균 Δ+${(sum / deltas.length).toFixed(4)}/쿼리 · 합산 Δ+${sum.toFixed(4)} (대상 ${deltas.length}건)`,
  )
}

console.log('\n=== 쿼리별 (rank 2 삽입 기준, 보수적) ===')
const perQuery: Array<[string, number, string]> = []
for (const [id, row] of results) {
  perQuery.push([id, median(row.per[1]), row.outlet])
}
perQuery.sort((a, b) => b[1] - a[1])
for (const [id, d, outlet] of perQuery) {
  console.log(`  ${id.padEnd(14)} Δ+${d.toFixed(4)}  gold=${outlet}  [${tagsById.get(id) ?? ''}]`)
}

// by-tag cumulative
const byTag = new Map<string, number>()
for (const [id, row] of results) {
  const t = tagsById.get(id) ?? '(untagged)'
  byTag.set(t, (byTag.get(t) ?? 0) + median(row.per[1]))
}
console.log('\n=== 태그별 누적 Δ (rank 2) ===')
for (const [t, d] of [...byTag.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t.padEnd(24)} Δ+${d.toFixed(4)}`)
}
