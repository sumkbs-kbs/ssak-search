/**
 * S95 대형 하락 쿼리 원인 판별 (2026-08-11).
 *
 * 저장 run-1..3 (S95 후)에서 하락 쿼리들의 백엔드 구성과 wikipedia 유무를
 * 확인해 — wikipedia 429 가용성 노이즈인지, S95 변경(E 아웃렛/G arxiv ceiling)
 * 회귀인지 구분한다. lt-06/lt-13/en-tech-13/en-news-11/zh-general-01 등.
 *
 * Usage: npx tsx scripts/probe-s95-drops.ts
 */
import { parseRunFiles } from '../eval/run-files'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'

const gold = loadGoldStandards() as Record<string, string[]>
const runs = parseRunFiles('eval').map((rf) => rf.report)

const ids = [
  'lt-06',
  'lt-13',
  'en-tech-13',
  'lt-03',
  'ja-tech-04',
  'en-news-11',
  'zh-general-01',
  'ja-fact-11',
  'xl-08',
  'en-fact-29',
]

for (const id of ids) {
  console.log(`=== ${id} | gold: ${(gold[id] ?? []).join(', ')} ===`)
  for (const run of runs) {
    const rq = (run.results ?? []).find((x) => x.query?.id === id)
    if (!rq) {
      console.log('  run: MISSING')
      continue
    }
    const bs = (rq.backends ?? []) as string[]
    const pool = (rq.response?.results ?? []) as Array<{ domain?: string }>
    const ndcg = computeNdcg(pool as never, gold[id] ?? [], 10)
    const hasWiki = pool.some((r) => (r.domain ?? '').includes('wikipedia.org'))
    const wikiB = bs.includes('wikipedia')
    console.log(
      `  run: backends=[${bs.join(',')}] wikiInPool=${hasWiki} wikiBackend=${wikiB} pool=${pool.length} NDCG=${ndcg.toFixed(3)}`,
    )
  }
}
