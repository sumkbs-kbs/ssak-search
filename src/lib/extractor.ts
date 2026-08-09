/**
 * Content Extraction Module
 * Primary: Jina AI Reader (r.jina.ai) - clean markdown extraction
 * Fallback: Cloudflare HTMLRewriter - server-side DOM parsing
 */

import type { ExtractedContent, Env } from '../types'
import { logger, toError } from './logger'
import { jinaExtract } from './jina-search'
import { youtubeExtract, isYouTubeUrl } from './youtube-search'
import { naverNewsExtract, isNaverNewsUrl } from './naver-news-search'
import { extractWithHtmlRewriter } from './html-rewriter'
import { extractRichSnippets } from './rich-snippets'
import { isSidecarAvailable, sidecarExtract } from './sidecar-client'
import { normalizeUrl, assertSafeFetchUrl } from './util'

export interface ExtractOptions {
  jinaApiKey?: string
  includeImages?: boolean
  maxTokens?: number
  timeoutMs?: number
  /** Cloudflare Env for sidecar URL resolution */
  env?: Env
}

/**
 * Extract clean content from one or more URLs.
 * Tries Jina Reader first, falls back to HTMLRewriter.
 *
 * SSRF guard: every URL is validated via `assertSafeFetchUrl` BEFORE any
 * network call. Private IPs, non-http(s) schemes, and credentials-in-URL
 * are rejected at the boundary.
 */
export async function extractContent(urls: string | string[], opts: ExtractOptions = {}): Promise<ExtractedContent[]> {
  const urlList = Array.isArray(urls) ? urls : [urls]

  // Cap number of URLs to prevent request amplification (subrequest budget).
  // 50 is Cloudflare Pages' per-request subrequest ceiling — leave headroom
  // for search-side fetches if extract is invoked from orchestrator.
  const MAX_URLS = 20
  if (urlList.length > MAX_URLS) {
    throw new Error(`Too many URLs (max ${MAX_URLS})`)
  }

  // Deduplicate, normalize, and SSRF-validate each URL.
  // Invalid URLs are recorded as extract failures rather than aborting the
  // whole batch — clients see explicit failure reasons.
  const validated: { url: string; error?: string }[] = []
  const seen = new Set<string>()
  for (const raw of urlList) {
    const trimmed = (raw ?? '').toString().trim()
    if (!trimmed) continue
    let normalized: string
    try {
      normalized = normalizeUrl(trimmed)
      await assertSafeFetchUrl(normalized)
    } catch (err) {
      validated.push({ url: trimmed, error: toError(err) })
      continue
    }
    if (seen.has(normalized.toLowerCase())) continue
    seen.add(normalized.toLowerCase())
    validated.push({ url: normalized })
  }

  const results: ExtractedContent[] = []

  // Emit explicit failure rows for URLs that failed validation
  for (const v of validated) {
    if (v.error) {
      results.push({ url: v.url, raw_content: '', success: false, error: v.error })
    }
  }

  const fetchable = validated.filter((v) => !v.error).map((v) => v.url)
  if (fetchable.length === 0) return results

  // Process URLs in parallel (limit concurrency to 5)
  const concurrencyLimit = 5
  for (let i = 0; i < fetchable.length; i += concurrencyLimit) {
    const batch = fetchable.slice(i, i + concurrencyLimit)
    const batchResults = await Promise.allSettled(batch.map((url) => extractSingleUrl(url, opts)))
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
async function extractSingleUrl(url: string, opts: ExtractOptions): Promise<ExtractedContent> {
  const { jinaApiKey, includeImages = false, maxTokens = 8000, timeoutMs = 20000 } = opts

  // Strategy 0: YouTube — watch-page description + transcript. Generic readers
  // cannot render YouTube watch pages (shell HTML / consent walls), so video
  // links previously contributed NO evidence to the research/chat pipeline
  // even when include_raw_content was requested. This path parses
  // ytInitialPlayerResponse for the description and pulls the transcript, so
  // LLM synthesis gets real video content. Falls through to the generic
  // readers if the video-specific extraction fails.
  if (isYouTubeUrl(url)) {
    try {
      const result = await youtubeExtract(url, { maxTokens, timeoutMs })
      if (result.success) return result
      logger.warn(`YouTube extraction failed for ${url}, falling back to generic readers:`, { error: result.error })
    } catch (err) {
      logger.warn(`YouTube extraction error for ${url}, falling back to generic readers:`, { error: toError(err) })
    }
  }

  // Strategy 0.5: Naver News article — full body from the embedded dic_area.
  // Naver article pages (n.news.naver.com) are JS-rendered; generic readers
  // often return shell HTML / the og:description stub instead of the full
  // article body. This path parses the <article id="dic_area"> body directly
  // so Korean news evidence in the research/chat pipeline gets real article
  // text — the same first-class treatment YouTube watch pages get.
  if (isNaverNewsUrl(url)) {
    try {
      const result = await naverNewsExtract(url, { maxTokens, timeoutMs, env: opts.env })
      if (result.success) return result
      logger.warn(`Naver news extraction failed for ${url}, falling back to generic readers:`, { error: result.error })
    } catch (err) {
      logger.warn(`Naver news extraction error for ${url}, falling back to generic readers:`, { error: toError(err) })
    }
  }

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
    logger.warn(`Jina reader failed for ${url}:`, { error: toError(err) })
  }

  // Strategy 2: Cloudflare HTMLRewriter fallback
  try {
    const result = await extractWithHtmlRewriter(url, { includeImages, maxTokens, timeoutMs })
    if (result.content && result.content.length > 50) {
      // Also extract rich snippets from the raw HTML if available
      let richSnippet: ExtractedContent['rich_snippet']
      if (result.rawHtml) {
        const snippets = extractRichSnippets(result.rawHtml)
        richSnippet = snippets[0]
      }
      return {
        url,
        title: result.title,
        raw_content: result.content,
        images: result.images,
        rich_snippet: richSnippet,
        success: true,
      }
    }
  } catch (err) {
    logger.warn(`HTMLRewriter failed for ${url}:`, { error: toError(err) })
  }

  // Strategy 3: Scrapling Sidecar (JS rendering for dynamic pages)
  if (isSidecarAvailable(opts.env)) {
    try {
      const sidecarResult = await sidecarExtract(url, {
        maxTokens,
        includeImages,
        env: opts.env,
        timeoutMs,
      })
      if (sidecarResult?.success && sidecarResult.content && sidecarResult.content.length > 50) {
        return {
          url,
          title: sidecarResult.title || undefined,
          raw_content: sidecarResult.content,
          images: sidecarResult.images,
          success: true,
        }
      }
    } catch (err) {
      logger.warn(`Sidecar extraction failed for ${url}:`, { error: toError(err) })
    }
  }

  return {
    url,
    raw_content: '',
    success: false,
    error: 'No content could be extracted',
  }
}
