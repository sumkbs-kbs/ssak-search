#!/usr/bin/env tsx
/**
 * Deterministic Korean-NLP A/B simulation — E.5 follow-up.
 *
 * Runs against a FIXED result pool (eval/results/latest.json from the
 * 2026-08-23 korean-tag run) so backend noise is eliminated: pools are
 * identical, only SCORING differs between sides. Execute this script in TWO
 * worktrees — pre-change (git worktree @ HEAD) and post-change (current) —
 * and diff the aggregate output:
 *
 *   AB_POOLS=/abs/path/latest.json npx tsx scripts/sim-korean-stemmer-ab.ts
 *
 * The script imports live src/ scoring, so each worktree naturally evaluates
 * its own tokenizer/stemmer/expander with zero code duplication.
 */

import { readFileSync } from 'node:fs'
import { hybridScore } from '../src/lib/search/ranking'
import { expandQuery } from '../src/lib/understanding/query-expander'
import { loadGoldStandards, computeNdcg, computeMrr, computePrecisionAtK } from '../eval/metrics'

interface PoolResult {
  title: string
  url: string
  content: string
  score: number
  domain?: string
}

interface PoolItem {
  query: { id: string; query: string }
  response: { results: PoolResult[] }
}

const poolPath =
  process.env.AB_POOLS ?? '/Users/mr.k/Downloads/webapp/eval/results/latest.json'
const data = JSON.parse(readFileSync(poolPath, 'utf-8')) as {
  report?: { results: PoolItem[] }
  results?: PoolItem[]
}
const items = data.report?.results ?? data.results ?? []
const gold = loadGoldStandards()

// Fixed constants both sides — isolates the tokenizer/stemmer/expander delta.
const TITLE_WEIGHT = 2

let compared = 0
let ndcgSum = 0
let mrrSum = 0
let p10Sum = 0
let orderChanged = 0
const movers: Array<{ id: string; q: string; ndcg: number; deltaTop10: number }> = []

for (const item of items) {
  const qid = item.query?.id
  const query = item.query?.query ?? ''
  const results = item.response?.results ?? []
  if (!qid || !query || results.length < 2) continue

  const relDomains = gold[qid]
  if (!relDomains || relDomains.length === 0) continue

  const expanded = expandQuery(query)
  const rescored = results
    .map((r) => ({
      ...r,
      _s: hybridScore(query, r.title, r.content, undefined, r.url, TITLE_WEIGHT, expanded),
    }))
    .sort((a, b) => b._s - a._s)

  // Order-stability check on the saved pipeline scores vs rescored order.
  const topUrlsBefore = results.slice(0, 10).map((r) => r.url)
  const topUrlsAfter = rescored.slice(0, 10).map((r) => r.url)
  if (topUrlsBefore.join('\n') !== topUrlsAfter.join('\n')) orderChanged++

  const ndcg = computeNdcg(rescored as never, relDomains, 10)
  const mrr = computeMrr(rescored as never, relDomains)
  const p10 = computePrecisionAtK(rescored as never, relDomains, 10)

  // Delta vs the SAVED (live-pipeline) ranking for context.
  const ndcgSaved = computeNdcg(results as never, relDomains, 10)

  compared++
  ndcgSum += ndcg
  mrrSum += mrr
  p10Sum += p10
  movers.push({ id: qid, q: query, ndcg, deltaTop10: ndcg - ndcgSaved })
}

movers.sort((a, b) => Math.abs(b.deltaTop10) - Math.abs(a.deltaTop10))

console.log('═══ Korean-NLP A/B side report ═══')
console.log(`pool file:        ${poolPath}`)
console.log(`queries compared: ${compared} (with gold standards)`)
if (compared > 0) {
  console.log(`NDCG@10 mean:     ${(ndcgSum / compared).toFixed(4)}`)
  console.log(`MRR mean:         ${(mrrSum / compared).toFixed(4)}`)
  console.log(`Precision@10:     ${(p10Sum / compared).toFixed(4)}`)
}
console.log(`top-10 order differs from saved live ranking: ${orderChanged}/${compared}`)
console.log('')
console.log('Top 15 |ΔNDCG| vs saved live ranking:')
for (const m of movers.slice(0, 15)) {
  const sign = m.deltaTop10 >= 0 ? '+' : ''
  console.log(`  ${sign}${m.deltaTop10.toFixed(4)}  ${m.id}  (${m.q.slice(0, 30)})  ndcg=${m.ndcg.toFixed(3)}`)
}
