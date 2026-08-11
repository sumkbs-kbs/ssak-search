/**
 * Cloudflare HTMLRewriter-based content extraction
 * This is a fallback when Jina AI Reader is unavailable.
 * Uses Cloudflare's built-in HTMLRewriter for streaming DOM parsing.
 *
 * Phase 4.4 — Adaptive Scraping (Scrapling-inspired):
 * - extractWithAdaptiveMode(): resilient extraction using saved element signatures
 * - SignatureCollector: capture element signatures during extraction for later re-location
 */

import type { Env } from '../types'
import { logger, toError } from './logger'
import { safeFetchWithRedirects, extractDomain, decodeEntities, truncateToTokens } from './util'
import {
  captureSignature,
  findElementsInHtml,
  relocateElement,
  type ElementSignature,
  type AdaptiveConfig,
} from './adaptive-scraper'

export interface HtmlRewriterOptions {
  includeImages?: boolean
  maxTokens?: number
  timeoutMs?: number
}

interface PageContent {
  title: string
  content: string
  images: string[]
}

/**
 * Extract clean content from a URL using Cloudflare HTMLRewriter.
 * Collects text from semantic elements and optionally images.
 */
export async function extractWithHtmlRewriter(
  url: string,
  opts: HtmlRewriterOptions = {},
  env?: Env,
): Promise<{ title: string; content: string; images?: string[]; rawHtml?: string }> {
  const { includeImages = false, maxTokens = 8000, timeoutMs = 15000 } = opts

  // P0-2 (SSRF): user-supplied URLs must be re-validated on EVERY redirect
  // hop — plain `redirect: 'follow'` would let Workers follow a 3xx to a
  // private/internal target without re-running the guard (redirect-pivot /
  // DNS-rebinding vector). safeFetchWithRedirects validates hop 0 (defense
  // in depth — extractor already called assertSafeFetchUrl) and every hop.
  const response = await safeFetchWithRedirects(
    env,
    url,
    {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SearchEngineBot/1.0; +https://webapp.pages.dev)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
      },
    },
    { timeoutMs, maxRedirects: 5 },
  )

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || ''
  const isHtml = contentType.includes('text/html') || contentType.includes('application/xhtml')

  // Read the full response body as text
  const rawHtml = await response.text()

  if (!isHtml) {
    // Non-HTML: return raw text
    return {
      title: extractDomain(url),
      content: truncateToTokens(rawHtml, maxTokens),
      rawHtml: undefined,
    }
  }

  // Reconstruct a Response from the raw HTML for HTMLRewriter processing
  const htmlResponse = new Response(rawHtml, {
    headers: response.headers,
  })

  // Use HTMLRewriter to extract content
  const pageContent: PageContent = {
    title: '',
    content: '',
    images: [],
  }

  // We collect text pieces in order, with element type for structure
  const textPieces: TextPiece[] = []
  let currentElement: string | null = null

  class TextPiece {
    constructor(
      public text: string,
      public tag: string,
    ) {}
  }

  const rewriter = new HTMLRewriter()
    .on('title', {
      text(t) {
        pageContent.title += t.text
        if (t.lastInTextNode) {
          pageContent.title = pageContent.title.trim()
        }
      },
    })
    // Skip non-content elements by removing them entirely from the stream.
    // el.remove() removes the element AND all its children, so we don't need
    // manual skipDepth tracking. This fixes the critical bug where skipDepth
    // was only incremented (never decremented), causing all content after the
    // first skipped element to be silently dropped.
    .on('script, style, noscript, iframe, svg, nav, footer, header, aside, form', {
      element(el) {
        el.remove()
      },
    })
    // Main content elements - add line breaks for structure
    .on('h1, h2, h3, h4, h5, h6', {
      element(el) {
        currentElement = el.tagName
        textPieces.push(new TextPiece('\n\n## ', el.tagName))
      },
      text(t) {
        if (t.text.trim()) {
          textPieces.push(new TextPiece(t.text, currentElement || 'h'))
          if (t.lastInTextNode) textPieces.push(new TextPiece('\n', 'br'))
        }
      },
    })
    .on('p, li, td, th, blockquote, dd, dt', {
      element(el) {
        currentElement = el.tagName
        textPieces.push(new TextPiece('\n', el.tagName))
      },
      text(t) {
        if (t.text.trim()) {
          textPieces.push(new TextPiece(t.text, currentElement || 'p'))
        }
      },
    })
    .on('br', {
      element() {
        textPieces.push(new TextPiece('\n', 'br'))
      },
    })
    // Catch-all for remaining text in body
    .on('body', {
      text(t) {
        if (t.text.trim()) {
          // Avoid duplicating text already captured by specific handlers
          // Only add if current element is not a heading/p/li
          if (
            currentElement &&
            !['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'td', 'th', 'blockquote', 'dd', 'dt'].includes(
              currentElement,
            )
          ) {
            textPieces.push(new TextPiece(t.text, currentElement))
          } else if (!currentElement) {
            textPieces.push(new TextPiece(t.text, 'body'))
          }
        }
        if (t.lastInTextNode) {
          currentElement = null
        }
      },
    })

  // Collect images if requested
  if (includeImages) {
    rewriter.on('img', {
      element(el) {
        const src = el.getAttribute('src') || el.getAttribute('data-src')
        if (src) {
          const absoluteUrl = resolveUrl(src, url)
          if (absoluteUrl) {
            pageContent.images.push(absoluteUrl)
          }
        }
      },
    })
    // Also capture Open Graph image
    rewriter.on('meta[property="og:image"]', {
      element(el) {
        const content = el.getAttribute('content')
        if (content) {
          const absoluteUrl = resolveUrl(content, url)
          if (absoluteUrl && !pageContent.images.includes(absoluteUrl)) {
            pageContent.images.unshift(absoluteUrl)
          }
        }
      },
    })
  }

  // Also capture meta description for better content
  let metaDescription = ''
  rewriter.on('meta[name="description"], meta[property="og:description"]', {
    element(el) {
      const content = el.getAttribute('content')
      if (content && !metaDescription) {
        metaDescription = content
      }
    },
  })

  // Run the rewriter on the reconstructed response
  const transformedResponse = rewriter.transform(htmlResponse)
  // Consume the body to trigger the rewriter handlers
  await transformedResponse.text()

  // Assemble content
  let content = textPieces
    .map((p) => p.text)
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()

  // Decode entities
  content = decodeEntities(content)

  // If content is too short, prepend meta description
  if (content.length < 100 && metaDescription) {
    content = `${metaDescription}\n\n${content}`
  }

  // Fallback title
  if (!pageContent.title) {
    pageContent.title = extractDomain(url)
  }

  return {
    title: pageContent.title,
    content: truncateToTokens(content, maxTokens),
    images: includeImages ? pageContent.images.slice(0, 20) : undefined,
    rawHtml,
  }
}

/** Resolve a relative URL against a base URL */
function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    if (src.startsWith('data:') || src.startsWith('blob:')) return null
    if (src.includes('1x1') || src.includes('pixel')) return null
    return new URL(src, baseUrl).href
  } catch (err) {
    logger.warn('Image URL resolution failed:', { error: toError(err) })
    return null
  }
}

// ============================================================
// Adaptive Extraction (Scrapling-inspired)
// ============================================================

/**
 * Extract content with adaptive element tracking.
 *
 * First attempt: use the original selector (targetSelector).
 * If no matches, try to re-locate elements using saved signatures.
 *
 * This is the TypeScript equivalent of Scrapling's `adaptive=True` mode.
 *
 * Usage:
 *   // Initial scrape (save signature)
 *   const result = await extractWithAdaptiveMode(rawHtml, { targetSelector: 'div.stock_top' })
 *   // Store result.signature for later use
 *
 *   // Re-scrape after HTML change
 *   const result2 = await extractWithAdaptiveMode(newHtml, {
 *     targetSelector: 'div.stock_top',
 *     savedSignature: savedSig,  // from previous scrape
 *   })
 *   // result2.foundWith tells you which selector worked
 */
export async function extractWithAdaptiveMode(
  html: string,
  opts: {
    targetSelector: string
    targetName?: string
    savedSignature?: ElementSignature
    config?: Partial<AdaptiveConfig>
    sourceUrl?: string
  },
): Promise<{
  /** Elements found matching the selector */
  elements: ElementSignature[]
  /** CSS selector that was successfully used */
  usedSelector: string
  /** Whether the position was found via adaptive re-location */
  adaptiveRelocated: boolean
  /** The saved signature (for future re-location) */
  signature: ElementSignature | null
  /** Similarity score if adaptive mode was used */
  similarity: number
}> {
  const { targetSelector, savedSignature, config, sourceUrl } = opts
  const mergedConfig: AdaptiveConfig = {
    minSimilarity: config?.minSimilarity ?? 0.45,
    useTextFingerprint: config?.useTextFingerprint ?? true,
    useStructuralPosition: config?.useStructuralPosition ?? true,
    allowRelaxedSelectors: config?.allowRelaxedSelectors ?? true,
  }

  // Step 1: Try the original selector first
  let elements = findElementsInHtml(html, targetSelector)
  let usedSelector = targetSelector
  let adaptiveRelocated = false
  let similarity = 1.0

  // Step 2: If no matches and we have a saved signature, try adaptive re-location
  if (elements.length === 0 && savedSignature) {
    const result = await relocateElement(savedSignature, html, mergedConfig)

    if (result.found) {
      elements = findElementsInHtml(html, result.usedSelector)
      usedSelector = result.usedSelector
      adaptiveRelocated = true
      similarity = result.similarity
    }
  }

  // Step 3: Generate a new signature from the first matched element (for future use)
  let signature: ElementSignature | null = null
  if (elements.length > 0) {
    signature = elements[0]
  } else if (!savedSignature) {
    // No elements found and no saved signature — create a minimal one from the selector
    const tag = targetSelector.match(/^([a-zA-Z0-9_-]+)/)?.[1] || 'div'
    const classes = (targetSelector.match(/\.([a-zA-Z0-9_-]+)/g) || []).map((c) => c.slice(1))
    const idMatch = targetSelector.match(/#([a-zA-Z0-9_-]+)/)
    signature = captureSignature({
      tag,
      classes,
      id: idMatch?.[1] || '',
      attributes: {},
      textContent: '',
      sourceUrl,
    })
  }

  return {
    elements,
    usedSelector,
    adaptiveRelocated,
    signature,
    similarity,
  }
}

/**
 * Extract and save signatures for multiple target selectors at once.
 * Useful for building a signature database during initial crawl.
 */
export async function extractWithSignatures(
  html: string,
  targets: Array<{ name: string; selector: string }>,
): Promise<
  Array<{
    name: string
    selector: string
    elements: ElementSignature[]
    count: number
  }>
> {
  const results: Array<{
    name: string
    selector: string
    elements: ElementSignature[]
    count: number
  }> = []

  for (const target of targets) {
    const elements = findElementsInHtml(html, target.selector)
    results.push({
      name: target.name,
      selector: target.selector,
      elements,
      count: elements.length,
    })
  }

  return results
}

/**
 * Generate auto-selectors from target names to CSS selectors.
 * This is useful for creating a fallback selector chain.
 *
 * Example:
 *   Input: '네이버 주식 카드'
 *   Output: ['div.stock_top', 'div[class*="stock"]', 'strong.item_name']
 */
export function generateFallbackSelectors(targetName: string): string[] {
  const selectors: string[] = []

  // Common Naver patterns
  if (targetName.includes('stock') || targetName.includes('주식') || targetName.includes('주가')) {
    selectors.push('div.stock_top', 'div[class*="stock"]', 'strong.item_name', 'span.stock_price')
  }
  if (targetName.includes('news') || targetName.includes('뉴스')) {
    selectors.push('a.news_tit', 'div.news_area', 'ul.news_list a', 'a[href*="news"]')
  }
  if (targetName.includes('search') || targetName.includes('검색')) {
    selectors.push('ul.lst_total li', 'div.total_area', 'a.total_tit', 'div.total_group')
  }

  // Generic fallbacks
  if (selectors.length === 0) {
    selectors.push(`[class*="${targetName}"]`, `#${targetName}`, `a[href*="${targetName.toLowerCase()}"]`)
  }

  return selectors
}
