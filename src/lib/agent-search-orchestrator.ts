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
}

export interface AgentSearchResult {
  query: string
  took_ms: number
  hits: AgentSearchHit[]
  aborted_backends: string[]
  signal_confidence: 'HIGH' | 'MEDIUM' | 'LOW'
}

export async function executeFastAgentSearch(
  query: string,
  maxResults = 5,
  _confidenceThreshold = 0.8,
  timeoutMs = 2500,
  env?: Env,
): Promise<AgentSearchResult> {
  const start = performance.now()
  const isKorean = /[\uac00-\ud7af\u1100-\u11ff]/.test(query)

  const hits: AgentSearchHit[] = []
  const seenUrls = new Set<string>()
  const abortedBackends: string[] = []

  // Define parallel search providers
  const providers = isKorean
    ? [
        {
          name: 'naver_mobile',
          fn: () => naverSearch(query, { maxResults, timeoutMs, env }),
        },
        {
          name: 'bing_mobile',
          fn: () => bingSearch(query, { maxResults, timeoutMs, region: 'ko-KR', env }),
        },
      ]
    : [
        {
          name: 'bing_mobile',
          fn: () => bingSearch(query, { maxResults, timeoutMs, region: 'en-US', env }),
        },
        {
          name: 'naver_mobile',
          fn: () => naverSearch(query, { maxResults, timeoutMs, env }),
        },
      ]

  const promises = providers.map(async ({ name, fn }) => {
    try {
      const rawResults = await fn()
      for (const item of rawResults) {
        const norm = normalizeUrl(item.url)
        if (!seenUrls.has(norm)) {
          seenUrls.add(norm)
          hits.push({
            title: item.title,
            url: item.url,
            snippet: item.content || '',
            score: item.score || 0.85,
            source: name,
          })
        }
      }
    } catch (_err) {
      abortedBackends.push(name)
    }
  })

  await Promise.allSettled(promises)

  hits.sort((a, b) => b.score - a.score)
  const finalHits = hits.slice(0, maxResults)

  return {
    query,
    took_ms: Math.round(performance.now() - start),
    hits: finalHits,
    aborted_backends: abortedBackends,
    signal_confidence: finalHits.some((h) => h.score >= 0.85) ? 'HIGH' : finalHits.length > 0 ? 'MEDIUM' : 'LOW',
  }
}
