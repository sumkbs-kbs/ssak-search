// S67: measure the single-run eval gate's false-regression rate. Each stored
// run-1..3 is an independent single-run snapshot; recomputing NDCG@10 under
// the CURRENT gold (S54 path) and diffing run-vs-run shows how often pure run
// noise would trip the -0.05 gate (diffBaseline's ndcgAt10 threshold).
import { readFileSync } from 'fs'
import { computeNdcg, loadGoldStandards } from '../eval/metrics'
import type { SearchResult } from '../src/types'

interface StoredQuery {
  query: { id: string }
  response: { results: SearchResult[] } | null
  backends?: string[]
}
interface StoredReport {
  results?: StoredQuery[]
  report?: { results?: StoredQuery[] }
}

const gold = loadGoldStandards()
type Pool = { id: string; results: SearchResult[]; hasWiki: boolean }
const runs: Record<number, Pool[]> = {}
for (const n of [1, 2, 3]) {
  const r = JSON.parse(readFileSync(`eval/results/run-${n}.json`, 'utf8')) as StoredReport
  runs[n] = (r.results ?? r.report?.results ?? [])
    .filter((q) => q?.query?.id && Array.isArray(q?.response?.results))
    .map((q) => ({
      id: q.query.id,
      results: q.response?.results ?? [],
      hasWiki: (q.backends ?? []).some((b) => b.toLowerCase().includes('wikipedia')),
    }))
}
const ndcg = (pool: SearchResult[], id: string): number | undefined =>
  gold[id] && pool.length > 0 ? computeNdcg(pool, gold[id], 10) : gold[id] ? 0 : undefined

const pairs: Array<[number, number]> = [
  [1, 2],
  [2, 3],
  [1, 3],
]
let flags = 0
let compared = 0
let availAttrib = 0 // losing run lacked wikipedia (availability-driven pool loss)
let rankingNoise = 0 // both runs had wikipedia (pure ranking/run variance)
const flagIds = new Set<string>()
for (const [a, b] of pairs) {
  const bMap = new Map(runs[b].map((p) => [p.id, p]))
  for (const pa of runs[a]) {
    const pb = bMap.get(pa.id)
    if (!pb) continue
    const x = ndcg(pa.results, pa.id)
    const y = ndcg(pb.results, pa.id)
    if (x === undefined || y === undefined) continue
    compared++
    if (x - y < -0.05) {
      flags++
      flagIds.add(pa.id)
      // losing side = the run with the lower NDCG
      if (x < y) {
        if (!pa.hasWiki) availAttrib++
        else if (pb.hasWiki) rankingNoise++
      } else {
        if (!pb.hasWiki) availAttrib++
        else if (pa.hasWiki) rankingNoise++
      }
    }
  }
}
console.log(`run-pairs compared=${compared}  gate flags(< -0.05)=${flags} (${((flags / compared) * 100).toFixed(2)}%)`)
console.log(`  availability-attributable (losing run lacked wikipedia): ${availAttrib}`)
console.log(`  ranking/run-noise (both runs had wikipedia):              ${rankingNoise}`)
console.log(`distinct queries flagging in >=1 pair: ${flagIds.size}`)
console.log('flags by pair:')
for (const [a, b] of pairs) {
  const bMap = new Map(runs[b].map((p) => [p.id, p]))
  let f = 0
  let c = 0
  for (const pa of runs[a]) {
    const pb = bMap.get(pa.id)
    if (!pb) continue
    const x = ndcg(pa.results, pa.id)
    const y = ndcg(pb.results, pa.id)
    if (x === undefined || y === undefined) continue
    c++
    if (x - y < -0.05) f++
  }
  console.log(`  run${a} vs run${b}: ${f}/${c}`)
}
