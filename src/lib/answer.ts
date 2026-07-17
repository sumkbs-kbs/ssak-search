/**
 * AI Answer Generation Module
 * Generates synthesized answers from search results.
 *
 * Strategy 1: Cloudflare Workers AI (if AI binding available)
 * Strategy 2: Extractive summarization (keyword-based, no AI needed)
 */

import type { SearchResult, SearchAnswer } from '../types'

/**
 * Generate an AI-style answer from search results.
 * Uses Workers AI if available, otherwise extractive summarization.
 */
export async function generateAnswer(
  query: string,
  results: SearchResult[],
  ai?: Ai,
): Promise<SearchAnswer> {
  // Strategy 1: Workers AI summarization
  if (ai && results.length > 0) {
    try {
      return await generateWithWorkersAI(query, results, ai)
    } catch (err) {
      console.warn('Workers AI answer generation failed, falling back to extractive:', err)
    }
  }

  // Strategy 2: Extractive summarization (always available)
  return generateExtractiveAnswer(query, results)
}

/**
 * Generate answer using Cloudflare Workers AI
 */
async function generateWithWorkersAI(
  query: string,
  results: SearchResult[],
  ai: Ai,
): Promise<SearchAnswer> {
  // Build context from top results
  const contextParts: string[] = []
  const sourceIndices: number[] = []

  for (let i = 0; i < Math.min(results.length, 5); i++) {
    const r = results[i]
    const content = r.raw_content || r.content
    if (content && content.length > 20) {
      // Limit each source to ~800 tokens
      const truncated = content.slice(0, 3200)
      contextParts.push(`[Source ${i + 1}] ${r.title}\nURL: ${r.url}\n${truncated}`)
      sourceIndices.push(i)
    }
  }

  if (contextParts.length === 0) {
    return generateExtractiveAnswer(query, results)
  }

  const prompt = `You are a helpful search assistant. Based on the following search results, provide a concise and accurate answer to the query.

CRITICAL RULES:
1. You MUST cite sources using inline references like [1], [2] at the end of each claim or sentence.
2. The number in [N] must match the [Source N] labels below.
3. Synthesize information from multiple sources when possible.
4. If the sources don't contain enough information, explicitly say "The available sources do not provide sufficient information."
5. Answer in the same language as the query.
6. Keep the answer under 300 words. Start directly with the answer — no preamble.

Query: ${query}

Search Results:
${contextParts.join('\n\n---\n\n')}

Answer (with inline citations [1], [2], etc.):`

  // Use a fast text generation model
  const modelResponse = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
    messages: [
      {
        role: 'system',
        content: 'You are a search assistant that provides concise, accurate answers with inline citations. Always cite sources as [1], [2] etc. Always answer in the same language as the query.',
      },
      { role: 'user', content: prompt },
    ],
    max_tokens: 600,
    temperature: 0.3,
  })

  // Extract text from response
  const responseText = extractAiResponseText(modelResponse)

  if (responseText && responseText.trim().length > 10) {
    return {
      text: responseText.trim(),
      confidence: sourceIndices.length > 2 ? 0.85 : 0.7,
      sources: sourceIndices,
    }
  }

  return generateExtractiveAnswer(query, results)
}

/** Extract text from Workers AI response (handles various response formats) */
function extractAiResponseText(response: unknown): string {
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

/**
 * Extractive summarization - no AI model needed.
 * Selects and combines the most relevant sentences from search results
 * based on query term overlap.
 */
function generateExtractiveAnswer(query: string, results: SearchResult[]): SearchAnswer {
  if (results.length === 0) {
    return {
      text: 'No results found for this query.',
      confidence: 0,
      sources: [],
    }
  }

  const queryTerms = extractQueryTerms(query)
  const sentences: ScoredSentence[] = []

  // Collect sentences from top results with scores
  for (let i = 0; i < Math.min(results.length, 5); i++) {
    const r = results[i]
    const content = r.raw_content || r.content
    if (!content) continue

    const splitSentences = splitIntoSentences(content)
    for (const sentence of splitSentences) {
      if (sentence.length < 30 || sentence.length > 300) continue
      const score = scoreSentence(sentence, queryTerms, i)
      if (score > 0) {
        sentences.push({ text: sentence, score, sourceIndex: i })
      }
    }
  }

  // Sort by score and select top sentences (up to 5)
  sentences.sort((a, b) => b.score - a.score)
  const topSentences = sentences.slice(0, 5)

  // Re-order by source index for coherence
  topSentences.sort((a, b) => a.sourceIndex - b.sourceIndex)

  // Deduplicate similar sentences
  const unique: ScoredSentence[] = []
  for (const s of topSentences) {
    if (!unique.some((u) => similarity(u.text, s.text) > 0.7)) {
      unique.push(s)
    }
  }

  // Build answer with inline citations [1], [2], etc.
  const answerText = unique.map((s) => `${s.text} [${s.sourceIndex + 1}]`).join(' ')

  // Get unique source indices
  const sources = [...new Set(unique.map((s) => s.sourceIndex))]

  return {
    text: answerText || results[0].content.slice(0, 500),
    confidence: Math.min(unique.length / 5, 1) * 0.6,
    sources,
  }
}

interface ScoredSentence {
  text: string
  score: number
  sourceIndex: number
}

/** Extract meaningful terms from the query */
function extractQueryTerms(query: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'must', 'can', 'what', 'when', 'where',
    'who', 'whom', 'which', 'why', 'how', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'and', 'or', 'but', 'not', 'no',
    'yes', 'so', 'than', 'too', 'very', 'just', 'about', 'above',
  ])
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
    .filter((t) => t.length > 1 && !stopWords.has(t))
}

/** Split text into sentences, handling both Western and CJK punctuation */
function splitIntoSentences(text: string): string[] {
  // Handle common abbreviations to avoid false splits
  const protected_ = text.replace(/(\b(?:Mr|Mrs|Dr|Prof|Inc|Ltd|Corp|vs|etc|e\.g|i\.e|U\.S|U\.K)\.)/g, '$1\x00')
  // Split on Western (. ! ?) + CJK (。！？) sentence endings.
  // CJK text often has no spaces, so we split on the punctuation itself.
  const sentences = protected_
    .split(/(?<=[.!?。！？])\s*(?=[A-Z\u00C0-\u017F\uAC00-\uD7A3\u4E00-\u9FFF])/)
    // Also split on CJK punctuation even without following space/letter
    .flatMap((s) => s.split(/(?<=[。！？])/))
    .map((s) => s.replace(/\x00/g, '.').trim())
    .filter((s) => s.length > 0)
  return sentences
}

/** Score a sentence based on query term overlap and source rank */
function scoreSentence(sentence: string, queryTerms: string[], sourceRank: number): number {
  const sentenceLower = sentence.toLowerCase()
  let termHits = 0
  for (const term of queryTerms) {
    if (sentenceLower.includes(term)) termHits++
  }
  const termScore = queryTerms.length > 0 ? termHits / queryTerms.length : 0
  // Source rank penalty: earlier sources get higher scores
  const rankScore = 1 / (sourceRank + 1)
  // Sentence length penalty: prefer medium-length sentences
  const lengthScore = sentence.length > 50 && sentence.length < 200 ? 1 : 0.5
  return termScore * 0.6 + rankScore * 0.3 + lengthScore * 0.1
}

/** Compute Jaccard similarity between two sentences (word overlap) */
function similarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/))
  const setB = new Set(b.toLowerCase().split(/\s+/))
  let intersection = 0
  for (const word of setA) {
    if (setB.has(word)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}
