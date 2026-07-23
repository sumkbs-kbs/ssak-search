/**
 * Document Chunker — Heading-Aware Segmentation
 *
 * Splits documents into semantic chunks based on HTML heading structure.
 * Preserves heading hierarchy and context for better retrieval.
 */

import type { VectorizeChunk } from './types'

// ============================================================
// Types
// ============================================================

export interface ChunkOptions {
  /** Maximum tokens per chunk (approximate) */
  maxTokens: number
  /** Minimum tokens per chunk */
  minTokens: number
  /** Overlap tokens between chunks */
  overlapTokens: number
  /** Include heading path in chunk content */
  includeHeadingPath: boolean
  /** Max heading depth to consider */
  maxHeadingDepth: number
  /** Language for tokenization hints */
  language?: string
}

export interface ChunkResult {
  chunks: VectorizeChunk[]
  totalTokens: number
  stats: {
    totalChunks: number
    avgTokensPerChunk: number
    headingPaths: string[]
  }
}

export interface ParsedSection {
  heading: string
  level: number // 1-6
  content: string
  children: ParsedSection[]
  startOffset: number
  endOffset: number
}

// ============================================================
// Default Options
// ============================================================

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  maxTokens: 300,
  minTokens: 50,
  overlapTokens: 50,
  includeHeadingPath: true,
  maxHeadingDepth: 3,
  language: 'en',
}

// Re-export constants for convenience
export const MAX_CHUNK_TOKENS = 300
export const MIN_CHUNK_TOKENS = 50

// ============================================================
// HTML Parsing
// ============================================================

/**
 * Parse HTML into hierarchical sections based on headings
 */
export function parseHtmlSections(html: string): ParsedSection[] {
  // Strip scripts, styles, comments
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, '')

  // Extract all heading tags with positions
  const headingRegex = /<h([1-6])[^>]*>([\s\S]*?)<\/h[1-6]>/gi
  const headings: Array<{ level: number; text: string; index: number }> = []

  let match: RegExpExecArray | null
  while ((match = headingRegex.exec(cleaned)) !== null) {
    const level = parseInt(match[1], 10)
    const text = match[2].replace(/<[^>]+>/g, '').trim()
    if (text) {
      headings.push({ level, text, index: match.index })
    }
  }

  if (headings.length === 0) {
    // No headings - return single section with full content
    const text = stripHtml(cleaned).trim()
    return [{
      heading: '',
      level: 0,
      content: text,
      children: [],
      startOffset: 0,
      endOffset: text.length,
    }]
  }

  // Build hierarchy
  const root: ParsedSection = {
    heading: '',
    level: 0,
    content: '',
    children: [],
    startOffset: 0,
    endOffset: cleaned.length,
  }

  const stack: ParsedSection[] = [root]

  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const nextHeading = headings[i + 1]

    // Find parent (closest heading with lower level)
    while (stack.length > 1 && stack[stack.length - 1].level >= h.level) {
      stack.pop()
    }

    const parent = stack[stack.length - 1]

    const startOffset = h.index + h.text.length + h.text.length // approximate
    const endOffset = nextHeading ? nextHeading.index : cleaned.length

    // Extract content between this heading and next
    const sectionContent = cleaned.slice(h.index + (h.text.length + 7), endOffset) // rough

    const section: ParsedSection = {
      heading: h.text,
      level: h.level,
      content: stripHtml(sectionContent).trim(),
      children: [],
      startOffset: startOffset,
      endOffset: endOffset,
    }

    parent.children.push(section)
    stack.push(section)
  }

  return root.children
}

/**
 * Strip HTML tags and decode entities
 */
export function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&/g, '&')
    .replace(/</g, '<')
    .replace(/>/g, '>')
    .replace(/"/g, '"')
    .replace(/'/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Build heading path for a section (e.g., "Introduction > Overview > Details")
 */
export function buildHeadingPath(section: ParsedSection, maxDepth = 3): string {
  const path: string[] = []
  let current: ParsedSection | null = section

  while (current && current.level > 0 && path.length < maxDepth) {
    path.unshift(current.heading)
    // Find parent in tree (simplified - would need full tree traversal)
    break // Simplified for now
  }

  return path.join(' > ')
}

// ============================================================
// Chunking Logic
// ============================================================

/**
 * Estimate token count (rough approximation: 1 token ≈ 4 chars for English, 1.5-2 for CJK)
 */
export function estimateTokens(text: string, language = 'en'): number {
  if (language.startsWith('zh') || language.startsWith('ja') || language === 'ko') {
    // CJK: ~1.5-2 chars per token
    return Math.ceil(text.length / 1.8)
  }
  // Latin: ~4 chars per token
  return Math.ceil(text.length / 4)
}

/**
 * Chunk a document into semantic pieces
 */
export function chunkDocument(
  url: string,
  title: string,
  html: string,
  options: Partial<ChunkOptions> = {}
): ChunkResult {
  const opts = { ...DEFAULT_CHUNK_OPTIONS, ...options }
  const language = options.language ?? 'en'

  // Parse into sections
  const sections = parseHtmlSections(html)

  // Flatten all sections for processing
  const flatSections: Array<{ section: ParsedSection; headingPath: string }> = []

  function flatten(s: ParsedSection, path = '') {
    const newPath = s.heading ? (path ? `${path} > ${s.heading}` : s.heading) : path
    flatSections.push({ section: s, headingPath: newPath })
    for (const child of s.children) {
      flatten(child, newPath)
    }
  }

  for (const s of sections) {
    flatten(s)
  }

  // If no headings found, treat as single section
  if (flatSections.length === 0) {
    const text = stripHtml(html).trim()
    const tokens = estimateTokens(text, options.language)
    if (tokens <= opts.maxTokens) {
      return singleChunkResult(url, title, text, language)
    }
    // Fall through to sliding window chunking
  }

  const chunks: VectorizeChunk[] = []
  let chunkIndex = 0
  let totalTokens = 0
  const headingPaths = new Set<string>()

  // Process each section
  for (const { section, headingPath } of flatSections) {
    if (headingPath) headingPaths.add(headingPath)

    const sectionText = section.content.trim()
    if (!sectionText) continue

    const sectionTokens = estimateTokens(sectionText, options.language)

    if (sectionTokens <= opts.maxTokens) {
      // Section fits in one chunk
      const chunk = createChunk({
        url, title, section, headingPath, chunkIndex, language: options.language,
        content: sectionText,
      })
      chunks.push(chunk)
      totalTokens += estimateTokens(sectionText, options.language)
      chunkIndex++
    } else {
      // Section too large - split with sliding window
      const subChunks = slidingWindowChunk(sectionText, opts, options.language ?? 'en')
      for (const subContent of subChunks) {
        const chunk = createChunk({
          url, title, section, headingPath, chunkIndex, language: options.language,
          content: subContent,
        })
        chunks.push(chunk)
        totalTokens += estimateTokens(subContent, options.language)
        chunkIndex++
      }
    }
  }

  // Calculate stats
  const stats = {
    totalChunks: chunks.length,
    avgTokensPerChunk: chunks.length > 0 ? Math.round(totalTokens / chunks.length) : 0,
    headingPaths: Array.from(headingPaths),
  }

  return { chunks, totalTokens, stats }
}

/**
 * Create a single chunk result for small documents
 */
function singleChunkResult(url: string, title: string, text: string, language: string): ChunkResult {
  const chunk: VectorizeChunk = {
    id: `${hashString(url)}_chunk_0`,
    url,
    title,
    content: text,
    chunkIndex: 0,
    totalChunks: 1,
    domain: extractDomain(url),
    language: detectLanguage(text) ?? 'en',
    contentHash: hashString(text),
  }
  const tokens = estimateTokens(text, 'en')
  return {
    chunks: [chunk],
    totalTokens: tokens,
    stats: { totalChunks: 1, avgTokensPerChunk: tokens, headingPaths: [] },
  }
}

/**
 * Sliding window chunking for large sections
 */
function slidingWindowChunk(
  text: string,
  opts: ChunkOptions,
  language: string
): string[] {
  const chunks: string[] = []
  const maxChars = opts.maxTokens * 4 // rough
  const minChars = opts.minTokens * 4
  const overlapChars = opts.overlapTokens * 4

  let start = 0
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length)

    // Try to break at sentence boundary
    if (end < text.length) {
      const searchStart = Math.max(start + minChars, end - 200)
      const sentenceEnd = findSentenceBoundary(text, searchStart, end)
      if (sentenceEnd > start + minChars) {
        end = sentenceEnd
      }
    }

    const chunk = text.slice(start, end).trim()
    if (chunk.length >= minChars) {
      chunks.push(chunk)
    }

    if (end >= text.length) break

    // Move start forward with overlap
    start = Math.max(end - overlapChars, start + minChars)
  }

  return chunks
}

function findSentenceBoundary(text: string, start: number, end: number): number {
  // Look for sentence endings: . ! ? 。 ！ ？
  const sentenceEndRegex = /[.!?。！？]/g
  let lastMatch = -1
  let match: RegExpExecArray | null

  sentenceEndRegex.lastIndex = start
  while ((match = sentenceEndRegex.exec(text)) !== null) {
    if (match.index >= end) break
    lastMatch = match.index + match[0].length
  }

  return lastMatch > 0 ? lastMatch : end
}

/**
 * Create a VectorizeChunk from section content
 */
interface CreateChunkParams {
  url: string
  title: string
  section: ParsedSection
  headingPath: string
  chunkIndex: number
  language: string | undefined
  content: string
}

function createChunk(params: CreateChunkParams): VectorizeChunk {
  const { section, chunkIndex, content } = params
  const lang = detectLanguage(content) ?? params.language ?? 'en'

  return {
    id: `${hashString(params.url)}_chunk_${chunkIndex}`,
    url: params.url,
    title: params.title,
    content: params.content,
    section: section.heading || undefined,
    chunkIndex,
    totalChunks: 0, // Will be set after all chunks created
    domain: extractDomain(params.url),
    language: lang,
    contentHash: hashString(content),
  }
}

/**
 * Extract domain from URL
 */
export function extractDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch (err) {
    return 'unknown'
  }
}

/**
 * Simple language detection
 */
export function detectLanguage(text: string): string | null {
  // Korean
  if (/[\uAC00-\uD7A3]/.test(text)) return 'ko'
  // Chinese
  if (/[\u4E00-\u9FFF]/.test(text)) return text.includes('繁') || /[\u9FA6-\u9FEF]/.test(text) ? 'zh-TW' : 'zh-CN'
  // Japanese
  if (/[\u3040-\u309F\u30A0-\u30FF]/.test(text)) return 'ja'
  // Default to English
  return 'en'
}

/**
 * Hash string for IDs
 */
export function hashString(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}

// ============================================================
// Convenience function
// ============================================================

export function chunkHtmlDocument(
  url: string,
  title: string,
  html: string,
  options: Partial<ChunkOptions> = {}
): ChunkResult {
  return chunkDocument(url, title, html, options)
}