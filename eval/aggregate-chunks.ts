#!/usr/bin/env tsx
/**
 * Aggregate chunk eval results into a single unified report.
 * 
 * Usage: npx tsx eval/aggregate-chunks.ts [--save-baseline]
 * 
 * Reads eval/results/chunk-{start}-{end}.json files and produces:
 * - eval/results/latest.json (unified report)
 * - eval/baseline.json (if --save-baseline)
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalReport, EvalResult, AggregateRankingMetrics, LatencyPercentiles, QPSMetrics } from './types'
import { computeNdcg } from './metrics'
import type { SearchResult } from '../src/types'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const EVAL_DIR = HERE
const RESULTS_DIR = path.join(EVAL_DIR, 'results')

interface ChunkReport {
  report: EvalReport
  results?: EvalResult[]
}

function loadChunks(): ChunkReport[] {
  const chunks: ChunkReport[] = []
  const files = fs.readdirSync(RESULTS_DIR)
    .filter(f => f.startsWith('chunk-') && f.endsWith('.json'))
    .sort((a, b) => {
      const aStart = parseInt(a.split('-')[1])
      const bStart = parseInt(b.split('-')[1])
      return aStart - bStart
    })

  for (const file of files) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf-8'))
      chunks.push(data)
      console.error(`  loaded ${file}: ${data.report.totalQueries} queries`)
    } catch (e) {
      console.error(`  skip ${file}: ${e}`)
    }
  }
  return chunks
}

function computePercentiles(sorted: number[]): LatencyPercentiles {
  const pct = (p: number) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)]
  return {
    min: sorted[0],
    p50: pct(0.5),
    p75: pct(0.75),
    p90: pct(0.9),
    p95: pct(0.95),
    p99: pct(0.99),
    max: sorted[sorted.length - 1],
  }
}

function aggregate(chunks: ChunkReport[]): EvalReport {
  // Merge all results
  const allResults: EvalResult[] = []
  for (const c of chunks) {
    const results = c.report.results || c.results || []
    allResults.push(...results)
  }

  // Merge backend coverage
  const backendCoverage: Record<string, number> = {}
  for (const c of chunks) {
    for (const [k, v] of Object.entries(c.report.backendCoverage)) {
      backendCoverage[k] = (backendCoverage[k] || 0) + v
    }
  }

  // Merge latency
  const allLatencies = allResults.map(r => r.responseTimeMs).sort((a, b) => a - b)
  const latencyPercentiles = computePercentiles(allLatencies)

  // Recalculate ranking metrics using current gold-standards.json
  // (the chunk files may contain stale NDCG from an earlier gold version)
  const gs = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'gold-standards.json'), 'utf-8'))
  let ndcgSum = 0, mrrSum = 0, precSum = 0, goldCount = 0

  for (const r of allResults) {
    const gold = gs[r.query.id]
    if (!gold?.relevantDomains || gold.relevantDomains.length === 0) continue

    // Use canonical NDCG from metrics.ts (S50 per-gold cap, dual-domain matching)
    const poolResults = (r.response?.results || []) as SearchResult[]
    const ndcg = computeNdcg(poolResults, gold.relevantDomains, 10)
    const relevantHits = poolResults.slice(0, 10).filter((res: SearchResult) => {
      const candidates: string[] = []
      try { candidates.push(new URL(res.url).hostname.replace(/^www\./, '').toLowerCase()) } catch { /* ignore invalid URL */ }
      if (res.domain) candidates.push(res.domain.toLowerCase().replace(/^www\./, ''))
      return gold.relevantDomains.some((g: string) => candidates.some((d) => d === g || d.endsWith('.' + g)))
    }).length
    const mrr = (() => {
      for (let i = 0; i < poolResults.length; i++) {
        const res = poolResults[i]
        const candidates: string[] = []
        try { candidates.push(new URL(res.url).hostname.replace(/^www\./, '').toLowerCase()) } catch { /* ignore invalid URL */ }
        if (res.domain) candidates.push(res.domain.toLowerCase().replace(/^www\./, ''))
        if (gold.relevantDomains.some((g: string) => candidates.some((d) => d === g || d.endsWith('.' + g)))) {
          return 1 / (i + 1)
        }
      }
      return 0
    })()
    const precision = relevantHits / Math.min(poolResults.length, 10)

    ndcgSum += ndcg
    mrrSum += mrr
    precSum += precision
    goldCount++

    // Update per-result ranking metrics
    r.ranking = { ndcgAt10: ndcg, mrr, precisionAt10: precision, relevantHits }
  }

  const ranking: AggregateRankingMetrics | undefined = goldCount > 0 ? {
    queriesWithGoldStandard: goldCount,
    avgNdcgAt10: ndcgSum / goldCount,
    avgMrr: mrrSum / goldCount,
    avgPrecisionAt10: precSum / goldCount,
  } : undefined

  // Aggregate QPS
  const totalDurationMs = allResults.reduce((sum, r) => sum + r.responseTimeMs, 0)
  const qps: QPSMetrics = {
    avgQps: allResults.length / (totalDurationMs / 1000),
    totalQueries: allResults.length,
    totalDurationMs,
    byTag: {},
    peakQps: 0, // approximate
  }

  // Compute per-tag QPS
  for (const r of allResults) {
    const tags = r.query?.tags || []
    for (const tag of tags) {
      qps.byTag[tag] = (qps.byTag[tag] || 0) + 1
    }
  }

  const passed = allResults.filter(r => r.passed).length
  const failed = allResults.length - passed

  return {
    timestamp: new Date().toISOString(),
    totalQueries: allResults.length,
    passedQueries: passed,
    failedQueries: failed,
    passRate: passed / allResults.length,
    avgTimeMs: allLatencies.reduce((s, v) => s + v, 0) / allLatencies.length,
    avgResultCount: allResults.reduce((s, r) => s + r.resultCount, 0) / allResults.length,
    backendCoverage,
    latencyPercentiles,
    qps,
    ranking,
    results: allResults,
  }
}

// ── Tag-level analysis ──
function printTagAnalysis(results: EvalResult[]) {
  const tagStats: Record<string, { count: number; ndcgSum: number; mrrSum: number; precSum: number; goldCount: number; pass: number; fail: number; latencySum: number }> = {}

  for (const r of results) {
    const tags = r.query?.tags || []
    for (const tag of tags) {
      if (!tagStats[tag]) tagStats[tag] = { count: 0, ndcgSum: 0, mrrSum: 0, precSum: 0, goldCount: 0, pass: 0, fail: 0, latencySum: 0 }
      tagStats[tag].count++
      tagStats[tag].latencySum += r.responseTimeMs
      if (r.passed) tagStats[tag].pass++
      else tagStats[tag].fail++
      if (r.ranking) {
        tagStats[tag].ndcgSum += r.ranking.ndcgAt10
        tagStats[tag].mrrSum += r.ranking.mrr
        tagStats[tag].precSum += r.ranking.precisionAt10
        tagStats[tag].goldCount++
      }
    }
  }

  console.log('\n═══ Per-Tag NDCG@10 Breakdown ═══')
  console.log('Tag'.padEnd(18) + 'Queries'.padStart(8) + '  NDCG@10'.padStart(10) + '  MRR'.padStart(8) + '  P@10'.padStart(8) + '  AvgMs'.padStart(8) + '  Pass%'.padStart(8))
  console.log('─'.repeat(78))
  const sorted = Object.entries(tagStats).sort((a, b) => b[1].count - a[1].count)
  for (const [tag, s] of sorted) {
    const ndcg = s.goldCount > 0 ? (s.ndcgSum / s.goldCount).toFixed(4) : 'N/A'
    const mrr = s.goldCount > 0 ? (s.mrrSum / s.goldCount).toFixed(4) : 'N/A'
    const prec = s.goldCount > 0 ? (s.precSum / s.goldCount).toFixed(4) : 'N/A'
    const avgMs = (s.latencySum / s.count).toFixed(0)
    const passRate = (s.pass / s.count * 100).toFixed(1)
    console.log(
      tag.padEnd(18) +
      String(s.count).padStart(8) +
      ndcg.padStart(10) +
      mrr.padStart(8) +
      prec.padStart(8) +
      avgMs.padStart(8) +
      (passRate + '%').padStart(8)
    )
  }
}

// ── Main ──
const saveBaseline = process.argv.includes('--save-baseline')

console.error('Aggregating eval chunks...')
const chunks = loadChunks()

if (chunks.length === 0) {
  console.error('No chunk files found in eval/results/')
  process.exit(1)
}

console.error(`\nAggregating ${chunks.length} chunks...`)
const report = aggregate(chunks)

// Save latest.json
const latestPath = path.join(RESULTS_DIR, 'latest.json')
const output = JSON.stringify({ report }, null, 2)
fs.writeFileSync(latestPath, output, 'utf-8')
console.error(`Wrote ${latestPath} (${(output.length / 1024).toFixed(0)} KB)`)

// Save baseline if requested
if (saveBaseline) {
  const baselinePath = path.join(HERE, 'baseline.json')
  fs.writeFileSync(baselinePath, JSON.stringify({ timestamp: report.timestamp, report }, null, 2), 'utf-8')
  console.error(`Baseline saved: ${baselinePath}`)
}

// Print summary
console.log('\n═══ Full Eval Summary (600 queries) ═══')
console.log(`Timestamp:     ${report.timestamp}`)
console.log(`Total Queries: ${report.totalQueries}`)
console.log(`Passed:        ${report.passedQueries} (${(report.passRate * 100).toFixed(1)}%)`)
console.log(`Failed:        ${report.failedQueries}`)
console.log(`Avg Latency:   ${report.avgTimeMs.toFixed(0)}ms`)
console.log(`Avg Results:   ${report.avgResultCount.toFixed(1)}`)
if (report.ranking) {
  console.log(`\n═══ Aggregate Ranking Metrics ═══`)
  console.log(`Gold Standard Queries: ${report.ranking.queriesWithGoldStandard}`)
  console.log(`NDCG@10:       ${report.ranking.avgNdcgAt10.toFixed(4)}`)
  console.log(`MRR:           ${report.ranking.avgMrr.toFixed(4)}`)
  console.log(`Precision@10:  ${report.ranking.avgPrecisionAt10.toFixed(4)}`)
}
if (report.latencyPercentiles) {
  console.log(`\n═══ Latency ═══`)
  console.log(`p50: ${report.latencyPercentiles.p50.toFixed(0)}ms`)
  console.log(`p95: ${report.latencyPercentiles.p95.toFixed(0)}ms`)
  console.log(`p99: ${report.latencyPercentiles.p99.toFixed(0)}ms`)
}

// Per-tag analysis
printTagAnalysis(report.results)
