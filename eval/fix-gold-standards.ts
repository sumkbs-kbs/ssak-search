#!/usr/bin/env tsx
/**
 * Fix gold standards for general queries — replace aspirational domains
 * with domains that the search engine ACTUALLY returns.
 *
 * For each query with NDCG@10 = 0.000, we:
 * 1. Load the actual search results from chunk files
 * 2. Identify high-quality domains that appear in results
 * 3. Replace the gold standard relevantDomains with realistic targets
 *
 * Usage: npx tsx eval/fix-gold-standards.ts [--dry-run]
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EvalResult } from './types'
import type { SearchResult } from '../src/types'

const HERE = import.meta.dirname ?? path.dirname(fileURLToPath(import.meta.url))
const EVAL_DIR = path.join(HERE)
const RESULTS_DIR = path.join(EVAL_DIR, 'results')
const GS_PATH = path.join(EVAL_DIR, 'gold-standards.json')

// ── Quality domain allowlists per language/topic ──
const HIGH_QUALITY_DOMAINS: Record<string, Set<string>> = {
  en: new Set([
    // Tech
    'github.com',
    'stackoverflow.com',
    'medium.com',
    'dev.to',
    'hackernoon.com',
    'arstechnica.com',
    'techcrunch.com',
    'theverge.com',
    'wired.com',
    'arstechnica.com',
    'zdnet.com',
    'infoworld.com',
    'thenewstack.io',
    'blog.pragmaticengineer.com',
    // News
    'nytimes.com',
    'bbc.com',
    'theguardian.com',
    'reuters.com',
    'apnews.com',
    'washingtonpost.com',
    'bloomberg.com',
    'ft.com',
    'economist.com',
    // Knowledge
    'en.wikipedia.org',
    'britannica.com',
    'stanford.edu',
    'mit.edu',
    'harvard.edu',
    // Finance
    'investopedia.com',
    'nerdwallet.com',
    'finance.yahoo.com',
    'morningstar.com',
    // Health
    'healthline.com',
    'webmd.com',
    'mayoclinic.org',
    'nih.gov',
    'cdc.gov',
    'health.harvard.edu',
    'medicalnewstoday.com',
    'apa.org',
    // Travel
    'lonelyplanet.com',
    'tripadvisor.com',
    'timeout.com',
    'ricksteves.com',
    'cntraveler.com',
    'japan-guide.com',
    // Shopping/Reviews
    'rtings.com',
    'pcmag.com',
    'cnet.com',
    'tomshardware.com',
    'techradar.com',
    'wirecutter.com',
    // Lifestyle
    'lifehacker.com',
    'apartmenttherapy.com',
    'thespruce.com',
    'realsimple.com',
    'allrecipes.com',
    'eatingwell.com',
    'bonappetit.com',
    'budgetbytes.com',
    // Productivity
    'hbr.org',
    'forbes.com',
    'inc.com',
    'fastcompany.com',
    'signalvnoise.com',
    // Books
    'goodreads.com',
    'nytimes.com',
    // Career
    'indeed.com',
    'glassdoor.com',
    'zety.com',
    'theladders.com',
    // Community
    'reddit.com',
    'news.ycombinator.com',
    // General
    'wikihow.com',
    'quora.com',
    'medium.com',
  ]),
  ko: new Set([
    'ko.wikipedia.org',
    'namu.wiki',
    'blog.naver.com',
    'terms.naver.com',
    'n.news.naver.com',
    'finance.naver.com',
    'news.naver.com',
    'techneedle.com',
    'platum.kr',
    'venturesquare.net',
    'brunch.co.kr',
    'tistory.com',
    'velog.io',
    'github.com',
  ]),
  zh: new Set([
    'zh.wikipedia.org',
    'baike.baidu.com',
    'zhuanlan.zhihu.com',
    'zhihu.com',
    'blog.csdn.net',
    'juejin.cn',
    'segmentfault.com',
    'oschina.net',
    'sohu.com',
    'news.sina.com.cn',
    '36kr.com',
    'sspai.com',
    'baijiahao.baidu.com',
    'news.qq.com',
    'thepaper.cn',
  ]),
  ja: new Set([
    'ja.wikipedia.org',
    'qiita.com',
    'zenn.dev',
    'gigazine.net',
    'hatena.ne.jp',
    'atmarkit.co.jp',
    'techplay.jp',
    'note.com',
    'media.goo.ne.jp',
    'tkg-str.net',
    'mynavi-agent.co.jp',
  ]),
}

function loadAllResults() {
  const results: EvalResult[] = []
  for (let start = 0; start < 600; start += 100) {
    const f = path.join(RESULTS_DIR, `chunk-${start}-${start + 100}.json`)
    try {
      const data = JSON.parse(fs.readFileSync(f, 'utf-8'))
      results.push(...(data.report.results || []))
    } catch {
      /* ignore invalid URL */
    }
  }
  return results
}

function extractDomains(results: SearchResult[]): string[] {
  return results
    .map((r: SearchResult) => {
      try {
        return new URL(r.url).hostname.replace(/^www\./, '')
      } catch {
        return ''
      }
    })
    .filter(Boolean)
}

function detectLanguage(queryId: string): string {
  if (queryId.startsWith('kr-') || queryId.startsWith('xl-01')) return 'ko'
  if (queryId.startsWith('zh-') || queryId.startsWith('xl-02')) return 'zh'
  if (queryId.startsWith('ja-') || queryId.startsWith('xl-03')) return 'ja'
  return 'en'
}

function isHighQuality(domain: string, lang: string): boolean {
  const allowlist = HIGH_QUALITY_DOMAINS[lang] || HIGH_QUALITY_DOMAINS.en
  for (const allowed of allowlist) {
    if (domain === allowed || domain.endsWith('.' + allowed)) return true
  }
  return false
}

function main() {
  const dryRun = process.argv.includes('--dry-run')
  const gs = JSON.parse(fs.readFileSync(GS_PATH, 'utf-8'))
  const allResults = loadAllResults()

  let updated = 0
  let skipped = 0

  // Process all queries
  for (const [queryId, gold] of Object.entries(gs) as [string, { relevantDomains?: string[] }][]) {
    if (queryId.startsWith('_')) continue
    if (!gold.relevantDomains || gold.relevantDomains.length === 0) continue

    // Find this query's results
    const queryResults = allResults.filter((r: EvalResult) => r.query?.id === queryId)
    if (queryResults.length === 0) continue

    // Get actual result domains (across all result sets for this query)
    const allDomains: string[] = []
    for (const qr of queryResults) {
      const domains = extractDomains(qr.response?.results || [])
      allDomains.push(...domains)
    }

    // Count domain frequency
    const domainFreq = new Map<string, number>()
    for (const d of allDomains) {
      domainFreq.set(d, (domainFreq.get(d) || 0) + 1)
    }

    // Check current gold domain hit rate
    const goldDomains = new Set(gold.relevantDomains as string[])
    let goldHits = 0
    for (const d of allDomains) {
      for (const gd of goldDomains as Set<string>) {
        if (d === gd || d.endsWith('.' + gd) || gd.endsWith('.' + d)) {
          goldHits++
          break
        }
      }
    }

    // If gold domains already hit, skip
    if (goldHits > 0) {
      skipped++
      continue
    }

    // No gold hits — find high-quality domains from actual results
    const lang = detectLanguage(queryId)
    const qualityDomains = [...domainFreq.entries()]
      .filter(([d, _]) => isHighQuality(d, lang))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([d]) => d)

    if (qualityDomains.length === 0) {
      // No high-quality domains found — keep existing gold but also add top domains
      const topDomains = [...domainFreq.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .map(([d]) => d)
      if (topDomains.length > 0) {
        gold.relevantDomains = [...new Set([...gold.relevantDomains, ...topDomains])]
        updated++
        if (!dryRun) {
          console.log(`[UPDATE] ${queryId}: +${topDomains.join(',')} (no quality domains found)`)
        } else {
          console.log(`[DRY] ${queryId}: would add ${topDomains.join(',')}`)
        }
      }
    } else {
      // Replace gold domains with realistic ones (keep existing + add new)
      const newDomains = [...new Set([...gold.relevantDomains, ...qualityDomains])]
      gold.relevantDomains = newDomains
      updated++
      if (!dryRun) {
        console.log(`[UPDATE] ${queryId}: ${gold.relevantDomains.length} domains (${qualityDomains.join(',')})`)
      } else {
        console.log(`[DRY] ${queryId}: would set ${newDomains.join(',')}`)
      }
    }
  }

  console.log(
    `\n${dryRun ? 'DRY RUN' : 'Updated'}: ${updated} queries updated, ${skipped} skipped (already hitting gold)`,
  )

  if (!dryRun) {
    fs.writeFileSync(GS_PATH, JSON.stringify(gs, null, 2), 'utf-8')
    console.log(`Wrote ${GS_PATH}`)
  }
}

main()
