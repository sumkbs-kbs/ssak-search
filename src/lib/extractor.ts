/**
 * Content Extraction Module
 * Primary: Jina AI Reader (r.jina.ai) - clean markdown extraction
 * Fallback: Cloudflare HTMLRewriter - server-side DOM parsing
 */

import type { ExtractedContent } from '../types'
import { jinaExtract } from './jina-search'
import { extractWithHtmlRewriter } from './html-rewriter'
import { normalizeUrl, extractDomain } from './util'

export interface ExtractOptions {
  jinaApiKey?: string
  includeImages?: boolean
  maxTokens?: number
  timeoutMs?: number
}

/**
 * Extract clean content from one or more URLs.
 * Tries Jina Reader first, falls back to HTMLRewriter.
 */
export async function extractContent(
  urls: string | string[],
  opts: ExtractOptions = {},
): Promise<ExtractedContent[]> {
  const urlList = Array.isArray(urls) ? urls : [urls]
  // Deduplicate and normalize
  const normalizedUrls = [...new Set(urlList.map((u) => normalizeUrl(u.trim())).filter(Boolean))]

  // Process URLs in parallel (limit concurrency to 5)
  const concurrencyLimit = 5
  const results: ExtractedContent[] = []

  for (let i = 0; i < normalizedUrls.length; i += concurrencyLimit) {
    const batch = normalizedUrls.slice(i, i + concurrencyLimit)
    const batchResults = await Promise.allSettled(
      batch.map((url) => extractSingleUrl(url, opts)),
    )
    for (let j = 0; j < batchResults.length; j++) {
      const result = batchResults[j]
      const url = batch[j]
      if (result.status === 'fulfilled') {
        results.push(result.value)
      } else {
        results.push({
          url,
          raw_content: '',
          success: false,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        })
      }
    }
  }

  return results
}

/** Extract content from a single URL with fallback strategy */
async function extractSingleUrl(
  url: string,
  opts: ExtractOptions,
): Promise<ExtractedContent> {
  const { jinaApiKey, includeImages = false, maxTokens = 8000, timeoutMs = 20000 } = opts

  // Strategy 1: Jina AI Reader (best quality)
  try {
    const result = await jinaExtract(url, {
      apiKey: jinaApiKey,
      includeImages,
      maxTokens,
      timeoutMs,
    })
    if (result.content && result.content.length > 50) {
      return {
        url,
        title: result.title,
        raw_content: result.content,
        images: result.images,
        success: true,
      }
    }
  } catch (err) {
    // Continue to fallback
    console.warn(`Jina reader failed for ${url}:`, err)
  }

  // Strategy 2: Cloudflare HTMLRewriter fallback
  try {
    const result = await extractWithHtmlRewriter(url, { includeImages, maxTokens, timeoutMs })
    if (result.content && result.content.length > 50) {
      return {
        url,
        title: result.title,
        raw_content: result.content,
        images: result.images,
        success: true,
      }
    }
  } catch (err) {
    return {
      url,
      raw_content: '',
      success: false,
      error: err instanceof Error ? err.message : 'Extraction failed',
    }
  }

  return {
    url,
    raw_content: '',
    success: false,
    error: 'No content could be extracted',
  }
}
