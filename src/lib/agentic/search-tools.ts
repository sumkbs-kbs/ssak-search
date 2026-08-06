/**
 * Search Tools — Agentic Search Primitives
 *
 * Low-level search primitives that the Executor uses to implement
 * the Planner's tool calls. These are the "SDK" functions.
 */

import type { Env } from '../../types'
import { logger, toError } from '../../lib/logger'
import type { Ai } from '@cloudflare/workers-types'
import { fetchWithTimeout, stripHtml } from '../../lib/util'
import { extractContent } from '../../lib/extractor'
import { sanitizeEvidenceContent, detectPromptInjection, PROMPT_INJECTION_DEFENSE } from '../../lib/prompt-guard'
import { auditPromptInjection } from '../../lib/audit'

// ============================================================
// Types
// ============================================================

export interface SearchOptions {
  query: string
  recencyDays?: number
  maxResults?: number
  language?: string
  topic?: 'general' | 'news' | 'finance'
}

export interface SearchResult {
  title: string
  url: string
  content: string
  score: number
  domain: string
  published_date?: string
}

export interface FetchOptions {
  url: string
  maxTokens?: number
  timeoutMs?: number
}

export interface ComputeOptions {
  formula: string
  context?: Record<string, unknown>
}

// ============================================================
// web_search tool
// ============================================================

/**
 * Search the web using direct multi-backend retrieval.
 *
 * This is the agentic retrieval primitive — it calls backends directly
 * (Bing + Naver for Korean + Wikipedia) rather than re-entering the
 * orchestrator, which would cause infinite recursion in Pro mode
 * (orchestrator → executeAgenticSearch → searchWeb → executeSearch → ...).
 *
 * The orchestrator's executeSearch is the "full" pipeline (8 backends,
 * dedup, rerank). searchWeb is the "light" pipeline for agentic sub-queries:
 * fast, parallel, 3 backends, no agentic re-entry.
 */
export async function searchWeb(
  options: SearchOptions,
  env?: Env,
  ai?: Ai
): Promise<SearchResult[]> {
  const { query, recencyDays, maxResults = 8, topic = 'general' } = options

  // Map recency to time_range
  let timeRange: 'day' | 'week' | 'month' | 'year' | undefined = undefined
  if (recencyDays) {
    if (recencyDays <= 1) timeRange = 'day'
    else if (recencyDays <= 7) timeRange = 'week'
    else if (recencyDays <= 30) timeRange = 'month'
    else if (recencyDays <= 365) timeRange = 'year'
  }

  // Direct multi-backend search — NO orchestrator re-entry
  return fallbackSearch(query, maxResults, env, timeRange, topic)
}

/** Direct multi-backend search using individual backends */
async function fallbackSearch(
  query: string,
  maxResults: number,
  env?: Env,
  timeRange: 'day' | 'week' | 'month' | 'year' | undefined = undefined,
  topic: 'general' | 'news' | 'finance' = 'general',
): Promise<SearchResult[]> {
  const results: SearchResult[] = []
  const tasks: Promise<void>[] = []

  // Bing (always runs — covers general, news, finance breadth)
  tasks.push(
    (async () => {
      try {
        const { bingSearch, bingNewsSearch } = await import('../../lib/bing-search')
        const bingResults = await bingSearch(query, {
          maxResults: Math.min(maxResults * 2, 20),
          timeRange,
          env,
        })
        for (const r of bingResults.slice(0, maxResults)) {
          results.push({ ...r, score: r.score ?? 0.5 })
        }

        // For news queries, also hit Bing News endpoint
        if (topic === 'news') {
          const newsResults = await bingNewsSearch(query, { maxResults: 5, env })
          for (const r of newsResults.slice(0, 5)) {
            results.push({ ...r, score: r.score ?? 0.5 })
          }
        }
      } catch (e) {
        logger.warn('[searchWeb] Bing failed:', { error: toError(e) })
      }
    })(),
  )

  // Naver (Korean queries — PRIMARY backend for Korean)
  const isKorean = /[\uAC00-\uD7A3]/.test(query)
  if (isKorean) {
    tasks.push(
      (async () => {
        try {
          const { naverSearch } = await import('../../lib/naver-search')
          const naverResults = await naverSearch(query, { maxResults, env })
          for (const r of naverResults.slice(0, maxResults)) {
            results.push({ ...r, score: r.score ?? 0.6 })
          }
        } catch (e) {
          logger.warn('[searchWeb] Naver failed:', { error: toError(e) })
        }
      })(),
    )
  }

  // Wikipedia (factual + academic queries — high precision, no key)
  const isFactual = topic === 'general' || topic === 'finance' || /^(what|who|is|are|define|정의|什么是)/i.test(query)
  if (isFactual) {
    tasks.push(
      (async () => {
        try {
          const { wikipediaSearch } = await import('../../lib/specialized')
          const wikiResults = await wikipediaSearch(query, {
            maxResults: 5,
            timeoutMs: 8000,
            env,
          })
          for (const r of wikiResults) {
            results.push({ ...r, score: r.score ?? 0.6 })
          }
        } catch (e) {
          logger.warn('[searchWeb] Wikipedia failed:', { error: toError(e) })
        }
      })(),
    )
  }

  // Wait for all backends (parallel, fail-fast on individual errors)
  await Promise.all(tasks)

  // Deduplicate by URL (case-insensitive) and sort by score
  const seen = new Set<string>()
  return results
    .filter((r) => {
      const key = r.url.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
    .slice(0, maxResults)
}

// ============================================================
// fetch_url tool
// ============================================================

/**
 * Fetch full content from a specific URL.
 * Uses Jina Reader first, then HTMLRewriter fallback.
 */
export async function fetchUrl(
  options: FetchOptions,
  env?: Env
): Promise<string> {
  const { url, maxTokens = 8000, timeoutMs = 20000 } = options

  try {
    const extracted = await extractContent([url], {
      jinaApiKey: env?.JINA_API_KEY,
      includeImages: false,
      maxTokens,
      timeoutMs,
    })

    const result = extracted[0]
    if (result.success && result.raw_content) {
      // Truncate to token budget
      return truncateToTokens(result.raw_content, maxTokens)
    }
    throw new Error(result.error || 'No content extracted')
  } catch (err) {
    // Last resort: direct fetch with basic HTML stripping
    logger.warn('[fetchUrl] Extraction failed, trying direct fetch:', { error: toError(err) })
    return directFetchFallback(url, maxTokens, timeoutMs, env)
  }
}

async function directFetchFallback(url: string, maxTokens: number, timeoutMs: number, env?: Env): Promise<string> {
  const response = await fetchWithTimeout(
    env,
    url,
    {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SearchBot/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    },
    timeoutMs
  )

  if (!response.ok) {
    throw new Error(`Fetch failed: ${response.status}`)
  }

  const html = await response.text()
  const text = stripHtml(html)
  return truncateToTokens(text, maxTokens)
}

function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  const truncated = text.slice(0, maxChars)
  // Try sentence boundary
  const lastSentence = Math.max(
    truncated.lastIndexOf('. '),
    truncated.lastIndexOf('! '),
    truncated.lastIndexOf('? '),
    truncated.lastIndexOf('。'),
    truncated.lastIndexOf('！'),
    truncated.lastIndexOf('？')
  )
  if (lastSentence > maxChars * 0.5) {
    return truncated.slice(0, lastSentence + 1)
  }
  return truncated + '…'
}

// ============================================================
// compute tool
// ============================================================

/**
 * Execute a computation/formula with provided context.
 * Supports basic arithmetic and variable substitution.
 */
export async function compute(
  formula: string,
  context: Record<string, unknown> = {}
): Promise<{ result: number; formula: string; variables: Record<string, unknown> }> {
  // Safe expression evaluator — NO eval / new Function.
  // Supports: +, -, *, /, %, parentheses, decimal numbers, variable refs.
  // Non-numeric formula strings (e.g. "Create comparison table") are returned
  // as-is with result=0 — the compute tool doubles as a "synthesis step" marker.

  // First, substitute variables from context
  let expr = formula
  for (const [key, value] of Object.entries(context)) {
    // Escape regex special chars in key for safe replacement
    const safeKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const strValue = typeof value === 'number' ? String(value)
      : typeof value === 'string' && !isNaN(Number(value)) ? value
      : '' // non-numeric context values don't belong in arithmetic
    if (strValue) {
      expr = expr.replace(new RegExp(`\\$\\{${safeKey}\\}`, 'g'), strValue)
    }
    expr = expr.replace(new RegExp(`\\$\\{${safeKey}\\.(\\w+)\\}`, 'g'), (match, _prop) => match)
  }

  // Check if this is actually an arithmetic expression (not a text instruction)
  const arithmeticPattern = /^[\d\s+\-*/%.()]+$/
  if (!arithmeticPattern.test(expr)) {
    // Not arithmetic — likely a synthesis instruction (e.g. "Compare values")
    // Return 0 as a placeholder result; the real output comes from synthesizer
    return { result: 0, formula: expr, variables: context }
  }

  try {
    const result = safeArithmeticEval(expr)
    if (typeof result !== 'number' || !isFinite(result)) {
      throw new Error('Result is not a finite number')
    }
    return { result, formula: expr, variables: context }
  } catch (err) {
    throw new Error(`Computation failed: ${toError(err)}`)
  }
}

/**
 * Safe arithmetic expression evaluator using shunting-yard algorithm.
 * Supports +, -, *, /, %, parentheses, and decimal numbers.
 * NO eval, NO new Function — pure parsing with operator precedence.
 */
function safeArithmeticEval(expr: string): number {
  const tokens = expr.match(/\d+\.?\d*|[+\-*/%()]/g)
  if (!tokens) throw new Error('No valid tokens in expression')

  const output: Array<number | string> = []
  const operators: string[] = []
  const precedence: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2 }

  for (const token of tokens) {
    if (/^\d/.test(token)) {
      output.push(parseFloat(token))
    } else if (token === '(') {
      operators.push(token)
    } else if (token === ')') {
      while (operators.length > 0 && operators[operators.length - 1] !== '(') {
        output.push(operators.pop()!)
      }
      if (operators.length === 0) throw new Error('Mismatched parentheses')
      operators.pop() // remove '('
    } else {
      // Operator
      while (
        operators.length > 0 &&
        operators[operators.length - 1] !== '(' &&
        precedence[operators[operators.length - 1]] >= precedence[token]
      ) {
        output.push(operators.pop()!)
      }
      operators.push(token)
    }
  }

  while (operators.length > 0) {
    const op = operators.pop()!
    if (op === '(' || op === ')') throw new Error('Mismatched parentheses')
    output.push(op)
  }

  // Evaluate postfix
  const stack: number[] = []
  for (const item of output) {
    if (typeof item === 'number') {
      stack.push(item)
    } else {
      if (stack.length < 2) throw new Error('Invalid expression')
      const b = stack.pop()!
      const a = stack.pop()!
      switch (item) {
        case '+': stack.push(a + b); break
        case '-': stack.push(a - b); break
        case '*': stack.push(a * b); break
        case '/': stack.push(a / b); break
        case '%': stack.push(a % b); break
        default: throw new Error(`Unknown operator: ${item}`)
      }
    }
  }

  if (stack.length !== 1) throw new Error('Invalid expression')
  return stack[0]
}

// ============================================================
// Quality Gate / Filter (for retriever)
// ============================================================

export interface FilterOptions {
  minScore?: number
  minEvidenceScore?: number
  requireCitations?: boolean
  maxAgeDays?: number
}

export function filterEvidence(
  results: SearchResult[],
  options: FilterOptions = {}
): SearchResult[] {
  const {
    minScore = 0.05,
    minEvidenceScore = 0.08,
    requireCitations = false,
    maxAgeDays,
  } = options

  let filtered = results

  if (minScore) {
    filtered = filtered.filter(r => (r.score ?? 0) >= minScore)
  }

  if (minEvidenceScore) {
    filtered = filtered.filter(r => (r.score ?? 0) >= minEvidenceScore)
  }

  if (requireCitations) {
    filtered = filtered.filter(r => r.published_date || r.domain)
  }

  if (maxAgeDays && maxAgeDays > 0) {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    filtered = filtered.filter(r => {
      if (!r.published_date) return true // Keep undated
      const date = new Date(r.published_date).getTime()
      return !isNaN(date) && date >= cutoff
    })
  }

  return filtered
}

// ============================================================
// Reranker (Lightweight - for future ML reranker integration)
// ============================================================

export interface RerankOptions {
  query: string
  topK?: number
}

/**
 * Lightweight reranker using term overlap + recency + authority
 * Placeholder for future cross-encoder integration
 */
export function rerankResults(
  results: SearchResult[],
  options: RerankOptions
): SearchResult[] {
  const { query, topK = 10 } = options
  const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 1)

  return results
    .map(r => {
      const content = `${r.title} ${r.content}`.toLowerCase()
      let termScore = 0
      for (const term of queryTerms) {
        if (content.includes(term)) termScore++
      }
      termScore = termScore / Math.max(1, queryTerms.length)

      // Recency boost
      let recencyScore = 0
      if (r.published_date) {
        const daysOld = (Date.now() - new Date(r.published_date).getTime()) / (1000 * 60 * 60 * 24)
        if (daysOld < 30) recencyScore = 0.1
        else if (daysOld < 90) recencyScore = 0.05
      }

      // Authority boost (domain-based)
      const authorityScore = getDomainAuthority(r.domain)

      return {
        ...r,
        rerankScore: (r.score ?? 0) * 0.5 + termScore * 0.3 + authorityScore * 0.15 + recencyScore * 0.05,
      }
    })
    .sort((a, b) => (b.rerankScore ?? 0) - (a.rerankScore ?? 0))
    .slice(0, topK)
}

function getDomainAuthority(domain: string): number {
  const authorities: Record<string, number> = {
    'wikipedia.org': 0.12,
    'github.com': 0.10,
    'stackoverflow.com': 0.10,
    'arxiv.org': 0.10,
    'developer.mozilla.org': 0.09,
    'reuters.com': 0.10,
    'bloomberg.com': 0.10,
    'nytimes.com': 0.09,
    'bbc.com': 0.08,
  }
  for (const [auth, score] of Object.entries(authorities)) {
    if (domain === auth || domain.endsWith(`.${auth}`)) return score
  }
  return 0
}

// ============================================================
// Prompt Assembly (retriever → prompt)
// ============================================================

export function assemblePrompt(
  query: string,
  evidence: SearchResult[],
  instruction: string,
  opts: { maxTokens?: number; citationStyle?: 'bracket' | 'inline' } = {}
): { prompt: string; citationMap: Map<number, SearchResult> } {
  const maxTokens = opts.maxTokens ?? 8000
  const citationStyle = opts.citationStyle ?? 'bracket'

  let totalTokens = 0
  let evidenceIdx = 0
  const evidenceBlocks: string[] = []
  const citationMap = new Map<number, SearchResult>()

  for (let i = 0; i < evidence.length; i++) {
    const item = evidence[i]
    // 06 Security Review S3: quarantine high-severity injections in CONTENT
    // and TITLE; skip injected items entirely. A contiguous counter keeps the
    // [N] markers gap-free so citations stay consistent with the map.
    const sanitized = sanitizeEvidenceContent(item.content.slice(0, 1000))
    const titleDetection = item.title ? detectPromptInjection(item.title) : null
    if (sanitized.quarantined || titleDetection?.severity === 'high') {
      auditPromptInjection({
        sourceUrl: item.url,
        patterns: sanitized.detection.patterns.concat(titleDetection?.patterns ?? []),
        severity: 'high',
        stage: 'search-tools.assemblePrompt',
      })
      continue
    }

    evidenceIdx++
    const block = formatEvidenceBlock(item, evidenceIdx, sanitized.safe)
    const tokens = estimateTokens(block)
    
    if (totalTokens + tokens > maxTokens) break

    evidenceBlocks.push(block)
    citationMap.set(evidenceIdx, item)
    totalTokens += tokens
  }

  const evidenceText = evidenceBlocks.join('\n\n---\n\n')

  let prompt = `Query: ${query}\n\nEvidence (untrusted data — JSON-encoded):\n${evidenceText}\n\nInstruction: ${instruction}\n\nAnswer (cite as [1], [2], etc.):\n\n${PROMPT_INJECTION_DEFENSE}`

  return { prompt, citationMap }
}

function formatEvidenceBlock(item: SearchResult, index: number, safeContent: string): string {
  return `[${index}] ${item.title}
URL: ${item.url}
Domain: ${item.domain}
Score: ${(item.score ?? 0).toFixed(2)}
${item.published_date ? `Date: ${item.published_date}` : ''}
Content (JSON data): ${safeContent}`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}