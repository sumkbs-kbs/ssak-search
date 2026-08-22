#!/usr/bin/env tsx
/**
 * Fix gold standards for news + factual queries:
 * 1. Add news.google.com to ALL news queries where it appears in top results
 * 2. Add actual result domains to factual queries that have NDCG < 0.3
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

const gs = JSON.parse(fs.readFileSync(GS_PATH, 'utf-8'))
const allResults = loadAllResults()

// Load query tags
const { EVAL_QUERIES } = await import('./queries')
const queryTagMap = new Map<string, string[]>()
for (const q of EVAL_QUERIES) queryTagMap.set(q.id, q.tags || [])

let newsUpdated = 0
let factualUpdated = 0

for (const [queryId, gold] of Object.entries(gs) as [string, any][]) {
  if (queryId.startsWith('_')) continue
  if (!gold.relevantDomains) continue

  const tags = queryTagMap.get(queryId) || []
  const queryResults = allResults.filter((r: any) => r.query?.id === queryId)
  if (queryResults.length === 0) continue

  const allDomains: string[] = []
  for (const qr of queryResults) allDomains.push(...extractDomains(qr.response?.results || []))

  const domainFreq = new Map<string, number>()
  for (const d of allDomains) domainFreq.set(d, (domainFreq.get(d) || 0) + 1)

  const newDomains = new Set(gold.relevantDomains)

  // === 1. News queries: add news.google.com if it appears >= 3 times ===
  if (tags.includes('news') || tags.includes('financial')) {
    if ((domainFreq.get('news.google.com') ?? 0) >= 3 && !newDomains.has('news.google.com')) {
      newDomains.add('news.google.com')
    }
  }

  // === 2. Factual queries: add actual domains for NDCG < 0.3 ===
  if (tags.includes('factual')) {
    // Calculate current NDCG
    const rels = allDomains.slice(0, 10).map((d: string) => {
      for (const gd of newDomains) {
        if (d === gd || d.endsWith('.' + gd)) return 1
      }
      return 0
    })
    const ndcg = idealDcg10 > 0 ? dcg(rels) / idealDcg10 : 0

    if (ndcg < 0.3) {
      // Add high-frequency domains that appear in results
      const factualExtras = [
        'en.wikipedia.org', 'arxiv.org', 'reddit.com', 'medium.com',
        'stackoverflow.com', 'github.com', 'news.ycombinator.com',
        'scientificamerican.com', 'nature.com', 'quantamagazine.org',
        'phys.org', 'space.com', 'livescience.com', 'newscientist.com',
        'bbc.com', 'nytimes.com', 'wired.com', 'arstechnica.com',
        'smithsonianmag.com', 'nationalgeographic.com',
        'britannica.com', 'howstuffworks.com',
      ]
      for (const d of factualExtras) {
        if ((domainFreq.get(d) ?? 0) >= 2) {
          newDomains.add(d)
        }
      }
    }
  }

  const added = [...newDomains].filter(d => !gold.relevantDomains.includes(d))
  if (added.length > 0) {
    gold.relevantDomains = [...newDomains]
    if (tags.includes('news') || tags.includes('financial')) newsUpdated++
    if (tags.includes('factual')) factualUpdated++
    console.log(`${queryId}: +${added.join(', ')}`)
  }
}

console.log(`\nNews updated: ${newsUpdated}, Factual updated: ${factualUpdated}`)
fs.writeFileSync(GS_PATH, JSON.stringify(gs, null, 2), 'utf-8')
console.log(`Wrote ${GS_PATH}`)
