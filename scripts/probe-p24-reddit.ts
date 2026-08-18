/**
 * P24 reddit-gold 라이브 검증 프로브 (2026-08-14) — 작업 중간 확인용.
 *
 * general 태그에서 reddit.com gold를 가진 13쿼리를 executeSearch로 직접
 * 실행해 NDCG@10 (S54 재계산 규칙) 회수 여부를 확인한다. eval 벌크(91쿼리
 * 연속)와 달리 13쿼리만 실행해 DDG 202/reddit 레이트리밋 영향이 작다.
 *
 * 사용: npx tsx scripts/probe-p24-reddit.ts
 */
import { executeSearch } from '../src/lib/orchestrator'
import { EVAL_QUERIES } from '../eval/queries'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import type { SearchResult } from '../src/types'

const REDDIT_GOLD_IDS = [
  'en-general-06',
  'en-general-07',
  'en-general-08',
  'en-general-09',
  'en-general-10',
  'en-general-12',
  'en-general-13',
  'en-general-14',
  'en-general-15',
  'en-general-17',
  'en-general-18',
  'en-general-19',
  'adv-11',
]

async function main(): Promise<void> {
  const gold = loadGoldStandards()
  const byId = new Map(EVAL_QUERIES.map((q) => [q.id, q]))
  console.log('=== P24 reddit-gold 라이브 프로브 (13쿼리) ===')
  let recovered = 0
  for (const id of REDDIT_GOLD_IDS) {
    const q = byId.get(id)
    if (!q) continue
    const goldDomains = gold[id] ?? []
    const t0 = Date.now()
    try {
      const resp = await executeSearch(
        { query: q.query, topic: q.topic, max_results: 10, include_answer: false },
        { env: { EVAL_MODE: 'true' } as never },
      )
      const pool = (resp.results ?? []) as SearchResult[]
      const ndcg = computeNdcg(pool, goldDomains, 10)
      const redditInPool = pool.some((r) => {
        const d = (r.domain ?? '').toLowerCase()
        return d === 'reddit.com' || d.endsWith('.reddit.com')
      })
      const backends = (resp.backend ?? '').split('+').filter(Boolean).join('+')
      if (ndcg > 0) recovered++
      console.log(
        `  ${id.padEnd(15)} NDCG=${ndcg.toFixed(3)} redditInPool=${redditInPool} ${Date.now() - t0}ms | ${backends}`,
      )
    } catch (err) {
      console.log(`  ${id.padEnd(15)} ERROR ${(err as Error).message.slice(0, 80)}`)
    }
  }
  console.log(`\n회수: ${recovered}/${REDDIT_GOLD_IDS.length} (NDCG>0)`)
}

main()
