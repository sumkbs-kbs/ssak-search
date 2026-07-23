/**
 * Jina AI Search Backend
 * Uses Jina AI's free s.jina.ai search API (no API key required, rate-limited)
 * Returns clean markdown content for each result.
 *
 * API: https://s.jina.ai/{query}
 * With optional headers:
 *   X-Retain-Images: none
 *   X-Return-Format: markdown
 */

import type { SearchResult, SearchRequest, Env } from '../types'
import { fetchWithTimeout, extractDomain, parseDate, truncateToTokens, computeScore } from './util'

const JINA_SEARCH_BASE = 'https://s.jina.ai/'

export interface JinaSearchOptions {
  apiKey?: string
  maxResults?: number
  includeRawContent?: boolean
  maxTokens?: number
  timeoutMs?: number
  env?: Env
}

/**
 * Search using Jina AI's s.jina.ai endpoint.
 * This endpoint returns a single aggregated page of results as markdown.
 * We parse the structured result blocks (URL headers + content sections).
 */
export async function jinaSearch(
  query: string,
  opts: JinaSearchOptions = {},
): Promise<SearchResult[]> {
  const {
    apiKey,
    maxResults = 10,
    includeRawContent = false,
    maxTokens = 4000,
    timeoutMs = 20000,
    env,
  } = opts

  // Build the search URL with query parameters
  const encodedQuery = encodeURIComponent(query)
  const searchUrl = `${JINA_SEARCH_BASE}${encodedQuery}`

  const headers: Record<string, string> = {
    'X-Retain-Images': 'none',
    'X-Return-Format': 'markdown',
    'X-Timeout': '20',
    Accept: 'application/json',
  }

  // If we have an API key, use it (higher rate limits)
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetchWithTimeout(
    env,
    searchUrl,
    { headers },
    timeoutMs,
  )

  if (!response.ok) {
    throw new Error(`Jina search failed: ${response.status} ${response.statusText}`)
  }

  // Jina returns JSON with a 'data' array when Accept: application/json
  const contentType = response.headers.get('content-type') || ''
  let results: SearchResult[] = []

  if (contentType.includes('application/json')) {
    const json = (await response.json()) as JinaSearchResponse
    results = parseJinaJsonResponse(json, query, includeRawContent, maxTokens)
  } else {
    // Fallback: parse as text/markdown
    const text = await response.text()
    results = parseJinaTextResponse(text, query, includeRawContent, maxTokens)
  }

  // Limit results
  return results.slice(0, maxResults)
}

// ============================================================
// Jina JSON response parsing
// ============================================================

interface JinaSearchResponse {
  code: number
  status: number
  data: JinaSearchItem[]
}

interface JinaSearchItem {
  title: string
  url: string
  content: string
  description?: string
  publishedTime?: string
  usage?: {
    promptTokens: number
    completionTokens: number
    totalTokens: number
  }
}

function parseJinaJsonResponse(
  json: JinaSearchResponse,
  query: string,
  includeRawContent: boolean,
  maxTokens: number,
): SearchResult[] {
  if (!json.data || !Array.isArray(json.data)) return []

  return json.data.map((item) => {
    const domain = extractDomain(item.url)
    const snippet = truncateToTokens(item.content || item.description || '', 800)
    const result: SearchResult = {
      title: item.title || domain || item.url,
      url: item.url,
      content: snippet,
      score: computeScore(item.title || '', item.content || '', query),
      domain,
      published_date: parseDate(item.publishedTime),
    }
    if (includeRawContent) {
      result.raw_content = truncateToTokens(item.content || '', maxTokens)
    }
    return result
  })
}

// ============================================================
// Jina text/markdown response parsing (fallback)
// ============================================================

function parseJinaTextResponse(
  text: string,
  query: string,
  includeRawContent: boolean,
  maxTokens: number,
): SearchResult[] {
  const results: SearchResult[] = []
  // Jina text format: blocks separated by "## " or "### " headers with URLs
  // Each block starts with a URL line and has a Title: line
  const blocks = text.split(/(?:^|\n)(?:Title:|URL:)/i)

  // Alternative: split by double newlines with URL markers
  const urlBlocks = text.split(/\n(?=https?:\/\/)/)

  for (const block of urlBlocks) {
    const urlMatch = block.match(/^(https?:\/\/[^\s\n]+)/i)
    if (!urlMatch) continue
    const url = urlMatch[1].trim()
    const titleMatch = block.match(/Title:\s*(.+)/i) || block.match(/^#\s+(.+)/m)
    const title = titleMatch ? titleMatch[1].trim() : extractDomain(url)
    const contentMatch = block.match(/(?:Content:|Description:)\s*([\s\S]+?)(?:\n(?:Title|URL|PublishedTime):|$)/i)
    const content = contentMatch ? contentMatch[1].trim() : block.replace(urlMatch[0], '').trim()

    const snippet = truncateToTokens(content, 800)
    const domain = extractDomain(url)
    const result: SearchResult = {
      title,
      url,
      content: snippet,
      score: computeScore(title, content, query),
      domain,
    }
    if (includeRawContent) {
      result.raw_content = truncateToTokens(content, maxTokens)
    }
    results.push(result)
  }

  return results
}

/**
 * Jina AI Reader - extract clean content from a single URL
 * API: https://r.jina.ai/{url}
 */
export async function jinaExtract(
  url: string,
  opts: { apiKey?: string; includeImages?: boolean; maxTokens?: number; timeoutMs?: number; env?: Env } = {},
): Promise<{ title: string; content: string; images?: string[] }> {
  const { apiKey, includeImages = false, maxTokens = 8000, timeoutMs = 20000, env } = opts

  const readerUrl = `https://r.jina.ai/${url}`
  const headers: Record<string, string> = {
    'X-Return-Format': 'markdown',
    'X-Timeout': '20',
    Accept: 'application/json',
  }
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }
  if (includeImages) {
    headers['X-Retain-Images'] = 'key'
  } else {
    headers['X-Retain-Images'] = 'none'
  }

  const response = await fetchWithTimeout(
    env,
    readerUrl,
    { headers },
    timeoutMs,
  )

  if (!response.ok) {
    throw new Error(`Jina reader failed: ${response.status}`)
  }

  const contentType = response.headers.get('content-type') || ''
  if (contentType.includes('application/json')) {
    const json = (await response.json()) as JinaReaderResponse
    return {
      title: json.data?.title || extractDomain(url),
      content: truncateToTokens(json.data?.content || '', maxTokens),
      images: includeImages ? json.data?.images : undefined,
    }
  }

  // Text fallback
  const text = await response.text()
  const titleMatch = text.match(/^Title:\s*(.+)/m)
  const contentMatch = text.match(/Markdown Content:\s*([\s\S]+)/i)
  return {
    title: titleMatch ? titleMatch[1].trim() : extractDomain(url),
    content: truncateToTokens(contentMatch ? contentMatch[1].trim() : text, maxTokens),
  }
}

interface JinaReaderResponse {
  code: number
  status: number
  data: {
    title: string
    description: string
    url: string
    content: string
    images?: string[]
  }
}
