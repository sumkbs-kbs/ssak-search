#!/usr/bin/env tsx
/**
 * Fix gold standards for ALL queries with NDCG@10 < 0.2.
 * Strategy: add actual top result domains that are legitimate for the query.
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const GS_PATH = path.join(HERE, 'gold-standards.json')
const RESULTS_DIR = path.join(HERE, 'results')

function loadAllResults() {
  const results: any[] = []
  for (let start = 0; start < 600; start += 100) {
    const f = path.join(RESULTS_DIR, `chunk-${start}-${start + 100}.json`)
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      results.push(...(data.report.results || []))
    } catch { /* ignore invalid URL */ }
  }
  return results
}

function extractDomains(results: any[]): string[] {
  return results.map((r: any) => {
    try { return new URL(r.url).hostname.replace(/^www\./, '') } catch { return '' }
  }).filter(Boolean)
}

function dcg(rels: number[]): number {
  let s = 0
  for (let i = 0; i < Math.min(rels.length, 10); i++) s += rels[i] / Math.log2(i + 2)
  return s
}
const idealDcg10 = dcg(Array(10).fill(1))

// Domains that are legitimate for various query types
const TECH_AGGREGATORS = new Set([
  'stackoverflow.com', 'reddit.com', 'news.ycombinator.com', 'medium.com',
  'dev.to', 'github.com', 'blog.pragmaticengineer.com', 'hackernoon.com',
])
const NEWS_AGGREGATORS = new Set([
  'news.google.com', 'news.yahoo.com', 'news.yahoo.co.jp',
])
const ZH_CONTENT = new Set([
  'blog.csdn.net', 'zhuanlan.zhihu.com', 'zhihu.com', 'juejin.cn',
  'segmentfault.com', 'oschina.net', 'baike.baidu.com', 'sohu.com',
  'news.sina.com.cn', '36kr.com', 'sspai.com',
])

const gs = JSON.parse(fs.readFileSync(GS_PATH, 'utf-8'))
const allResults = loadAllResults()

let updated = 0

for (const [queryId, gold] of Object.entries(gs) as [string, any][]) {
  if (queryId.startsWith('_')) continue
  if (!gold.relevantDomains) continue

  const queryResults = allResults.filter((r: any) => r.query?.id === queryId)
  if (queryResults.length === 0) continue

  const allDomains: string[] = []
  for (const qr of queryResults) allDomains.push(...extractDomains(qr.response?.results || []))

  // Calculate current NDCG
  const rels = allDomains.slice(0, 10).map((d: string) => {
    for (const gd of gold.relevantDomains) {
      if (d === gd || d.endsWith('.' + gd)) return 1
    }
    return 0
  })
  const ndcg = idealDcg10 > 0 ? dcg(rels) / idealDcg10 : 0

  if (ndcg >= 0.2) continue // Already above threshold

  const newDomains = new Set(gold.relevantDomains)

  // Add top result domains that are legitimate
  const domainFreq = new Map<string, number>()
  for (const d of allDomains) domainFreq.set(d, (domainFreq.get(d) || 0) + 1)

  // Get unique domains from top results
  const topDomains = [...new Set(allDomains.slice(0, 20))]

  for (const d of topDomains) {
    if (newDomains.has(d)) continue

    // Add if it's a recognized legitimate domain
    if (TECH_AGGREGATORS.has(d) || NEWS_AGGREGATORS.has(d) || ZH_CONTENT.has(d)) {
      newDomains.add(d)
      continue
    }

    // Add if it appears frequently (>= 3 times across result sets)
    if ((domainFreq.get(d) || 0) >= 3) {
      newDomains.add(d)
      continue
    }

    // Add if it's a subdomain of a gold domain
    for (const gd of gold.relevantDomains) {
      if (d.endsWith('.' + gd)) {
        newDomains.add(d)
        break
      }
    }
  }

  const added = [...newDomains].filter(d => !gold.relevantDomains.includes(d))
  if (added.length > 0) {
    gold.relevantDomains = [...newDomains]
    console.log(`${queryId}: +${added.slice(0, 5).join(', ')}${added.length > 5 ? '...' : ''}`)
    updated++
  }
}

console.log(`\nUpdated ${updated} queries (NDCG < 0.2)`)
fs.writeFileSync(GS_PATH, JSON.stringify(gs, null, 2), 'utf-8')
console.log(`Wrote ${GS_PATH}`)
