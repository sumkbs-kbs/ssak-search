/**
 * en-tech-40 라이브 풀 실측 (S102, 2026-08-11).
 *
 * S99(technical 라우팅) + S100(academic/technical SO 태스크) 포함 상태에서
 * 'machine learning model deployment'를 실제 오케스트레이터로 검색해 풀 구성을
 * 확인한다 — stackoverflow.com/github.com/developer.mozilla.org gold가 실제로
 * 들어오는지 + 회복 폭(gold hit 수·NDCG)을 정량화. S101 eval에서는 SO 쿼터
 * 소진(356 스킵)으로 stackoverflow.com이 빠졌으므로, 이 probe는 쿼터 여유
 * 상태의 실측이다.
 * Usage: npx tsx scripts/probe-en-tech-40-live.ts
 */
import { executeSearch } from '../src/lib/orchestrator'
import { loadGoldStandards, computeNdcg } from '../eval/metrics'
import type { SearchRequest } from '../src/types'

const gold = (loadGoldStandards() as Record<string, string[]>)['en-tech-40'] ?? [
  'github.com',
  'stackoverflow.com',
  'developer.mozilla.org',
  'dev.to',
  'medium.com',
  'freecodecamp.org',
  'digitalocean.com',
  'mlflow.org',
  'tensorflow.org',
]

async function main(): Promise<void> {
  const request: SearchRequest = {
    query: 'machine learning model deployment',
    max_results: 10,
    search_depth: 'advanced',
    topic: 'general',
  }
  const start = Date.now()
  const resp = await executeSearch(request, { env: undefined })
  const ms = Date.now() - start
  const pool = (resp.results ?? []) as Array<{ domain?: string; title?: string; url?: string }>
  const ndcg = computeNdcg(pool as never, gold, 10)

  console.log(`=== en-tech-40 라이브 검색 (${ms}ms) ===`)
  console.log(`pool: ${pool.length}건 · NDCG@10: ${ndcg.toFixed(4)} · gold: ${gold.join(', ')}`)
  console.log('\n--- 풀 도메인 구성 ---')
  const doms: Record<string, number> = {}
  for (const r of pool) doms[r.domain ?? ''] = (doms[r.domain ?? ''] ?? 0) + 1
  for (const [d, n] of Object.entries(doms).sort((a, b) => b[1] - a[1])) console.log(`  ${d.padEnd(30)} ${n}`)

  console.log('\n--- gold hit (label-suffix) ---')
  const hits = pool.filter((r) => {
    const d = (r.domain ?? '').toLowerCase()
    return gold.some((g) => d === g || d.endsWith(`.${g}`))
  })
  for (const h of hits) console.log(`  ${(h.domain ?? '').padEnd(28)} | ${(h.title ?? '').slice(0, 70)}`)
  if (hits.length === 0) console.log('  (none)')
}

void main()
