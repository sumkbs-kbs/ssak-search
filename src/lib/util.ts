/**
 * Shared utility functions for the search engine
 */

/** Extract the registered domain from a URL string */
export function extractDomain(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Normalize a URL (add https:// if missing) */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`
  return `https://${trimmed}`
}

/** Check if a URL matches any of the domain filters (include/exclude) */
export function domainMatches(url: string, domains: string[]): boolean {
  const host = extractDomain(url).toLowerCase()
  return domains.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./, '')
    return host === domain || host.endsWith(`.${domain}`)
  })
}

/** Strip HTML tags and decode entities, returning plain text */
export function stripHtml(html: string): string {
  // Remove script/style blocks entirely
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  // Replace block tags with newlines for better readability
  cleaned = cleaned
    .replace(/<(?:p|div|br|li|h[1-6]|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
  // Decode common HTML entities
  cleaned = decodeEntities(cleaned)
  // Collapse whitespace
  cleaned = cleaned
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned
}

/** Decode common HTML entities */
export function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&laquo;': '«',
    '&raquo;': '»',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
  }
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => entities[m.toLowerCase()] ?? m)
}

/** Truncate text to maxTokens approximate (1 token ≈ 4 chars) */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  const truncated = text.slice(0, maxChars)
  // Try to cut at a sentence/word boundary
  const lastSentence = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? '),
  )
  if (lastSentence > maxChars * 0.5) {
    return truncated.slice(0, lastSentence + 1) + '…'
  }
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > maxChars * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '…'
}

/** Compute a simple relevance score based on query term overlap */
export function computeScore(title: string, content: string, query: string): number {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)
  if (queryTerms.length === 0) return 0.5
  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()
  let titleHits = 0
  let contentHits = 0
  for (const term of queryTerms) {
    if (titleLower.includes(term)) titleHits++
    if (contentLower.includes(term)) contentHits++
  }
  // Title matches are weighted 3x, content 1x, normalized
  const titleScore = (titleHits / queryTerms.length) * 0.6
  const contentScore = Math.min(contentHits / queryTerms.length, 1) * 0.3
  // Base score so results aren't too low
  const baseScore = 0.1
  return Math.min(Math.round((titleScore + contentScore + baseScore) * 100) / 100, 0.99)
}

/** Parse a date string and return ISO 8601 if valid */
export function parseDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return undefined
    return d.toISOString()
  } catch {
    return undefined
  }
}

/** Convert a TimeRange to number of days */
export function timeRangeToDays(range: string | undefined): number | undefined {
  switch (range) {
    case 'day':
      return 1
    case 'week':
      return 7
    case 'month':
      return 30
    case 'year':
      return 365
    default:
      return undefined
  }
}

/** Fetch with timeout */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, {
      ...init,
      signal: controller.signal,
    })
    return response
  } finally {
    clearTimeout(timeoutId)
  }
}

/** Generate related queries from the original query and results */
export function generateRelatedQueries(query: string, resultTitles: string[]): string[] {
  const related = new Set<string>()
  const baseQuery = query.trim()

  // Generic question variants
  const templates = [
    `${baseQuery} guide`,
    `${baseQuery} explained`,
    `best ${baseQuery}`,
    `${baseQuery} examples`,
    `${baseQuery} 2026`,
  ]
  for (const t of templates) {
    if (t.toLowerCase() !== baseQuery.toLowerCase()) related.add(t)
  }

  // Extract keywords from top result titles
  const topWords = new Map<string, number>()
  for (const title of resultTitles.slice(0, 5)) {
    const words = title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 4 && !isStopWord(w))
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
    for (const w of words) {
      topWords.set(w, (topWords.get(w) ?? 0) + 1)
    }
  }
  const topKeywords = [...topWords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([w]) => w)

  for (const kw of topKeywords) {
    if (!baseQuery.toLowerCase().includes(kw)) {
      related.add(`${baseQuery} ${kw}`)
    }
  }

  return [...related].slice(0, 5)
}

const STOP_WORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'between', 'both',
  'during', 'having', 'their', 'there', 'these', 'those', 'where',
  'which', 'while', 'with', 'your', 'what', 'when', 'where', 'this',
  'that', 'from', 'into', 'should', 'would', 'could', 'might', 'will',
  'been', 'were', 'they', 'them', 'more', 'most', 'some', 'such',
  'only', 'very', 'than', 'then', 'also', 'just', 'like', 'make',
  'made', 'many', 'much', 'must', 'need', 'even', 'ever', 'every',
])

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase())
}
