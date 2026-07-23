/**
 * Research Mode — Multi-step Deep Search (v2.0)
 *
 * Perplexity-style Deep Research pipeline with iterative refinement:
 * 1. Query decomposition → dynamic sub-query generation (AI or heuristic)
 * 2. Parallel sub-query execution → evidence collection
 * 3. Evidence evaluation → gap detection
 * 4. Iterative refinement loop (additional sub-queries for uncovered angles)
 * 5. Final synthesis → structured report with inline citations
 *
 * Depth levels:
 *   - 'quick': 3 sub-queries, 1 refinement pass
 *   - 'deep':  5+ sub-queries, up to 2 refinement passes
 */

import type { SearchResult } from '../types'
import { logger, toError } from './logger'
import { executeSearch } from './orchestrator'

export interface ResearchRequest {
  query: string
  depth?: 'quick' | 'deep'
  max_sources?: number
  language?: string
  /** Conversation context for follow-up questions (Phase 1.2) */
  context?: Array<{ query: string; answer: string }>
  /** Uploaded file IDs to include as context (Phase 2.2) */
  file_ids?: string[]
}

export interface ResearchSource {
  title: string
  url: string
  content: string
  sub_query: string
}

export interface ResearchResponse {
  query: string
  answer: string
  sources: ResearchSource[]
  sub_queries: string[]
  depth: 'quick' | 'deep'
  response_time_ms: number
  /** Number of refinement passes executed */
  refinement_passes?: number
  /** Whether gaps were detected and additional queries were generated */
  gaps_filled?: boolean
  /** Token/quality estimate for the answer */
  quality_estimate?: string
}

// ============================================================
// Streaming / SSE Support
// ============================================================

export type ResearchProgressEvent =
  | { type: 'phase'; phase: string; message: string; timestamp: number }
  | { type: 'sub_query_start'; sub_query: string; index: number; total: number; timestamp: number }
  | { type: 'sub_query_complete'; sub_query: string; index: number; total: number; sources_found: number; sources_so_far: number; timestamp: number }
  | { type: 'refinement_start'; pass: number; gap_queries: string[]; timestamp: number }
  | { type: 'refinement_complete'; pass: number; sources_found: number; sources_so_far: number; timestamp: number }
  | { type: 'synthesizing'; sources_count: number; timestamp: number }
  | { type: 'complete'; query: string; sources_count: number; sub_queries_count: number; response_time_ms: number; timestamp: number }
  | { type: 'error'; message: string; timestamp: number }

export type ProgressCallback = (event: ResearchProgressEvent) => void | Promise<void>

function emit(cb: ProgressCallback | undefined, event: ResearchProgressEvent): void {
  if (cb) {
    try {
      void Promise.resolve(cb(event))
    } catch (err) {
      // Non-critical — swallow callback errors
    }
  }
}

// ============================================================
// Step 1: AI-Powered Sub-Query Generation
// ============================================================

/**
 * Generate sub-queries using Workers AI when available.
 * Falls back to heuristic template-based generation.
 */
async function generateSubQueries(
  query: string,
  depth: 'quick' | 'deep',
  ai?: any,
  context?: Array<{ query: string; answer: string }>,
  fileContext?: string,
): Promise<string[]> {
  // If AI is available, use it for smart decomposition
  if (ai) {
    try {
      const aiQueries = await aiGenerateSubQueries(query, depth, ai, context, fileContext)
      if (aiQueries.length >= 2) return aiQueries
    } catch (err) {
      logger.warn('AI sub-query generation failed:', { error: toError(err) })
      // Fall through to heuristic
    }
  }

  // Heuristic fallback: template-based
  const queries: string[] = [query]

  if (depth === 'quick') {
    queries.push(
      `${query} overview`,
      `${query} recent developments 2026`,
      `${query} key facts`,
    )
  } else {
    queries.push(
      `${query} overview and introduction`,
      `${query} recent developments 2026`,
      `${query} advantages and disadvantages`,
      `${query} future outlook`,
      `${query} comparison alternatives`,
      `${query} applications use cases`,
    )
  }

  return queries
}

/**
 * Use Workers AI to generate smart, diverse sub-queries.
 */
async function aiGenerateSubQueries(
  query: string,
  depth: 'quick' | 'deep',
  ai: any,
  context?: Array<{ query: string; answer: string }>,
  fileContext?: string,
): Promise<string[]> {
  const targetCount = depth === 'quick' ? 3 : 6

  const contextBlock = context && context.length > 0
    ? `\nCONVERSATION CONTEXT (previous exchanges):\n${context.map((c, i) => `  Q${i + 1}: ${c.query}\n  A${i + 1}: ${c.answer.slice(0, 300)}`).join('\n\n')}\n\nThe current query is a FOLLOW-UP to this conversation. Generate sub-queries that build on the previous answers.\n`
    : ''

  const fileBlock = fileContext
    ? `\nUPLOADED DOCUMENTS (user-provided context):\n${fileContext.slice(0, 2000)}\n\nConsider these documents when generating sub-queries. Include sub-queries that reference or build upon the uploaded content.\n`
    : ''

  const prompt = `You are a research strategist. Decompose the following research query into ${targetCount} specific, diverse sub-queries that together provide comprehensive coverage.

RESEARCH QUERY: "${query}"
${contextBlock}${fileBlock}
RULES:
- Each sub-query must be SELF-CONTAINED (can be searched independently)
- Cover DIFFERENT angles: background, technical details, controversies, comparisons, recent developments, future outlook
- Be SPECIFIC and SEARCHABLE (not vague)
- Return ONLY a JSON array of strings, no other text
- Exactly ${targetCount} sub-queries

Example output format:
["sub query 1", "sub query 2", "sub query 3"]`

  const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      { role: 'system', content: 'You are a research strategist that outputs only valid JSON arrays.' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 500,
    temperature: 0.4,
  })

  const text = extractResponseText(response)
  const parsed = tryParseJsonArray(text)
  if (parsed && parsed.length >= 2) {
    // Ensure the original query is included
    if (!parsed.includes(query)) {
      parsed.unshift(query)
    }
    return parsed.slice(0, targetCount + 1)
  }

  throw new Error('Failed to parse AI-generated sub-queries')
}

// ============================================================
// Step 2: Evidence Collection
// ============================================================

/**
 * Execute sub-queries and collect deduplicated sources.
 * Emits progress events per sub-query when onProgress is provided.
 */
async function collectEvidence(
  subQueries: string[],
  maxSources: number,
  config: { env?: any; ai?: any },
  onProgress?: ProgressCallback,
): Promise<ResearchSource[]> {
  const seenUrls = new Set<string>()
  const sources: ResearchSource[] = []

  // Emit start events for all sub-queries
  for (let i = 0; i < subQueries.length; i++) {
    emit(onProgress, { type: 'sub_query_start', sub_query: subQueries[i], index: i, total: subQueries.length, timestamp: Date.now() })
  }

  // Fire all searches in parallel but track each individually for streaming
  const searchPromises = subQueries.map((sq, i) =>
    executeSearch(
      {
        query: sq,
        max_results: Math.min(12, maxSources),
        search_depth: 'advanced',
        include_answer: false,
        include_raw_content: true,
      },
      { env: config.env, ai: config.ai },
    )
      .then((result) => ({ index: i, result }))
      .catch((err) => {
        logger.warn(`Sub-query failed: "${sq}" —`, { error: toError(err) })
        return { index: i, result: null }
      }),
  )

  // Track each sub-query result as it completes
  for (const promise of searchPromises) {
    const { index, result } = await promise
    const sq = subQueries[index]
    let sourcesFound = 0

    if (result?.results) {
      for (const r of result.results) {
        if (seenUrls.has(r.url)) continue
        seenUrls.add(r.url)
        sources.push({
          title: r.title,
          url: r.url,
          content: (r.raw_content || r.content || '').slice(0, 2000),
          sub_query: sq,
        })
        sourcesFound++
        if (sources.length >= maxSources) break
      }
    }

    emit(onProgress, {
      type: 'sub_query_complete',
      sub_query: sq,
      index,
      total: subQueries.length,
      sources_found: sourcesFound,
      sources_so_far: sources.length,
      timestamp: Date.now(),
    })

    if (sources.length >= maxSources) break
  }

  return sources
}

// ============================================================
// Step 3: Gap Detection
// ============================================================

/**
 * Evaluate whether collected sources are sufficient.
 * Returns gap analysis and suggested additional queries.
 */
async function detectGaps(
  query: string,
  sources: ResearchSource[],
  depth: 'quick' | 'deep',
  ai?: any,
): Promise<{ hasGaps: boolean; additionalQueries: string[] }> {
  // Minimum source threshold
  const minSources = depth === 'deep' ? 6 : 3
  if (sources.length < minSources) {
    return {
      hasGaps: true,
      additionalQueries: [`${query} in-depth analysis`, `${query} detailed information`],
    }
  }

  // If no AI, skip AI-based gap detection
  if (!ai) return { hasGaps: false, additionalQueries: [] }

  // Use AI to detect information gaps
  const sourceTitles = sources.slice(0, 8).map((s) => `- ${s.title} (${s.url})`).join('\n')

  try {
    const prompt = `You are a research quality analyst. Evaluate whether the following sources are SUFFICIENT to comprehensively answer the research query.

RESEARCH QUERY: "${query}"

COLLECTED SOURCES:
${sourceTitles}

For 'deep' mode: we need at least 6 quality sources covering different angles.
For 'quick' mode: we need at least 3 quality sources.

If sources are INSUFFICIENT, suggest 1-2 specific sub-queries to fill the gaps.
If sources are SUFFICIENT, respond with just: {"sufficient": true}

OUTPUT FORMAT (JSON only):
{"sufficient": true}
or
{"sufficient": false, "gaps": ["suggested sub-query 1", "suggested sub-query 2"]}`

    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: 'You are a research quality analyst. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 300,
      temperature: 0.2,
    })

    const text = extractResponseText(response)
    const parsed = tryParseJson(text)
    if (parsed && parsed.sufficient === false && Array.isArray(parsed.gaps)) {
      return {
        hasGaps: true,
        additionalQueries: parsed.gaps.slice(0, 2),
      }
    }
  } catch (err) {
    logger.warn('Gap analysis failed:', { error: toError(err) })
    // Fall through — assume sufficient
  }

  return { hasGaps: false, additionalQueries: [] }
}

// ============================================================
// Step 4: Synthesis
// ============================================================

/**
 * Generate a structured research answer using Workers AI.
 * Uses source-grounded generation with inline citations.
 */
async function synthesizeAnswer(
  query: string,
  sources: ResearchSource[],
  subQueries: string[],
  ai: any,
  context?: Array<{ query: string; answer: string }>,
  fileContext?: string,
): Promise<string> {
  const maxContextSources = sources.slice(0, 12)
  const sourceContext = maxContextSources
    .map((s, i) => `[Source ${i + 1}] ${s.title}\nURL: ${s.url}\n${s.content.slice(0, 1200)}`)
    .join('\n\n---\n\n')

  const subQueryList = subQueries.map((sq, i) => `  ${i + 1}. "${sq}"`).join('\n')

  const contextBlock = context && context.length > 0
    ? `\nCONVERSATION CONTEXT (previous exchanges in this thread):\n${context.map((c, i) => `  Q${i + 1}: ${c.query}\n  A${i + 1}: ${c.answer.slice(0, 500)}`).join('\n\n')}\n\nThe user's current query is a FOLLOW-UP to this conversation. Build upon the previous answers—do NOT repeat what was already said. Focus on NEW information that addresses the follow-up.\n`
    : ''

  const fileBlock = fileContext
    ? `\nUPLOADED DOCUMENTS (user-provided reference material):\n${fileContext.slice(0, 3000)}\n\nIncorporate information from these documents into your answer where relevant. Cite them by filename.\n`
    : ''

  const prompt = `You are a research analyst producing a comprehensive report. Based on the provided sources, write a thorough answer to the research query.
${contextBlock}${fileBlock}
RESEARCH QUERY: ${query}

SUB-QUERIES SEARCHED:
${subQueryList}

SOURCES:
${sourceContext}

REPORT STRUCTURE:
1. **Executive Summary** (2-3 sentences)
2. **Key Findings** (bulleted, each with [N] citation)
3. **Detailed Analysis** (2-3 paragraphs covering different angles)
4. **Key Statistics / Data Points** (if available, with citations)
5. **Contrasting Views / Debates** (if sources disagree)
6. **Research Gaps** (what information is NOT available)
7. **Sources** (numbered list of cited URLs)

RULES:
- Cite sources inline as [1], [2] using the [Source N] numbers
- Synthesize across sources — do NOT list them sequentially
- If a claim lacks source support, say "this could not be verified from available sources"
- Answer in the SAME LANGUAGE as the research query (${query})
- Use markdown formatting for readability`

  try {
    const modelResponse = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a research analyst that produces well-structured reports with inline citations. Use markdown formatting including headings, bold, and bullet points.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 2000,
      temperature: 0.3,
    })

    const text = extractResponseText(modelResponse)
    if (text && text.trim().length > 50) return text.trim()
  } catch (err) {
    logger.warn('Research answer synthesis failed:', { error: toError(err) })
  }

  return ''
}

// ============================================================
// File Context Integration (Phase 2.2b)
// ============================================================

interface FileRecord {
  file_id: string
  filename: string
  text_content: string
  summary?: string
  key_points?: string[]
}

/**
 * Fetch uploaded file contents from R2 to include as research context.
 */
async function fetchFileContext(env: any, fileIds: string[]): Promise<string> {
  if (!env?.UPLOAD_BUCKET || !fileIds || fileIds.length === 0) return ''

  const blocks: string[] = []

  for (const fileId of fileIds) {
    try {
      const metaObj = await env.UPLOAD_BUCKET.get(`meta_${fileId}`)
      if (!metaObj) continue

      const record: FileRecord = JSON.parse(await metaObj.text())
      const content = record.text_content?.slice(0, 4000) || ''
      const keyPoints = record.key_points?.map(k => `  - ${k}`).join('\n') || ''
      const summary = record.summary ? `Summary: ${record.summary}` : ''

      blocks.push(
        `--- UPLOADED FILE: "${record.filename}" ---\n${summary}${keyPoints ? '\nKey Points:\n' + keyPoints : ''}\n\nContent:\n${content}\n--- END FILE ---`
      )
    } catch (err) {
      logger.warn(`Failed to fetch file context for ${fileId}:`, { error: toError(err) })
    }
  }

  return blocks.join('\n\n')
}

// ============================================================
// Main Pipeline
// ============================================================

/**
 * Execute a research query with multi-step search, iterative refinement,
 * and structured synthesis.
 */
export async function executeResearch(
  request: ResearchRequest,
  config: { env?: any; ai?: any },
  onProgress?: ProgressCallback,
): Promise<ResearchResponse> {
  const startTime = Date.now()
  const { query, depth = 'quick', max_sources = 15, context, file_ids } = request

  // Fetch uploaded file context if file_ids provided (Phase 2.2b)
  let fileContext = ''
  if (file_ids && file_ids.length > 0 && config.env) {
    emit(onProgress, { type: 'phase', phase: 'file_context', message: 'Loading uploaded file context...', timestamp: Date.now() })
    fileContext = await fetchFileContext(config.env, file_ids)
  }

  emit(onProgress, { type: 'phase', phase: 'decomposition', message: 'Generating sub-queries...', timestamp: Date.now() })

  // Phase 1: AI-powered sub-query generation (with conversation + file context)
  const subQueries = await generateSubQueries(query, depth, config.ai, context, fileContext)

  emit(onProgress, { type: 'phase', phase: 'search', message: `Searching ${subQueries.length} sub-queries...`, timestamp: Date.now() })

  // Phase 2: Collect evidence from all sub-queries
  let sources = await collectEvidence(subQueries, max_sources, config, onProgress)

  // Phase 3: Iterative refinement — detect gaps and fill them
  let refinementPasses = 0
  let gapsFilled = false
  const maxRefinements = depth === 'deep' ? 2 : 1

  for (let pass = 0; pass < maxRefinements; pass++) {
    emit(onProgress, { type: 'phase', phase: 'gap_analysis', message: 'Analyzing for information gaps...', timestamp: Date.now() })

    const gapResult = await detectGaps(query, sources, depth, config.ai)
    if (!gapResult.hasGaps) break

    refinementPasses++
    gapsFilled = true

    emit(onProgress, {
      type: 'refinement_start',
      pass: pass + 1,
      gap_queries: gapResult.additionalQueries,
      timestamp: Date.now(),
    })

    // Execute additional gap-filling queries
    const additionalSources = await collectEvidence(
      gapResult.additionalQueries,
      Math.max(5, max_sources - sources.length),
      config,
      onProgress,
    )

    // Merge new sources (dedup by URL)
    const seenUrls = new Set(sources.map((s) => s.url))
    for (const s of additionalSources) {
      if (!seenUrls.has(s.url)) {
        seenUrls.add(s.url)
        sources.push(s)
      }
    }

    emit(onProgress, {
      type: 'refinement_complete',
      pass: pass + 1,
      sources_found: additionalSources.length,
      sources_so_far: sources.length,
      timestamp: Date.now(),
    })

    // Cap total sources
    if (sources.length >= max_sources) {
      sources = sources.slice(0, max_sources)
      break
    }

    // Small delay to avoid hammering backends
    if (pass < maxRefinements - 1) {
      await new Promise((r) => setTimeout(r, 200))
    }
  }

  const responseTimeMs = Date.now() - startTime

  // Phase 4: Synthesize answer
  let answer = ''
  let qualityEstimate = 'unavailable'
  if (config.ai && sources.length > 0) {
    emit(onProgress, { type: 'synthesizing', sources_count: sources.length, timestamp: Date.now() })
    answer = await synthesizeAnswer(query, sources, subQueries, config.ai, context, fileContext)
    qualityEstimate = sources.length >= 8 ? 'comprehensive' : sources.length >= 4 ? 'moderate' : 'limited'
  }

  emit(onProgress, {
    type: 'complete',
    query,
    sources_count: sources.length,
    sub_queries_count: subQueries.length,
    response_time_ms: responseTimeMs,
    timestamp: Date.now(),
  })

  return {
    query,
    answer,
    sources,
    sub_queries: subQueries,
    depth,
    response_time_ms: responseTimeMs,
    refinement_passes: refinementPasses,
    gaps_filled: gapsFilled,
    quality_estimate: qualityEstimate,
  }
}

// ============================================================
// Helpers
// ============================================================

function extractResponseText(response: unknown): string {
  if (typeof response === 'string') return response
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>
    if (typeof r.response === 'string') return r.response
    if (Array.isArray(r.response) && r.response.length > 0) {
      const first = r.response[0] as Record<string, unknown>
      if (first && typeof first === 'object' && typeof first.content === 'string') {
        return first.content
      }
    }
  }
  return ''
}

function tryParseJsonArray(text: string): string[] | null {
  try {
    // Try to extract JSON array from the text (may be wrapped in markdown code fences)
    const match = text.match(/```(?:json)?\s*(\[[\s\S]*?\])\s*```/) || text.match(/\[[\s\S]*\]/)
    const jsonStr = match ? match[1] || match[0] : text
    const parsed = JSON.parse(jsonStr)
    if (Array.isArray(parsed) && parsed.every((i) => typeof i === 'string')) {
      return parsed
    }
  } catch (err) {
    // Not valid
  }
  return null
}

function tryParseJson(text: string): Record<string, unknown> | null {
  try {
    const match = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || text.match(/\{[\s\S]*\}/)
    const jsonStr = match ? match[1] || match[0] : text
    const parsed = JSON.parse(jsonStr)
    if (parsed && typeof parsed === 'object') return parsed
  } catch (err) {
    // Not valid
  }
  return null
}
