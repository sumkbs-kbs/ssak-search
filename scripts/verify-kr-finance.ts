/**
 * Check Korean finance routing + NDCG after the bing fallback fix.
 *
 * Mirrors the eval path: topic: 'finance' → isFinance → korean finance cascade.
 * Gold domains are loaded from the canonical eval/gold-standards.json (single
 * source of truth — no inline duplication).
 *
 * S54 (2026-08-08): this script NEVER reads a stored ranking field — it runs
 * a LIVE search and recomputes NDCG@10 on the fresh pool via
 * computeRankingMetrics (→ computeNdcg with the CURRENT S49 label-suffix
 * matcher + S50 DCG cap). The stored run-*.json `ranking` values are only
 * valid for the gold+rules that were live when that run was saved; a live
 * verify must not inherit their staleness.
 *
 * Usage: npx tsx scripts/verify-kr-finance.ts
 */
import { executeSearch } from '../src/lib/orchestrator'
import { computeRankingMetrics } from '../eval/metrics'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const gold = JSON.parse(readFileSync(join(process.cwd(), 'eval', 'gold-standards.json'), 'utf-8')) as Record<
  string,
  { relevantDomains?: string[] }
>

const QUERIES: Array<[string, string]> = [
  ['배당주 추천 2025', 'kr-stock-13'],
  ['코스닥 지수 오늘', 'kr-stock-12'],
  ['한국은행 기준금리', 'kr-fin-08'],
  ['ETF 투자 방법 초보', 'kr-stock-14'],
  ['삼성전자 주가', 'kr-stock-01'],
  ['카카오 실적 발표', 'kr-stock-02'],
]

for (const [q, id] of QUERIES) {
  const relevantDomains = gold[id]?.relevantDomains ?? []
  const r = await executeSearch({ query: q, topic: 'finance', max_results: 10, include_answer: false }, { env: {} })
  const ndcg = computeRankingMetrics(r.results ?? [], relevantDomains)?.ndcgAt10.toFixed(4) ?? 'n/a'
  console.log(`${id.padEnd(13)} ${q.padEnd(16)} count: ${r.results?.length} | backend: ${r.backend} | NDCG@10: ${ndcg}`)
  for (const res of (r.results ?? []).slice(0, 2)) {
    console.log('   -', (res.title ?? '').slice(0, 55), '|', res.domain ?? res.url?.split('/')[2])
  }
}
