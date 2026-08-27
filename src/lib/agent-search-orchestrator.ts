import { normalizeUrl } from './util'
import { naverSearch } from './naver-search'
import { bingSearch } from './bing-search'
import type { Env } from '../types'

export interface AgentSearchHit {
  title: string
  url: string
  snippet: string
  score: number
  source: string
  authority_boost?: boolean
}

export interface AgentSearchResult {
  query: string
  took_ms: number
  hits: AgentSearchHit[]
  aborted_backends: string[]
  signal_confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  decomposed_subqueries?: string[]
}

export interface AgentSearchOptions {
  maxResults?: number
  confidenceThreshold?: number
  timeoutMs?: number
  topic?: 'general' | 'code' | 'news' | 'finance'
  decomposeSubqueries?: boolean
  env?: Env
}

const CODE_AUTHORITY_DOMAINS = [
  'github.com',
  'stackoverflow.com',
  'developer.mozilla.org',
  'docs.',
  'npmjs.com',
  'pypi.org',
  'pkg.go.dev',
  'crates.io',
  'learn.microsoft.com',
  'dev.to',
  'medium.com',
]

export function generateSubqueries(query: string, topic: string): string[] {
  const subqueries = [query]
  if (topic === 'code') {
    if (!query.toLowerCase().includes('github') && !query.toLowerCase().includes('docs')) {
      subqueries.push(`${query} official docs github`)
    }
    if (!query.toLowerCase().includes('error') && !query.toLowerCase().includes('solution')) {
      subqueries.push(`${query} solution example`)
    }
  } else if (topic === 'news') {
    subqueries.push(`${query} 속보 뉴스`)
  } else if (topic === 'finance') {
    subqueries.push(`${query} 실적 주가 공시`)
  }
  return subqueries.slice(0, 3)
}

export async function executeFastAgentSearch(
  query: string,
  maxResults = 5,
  _confidenceThreshold = 0.8,
  timeoutMs = 2500,
  env?: Env,
  topic: 'general' | 'code' | 'news' | 'finance' = 'general',
  decomposeSubqueries = false,
): Promise<AgentSearchResult> {
  const start = performance.now()
  const isKorean = /[\uac00-\ud7af\u1100-\u11ff]/.test(query)

  const hits: AgentSearchHit[] = []
  const seenUrls = new Set<string>()
  const abortedBackends: string[] = []

  const queriesToRun = decomposeSubqueries ? generateSubqueries(query, topic) : [query]

  const tasks: Array<() => Promise<void>> = []

  for (const q of queriesToRun) {
    const providers = isKorean
      ? [
          {
            name: 'naver_mobile',
            fn: () => naverSearch(q, { maxResults, timeoutMs, env }),
          },
          {
            name: 'bing_mobile',
            fn: () => bingSearch(q, { maxResults, timeoutMs, region: 'ko-KR', env }),
          },
        ]
      : [
          {
            name: 'bing_mobile',
            fn: () => bingSearch(q, { maxResults, timeoutMs, region: 'en-US', env }),
          },
          {
            name: 'naver_mobile',
            fn: () => naverSearch(q, { maxResults, timeoutMs, env }),
          },
        ]

    for (const { name, fn } of providers) {
      tasks.push(async () => {
        try {
          const rawResults = await fn()
          for (const item of rawResults) {
            const norm = normalizeUrl(item.url)
            if (!seenUrls.has(norm)) {
              seenUrls.add(norm)
              let score = item.score || 0.85

              // Code Authority Boosting
              let authorityBoost = false
              if (topic === 'code' && CODE_AUTHORITY_DOMAINS.some((d) => item.url.toLowerCase().includes(d))) {
                score = Math.min(score + 0.1, 1.0)
                authorityBoost = true
              }

              hits.push({
                title: item.title,
                url: item.url,
                snippet: item.content || '',
                score,
                source: name,
                authority_boost: authorityBoost,
              })
            }
          }
        } catch (_err) {
          if (!abortedBackends.includes(name)) {
            abortedBackends.push(name)
          }
        }
      })
    }
  }

  await Promise.allSettled(tasks.map((t) => t()))

  hits.sort((a, b) => b.score - a.score)
  const finalHits = hits.slice(0, maxResults)

  return {
    query,
    took_ms: Math.round(performance.now() - start),
    hits: finalHits,
    aborted_backends: abortedBackends,
    signal_confidence: finalHits.some((h) => h.score >= 0.85) ? 'HIGH' : finalHits.length > 0 ? 'MEDIUM' : 'LOW',
    decomposed_subqueries: decomposeSubqueries ? queriesToRun : undefined,
  }
}
