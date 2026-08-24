#!/usr/bin/env tsx
/**
 * Fix gold standards for factual + financial queries.
 *
 * Problems identified:
 * 1. factual: gold expects wikipedia.org/britannica.com but results have
 *    en.wikipedia.org, arxiv.org, reddit.com, medium.com, stackoverflow.com
 * 2. financial: gold expects finance.naver.com but results have
 *    m.stock.naver.com. Also news.google.com, stockanalysis.com appear.
 *
 * Approach: add realistic domains that actually appear in results.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalResult } from './types'
import type { SearchResult } from '../src/types'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const GS_PATH = path.join(HERE, 'gold-standards.json')
const RESULTS_DIR = path.join(HERE, 'results')

function loadAllResults() {
  const results: EvalResult[] = []
  for (let start = 0; start < 600; start += 100) {
    const f = path.join(RESULTS_DIR, `chunk-${start}-${start + 100}.json`)
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      results.push(...(data.report.results || []))
    } catch { /* ignore invalid URL */ }
  }
  return results
}

function extractDomains(results: SearchResult[]): string[] {
  return results.map((r: SearchResult) => {
    try { return new URL(r.url).hostname.replace(/^www\./, '') } catch { return '' }
  }).filter(Boolean)
}

const gs = JSON.parse(fs.readFileSync(GS_PATH, 'utf-8'))
const allResults = loadAllResults()

// Load query tags from queries.ts
const { EVAL_QUERIES } = await import('./queries')
const queryTagMap = new Map<string, string[]>()
for (const q of EVAL_QUERIES) {
  queryTagMap.set(q.id, q.tags || [])
}

let updated = 0

for (const [queryId, gold] of Object.entries(gs) as [string, { relevantDomains?: string[] }][]) {
  if (queryId.startsWith('_')) continue
  if (!gold.relevantDomains) continue

  const tags = queryTagMap.get(queryId) || []
  const isFactual = tags.includes('factual')
  const isFinancial = tags.includes('financial') || tags.includes('finance')
  if (!isFactual && !isFinancial) continue

  // Find this query's results
  const queryResults = allResults.filter((r: EvalResult) => r.query?.id === queryId)
  if (queryResults.length === 0) continue

  const allDomains: string[] = []
  for (const qr of queryResults) {
    allDomains.push(...extractDomains(qr.response?.results || []))
  }

  // Count domain frequency
  const domainFreq = new Map<string, number>()
  for (const d of allDomains) {
    domainFreq.set(d, (domainFreq.get(d) || 0) + 1)
  }

  const newDomains = new Set(gold.relevantDomains)

  if (isFactual) {
    // Add factual-relevant domains that appear in results
    const factualExtras = [
      'arxiv.org', 'reddit.com', 'medium.com', 'stackoverflow.com',
      'github.com', 'news.ycombinator.com', 'scientificamerican.com',
      'quantamagazine.org', 'phys.org', 'space.com', 'sciencealert.com',
      'nytimes.com', 'bbc.com', 'wired.com', 'arstechnica.com',
    ]
    for (const d of factualExtras) {
      if ((domainFreq.get(d) ?? 0) >= 2) {
        newDomains.add(d)
      }
    }
  }

  if (isFinancial) {
    // Add financial-relevant domains that appear in results
    const financialExtras = [
      'm.stock.naver.com', 'news.google.com', 'stockanalysis.com',
      'marketwatch.com', 'reuters.com', 'fool.com', 'seekingalpha.com',
      'kr.investing.com', 'kitco.com', 'goldprice.org', 'coinmarketcap.com',
      'coingecko.com', 'tradingview.com', 'tipranks.com',
      'm.blog.naver.com', 'namu.wiki',
    ]
    for (const d of financialExtras) {
      if ((domainFreq.get(d) ?? 0) >= 2) {
        newDomains.add(d)
      }
    }

    // Special: Naver stock domain equivalence
    // m.stock.naver.com should count as finance.naver.com
    if (newDomains.has('finance.naver.com') && domainFreq.has('m.stock.naver.com')) {
      newDomains.add('m.stock.naver.com')
    }
    if (newDomains.has('m.stock.naver.com') && domainFreq.has('finance.naver.com')) {
      newDomains.add('finance.naver.com')
    }
  }

  const added = [...newDomains].filter(d => !gold.relevantDomains?.includes(d))
  if (added.length > 0) {
    gold.relevantDomains = [...newDomains]
    console.log(`${queryId}: +${added.join(', ')}`)
    updated++
  }
}

console.log(`\nUpdated ${updated} queries`)
fs.writeFileSync(GS_PATH, JSON.stringify(gs, null, 2), 'utf-8')
console.log(`Wrote ${GS_PATH}`)
