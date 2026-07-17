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

import type { SearchResult } from '../types'
import { fetchWithTimeout, extractDomain, stripHtml, decodeEntities, computeScore, truncateToTokens, simplifyQuery } from './util'

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
  opts: { maxResults?: number; timeoutMs?: number; language?: string } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, language = 'en' } = opts
  const results: SearchResult[] = []

  // Wikipedia REST API can return HTTP 429 (rate limit) under rapid sequential calls.
  // Implement retry with exponential backoff: 500ms → 1200ms → 3000ms
  const maxRetries = 3
  const backoffDelays = [500, 1200, 3000]

  try {
    // Search for page titles
    const searchUrl = `https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${maxResults}`

    let response: Response | null = null
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await fetchWithTimeout(searchUrl, {
        headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
      }, timeoutMs)

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
        const actionRes = await fetchWithTimeout(actionUrl, {
          headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
        }, timeoutMs)
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
      } catch {
        // Action API also failed — give up silently
      }
    }
  } catch (err) {
    console.warn('Wikipedia search failed:', err)
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
): Promise<{ title: string; extract: string; url: string } | null> {
  try {
    const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
    const response = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
    }, timeoutMs)
    if (!response.ok) return null
    const data = await response.json() as { title: string; extract: string; content_urls?: { desktop?: { page?: string } } }
    return {
      title: data.title,
      extract: data.extract || '',
      url: data.content_urls?.desktop?.page || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    }
  } catch {
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
  opts: { maxResults?: number; timeoutMs?: number } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 8000 } = opts
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
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'SearchAPI/1.0',
      },
    }, timeoutMs)

    if (!response.ok) return results
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
    console.warn('GitHub search failed:', err)
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
  opts: { maxResults?: number; timeoutMs?: number; timeRange?: string } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 8000, timeRange } = opts
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
    const response = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json' },
    }, timeoutMs)

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
    console.warn('HackerNews search failed:', err)
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
  opts: { maxResults?: number; timeoutMs?: number; timeRange?: string } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, timeRange } = opts
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
    const response = await fetchWithTimeout(url, {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'SearchAPI/1.0 (contact@example.com)',
      },
    }, timeoutMs)

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
    console.warn('Reddit search failed:', err)
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
  opts: { maxResults?: number; timeoutMs?: number } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 10000 } = opts
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
    const response = await fetchWithTimeout(url, {
      headers: { Accept: 'application/xml, application/atom+xml' },
    }, timeoutMs)

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
    console.warn('arXiv search failed:', err)
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
): Promise<{ abstract: string; source: string; url: string } | null> {
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    })
    const response = await fetchWithTimeout(
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
  } catch {
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
 */
export type QueryType = 'technical' | 'factual' | 'financial' | 'news' | 'academic' | 'general'

export function detectQueryType(query: string): QueryType {
  const lower = query.toLowerCase()

  // Financial / stock keywords (Korean + English + Chinese)
  // Must be checked BEFORE news because stock queries often contain year numbers
  // \b word boundaries on short English terms (per, pbr, roe, eps) to prevent
  // false matches in words like "operator", "perform", "paper", "experience"
  if (/주가|주식|증권|코스피|코스닥|kospi|kosdaq|시세|변동률|상한가|하한가|목표주가|투자의견|실적|배당|주주|공시|기업분석|리서치|\bper\b|\bpbr\b|\broe\b|\beps\b|시가총액|거래량|시장가|주봉|일봉|월봉|\bchart\b|\bfinance\b|\bfinancial\b|\bstock\b|\bprice\b|\bshare\b|\bshares\b|\bdividend\b|market\s?cap|\btrading\b|\bipo\b|공모가/i.test(query)) {
    return 'financial'
  }

  // Technical keywords (expanded for accurate detection)
  // Covers: tutorial/learning, cloud infra, languages, frameworks, tools, concepts
  // Checked BEFORE news so that "React 2025" or "D1 tutorial 2025" → technical, not news
  if (/\b(tutorial|tutorials|guide|guides|docs|documentation|example|examples|walkthrough|how\s?to|github|code|coding|programming|api|apis|framework|frameworks|library|libraries|sdk|cli|npm|pip|cargo|yarn|pnpm|docker|kubernetes|react|vue|angular|svelte|nextjs|next\.js|nuxt|express|fastify|hono|django|flask|rails|spring|laravel|python|javascript|typescript|rust|golang|java|kotlin|swift|ruby|php|sql|database|sqlite|postgres|postgresql|mysql|mongodb|redis|graphql|rest|grpc|serverless|cloudflare|workers?|lambda|aws|azure|gcp|vercel|netlify|edge|deploy|deployment|git|webpack|vite|rollup|esbuild|eslint|prettier|jest|vitest|tailwind|bootstrap|html|css|node|deno|bun|oauth|jwt|cors|websocket|devtools)\b/i.test(query)) {
    return 'technical'
  }

  // News/current events keywords
  // Year numbers alone are news indicators only if no technical/financial keywords matched above
  // Current + previous year are dynamically included to avoid stale hardcoded years.
  const _y = new Date().getFullYear()
  const _yearPattern = `${_y}|${_y - 1}`
  if (new RegExp(`\\b(latest|news|today|${_yearPattern}|recent|breaking|update|updates|announce|announcement|launch|launched|release|released)\\b`, 'i').test(query)) {
    return 'news'
  }

  // Academic keywords
  if (/\b(research|paper|study|theory|analysis|survey|journal|arxiv|academic|science|physics|biology|medicine)\b/i.test(query)) {
    return 'academic'
  }

  // Factual - short queries that look like entity lookups
  // Includes Chinese question patterns: 什么是/什麼是 (what is), 什么是 (what)
  if (query.trim().split(/\s+/).length <= 4 && (/\b(what|who|when|where|definition|meaning|is|are|was|were)\b/i.test(lower) || /什么是|什麼是|什么叫|什麼叫/.test(query))) {
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
} {
  switch (type) {
    case 'technical':
      return { useWikipedia: false, useGitHub: true, useHackerNews: true, useReddit: false, useArxiv: false }
    case 'factual':
      // Factual: Wikipedia for definitions + HackerNews for discussions/explanations
      // HackerNews boosts result count for "what is X" queries with community explanations
      return { useWikipedia: true, useGitHub: false, useHackerNews: true, useReddit: false, useArxiv: false }
    case 'financial':
      // Financial queries: Wikipedia for company background + HackerNews for stock discussion/news.
      // HN provides stock market discussions, earnings analysis, and investor commentary
      // that Bing stock-card results don't cover — boosts result count to 10+.
      return { useWikipedia: true, useGitHub: false, useHackerNews: true, useReddit: false, useArxiv: false }
    case 'news':
      return { useWikipedia: false, useGitHub: false, useHackerNews: true, useReddit: true, useArxiv: false }
    case 'academic':
      // Academic: Wikipedia + arXiv for research papers
      return { useWikipedia: true, useGitHub: false, useHackerNews: false, useReddit: false, useArxiv: true }
    default:
      return { useWikipedia: true, useGitHub: false, useHackerNews: true, useReddit: false, useArxiv: false }
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
export async function getKnowledgeGraph(
  query: string,
  language = 'en',
): Promise<{ title: string; description: string; url?: string; image?: string; type?: string; facts?: Record<string, string> } | null> {
  try {
    // Try the Wikipedia summary API directly with the query
    const summaryUrl = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, '_'))}`
    const response = await fetchWithTimeout(summaryUrl, {
      headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
    }, 6000)

    if (!response.ok) return null
    const data = await response.json() as Record<string, unknown>

    // Wikipedia returns type: "standard" for real articles, "disambiguation" for ambiguous
    if (data.type === 'disambiguation' || !data.extract) return null

    const title = data.title as string
    const extract = data.extract as string
    const pageUrl = (data.content_urls as { desktop?: { page?: string } })?.desktop?.page
    const thumbnail = (data.thumbnail as { source?: string })?.source
    const description = data.description as string | undefined

    // Build facts from available metadata
    const facts: Record<string, string> = {}
    if (description) facts['Description'] = description

    return {
      title,
      description: extract.slice(0, 400),
      url: pageUrl || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      image: thumbnail,
      type: description?.toLowerCase().includes('company') ? 'organization'
        : description?.toLowerCase().includes('person') ? 'person'
        : description?.toLowerCase().includes('city') || description?.toLowerCase().includes('country') ? 'place'
        : 'concept',
      facts: Object.keys(facts).length > 0 ? facts : undefined,
    }
  } catch {
    return null
  }
}
