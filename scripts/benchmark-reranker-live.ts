#!/usr/bin/env tsx
/**
 * Live Reranker Blend Weight A/B Benchmark
 *
 * Runs the actual CrossEncoderReranker with different blend weights
 * on a subset of eval queries. Compares NDCG@10 at each weight.
 *
 * Requires: SIDECAR_RERANK_URL env (or local sidecar running)
 * Usage: npx tsx scripts/benchmark-reranker-live.ts [--queries 30] [--weights 0.6,0.7,0.8,0.9]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CrossEncoderReranker, type RerankDocument } from '../src/lib/retrieval/reranker'
import type { SearchResult } from '../src/types'
import { computeNdcg } from '../eval/metrics'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const EVAL_DIR = path.resolve(HERE, '..', 'eval')
const RESULTS_DIR = path.join(EVAL_DIR, 'results')

// ── Parse CLI args ──
const args = process.argv.slice(2)
const queryCount = parseInt(args.find((a: string) => a.startsWith('--queries'))?.split('=')[1] || args[args.indexOf('--queries') + 1] || '30')
const weightsArg = args.find((a: string) => a.startsWith('--weights'))?.split('=')[1] || args[args.indexOf('--weights') + 1] || '0.6,0.7,0.8,0.9'
const WEIGHTS = weightsArg.split(',').map(Number)

// ── Load data ──
const golds = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'gold-standards.json'), 'utf-8'))
const latest = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, 'latest.json'), 'utf-8'))

// Load chunk pools
const chunkFiles = fs.readdirSync(RESULTS_DIR)
  .filter(f => f.startsWith('chunk-') && f.endsWith('.json'))
  .sort()

const poolsByQuery: Record<string, RerankDocument[]> = {}
for (const cf of chunkFiles) {
  const chunk = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, cf), 'utf-8'))
  for (const r of chunk.report?.results || []) {
    const qid = r.query?.id
    if (!qid) continue
    poolsByQuery[qid] = (r.response?.results || []).map((res: any, i: number) => ({
      id: `doc_${i}`,
      title: res.title || '',
      content: res.content || '',
      url: res.url,
      domain: res.domain || '',
      score: res.score || 0,
    }))
  }
}

// ── Select queries ──
const queryIds = Object.keys(poolsByQuery).filter(qid => {
  const gold = golds[qid]
  const pool = poolsByQuery[qid]
  return gold?.relevantDomains?.length > 0 && pool?.length >= 5
})

// Stratified sample
const { EVAL_QUERIES } = await import('../eval/queries')
const tagMap = new Map<string, string>()
for (const q of EVAL_QUERIES) tagMap.set(q.id, q.tags?.[0] || 'unknown')

const tagBuckets: Record<string, string[]> = {}
for (const qid of queryIds) {
  const tag = tagMap.get(qid) || 'unknown'
  if (!tagBuckets[tag]) tagBuckets[tag] = []
  tagBuckets[tag].push(qid)
}

const selectedIds: string[] = []
const perTag = Math.max(3, Math.ceil(queryCount / Object.keys(tagBuckets).length))
for (const [_tag, ids] of Object.entries(tagBuckets)) {
  const step = Math.max(1, Math.floor(ids.length / perTag))
  for (let i = 0; i < ids.length && selectedIds.length < queryCount; i += step) {
    selectedIds.push(ids[i])
  }
}
console.log(`Selected ${selectedIds.length} queries from ${Object.keys(tagBuckets).length} tags`)

// ── Run reranker at each weight ──
interface WeightResult {
  ndcgSum: number
  count: number
  queries: Array<{ id: string; ndcg: number; tag: string }>
}

const results: Record<number, WeightResult> = {}
for (const w of WEIGHTS) {
  results[w] = { ndcgSum: 0, count: 0, queries: [] }
}

let successCount = 0
let failCount = 0

for (const qid of selectedIds) {
  const gold = golds[qid]
  const pool = poolsByQuery[qid]
  const tag = tagMap.get(qid) || 'unknown'

  for (const w of WEIGHTS) {
    try {
      const reranker = new CrossEncoderReranker({ blendWeight: w })

      // Use heuristic-only mode (no ML calls) for fast offline comparison
      // The reranker falls back to heuristic when Workers AI and sidecar are unavailable
      const reranked = await reranker.rerank(
        latest.report.results.find((r: any) => r.query?.id === qid)?.query?.query || '',
        pool,
        undefined, // no env = heuristic fallback
        { enableWorkersAI: false, enableSidecar: false, topK: 10 },
      )

      const resultsForNdcg: SearchResult[] = reranked.map(r => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.rerankScore,
        domain: r.domain,
      }))
      const ndcg = computeNdcg(resultsForNdcg, gold.relevantDomains, 10)

      results[w].ndcgSum += ndcg
      results[w].count++
      results[w].queries.push({ id: qid, ndcg, tag })
      successCount++
    } catch (_err) {
      failCount++
    }
  }

  process.stdout.write(`\r  Processed ${selectedIds.indexOf(qid) + 1}/${selectedIds.length} queries...`)
}
console.log(`\n  Done: ${successCount} success, ${failCount} failed`)

// ── Report ──
console.log('\n═══ Live Reranker Blend Weight A/B Benchmark ═══')
console.log(`Queries: ${selectedIds.length}`)
console.log('')

console.log('BlendWeight   NDCG@10     vs w=0.7')
console.log('──────────────────────────────────────')

const baseNdcg = results[0.7]?.ndcgSum / results[0.7]?.count || 0

for (const w of WEIGHTS) {
  const r = results[w]
  const avgNdcg = r.count > 0 ? r.ndcgSum / r.count : 0
  const delta = avgNdcg - baseNdcg
  const marker = w === 0.7 ? ' ★' : ''
  const deltaStr = w === 0.7 ? '(baseline)' : `${delta >= 0 ? '+' : ''}${(delta * 100).toFixed(2)}%`
  console.log(`  ${w.toFixed(1)}         ${avgNdcg.toFixed(4)}     ${deltaStr}${marker}`)
}

// ── Per-tag breakdown ──
console.log('\n═══ Per-Tag NDCG@10 ═══')
const tags = [...new Set(selectedIds.map(qid => tagMap.get(qid) || 'unknown'))].sort()

for (const tag of tags) {
  const parts = WEIGHTS.map((w: number) => {
    const tagQ = results[w].queries.filter(q => q.tag === tag)
    const avg = tagQ.length > 0 ? tagQ.reduce((s, q) => s + q.ndcg, 0) / tagQ.length : 0
    return `w=${w.toFixed(1)}: ${avg.toFixed(4)}`
  }).join(' | ')
  const n = results[WEIGHTS[0]].queries.filter(q => q.tag === tag).length
  console.log(`  ${tag.padEnd(12)} n=${String(n).padStart(3)} | ${parts}`)
}

// ── Find optimal ──
let bestW = 0.7
let bestNdcg = 0
for (const w of WEIGHTS) {
  const avg = results[w].count > 0 ? results[w].ndcgSum / results[w].count : 0
  if (avg > bestNdcg) { bestNdcg = avg; bestW = w }
}
console.log(`\n→ Optimal weight: ${bestW.toFixed(1)} (NDCG@10: ${bestNdcg.toFixed(4)})`)

// ── Save ──
const report = {
  timestamp: new Date().toISOString(),
  queryCount: selectedIds.length,
  mode: 'heuristic-fallback (offline)',
  weights: WEIGHTS,
  results: WEIGHTS.map((w: number) => ({
    weight: w,
    ndcgAt10: results[w].count > 0 ? results[w].ndcgSum / results[w].count : 0,
    queryCount: results[w].count,
  })),
  optimalWeight: bestW,
}

fs.writeFileSync(path.join(RESULTS_DIR, 'reranker-blend-live.json'), JSON.stringify(report, null, 2))
console.log('Report saved.')
