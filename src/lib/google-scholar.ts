/**
 * Google Scholar Search (Phase 3.4a)
 *
 * Scrapes Google Scholar for academic papers without an API key.
 * Uses the public scholar.google.com interface with mobile User-Agent.
 *
 * Endpoints:
 *   - https://scholar.google.com/scholar?q=... (search)
 *   - https://scholar.google.com/scholar?q=...&start=10 (pagination)
 *
 * Parsing targets:
 *   - .gs_ri (result item)
 *   - .gs_rt a (title + link)
 *   - .gs_a (authors, venue, year)
 *   - .gs_rs (snippet/abstract)
 *   - .gs_or_ggsm a (PDF link)
 */

import type { SearchResult } from '../types'

import { logger } from './logger'
const SCHOLAR_BASE = 'https://scholar.google.com/scholar'
const USER_AGENT = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

interface ScholarResult {
  title: string
  url: string
  authors: string
  venue: string
  year?: string
  snippet: string
  pdfUrl?: string
  citations?: number
}

/**
 * Search Google Scholar for academic papers.
 */
export async function searchGoogleScholar(
  query: string,
  maxResults = 10,
  signal?: AbortSignal,
): Promise<ScholarResult[]> {
  const params = new URLSearchParams({
    q: query,
    hl: 'en',
    as_sdt: '0,5', // articles + patents
    start: '0',
  })

  const url = `${SCHOLAR_BASE}?${params}`

  const resp = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      'Accept-Language': 'en-US,en;q=0.9',
    },
    signal,
    cf: { cacheTtl: 3600, cacheEverything: true },
  })

  if (!resp.ok) {
    logger.warn(`Google Scholar search failed: HTTP ${resp.status}`)
    return []
  }

  const html = await resp.text()
  return parseScholarResults(html, maxResults)
}

/**
 * Parse Scholar search results from HTML.
 */
function parseScholarResults(html: string, maxResults: number): ScholarResult[] {
  const results: ScholarResult[] = []

  // Find all .gs_ri elements (result items)
  const riRegex = /<div class="gs_ri"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g
  let match: RegExpExecArray | null

  while ((match = riRegex.exec(html)) && results.length < maxResults) {
    const itemHtml = match[1]

    // Title and link: .gs_rt a
    const titleMatch = itemHtml.match(/<h3 class="gs_rt"[^>]*><a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/)
    if (!titleMatch) continue

    const url = titleMatch[1]
    let title = titleMatch[2].replace(/<[^>]+>/g, '').trim()

    // Clean up [PDF] or [HTML] tags in title
    title = title.replace(/^\[(PDF|HTML|DOC)\]\s*/i, '')

    // Authors/venue/year: .gs_a
    const authorsMatch = itemHtml.match(/<div class="gs_a"[^>]*>([\s\S]*?)<\/div>/)
    const authorsText = authorsMatch ? authorsMatch[1].replace(/<[^>]+>/g, '').trim() : ''

    // Snippet: .gs_rs
    const snippetMatch = itemHtml.match(/<div class="gs_rs"[^>]*>([\s\S]*?)<\/div>/)
    const snippet = snippetMatch ? snippetMatch[1].replace(/<[^>]+>/g, '').trim() : ''

    // PDF link: .gs_or_ggsm a
    let pdfUrl: string | undefined
    const pdfMatch = itemHtml.match(/class="gs_or_ggsm"[^>]*><a[^>]*href="([^"]*\.pdf[^"]*)"/i)
    if (pdfMatch) {
      pdfUrl = pdfMatch[1]
    }

    // Citations: "Cited by N" link
    let citations: number | undefined
    const citedMatch = itemHtml.match(/Cited by (\d+)/)
    if (citedMatch) {
      citations = parseInt(citedMatch[1], 10)
    }

    // Parse authors/venue/year from authorsText
    // Format: "Author1, Author2 - Venue, Year" or "Author1, Author2 - Venue"
    let authors = ''
    let venue = ''
    let year: string | undefined

    if (authorsText) {
      const dashIdx = authorsText.lastIndexOf(' - ')
      if (dashIdx > 0) {
        authors = authorsText.slice(0, dashIdx).trim()
        const venueYear = authorsText.slice(dashIdx + 3).trim()
        // Try to extract year from end
        const yearMatch = venueYear.match(/(\d{4})(?!\d)/)
        if (yearMatch) {
          year = yearMatch[1]
          venue = venueYear.replace(year, '').replace(/[,\-]\s*$/, '').trim()
        } else {
          venue = venueYear
        }
      } else {
        authors = authorsText
      }
    }

    results.push({
      title,
      url,
      authors,
      venue,
      year,
      snippet: snippet.slice(0, 500),
      pdfUrl,
      citations,
    })
  }

  return results
}

/**
 * Convert ScholarResult to SearchResult for orchestrator integration.
 */
export function scholarToSearchResult(s: ScholarResult, score = 0.85): SearchResult {
  const parts: string[] = []
  if (s.authors) parts.push(`Authors: ${s.authors}`)
  if (s.venue) parts.push(`Venue: ${s.venue}`)
  if (s.year) parts.push(`Year: ${s.year}`)
  if (s.citations !== undefined) parts.push(`Citations: ${s.citations}`)
  if (s.pdfUrl) parts.push('PDF available')
  parts.push(s.snippet || '')

  return {
    title: s.title,
    url: s.pdfUrl || s.url,
    content: parts.join('\n'),
    score,
    published_date: s.year ? `${s.year}-01-01` : undefined,
    domain: 'scholar.google.com',
  }
}

/**
 * Search Google Scholar and return SearchResult[] for direct orchestrator integration.
 */
export async function searchGoogleScholarAsResults(
  query: string,
  maxResults = 10,
  signal?: AbortSignal,
): Promise<SearchResult[]> {
  const results = await searchGoogleScholar(query, maxResults, signal)
  return results.map((r) => scholarToSearchResult(r))
}

export { type ScholarResult }