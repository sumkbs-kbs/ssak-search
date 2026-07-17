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

/** Check if a string contains CJK characters (Chinese/Japanese/Korean) */
function hasCJK(text: string): boolean {
  // \u4E00-\u9FFF: CJK Unified Ideographs (Chinese/Japanese Kanji)
  // \uAC00-\uD7A3: Hangul Syllables (Korean)
  return /[\u4E00-\u9FFF\uAC00-\uD7A3]/.test(text)
}

/** Extract CJK/Korean bigrams (2-char substrings) for fuzzy matching */
function cjkBigrams(text: string): string[] {
  // Extract CJK ideographs and Hangul syllables, then form bigrams
  const cjkOnly = text.replace(/[^\u4E00-\u9FFF\uAC00-\uD7A3]/g, '')
  const bigrams: string[] = []
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    bigrams.push(cjkOnly.slice(i, i + 2))
  }
  return bigrams
}

/** Compute a relevance score based on query term overlap + phrase matching + freshness */
export function computeScore(title: string, content: string, query: string, publishedDate?: string): number {
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 0)

  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()

  // --- Freshness boost: recent content gets up to +0.05, decaying over 365 days ---
  let freshnessBoost = 0
  if (publishedDate) {
    try {
      const pubDate = new Date(publishedDate)
      if (!isNaN(pubDate.getTime())) {
        const daysOld = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60 * 24)
        if (daysOld < 365) {
          // Exponential decay: full +0.05 at 0 days, ~0.02 at 30 days, ~0.005 at 180 days
          freshnessBoost = 0.05 * Math.exp(-daysOld / 90)
        }
      }
    } catch {
      // Invalid date — no boost
    }
  }

  // --- CJK (Chinese/Japanese) special handling ---
  // CJK text has no spaces, so whitespace-splitting produces one huge "word" that
  // won't match anything. Use bigram matching instead for CJK queries.
  const queryIsCJK = hasCJK(query)
  if (queryIsCJK) {
    const queryBigrams = cjkBigrams(query)
    if (queryBigrams.length > 0) {
      // Check bigram overlap with title and content
      let titleBigramHits = 0
      let contentBigramHits = 0
      for (const bg of queryBigrams) {
        if (titleLower.includes(bg)) titleBigramHits++
        if (contentLower.includes(bg)) contentBigramHits++
      }
      const titleScoreCJK = (titleBigramHits / queryBigrams.length) * 0.6
      const contentScoreCJK = Math.min(contentBigramHits / queryBigrams.length, 1) * 0.3
      const baseScoreCJK = 0.05

      // Cross-language penalty: if the query is CJK but the result title/content
      // contains NO CJK characters at all, the result is likely in a different language
      // and probably irrelevant (e.g. English "AARP Games" for a Chinese query).
      // Penalize heavily so these don't pass the minimum score threshold.
      let crossLangPenalty = 0
      const titleIsCJK = hasCJK(title)
      const contentIsCJK = hasCJK(content)
      if (!titleIsCJK && !contentIsCJK) {
        crossLangPenalty = 0.15 // Heavy penalty — drops score below 0.10 threshold
      } else if (!titleIsCJK) {
        crossLangPenalty = 0.05 // Title is non-CJK but content has some — mild penalty
      }

      // Phrase bonus: if cleaned CJK query appears verbatim in title
      let phraseBonusCJK = 0
      const cleanedCJK = query.replace(/^[什么是什麼是什么叫什麼叫]+/, '').trim()
      if (cleanedCJK.length > 1 && titleLower.includes(cleanedCJK)) {
        phraseBonusCJK = 0.12
      }

      const rawScore = titleScoreCJK + contentScoreCJK + baseScoreCJK + phraseBonusCJK - crossLangPenalty + freshnessBoost
      return Math.min(Math.max(Math.round(rawScore * 100) / 100, 0), 0.99)
    }
    // If CJK bigrams couldn't be formed (e.g. single char query), fall through
    if (queryTerms.length === 0) return 0.5
  }

  if (queryTerms.length === 0) return 0.5

  let titleHits = 0
  let contentHits = 0
  for (const term of queryTerms) {
    if (titleLower.includes(term)) titleHits++
    if (contentLower.includes(term)) contentHits++
  }
  // Title matches are weighted 2x (0.6 vs 0.3), normalized
  const titleScore = (titleHits / queryTerms.length) * 0.6
  const contentScore = Math.min(contentHits / queryTerms.length, 1) * 0.3
  // Base score: lowered from 0.1 to 0.05 so that results with zero query-term
  // overlap don't automatically pass the Tier 1 threshold (0.10).
  const baseScore = 0.05

  // Phrase matching bonus: if the full query (or a significant substring) appears
  // verbatim in the title, give extra weight. This disambiguates e.g.
  // "transformer architecture paper" from electrical transformer pages.
  let phraseBonus = 0
  const queryLower = query.toLowerCase().trim()
  if (queryLower.length > 3) {
    if (titleLower.includes(queryLower)) {
      phraseBonus = 0.12 // Exact full-query match in title → strong signal
    } else {
      // Try progressively shorter substrings (2+ consecutive terms)
      const terms = queryLower.split(/\s+/).filter((t) => t.length > 1)
      for (let len = terms.length - 1; len >= 2; len--) {
        for (let start = 0; start <= terms.length - len; start++) {
          const sub = terms.slice(start, start + len).join(' ')
          if (titleLower.includes(sub)) {
            phraseBonus = Math.max(phraseBonus, 0.04 * len)
            break
          }
        }
        if (phraseBonus > 0) break
      }
    }
  }

  return Math.min(Math.round((titleScore + contentScore + baseScore + phraseBonus + freshnessBoost) * 100) / 100, 0.99)
}

// ============================================================
// Query Simplification for API-based specialized sources
// ============================================================

/**
 * Words/tokens that are generic and should be stripped when building
 * a simplified query for GitHub / HackerNews / Reddit search APIs.
 * These APIs match on keywords, not natural language — removing filler
 * dramatically increases hit rate (e.g. "Cloudflare Workers D1 tutorial 2025"
 * → "cloudflare workers d1" which actually returns results).
 */
const QUERY_NOISE_WORDS = new Set([
  // English filler / intent words
  'tutorial', 'tutorials', 'guide', 'guides', 'how', 'to', 'for', 'with',
  'best', 'top', 'latest', 'new', 'newest', 'recent', 'updated', 'modern',
  'simple', 'easy', 'beginner', 'advanced', 'complete', 'comprehensive',
  'introduction', 'intro', 'overview', 'explained', 'examples', 'example',
  'vs', 'versus', 'alternative', 'alternatives', 'comparison', 'compare',
  'what', 'is', 'are', 'was', 'were', 'the', 'a', 'an', 'of', 'in', 'on',
  'about', 'into', 'from', 'using', 'use', 'learn', 'learning',
  'documentation', 'docs', 'reference', 'cheatsheet', 'cheat', 'sheet',
  'deep', 'dive', 'deepdive', 'crash', 'course', 'step', 'by', 'stepbystep',
  // Korean filler words (already in STOP_WORDS but duplicated here for clarity)
  '튜토리얼', '가이드', '설명', '정리', '최신', '쉽게', '간단한', '완벽',
  '소개', '개요', '예시', '예제', '비교', '대안', '사용법', '방법',
  '하는', '하는법', '알아보기', '정리해', '모음', '추천',
  // Academic filler words — strip for API-based searches
  'paper', 'papers', 'article', 'articles', 'survey', 'surveys',
  'architecture', 'model', 'models', 'method', 'methods', 'approach',
  'network', 'networks', 'algorithm', 'algorithms', 'system', 'systems',
  'based', 'novel', 'new', 'proposed', 'towards', 'toward',
])

/**
 * Simplify a natural-language query into a compact keyword string suitable
 * for API-based search backends (GitHub, HackerNews, Reddit).
 *
 * Strategy:
 *   1. Strip year-only tokens (2024, 2025, 2026) — they kill API match rates
 *   2. Remove generic noise words (tutorial, guide, best, latest, ...)
 *   3. Remove single-char tokens and pure punctuation
 *   4. Keep proper nouns, tech terms, entity names
 *   5. Limit to 5 most significant terms (APIs prefer shorter queries)
 *
 * Examples:
 *   "Cloudflare Workers D1 tutorial 2025" → "cloudflare workers d1"
 *   "React state management best practices" → "react state management"
 *   "Hono TypeScript framework" → "hono typescript framework"
 *   "Apple stock price" → "apple stock price"
 */
export function simplifyQuery(query: string, maxTerms = 5): string {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '').trim())
    .filter((t) => t.length > 1)
    // Remove year-only tokens
    .filter((t) => !/^(19|20)\d{2}$/.test(t))
    // Remove noise words
    .filter((t) => !QUERY_NOISE_WORDS.has(t))

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t)
      unique.push(t)
    }
  }

  // If simplification removed everything, fall back to original query
  // (minus years) so we don't send an empty string to the API
  if (unique.length === 0) {
    return query
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1 && !/^(19|20)\d{2}$/.test(t))
      .join(' ')
      .trim() || query.trim()
  }

  return unique.slice(0, maxTerms).join(' ')
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
  const isKorean = /[\uAC00-\uD7A3]/.test(baseQuery)

  // Detect financial/stock queries for specialized related queries
  const isFinancial = /주가|주식|증권|코스피|코스닥|kospi|kosdaq|stock|price|finance|dividend|\bper\b|\bpbr\b|시세|목표주가|투자의견|실적|배당/i.test(baseQuery)
  const currentYear = new Date().getFullYear().toString()

  // Generic question variants — use Korean templates for Korean queries
  const templates = isKorean
    ? isFinancial
      ? [
          `${baseQuery} 전망`,
          `${baseQuery} 분석`,
          `${baseQuery} 실적`,
          `${baseQuery} 목표주가`,
          `${baseQuery} 배당`,
        ]
      : [
          `${baseQuery} 정리`,
          `${baseQuery} 설명`,
          `${baseQuery} 최신`,
          `${baseQuery} 가이드`,
          `${baseQuery} ${currentYear}`,
        ]
    : isFinancial
      ? [
          `${baseQuery} forecast`,
          `${baseQuery} analysis`,
          `${baseQuery} earnings`,
          `${baseQuery} price target`,
          `${baseQuery} dividend`,
        ]
      : [
          `${baseQuery} guide`,
          `${baseQuery} explained`,
          `best ${baseQuery}`,
          `${baseQuery} examples`,
          `${baseQuery} ${currentYear}`,
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
      .filter((w) => w.length > 1 && !isStopWord(w))
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((w) => w.length > 0)
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
  // English stop words
  'about', 'above', 'after', 'again', 'against', 'between', 'both',
  'during', 'having', 'their', 'there', 'these', 'those', 'where',
  'which', 'while', 'with', 'your', 'what', 'when', 'where', 'this',
  'that', 'from', 'into', 'should', 'would', 'could', 'might', 'will',
  'been', 'were', 'they', 'them', 'more', 'most', 'some', 'such',
  'only', 'very', 'than', 'then', 'also', 'just', 'like', 'make',
  'made', 'many', 'much', 'must', 'need', 'even', 'ever', 'every',
  // Korean stop words — particles, common verbs, filler words
  '그리고', '그래서', '그러나', '그런', '그렇게', '그것', '그게', '그',
  '이런', '이것', '이게', '이', '저런', '저것', '저게',
  '하는', '한다', '했다', '할', '한', '하다', '되는', '된다', '됐다',
  '있는', '있다', '없는', '없다', '없는',
  '이런', '저런', '그런', '어떤', '무엇', '누가', '언제', '어디',
  '에서', '에게', '에게서', '한테', '한테서', '으로', '로', '로서',
  '와', '과', '하고', '며', '며는', '이고', '이며', '거나', '든지',
  '는', '은', '가', '이', '을', '를', '의', '에', '도', '만', '까지',
  '부터', '조차', '마저', '든지', '이나', '나', '든', '인', '일',
  '매우', '정말', '진짜', '너무', '좀', '조금', '다시', '또', '또한',
  '더', '더욱', '특히', '바로', '미리', '이미', '아직', '벌써',
])

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase())
}
