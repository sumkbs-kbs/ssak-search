/**
 * Cloudflare HTMLRewriter-based content extraction
 * This is a fallback when Jina AI Reader is unavailable.
 * Uses Cloudflare's built-in HTMLRewriter for streaming DOM parsing.
 */

import { fetchWithTimeout, extractDomain, decodeEntities, truncateToTokens } from './util'

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
): Promise<{ title: string; content: string; images?: string[] }> {
  const { includeImages = false, maxTokens = 8000, timeoutMs = 15000 } = opts

  const response = await fetchWithTimeout(
    url,
    {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (compatible; SearchEngineBot/1.0; +https://webapp.pages.dev)',
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
      },
      redirect: 'follow',
    },
    timeoutMs,
  )

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
    // Non-HTML: return raw text
    const text = await response.text()
    return {
      title: extractDomain(url),
      content: truncateToTokens(text, maxTokens),
    }
  }

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
          if (currentElement && !['h1','h2','h3','h4','h5','h6','p','li','td','th','blockquote','dd','dt'].includes(currentElement)) {
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

  // Run the rewriter - we need to consume the response
  // The HTMLRewriter transforms the response, we use a dummy Response to trigger
  const transformedResponse = rewriter.transform(response)
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
  }
}

/** Resolve a relative URL against a base URL */
function resolveUrl(src: string, baseUrl: string): string | null {
  try {
    // Skip data URIs and blob URLs
    if (src.startsWith('data:') || src.startsWith('blob:')) return null
    // Skip tiny tracking pixels
    if (src.includes('1x1') || src.includes('pixel')) return null
    return new URL(src, baseUrl).href
  } catch {
    return null
  }
}
