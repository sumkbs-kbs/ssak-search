/**
 * Wikipedia knowledge backbone for the agent fast path.
 *
 * Deliberately separate from specialized.wikipediaSearch: that function's
 * retry budgets are tuned against the fanout's 4.5s ceiling (REST capped at
 * 3000ms → 700ms/attempt), and the /search/page round-trip alone measures
 * 500–700ms from many networks — borderline attempts abort, and a timeout is
 * not retryable there, so the chain returns nothing. The backbone is a
 * single-shot, no-fanout use case: one Action API call with a generous
 * timeout is the honest shape.
 */

import { fetchWithTimeout, stripHtml, truncateToTokens, computeScore } from './util'
import type { SearchResult, Env } from '../types'

const WIKIPEDIA_BACKBONE_TIMEOUT_MS = 2500

export async function wikipediaBackboneSearch(
  query: string,
  opts: { maxResults?: number; language?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, language = 'en', env } = opts
  const url = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}&srprop=snippet`

  try {
    const res = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'ssak-search/2.8.0 (self-hosted; https://github.com/mr.k/webapp)',
        },
      },
      WIKIPEDIA_BACKBONE_TIMEOUT_MS,
    )
    if (!res.ok) return [] // 429/5xx — backbone is best-effort, never blocks

    const data = (await res.json()) as {
      query?: { search?: Array<{ title: string; snippet: string }> }
    }
    const hits = data.query?.search ?? []
    const results: SearchResult[] = []
    for (const hit of hits.slice(0, maxResults)) {
      const snippet = stripHtml(hit.snippet || '').trim()
      results.push({
        title: hit.title,
        url: `https://${language}.wikipedia.org/wiki/${encodeURIComponent(hit.title.replace(/ /g, '_'))}`,
        content: truncateToTokens(snippet, 500),
        // Same authority clamp as specialized.wikipediaSearch
        score: Math.min(computeScore(hit.title, snippet, query) + 0.15, 0.99),
        domain: `${language}.wikipedia.org`,
      })
    }
    return results
  } catch {
    return []
  }
}
