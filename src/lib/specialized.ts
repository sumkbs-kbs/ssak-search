/**
 * Specialized Search Sources (No API Key Required)
 *
 * These are free, no-auth APIs that complement general web search:
 * - Wikipedia REST API: encyclopedia entries with summaries
 * - GitHub Search API: repositories, code, issues (rate-limited without token)
 * - HackerNews Algolia API: tech news and discussions
 * - OpenAlex API: academic papers
 * - Reddit JSON API: community discussions
 *
 * These sources add depth and authority to search results,
 * especially for factual, technical, and academic queries.
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, extractDomain, stripHtml, decodeEntities, computeScore, truncateToTokens, simplifyQuery, timeRangeToDays, parseDate } from './util'

// ============================================================
// Wikipedia REST API
// ============================================================

/**
 * Search Wikipedia for encyclopedia entries.
 * Free, no API key. Works for all languages.
 * Returns title, excerpt, and URL for each match.
 */
export async function wikipediaSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; language?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, language = 'en', env } = opts
  const results: SearchResult[] = []

  // Wikipedia REST API can return HTTP 429 (rate limit) under rapid sequential
  // calls. Retry with backoff that fits within fanout's wikipedia ceiling
  // (4500ms). The original 500/1200/3000 delays pushed the full retry chain
  // past the ceiling, causing fanout to time the task out before the final
  // attempt finished. 250/500/1000 keeps all 4 attempts inside ~2 s.
  const maxRetries = 3
  const backoffDelays = [250, 500, 1000]

  try {
    // Search for page titles
    const searchUrl = `https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${maxResults}`

    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await fetchWithTimeout(
        env,
        searchUrl,
        {
          headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
        },
        timeoutMs,
      )

      if (response.ok) break
      if (response.status === 429 && attempt < maxRetries) {
        // Rate limited — wait and retry
        await new Promise((r) => setTimeout(r, backoffDelays[attempt]))
        continue
      }
      // Non-429 error or exhausted retries
      break
    }

    if (!response || !response.ok) return results
    const data = await response.json() as { pages?: { title: string; key: string; excerpt: string; description?: string }[] }
    const pages = data.pages || []

    for (const page of pages) {
      if (results.length >= maxResults) break
      const url = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.key.replace(/ /g, '_'))}`
      // Clean excerpt - remove HTML spans
      const excerpt = stripHtml(page.excerpt || '').trim()
      const description = page.description ? `${page.description}. ` : ''
      const content = truncateToTokens(`${description}${excerpt}`, 500)

      results.push({
        title: page.title,
        url,
        content,
        score: Math.min(computeScore(page.title, excerpt, query) + 0.15, 0.99), // Wikipedia authority boost (clamped)
        domain: `${language}.wikipedia.org`,
      })
    }

    // Fallback: if REST API returned no results, try Action API (list=search)
    // This helps for Chinese and other non-English wikis where REST search may return empty
    if (results.length === 0) {
      try {
        const actionUrl = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}&srprop=snippet`
        const actionRes = await fetchWithTimeout(
          env,
          actionUrl,
          {
            headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
          },
          timeoutMs,
        )
        if (actionRes.ok) {
          const actionData = await actionRes.json() as { query?: { search?: { title: string; snippet: string }[] } }
          for (const item of actionData.query?.search || []) {
            if (results.length >= maxResults) break
            const pageUrl = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`
            const excerpt = stripHtml(item.snippet || '').trim()
            results.push({
              title: item.title,
              url: pageUrl,
              content: truncateToTokens(excerpt, 500),
              score: Math.min(computeScore(item.title, excerpt, query) + 0.15, 0.99),
              domain: `${language}.wikipedia.org`,
            })
          }
        }
      } catch (err) {
        logger.warn('Wikipedia Action API fallback failed:', { error: toError(err) })
      }
    }
  } catch (err) {
    logger.warn('Wikipedia search failed:', { error: toError(err) })
  }

  return results
}

/**
 * Get Wikipedia article summary (first paragraph) by title.
 */
export async function wikipediaSummary(
  title: string,
  language = 'en',
  timeoutMs = 8000,
  env?: Env,
): Promise<{ title: string; extract: string; url: string } | null> {
  try {
    const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
      },
      timeoutMs,
    )
    if (!response.ok) return null
    const data = await response.json() as { title: string; extract: string; content_urls?: { desktop?: { page?: string } } }
    return {
      title: data.title,
      extract: data.extract || '',
      url: data.content_urls?.desktop?.page || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    }
  } catch (err) {
    logger.warn('Wikipedia REST API failed:', { error: toError(err) })
    return null
  }
}

// ============================================================
// GitHub Search API
// ============================================================

/**
 * Search GitHub repositories.
 * Free without token (rate-limited to ~10 req/min per IP).
 */
export async function githubSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 8000, env } = opts
  const results: SearchResult[] = []

  try {
    // GitHub Search API returns 0 results for overly specific natural-language queries.
    // Simplify: strip years, filler words, keep only key tech terms.
    // e.g. "Cloudflare Workers D1 tutorial 2025" → "cloudflare workers d1"
    const simplified = simplifyQuery(query, 4)
    const params = new URLSearchParams({
      q: simplified,
      sort: 'stars',
      order: 'desc',
      per_page: String(Math.min(maxResults, 30)),
    })
    const url = `https://api.github.com/search/repositories?${params}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'SearchAPI/1.0',
        },
      },
      timeoutMs,
    )

    const data = await response.json() as { items?: { full_name: string; description: string | null; html_url: string; stargazers_count: number; language: string | null; topics?: string[] }[] }

    for (const repo of data.items || []) {
      if (results.length >= maxResults) break
      // Quality filter: skip very low-quality repos (no description)
      // Personal/student repos without descriptions aren't authoritative
      if (!repo.description) continue
      const desc = repo.description || ''
      const lang = repo.language ? ` [${repo.language}]` : ''
      const stars = repo.stargazers_count > 0 ? ` ★${repo.stargazers_count}` : ''
      const content = truncateToTokens(`${desc}${lang}${stars}`, 500)

      results.push({
        title: `${repo.full_name}${stars}`,
        url: repo.html_url,
        content,
        score: Math.min(computeScore(repo.full_name, desc, query) + 0.1, 0.99), // GitHub authority boost (clamped)
        domain: 'github.com',
      })
    }
  } catch (err) {
    logger.warn('GitHub search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// HackerNews Algolia API
// ============================================================

/**
 * Search HackerNews stories.
 * Free, no API key. Great for tech news and discussions.
 */
export async function hackerNewsSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; timeRange?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 8000, timeRange, env } = opts
  const results: SearchResult[] = []

  try {
    // HN Algolia API returns 0 hits for overly specific natural-language queries.
    // Simplify query to key terms for better match rate.
    // e.g. "Cloudflare Workers D1 tutorial 2025" → "cloudflare workers d1"
    const simplified = simplifyQuery(query, 4)
    const params = new URLSearchParams({
      query: simplified,
      tags: 'story',
      hitsPerPage: String(Math.min(maxResults, 20)),
    })
    // Add time range filter if specified (Unix timestamp)
    if (timeRange) {
      const daysMap: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 }
      const days = daysMap[timeRange] || 30
      const minTimestamp = Math.floor(Date.now() / 1000) - days * 86400
      params.append('numericFilters', `created_at_i>${minTimestamp}`)
    }

    const url = `https://hn.algolia.com/api/v1/search?${params}`
    const response = await fetchWithTimeout(
      env,
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' } },
      timeoutMs,
    )

    if (!response.ok) return results
    const data = await response.json() as { hits?: { title: string; url: string; points: number; num_comments: number; objectID: string; created_at: string }[] }

    for (const hit of data.hits || []) {
      if (results.length >= maxResults) break
      // HN stories may have external URL or point to HN discussion
      const extUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`

      // Relevance filter: skip results with very low relevance to the ORIGINAL query
      // (not the simplified one) — this prevents unrelated trending stories
      const relevance = computeScore(hit.title, '', query)
      if (relevance < 0.08) continue  // Skip low-relevance results
      // Extra filter: "Show HN:" posts are only useful if actually relevant
      if (/^Show HN:/i.test(hit.title) && relevance < 0.15) continue

      const comments = hit.num_comments > 0 ? ` (${hit.num_comments} comments)` : ''
      const points = hit.points > 0 ? ` ↑${hit.points}` : ''
      const content = truncateToTokens(`${hit.title}${points}${comments}`, 500)

      results.push({
        title: hit.title,
        url: extUrl,
        content,
        score: relevance + Math.min(hit.points / 100, 0.1),
        domain: extractDomain(extUrl),
      })
    }
  } catch (err) {
    logger.warn('HackerNews search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// Reddit JSON API
// ============================================================

/**
 * Search Reddit posts via .json endpoint.
 * Free, no API key. Requires descriptive User-Agent.
 */
export async function redditSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; timeRange?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, timeRange, env } = opts
  const results: SearchResult[] = []

  try {
    // Reddit search also benefits from simplified queries for better hit rates
    const simplified = simplifyQuery(query, 5)
    const params = new URLSearchParams({
      q: simplified,
      limit: String(Math.min(maxResults, 25)),
      sort: 'relevance',
    })
    if (timeRange) {
      const tMap: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' }
      params.append('t', tMap[timeRange] || 'month')
    }

    const url = `https://www.reddit.com/search.json?${params}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SearchAPI/1.0 (contact@example.com)',
        },
      },
      timeoutMs,
    )

    if (!response.ok) return results
    const data = await response.json() as { data?: { children?: { data: { title: string; url: string; selftext: string; subreddit: string; score: number; num_comments: number; permalink: string } }[] } }
    const children = data.data?.children || []

    for (const child of children) {
      if (results.length >= maxResults) break
      const post = child.data
      // Reddit post URL - use external URL if it's a link post, otherwise Reddit permalink
      const postUrl = post.url && !post.url.includes('reddit.com') && !post.url.includes('redd.it')
        ? post.url
        : `https://www.reddit.com${post.permalink}`
      const subreddit = `r/${post.subreddit}`
      const score = post.score > 0 ? ` ↑${post.score}` : ''
      const comments = post.num_comments > 0 ? ` (${post.num_comments} comments)` : ''
      const selftext = post.selftext ? ` - ${post.selftext.slice(0, 200)}` : ''
      const content = truncateToTokens(`${subreddit}${score}${comments}${selftext}`, 500)

      results.push({
        title: post.title,
        url: postUrl,
        content,
        score: computeScore(post.title, post.selftext, query) + Math.min(post.score / 1000, 0.05),
        domain: extractDomain(postUrl),
      })
    }
  } catch (err) {
    logger.warn('Reddit search failed:', { error: toError(err) })
  }

  return results
}



// ============================================================
// arXiv API (Academic Papers — No Key Required)
// ============================================================

/**
 * Search arXiv for academic papers.
 * Free, no API key. Returns research paper titles, abstracts, and URLs.
 * Excellent for academic/scientific queries — far better than Wikipedia
 * for ML/AI/physics/cs papers.
 *
 * Endpoint: https://export.arxiv.org/api/query?search_query=all:QUERY&max_results=N
 * Returns Atom XML feed.
 */
export async function arxivSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 10000, env } = opts
  const results: SearchResult[] = []

  try {
    // Simplify query for arXiv — strip filler words, keep key terms
    const simplified = simplifyQuery(query, 4)
    const params = new URLSearchParams({
      search_query: `all:${simplified}`,
      start: '0',
      max_results: String(Math.min(maxResults, 20)),
      sortBy: 'relevance',
      sortOrder: 'descending',
    })
    const url = `https://export.arxiv.org/api/query?${params.toString()}`
    const response = await fetchWithTimeout(
      env,
      url,
      { headers: { Accept: 'application/xml, application/atom+xml' } },
      timeoutMs,
    )

    if (!response.ok) return results
    const xml = await response.text()

    // Parse Atom XML entries: <entry>...<title>...</title><summary>...</summary><id>...</id>...</entry>
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi
    let match: RegExpExecArray | null
    while ((match = entryRegex.exec(xml)) !== null && results.length < maxResults) {
      const entry = match[1]
      const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      const summaryMatch = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)
      const idMatch = entry.match(/<id[^>]*>([\s\S]*?)<\/id>/i)
      // Also try to get published date
      const publishedMatch = entry.match(/<published[^>]*>([\s\S]*?)<\/published>/i)
      // Try to get authors
      const authorMatches = [...entry.matchAll(/<name[^>]*>([\s\S]*?)<\/name>/gi)]

      if (!titleMatch || !idMatch) continue
      const title = stripHtml(titleMatch[1]).trim()
      if (!title || title.length < 5) continue

      const rawId = idMatch[1].trim()
      // arXiv IDs look like http://arxiv.org/abs/2106.09685v1
      const url = rawId.replace(/^http:/, 'https:')
      const summary = summaryMatch ? stripHtml(summaryMatch[1]).trim() : ''
      const authors = authorMatches.map((m) => stripHtml(m[1]).trim()).slice(0, 3).join(', ')
      const publishedDate = publishedMatch ? publishedMatch[1].trim() : undefined

      const content = truncateToTokens(`${authors ? `[${authors}] ` : ''}${summary}`, 500)

      results.push({
        title,
        url,
        content,
        score: Math.min(computeScore(title, summary, query) + 0.12, 0.99), // arXiv authority boost (clamped)
        domain: 'arxiv.org',
        published_date: publishedDate,
      })
    }
  } catch (err) {
    logger.warn('arXiv search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// DuckDuckGo Instant Answer API (lightweight, no HTML scraping)
// ============================================================

/**
 * DuckDuckGo Instant Answer API.
 * Free, no API key. Returns Wikipedia-sourced abstracts for factual queries.
 * This is the JSON API (api.duckduckgo.com), NOT the HTML endpoint.
 */
export async function duckDuckGoInstantAnswer(
  query: string,
  timeoutMs = 8000,
  env?: Env,
): Promise<{ abstract: string; source: string; url: string } | null> {
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    })
    const response = await fetchWithTimeout(
      env,
      `https://api.duckduckgo.com/?${params}`,
      { headers: { Accept: 'application/json' } },
      timeoutMs,
    )
    if (!response.ok) return null
    const data = await response.json() as DDGInstantAnswerResponse

    if (data.AbstractText && data.AbstractText.length > 20) {
      return {
        abstract: data.AbstractText,
        source: data.AbstractSource || 'DuckDuckGo',
        url: data.AbstractURL || '',
      }
    }
    return null
  } catch (err) {
    logger.warn('DuckDuckGo Instant Answer API failed:', { error: toError(err) })
    return null
  }
}

interface DDGInstantAnswerResponse {
  AbstractText: string
  AbstractSource: string
  AbstractURL: string
  Heading: string
  RelatedTopics: unknown[]
}

// ============================================================
// Query Type Detection
// ============================================================

/**
 * Detect the type of a search query to determine which specialized sources to use.
 *
 * Phase 1.3: Added optional entities parameter for entity-aware routing.
 * Pass entity information from the understanding module to refine query type.
 */
export type QueryType = 'technical' | 'factual' | 'financial' | 'news' | 'academic' | 'general'

export function detectQueryType(
  query: string,
  entities?: { organizations: string[]; technologies: string[]; products: string[]; people: string[] },
): QueryType {
  const lower = query.toLowerCase()
  const trimmed = query.trim()

  // Extracted entity hints for refined classification
  const hasOrg = entities ? entities.organizations.length > 0 : false
  const hasTech = entities ? entities.technologies.length > 0 : false
  const hasProduct = entities ? entities.products.length > 0 : false
  const hasPerson = entities ? entities.people.length > 0 : false

  // Financial / stock keywords (Korean + English + Chinese)
  // Must be checked BEFORE news because stock queries often contain year numbers
  // Phase 1.3: If known organization is detected + financial context keywords → financial
  const isFinancialPattern = /주가|주식|증권|코스피|코스닥|kospi|kosdaq|시세|변동률|상한가|하한가|목표주가|투자의견|실적|배당|주주|공시|기업분석|리서치|\bper\b|\bpbr\b|\broe\b|\beps\b|시가총액|거래량|시장가|주봉|일봉|월봉|\bchart\b|\bfinance\b|\bfinancial\b|\bstock\b|\bprice\b|\bshare\b|\bshares\b|\bdividend\b|market\s?cap|\btrading\b|\bipo\b|공모가/i.test(query)

  if (isFinancialPattern) {
    return 'financial'
  }

  // Phase 1.3: Organization-only queries with financial context
  // e.g. "삼성전자 실적", "TSMC earnings"
  if (hasOrg && /실적|실적발표|earnings|revenue|profit|분기/i.test(query)) {
    return 'financial'
  }

  // Technical keywords (expanded for accurate detection)
  // Phase 1.3: If entity extraction found technology entities → boost confidence
  const isTechnicalPattern = /\b(tutorial|tutorials|guide|guides|docs|documentation|example|examples|walkthrough|how\s?to|github|code|coding|programming|api|apis|framework|frameworks|library|libraries|sdk|cli|npm|pip|cargo|yarn|pnpm|docker|kubernetes|react|vue|angular|svelte|nextjs|next\.js|nuxt|express|fastify|hono|django|flask|rails|spring|laravel|python|javascript|typescript|rust|golang|java|kotlin|swift|ruby|php|sql|database|sqlite|postgres|postgresql|mysql|mongodb|redis|graphql|rest|grpc|serverless|cloudflare|workers?|lambda|aws|azure|gcp|vercel|netlify|edge|deploy|deployment|git|webpack|vite|rollup|esbuild|eslint|prettier|jest|vitest|tailwind|bootstrap|html|css|node|deno|bun|oauth|jwt|cors|websocket|devtools)\b/i.test(query)

  if (isTechnicalPattern || hasTech) {
    return 'technical'
  }

  // News/current events keywords
  // Year numbers alone are news indicators only if no technical/financial keywords matched above
  const _y = new Date().getFullYear()
  const _yearPattern = `${_y}|${_y - 1}`
  if (new RegExp(`\\b(latest|news|today|${_yearPattern}|recent|breaking|update|updates|announce|announcement|launch|launched|release|released)\\b`, 'i').test(query)) {
    return 'news'
  }

  // Academic keywords
  // Phase 1.3: If entities include known academic concepts + academic keywords → boost
  if (/\b(research|paper|study|theory|analysis|survey|journal|arxiv|academic|science|physics|biology|medicine)\b/i.test(query)) {
    return 'academic'
  }

  // Factual - short queries that look like entity lookups
  // Phase 1.3: Enhanced with entity detection
  const isShortQuery = trimmed.split(/\s+/).length <= 4
  const isQuestionPattern = /\b(what|who|when|where|definition|meaning|is|are|was|were)\b/i.test(lower) || /什么是|什麼是|什么叫|什麼叫/.test(query)

  if (isShortQuery && (isQuestionPattern || hasOrg || hasProduct || hasPerson)) {
    return 'factual'
  }

  return 'general'
}

/**
 * Determine which specialized sources to query based on query type.
 */
export function getSourcesForQueryType(type: QueryType): {
  useWikipedia: boolean
  useGitHub: boolean
  useHackerNews: boolean
  useReddit: boolean
  useArxiv: boolean
  useGoogleScholar: boolean
} {
  switch (type) {
    case 'technical':
      return { useWikipedia: false, useGitHub: true, useHackerNews: true, useReddit: false, useArxiv: false, useGoogleScholar: false }
    case 'factual':
      // Factual: Wikipedia for definitions + HackerNews for discussions/explanations
      // HackerNews boosts result count for "what is X" queries with community explanations
      return { useWikipedia: true, useGitHub: false, useHackerNews: true, useReddit: false, useArxiv: false, useGoogleScholar: false }
    case 'financial':
      // Financial queries: Wikipedia for company background + HackerNews for stock discussion/news.
      // HN provides stock market discussions, earnings analysis, and investor commentary
      // that Bing stock-card results don't cover — boosts result count to 10+.
      return { useWikipedia: true, useGitHub: false, useHackerNews: true, useReddit: false, useArxiv: false, useGoogleScholar: false }
    case 'news':
      return { useWikipedia: false, useGitHub: false, useHackerNews: true, useReddit: true, useArxiv: false, useGoogleScholar: false }
    case 'academic':
      // Academic: Wikipedia + arXiv for research papers + Google Scholar
      return { useWikipedia: true, useGitHub: false, useHackerNews: false, useReddit: false, useArxiv: true, useGoogleScholar: true }
    default:
      return { useWikipedia: true, useGitHub: false, useHackerNews: true, useReddit: false, useArxiv: false, useGoogleScholar: false }
  }
}

// ============================================================
// Knowledge Graph / Entity Panel
// ============================================================

/**
 * Fetch a knowledge graph panel for a query using Wikipedia's REST summary API.
 * Returns a KnowledgeGraph object with title, description, image, and key facts,
 * or null if no entity is found.
 */
/**
 * Get Wikidata entity ID from a Wikipedia page title.
 */
async function wikipediaToWikidataId(title: string, language = 'en'): Promise<string | null> {
  try {
    const url = `https://${language}.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=${encodeURIComponent(title)}&format=json&redirects=1`
    const resp = await fetch(url, { headers: { 'User-Agent': 'SearchAPI/1.0' } })
    if (!resp.ok) return null
    const data = await resp.json() as Record<string, unknown>
    const pages = (data.query as Record<string, unknown>)?.pages as Record<string, Record<string, unknown>> | undefined
    if (!pages) return null
    for (const page of Object.values(pages)) {
      const props = page.pageprops as Record<string, string> | undefined
      if (props?.wikibase_item) return props.wikibase_item
    }
    return null
  } catch (err) {
    logger.warn('Wikipedia Wikidata lookup failed:', { error: toError(err) })
    return null
  }
}

/**
 * Fetch Wikidata entity and extract interesting facts.
 */
async function wikidataEntityFacts(wikidataId: string): Promise<{ type?: string; facts: Record<string, string>; image?: string; timeline?: Array<{ date: string; event: string }>; stats?: Record<string, string> } | null> {
  try {
    const url = `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`
    const resp = await fetch(url, { headers: { 'User-Agent': 'SearchAPI/1.0' } })
    if (!resp.ok) return null
    const data = await resp.json() as Record<string, unknown>
    const entities = data.entities as Record<string, Record<string, unknown>>
    const entity = entities?.[wikidataId] as Record<string, unknown> | undefined
    if (!entity) return null

    const claims = entity.claims as Record<string, { mainsnak: { datavalue?: { value?: unknown } }; rank?: string }[]> | undefined
    if (!claims) return null

    const facts: Record<string, string> = {}
    let type: string | undefined
    let image: string | undefined

    // Instance of (P31) → determine KG type
    const instanceOf = claims.P31?.[0]?.mainsnak?.datavalue?.value as Record<string, unknown> | undefined
    const instanceId = instanceOf?.id as string | undefined
    if (instanceId) {
      if (['Q5', 'Q215627', 'Q95074', 'Q811430'].includes(instanceId)) type = 'person'
      else if (['Q43229', 'Q4830453', 'Q6881511'].includes(instanceId)) type = 'organization'
      else if (['Q486972', 'Q515', 'Q5107', 'Q3957'].includes(instanceId)) type = 'place'
      else if (['Q7725634', 'Q188451', 'Q11424'].includes(instanceId)) type = 'concept'
      else type = 'concept'
    }

    // Helper to get label from claim
    const claimValue = (claimId: string): string | undefined => {
      const claim = claims[claimId]?.[0]
      if (!claim) return undefined
      const val = claim.mainsnak?.datavalue?.value
      if (typeof val === 'string') return val
      if (val && typeof val === 'object') {
        const v = val as Record<string, unknown>
        return (v.label || v.text || v.id || v.time || '') as string
      }
      return undefined
    }

    // Map claim IDs to human-readable labels
    const CLAIM_MAP: Record<string, string> = {
      P569: 'Born',
      P570: 'Died',
      P571: 'Founded',
      P576: 'Dissolved',
      P577: 'Publication date',
      P856: 'Website',
      P112: 'Founder',
      P488: 'Chairperson',
      P169: 'CEO',
      P127: 'Owner',
      P159: 'Headquarters',
      P17: 'Country',
      P1082: 'Population',
      P2046: 'Area',
      P2048: 'Height',
      P2049: 'Width',
      P2079: 'Production',
      P2131: 'Revenue',
      P2403: 'Net profit',
      P2295: 'Net income',
      P414: 'Stock exchange',
      P1454: 'Legal form',
      P452: 'Industry',
      P1056: 'Product',
      P1416: 'Award received',
    }

    for (const [claimId, label] of Object.entries(CLAIM_MAP)) {
      const val = claimValue(claimId)
      if (val) facts[label] = val
    }

    // Image (P18)
    const imageClaim = claims.P18?.[0]?.mainsnak?.datavalue?.value as string | undefined
    if (imageClaim) {
      image = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageClaim.replace(/\s+/g, '_'))}`
    }

    const timeline = extractTimelineFromClaims(claims)
    const stats = extractStatsFromClaims(claims)

    return Object.keys(facts).length > 0 || type ? { type, facts, image, timeline, stats } : null
  } catch (err) {
    logger.warn('Wikidata entity fetch failed:', { error: toError(err) })
    return null
  }
}

/**
 * Extract a chronological timeline from Wikidata claims.
 * Only date-typed claims (time precision ≥ year) are included.
 */
export function extractTimelineFromClaims(
  claims: Record<string, { mainsnak: { datavalue?: { value?: unknown } }; rank?: string }[]>,
): Array<{ date: string; event: string }> {
  const TIMELINE_CLAIMS: Record<string, string> = {
    P569: 'Born',
    P570: 'Died',
    P571: 'Founded',
    P576: 'Dissolved',
    P577: 'Publication date',
    P580: 'Start time',
    P582: 'End time',
    P1619: 'Opened',
  }

  const timeline: Array<{ date: string; event: string }> = []
  for (const [claimId, label] of Object.entries(TIMELINE_CLAIMS)) {
    const claim = claims[claimId]?.[0]
    const val = claim?.mainsnak?.datavalue?.value
    if (!val || typeof val !== 'object') continue
    const time = (val as { time?: string }).time
    if (!time) continue
    // Wikidata time format: "+1969-07-20T00:00:00Z" — extract the year
    const yearMatch = time.match(/[+-]?(\d{4})/)
    if (yearMatch) timeline.push({ date: yearMatch[1], event: label })
  }

  return timeline.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Extract key numeric statistics from Wikidata claims (population, area, revenue...).
 */
export function extractStatsFromClaims(
  claims: Record<string, { mainsnak: { datavalue?: { value?: unknown } }; rank?: string }[]>,
): Record<string, string> {
  const STAT_CLAIMS: Record<string, string> = {
    P1082: 'Population',
    P2046: 'Area',
    P2048: 'Height',
    P2049: 'Width',
    P2131: 'Revenue',
    P2403: 'Net profit',
    P2295: 'Net income',
    P2079: 'Production',
  }

  const stats: Record<string, string> = {}
  for (const [claimId, label] of Object.entries(STAT_CLAIMS)) {
    const claim = claims[claimId]?.[0]
    const val = claim?.mainsnak?.datavalue?.value
    if (!val) continue
    // Amount form: { amount: "+510000000", unit: "..." } or plain number/string
    let raw: string
    if (typeof val === 'string' || typeof val === 'number') {
      raw = String(val)
    } else {
      const amount = (val as { amount?: string }).amount
      if (typeof amount !== 'string') continue
      raw = amount
    }
    const normalized = raw.replace(/^[+-]/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    if (normalized && normalized !== '0') stats[label] = normalized
  }

  return stats
}

/**
 * Fetch DBPedia entity data and extract abstract + thumbnail.
 * Free, no API key. Silent failure — returns null on any error.
 */
export async function fetchDbpediaEntity(
  title: string,
  env?: Env,
): Promise<{ abstract?: string; thumbnail?: string } | null> {
  try {
    const encodedTitle = encodeURIComponent(title.replace(/\s+/g, '_'))
    const url = `https://dbpedia.org/data/${encodedTitle}.json`
    const resp = await fetchWithTimeout(env, url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' },
    }, 6000)
    if (!resp.ok) return null
    const data = await resp.json() as Record<string, unknown>
    // DBPedia JSON structure: { "http://dbpedia.org/resource/Title": { predicate: [{ value }] } }
    const resourceKey = `http://dbpedia.org/resource/${encodedTitle}`
    const entity = data[resourceKey] as Record<string, Array<{ value?: unknown }>> | undefined
    if (!entity) return null

    const pick = (predicate: string): string | undefined => {
      const value = entity[predicate]?.[0]?.value
      return typeof value === 'string' ? value : undefined
    }

    const abstract = pick('http://dbpedia.org/ontology/abstract')
    const thumbnail = pick('http://dbpedia.org/ontology/thumbnail')
    return abstract || thumbnail ? { abstract, thumbnail } : null
  } catch (err) {
    logger.warn('DBPedia entity fetch failed:', { error: toError(err) })
    return null
  }
}

/**
 * Fetch Wikipedia infobox HTML snippet and extract key-value pairs.
 */
async function wikipediaInfobox(query: string, language = 'en'): Promise<Record<string, string> | null> {
  try {
    // Use the Action API to get the page HTML
    const url = `https://${language}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(query)}&prop=text&section=0&format=json&redirects=1`
    const resp = await fetch(url, { headers: { 'User-Agent': 'SearchAPI/1.0' } })
    if (!resp.ok) return null
    const data = await resp.json() as Record<string, unknown>
    const parseData = data.parse as Record<string, unknown> | undefined
    const text = parseData?.text as Record<string, unknown> | undefined
    const html = text?.['*'] as string | undefined
    if (!html) return null

    // Match infobox table rows: <th>label</th><td>value</td>
    const facts: Record<string, string> = {}
    const infoboxRegex = /<th[^>]*class="infobox-label"[^>]*>(.*?)<\/th>\s*<td[^>]*class="infobox-data"[^>]*>(.*?)<\/td>/gi
    let match: RegExpExecArray | null
    while ((match = infoboxRegex.exec(html)) !== null) {
      const label = stripHtml(match[1]).trim()
      const value = stripHtml(match[2]).trim()
      if (label && value && label.length < 50 && value.length < 200) {
        facts[label] = value
      }
    }

    // Fallback: older infobox format
    if (Object.keys(facts).length === 0) {
      const oldRegex = /<tr>\s*<th[^>]*>(.*?)<\/th>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gi
      let m2: RegExpExecArray | null
      while ((m2 = oldRegex.exec(html)) !== null) {
        const label = stripHtml(m2[1]).trim()
        const value = stripHtml(m2[2]).trim()
        if (label && value && label.length < 50 && value.length < 200 && !label.includes('<')) {
          facts[label] = value
        }
      }
    }

    return Object.keys(facts).length > 0 ? facts : null
  } catch (err) {
    logger.warn('Wikipedia infobox parsing failed:', { error: toError(err) })
    return null
  }
}

/**
 * Wikipedia → Wikidata → Infobox Knowledge Graph
 *
 * Combines three data sources for rich entity information:
 * 1. Wikipedia summary (description, image)
 * 2. Wikidata entity (structured facts, entity type, logo)
 * 3. Wikipedia infobox (detailed key-value pairs)
 */
export async function getKnowledgeGraph(
  query: string,
  language = 'en',
  env?: Env,
): Promise<{ title: string; description: string; url?: string; image?: string; type?: string; facts?: Record<string, string>; timeline?: Array<{ date: string; event: string }>; stats?: Record<string, string> } | null> {
  try {
    // Phase 1: Get Wikipedia summary (primary source of truth)
    const summaryUrl = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, '_'))}`
    const summaryResp = await fetchWithTimeout(
      env,
      summaryUrl,
      { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' } },
      6000,
    )

    if (!summaryResp.ok) return null
    const summary = await summaryResp.json() as Record<string, unknown>

    // Wikipedia returns type: "standard" for real articles, "disambiguation" for ambiguous
    if (summary.type === 'disambiguation' || !summary.extract) return null

    const title = summary.title as string
    const extract = summary.extract as string
    const pageUrl = (summary.content_urls as { desktop?: { page?: string } })?.desktop?.page
    const thumbnail = (summary.thumbnail as { source?: string })?.source
    const description = summary.description as string | undefined

    // Phase 2: Get Wikidata ID → richer facts + DBPedia abstract (run in parallel with infobox)
    const wikidataId = await wikipediaToWikidataId(title, language)

    const [wd, infobox, dbpedia] = await Promise.all([
      wikidataId ? wikidataEntityFacts(wikidataId) : Promise.resolve(null),
      wikipediaInfobox(title, language),
      fetchDbpediaEntity(title, env),
    ])

    // Merge facts: Wikidata structured data + Wikipedia infobox
    const facts: Record<string, string> = {}
    if (wd?.facts) Object.assign(facts, wd.facts)
    if (infobox) {
      for (const [key, value] of Object.entries(infobox)) {
        // Wikidata takes precedence for overlapping keys
        if (!facts[key]) facts[key] = value
      }
    }
    // Always include description
    if (description) facts['Description'] = description

    const image = wd?.image || dbpedia?.thumbnail || thumbnail
    const type = wd?.type ?? (
      description?.toLowerCase().includes('company') ? 'organization'
        : description?.toLowerCase().includes('person') ? 'person'
        : description?.toLowerCase().includes('city') || description?.toLowerCase().includes('country') ? 'place'
        : 'concept'
    )

    return {
      title,
      description: extract.slice(0, 400),
      url: pageUrl || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      image,
      type,
      facts: Object.keys(facts).length > 0 ? facts : undefined,
      timeline: wd?.timeline && wd.timeline.length > 0 ? wd.timeline : undefined,
      stats: wd?.stats && Object.keys(wd.stats).length > 0 ? wd.stats : undefined,
    }
  } catch (err) {
    logger.warn('Wikipedia knowledge graph fetch failed:', { error: toError(err) })
    return null
  }
}
