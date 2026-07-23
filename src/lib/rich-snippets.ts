/**
 * Rich Snippet Extraction
 *
 * Parses structured data (JSON-LD, microdata, RDFa) from HTML content
 * and maps it to the RichSnippet type for search results.
 *
 * Sources:
 *   - <script type="application/ld+json"> tags (primary)
 *   - Microdata attributes (itemscope/itemtype/itemprop)
 *   - Open Graph / Twitter Card meta tags (secondary)
 */

import type { RichSnippet } from '../types'

/**
 * Extract all rich snippets from HTML content.
 * Prioritizes JSON-LD, falls back to microdata and meta tags.
 */
export function extractRichSnippets(html: string): RichSnippet[] {
  const snippets: RichSnippet[] = []

  // Phase 1: JSON-LD (most reliable)
  snippets.push(...extractJsonLdSnippets(html))

  // Phase 2: Microdata
  if (snippets.length === 0) {
    snippets.push(...extractMicrodataSnippets(html))
  }

  // Phase 3: OG/meta tags (always include as supplementary)
  const metaSnippets = extractMetaSnippets(html)
  if (metaSnippets) snippets.push(metaSnippets)

  return snippets
}

/**
 * Extract structured data from <script type="application/ld+json"> blocks.
 * Handles both single objects and arrays (e.g. breadcrumbList).
 */
function extractJsonLdSnippets(html: string): RichSnippet[] {
  const snippets: RichSnippet[] = []
  const regex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi
  let match: RegExpExecArray | null

  while ((match = regex.exec(html)) !== null) {
    try {
      const raw = match[1].trim()
      if (!raw) continue
      const parsed = JSON.parse(raw)

      // Handle @graph arrays (schema.org graph container)
      const items = parsed['@graph'] || (Array.isArray(parsed) ? parsed : [parsed])
      for (const item of items) {
        const snippet = jsonLdToSnippet(item)
        if (snippet) snippets.push(snippet)
      }
    } catch (err) {
      // Skip malformed JSON-LD blocks
    }

    // Safety: limit iterations to avoid pathological input
    if (snippets.length > 20) break
  }

  return snippets
}

/**
 * Convert a parsed JSON-LD node to a RichSnippet.
 * Handles common Schema.org types: Product, Recipe, Article, FAQPage,
 * BreadcrumbList, Movie, Book, LocalBusiness, AggregateRating.
 */
function jsonLdToSnippet(node: Record<string, unknown>): RichSnippet | null {
  const type = resolveType(node['@type'] as string | string[] | undefined)
  if (!type) return null

  switch (type) {
    case 'Product':
    case 'LocalBusiness':
    case 'Service': {
      const rating = extractRating(node)
      const price = extractPrice(node)
      if (rating && rating.rating !== undefined) {
        return { type: 'rating', rating: rating.rating, review_count: rating.review_count }
      }
      if (price) {
        return { type: 'price', price }
      }
      return null
    }

    case 'Recipe': {
      const rating = extractRating(node)
      if (rating && rating.rating !== undefined) {
        return { type: 'rating', rating: rating.rating, review_count: rating.review_count }
      }
      return null
    }

    case 'Article':
    case 'NewsArticle':
    case 'BlogPosting':
    case 'TechArticle':
    case 'ScholarlyArticle': {
      const author = extractAuthor(node)
      return {
        type: 'article',
        author: author || undefined,
        reading_time_min: extractReadingTime(node),
      }
    }

    case 'FAQPage': {
      // FAQPage → just signal presence (no question content in rich snippet)
      return { type: 'faq' }
    }

    case 'BreadcrumbList': {
      return { type: 'breadcrumb' }
    }

    case 'AggregateRating': {
      const rating = extractRating(node)
      if (rating && rating.rating !== undefined) {
        return { type: 'rating', rating: rating.rating, review_count: rating.review_count }
      }
      return null
    }

    default:
      return null
  }
}

/**
 * Resolve Schema.org type, handling both string and string[] (multiple types).
 */
function resolveType(type: string | string[] | undefined): string | null {
  if (!type) return null
  if (typeof type === 'string') return type
  // Multiple types: pick the most specific one for rich snippets
  const order = ['Product', 'Recipe', 'Article', 'NewsArticle', 'FAQPage', 'BreadcrumbList', 'LocalBusiness', 'AggregateRating']
  for (const t of order) {
    if (type.includes(t)) return t
  }
  return type[0] || null
}

/**
 * Extract aggregate rating from a schema node.
 * Handles both direct 'aggregateRating' and nested 'review.aggregateRating'.
 */
function extractRating(node: Record<string, unknown>): { rating: number; review_count?: number } | null {
  // Direct aggregateRating
  const ar = node.aggregateRating as Record<string, unknown> | undefined
  if (ar) {
    const ratingValue = parseFloat(ar.ratingValue as string)
    const reviewCount = ar.reviewCount ? parseInt(ar.reviewCount as string, 10) : undefined
    if (!isNaN(ratingValue)) {
      return { rating: Math.min(ratingValue, 5), review_count: reviewCount }
    }
  }

  // Review-based: pick the first review's rating
  const reviews = node.review as Array<Record<string, unknown>> | Record<string, unknown> | undefined
  if (reviews) {
    const reviewList = Array.isArray(reviews) ? reviews : [reviews]
    for (const review of reviewList) {
      const ra = review.reviewRating as Record<string, unknown> | undefined
      if (ra) {
        const ratingValue = parseFloat(ra.ratingValue as string)
        if (!isNaN(ratingValue)) {
          return { rating: Math.min(ratingValue, 5) }
        }
      }
    }
  }

  // Top-level ratingValue (AggregateRating itself)
  if (node.ratingValue !== undefined) {
    const ratingValue = parseFloat(node.ratingValue as string)
    if (!isNaN(ratingValue)) {
      const reviewCount = node.reviewCount ? parseInt(node.reviewCount as string, 10) : undefined
      return { rating: Math.min(ratingValue, 5), review_count: reviewCount }
    }
  }

  return null
}

/**
 * Extract price string from Product/Service schema.
 * Checks 'offers' array or single 'offers' object.
 */
function extractPrice(node: Record<string, unknown>): string | null {
  const offers = node.offers as Array<Record<string, unknown>> | Record<string, unknown> | undefined
  if (!offers) return null

  const offerList = Array.isArray(offers) ? offers : [offers]
  for (const offer of offerList) {
    const price = offer.price as string | number | undefined
    const currency = offer.priceCurrency as string | undefined
    if (price !== undefined) {
      const formatted = typeof price === 'number' ? price.toFixed(2) : price
      return currency ? `${formatted} ${currency}` : `${formatted}`
    }
  }

  // Direct price property (some schemas use this instead of offers)
  if (node.price !== undefined) {
    const price = node.price as string | number
    const currency = node.priceCurrency as string | undefined
    const formatted = typeof price === 'number' ? price.toFixed(2) : price
    return currency ? `${formatted} ${currency}` : `${formatted}`
  }

  return null
}

/**
 * Extract author name from Article schema.
 */
function extractAuthor(node: Record<string, unknown>): string | null {
  const author = node.author as Record<string, unknown> | Array<Record<string, unknown>> | string | undefined
  if (!author) return null
  if (typeof author === 'string') return author
  const list = Array.isArray(author) ? author : [author]
  for (const a of list) {
    if (a.name && typeof a.name === 'string') return a.name
  }
  return null
}

/**
 * Extract reading time from Article schema.
 * Schema.org timeRequired: "PT5M" → 5 minutes.
 */
function extractReadingTime(node: Record<string, unknown>): number | undefined {
  const timeRequired = node.timeRequired as string | undefined
  if (timeRequired) {
    const match = timeRequired.match(/PT(\d+)M/)
    if (match) return parseInt(match[1], 10)
  }
  return undefined
}

/**
 * Extract rich snippets from HTML microdata (itemscope/itemtype/itemprop).
 * Simpler parser that handles common patterns without a full DOM.
 */
function extractMicrodataSnippets(html: string): RichSnippet[] {
  const snippets: RichSnippet[] = []

  // Match itemscope blocks with an itemtype
  const blockRegex = /<[^>]*itemscope[^>]*itemtype=["']https?:\/\/schema\.org\/([^"']+)["'][^>]*>([\s\S]*?)<\/[^>]+>/gi
  let match: RegExpExecArray | null

  while ((match = blockRegex.exec(html)) !== null) {
    const schemaType = match[1]
    const content = match[2]

    switch (schemaType) {
      case 'Product':
      case 'LocalBusiness': {
        const rating = extractMicrodataRating(content)
        if (rating) snippets.push({ type: 'rating', ...rating })
        break
      }
      case 'Article':
      case 'NewsArticle': {
        const author = extractMicrodataProp(content, 'author')
        if (author) snippets.push({ type: 'article', author })
        break
      }
    }

    if (snippets.length > 10) break
  }

  return snippets
}

/**
 * Extract a specific itemprop value from microdata content.
 */
function extractMicrodataProp(content: string, prop: string): string | null {
  const regex = new RegExp(`itemprop=["']${prop}["'][^>]*content=["']([^"']+)["']`, 'i')
  const match = regex.exec(content)
  return match?.[1] || null
}

/**
 * Extract aggregate rating from microdata content.
 */
function extractMicrodataRating(content: string): { rating: number; review_count?: number } | null {
  const ratingRegex = /itemprop=["']ratingValue["'][^>]*content=["']([^"']+)["']/i
  const ratingMatch = ratingRegex.exec(content)
  if (!ratingMatch) return null

  const ratingValue = parseFloat(ratingMatch[1])
  if (isNaN(ratingValue)) return null

  let reviewCount: number | undefined
  const countRegex = /itemprop=["']reviewCount["'][^>]*content=["']([^"']+)["']/i
  const countMatch = countRegex.exec(content)
  if (countMatch) {
    reviewCount = parseInt(countMatch[1], 10)
  }

  return { rating: Math.min(ratingValue, 5), review_count: !isNaN(reviewCount ?? NaN) ? reviewCount : undefined }
}

/**
 * Extract rich snippet from Open Graph and Twitter Card meta tags.
 * These provide basic metadata even without JSON-LD.
 */
function extractMetaSnippets(html: string): RichSnippet | null {
  const ogType = extractMetaContent(html, 'og:type')
  const ogTitle = extractMetaContent(html, 'og:title')
  const articleAuthor = extractMetaContent(html, 'article:author')

  // Detect article types from OG
  if (ogType && ogType.startsWith('article')) {
    return {
      type: 'article',
      author: articleAuthor || undefined,
    }
  }

  // Detect product types
  if (ogType === 'product') {
    const priceMatch = html.match(/<meta[^>]*property=["']product:price\.amount["'][^>]*content=["']([^"']+)["']/i)
    if (priceMatch) {
      return { type: 'price', price: priceMatch[1] }
    }
  }

  return null
}

/**
 * Extract content from a specific meta tag property/name.
 */
function extractMetaContent(html: string, property: string): string | null {
  // Check property= first, then name=
  const regex = new RegExp(`<meta[^>]+(?:property|name)=["']${escapeRegExp(property)}["'][^>]*content=["']([^"']+)["']`, 'i')
  const match = regex.exec(html)
  return match?.[1] || null
}

/**
 * Escape special regex characters in a string.
 */
function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
