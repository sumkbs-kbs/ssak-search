/**
 * API Route: /api/suggest — Query Autosuggest
 *
 * Returns search query suggestions (autocomplete) from DuckDuckGo's suggest API.
 * No API key required. Lightweight proxy with caching.
 *
 * GET /api/suggest?q=quantum
 * Returns: { query: string, suggestions: string[] }
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'

const suggestRoute = new Hono<{ Bindings: AppBindings }>()

suggestRoute.use('/*', cors({ origin: '*' }))

// In-memory cache for suggestions (per-isolate)
const suggestCache = new Map<string, { suggestions: string[]; timestamp: number }>()
const SUGGEST_CACHE_TTL = 60_000 // 1 minute (freshness matters for suggestions)

// Backend suggestion providers (fallback chain)
const SUGGEST_PROVIDERS = [
  {
    name: 'duckduckgo',
    url: (q: string) => `https://duckduckgo.com/ac/?q=${encodeURIComponent(q)}&type=list`,
    parse: (data: unknown): string[] => {
      // DDG returns: [query, [suggestion1, suggestion2, ...]]
      if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[1])) {
        return data[1].filter((s: unknown): s is string => typeof s === 'string')
      }
      return []
    },
  },
  {
    name: 'bing',
    url: (q: string) => `https://api.bing.com/osjson.aspx?query=${encodeURIComponent(q)}`,
    parse: (data: unknown): string[] => {
      // Bing returns: [query, [suggestion1, suggestion2, ...]]
      if (Array.isArray(data) && data.length >= 2 && Array.isArray(data[1])) {
        return data[1].filter((s: unknown): s is string => typeof s === 'string')
      }
      return []
    },
  },
]

/** Fetch suggestions from a provider with timeout */
async function fetchSuggestions(provider: (typeof SUGGEST_PROVIDERS)[0], query: string): Promise<string[] | null> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 3000)

    const resp = await fetch(provider.url(query), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SearchEngineBot/1.0)',
        Accept: 'application/json',
      },
    })
    clearTimeout(timer)

    if (!resp.ok) return null
    const data = await resp.json()
    const suggestions = provider.parse(data)
    return suggestions.length > 0 ? suggestions.slice(0, 10) : null
  } catch (err) {
    logger.warn('Suggest API failed:', { error: toError(err) })
    return null
  }
}

// GET /api/suggest?q=query
suggestRoute.get('/', async (c) => {
  const query = c.req.query('q') || c.req.query('query')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "q" is required', code: 'missing_query' }, 400)
  }

  const trimmed = query.trim().slice(0, 200) // cap input length

  // Check cache
  const cached = suggestCache.get(trimmed)
  if (cached && Date.now() - cached.timestamp < SUGGEST_CACHE_TTL) {
    return c.json({ query: trimmed, suggestions: cached.suggestions })
  }

  // Try providers in order
  let suggestions: string[] = []
  for (const provider of SUGGEST_PROVIDERS) {
    const result = await fetchSuggestions(provider, trimmed)
    if (result) {
      suggestions = result
      break
    }
  }

  // Cache (even empty results to prevent hammering on misspelled queries)
  suggestCache.set(trimmed, { suggestions, timestamp: Date.now() })

  // Evict old entries if cache grows too large
  if (suggestCache.size > 500) {
    const oldest = Date.now() - SUGGEST_CACHE_TTL * 2
    for (const [key, val] of suggestCache) {
      if (val.timestamp < oldest) suggestCache.delete(key)
    }
  }

  return c.json({ query: trimmed, suggestions })
})

export { suggestRoute }
