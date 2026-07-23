/**
 * Query Understanding Classifier — LLM + Regex Hybrid
 *
 * Provides multi-dimensional query understanding:
 * 1. Intent detection (navigational, informational, transactional, commercial)
 * 2. Granular sub-type classification (tutorial, comparison, definition, etc.)
 * 3. Language & script detection
 * 4. Complexity estimation
 * 5. Workers AI integration for LLM-based enhancement
 *
 * Falls back gracefully to regex-based heuristic when AI is unavailable.
 */

import type { Ai } from '@cloudflare/workers-types'

import { logger, toError } from '../logger'
// ============================================================
// Types
// ============================================================

export type SearchIntent = 'informational' | 'navigational' | 'transactional' | 'commercial'

export type QuerySubType =
  | 'definition'       // "what is X"
  | 'how-to'           // "how to X"
  | 'tutorial'         // "X tutorial"
  | 'comparison'       // "X vs Y"
  | 'analysis'         // "analyze X"
  | 'troubleshooting'  // "X not working"
  | 'list'             // "top X", "best X"
  | 'factual'          // "who invented X"
  | 'news'             // "X latest news"
  | 'academic'         // "X research paper"
  | 'financial'        // "X stock price"
  | 'opinion'          // "X review/thoughts"
  | 'location'         // "X near me"
  | 'download'         // "download X"
  | 'general'

export type ScriptType = 'korean' | 'chinese' | 'japanese' | 'latin' | 'mixed' | 'other'

export interface UnderstandingResult {
  /** Primary search intent */
  intent: SearchIntent
  /** Granular query sub-type */
  subType: QuerySubType
  /** Confidence in classification 0-1 */
  confidence: number
  /** Detected script/language type */
  script: ScriptType
  /** Whether the query is complex (multi-part, comparative, analytical) */
  isComplex: boolean
  /** Complexity score 0-1 for pro search routing */
  complexityScore: number
  /** Detected patterns (e.g. ['comparison', 'multi-part']) */
  detectedPatterns: string[]
  /** Human-readable reasoning */
  reasoning: string
  /** Whether the query contains temporal context (dates, years, recency) */
  hasTemporalContext: boolean
  /** Whether the query is a question */
  isQuestion: boolean
  /** Whether AI-based classification was used */
  aiEnhanced: boolean
}

// ============================================================
// Intent Detection Patterns
// ============================================================

const INTENT_PATTERNS: Array<{
  intent: SearchIntent
  patterns: RegExp[]
  weight: number
}> = [
  {
    intent: 'navigational',
    patterns: [
      /^(open|go to|navigate|visit|login|sign in|dashboard)\b/i,
      /\b(website|homepage|site|app|login|signup)\b.*\b(open|go|access)\b/i,
      /^[\w.-]+\.[a-z]{2,}\s*$/i,  // domain.com
      /\b(facebook|twitter|github|linkedin|youtube|netflix|spotify)\b/i,
    ],
    weight: 0.6,
  },
  {
    intent: 'transactional',
    patterns: [
      /\b(buy|purchase|order|subscribe|download|install|get|price|cost|cheap|discount|coupon|deal)\b/i,
      /\b(how much|how many)\b.*\b(cost|price|dollar|usd|krw|eur)\b/i,
      /^(buy|download|subscribe|order|install)\b/i,
    ],
    weight: 0.5,
  },
  {
    intent: 'commercial',
    patterns: [
      /\b(best|top|cheap|cheapest)\b.*\b(price|cost|deal|coupon|review|rating|buy)\b/i,
      /\b(review|rating)\b.*\b(price|cost|worth|value)\b/i,
      /\b(which|what)\b.*\b(best|cheapest|recommend|good|worth)\b/i,
      /\b(compared|comparison|alternatives)\b.*\b(review|rating|price|cost)\b/i,
    ],
    weight: 0.4,
  },
]

// ============================================================
// Sub-Type Detection Patterns
// ============================================================

const SUBTYPE_PATTERNS: Array<{
  subType: QuerySubType
  patterns: RegExp[]
  weight: number
}> = [
  {
    subType: 'definition',
    patterns: [
      /\b(what is|what are|what's|define|definition of|meaning of|explain|what does)\b/i,
      /^(what|what's|define|explain)\b/i,
      /什么是|什麼是|什么叫|什麼叫|이란|이 뭐|무엇|뜻|의미/i,
    ],
    weight: 0.7,
  },
  {
    subType: 'how-to',
    patterns: [
      /\b(how to|how do i|how can i|how would i|steps to|way to)\b/i,
      /^(how|how do|how can)\b/i,
      /방법|하는 법|만드는 법|어떻게|만들기|하는 방법/i,
      /怎么|如何|怎样/i,
    ],
    weight: 0.6,
  },
  {
    subType: 'tutorial',
    patterns: [
      /\b(tutorial|guide|walkthrough|crash course|getting started|beginners|hands-on)\b/i,
      /\b(step by step|step-by-step|from scratch|learn)\b.*\b(tutorial|guide|how)\b/i,
      /튜토리얼|가이드|강좌|강의/i,
    ],
    weight: 0.5,
  },
  {
    subType: 'comparison',
    patterns: [
      /\b(vs|versus|compare|comparison|better than|worse than|or|alternative)\b.*\b(and|or)\b.*\b(\w+)\b/i,
      /\bdifference between\b/i,
      /\b(compare|comparison)\b/i,
      /비교|차이|vs|vs\./i,
    ],
    weight: 0.6,
  },
  {
    subType: 'troubleshooting',
    patterns: [
      /\b(not working|error|bug|issue|problem|failed|broken|crash|fix|solution|troubleshoot)\b/i,
      /\b(error|exception)\b.*\b(fix|solve|help|why|how)\b/i,
      /안됨|오류|에러|문제|해결|고장/i,
    ],
    weight: 0.5,
  },
  {
    subType: 'analysis',
    patterns: [
      /\b(analyze|analysis|evaluate|assessment|pros and cons|trade.?offs|implications|impact|outlook|forecast)\b/i,
      /\b(deep dive|breakdown|examination)\b/i,
      /분석|전망|평가|영향/i,
    ],
    weight: 0.5,
  },
  {
    subType: 'list',
    patterns: [
      /\b(top|best|list of|examples of|types of|kinds of|popular|most|new|trending)\b/i,
      /^(top|best|list|famous|popular)\b/i,
      /추천|베스트|인기|목록|종류/i,
    ],
    weight: 0.4,
  },
  {
    subType: 'news',
    patterns: [
      /\b(news|latest|recent|today|breaking|update|announce|launch|released)\b/i,
      /\b(20\d{2}|next week|this week|yesterday)\b.*\b(news|update|release|announce)\b/i,
      /뉴스|최신|속보|업데이트/i,
    ],
    weight: 0.5,
  },
  {
    subType: 'financial',
    patterns: [
      /\b(stock|stocks|share|shares|price|market cap|dividend|earnings|revenue|pe ratio|per|pbr|eps|roe|ipo)\b/i,
      /주가|주식|증권|코스피|코스닥|시세|배당|실적|목표주가/i,
      /\b(forex|currency|exchange rate|interest rate|inflation|gdp|economic)\b/i,
    ],
    weight: 0.6,
  },
  {
    subType: 'opinion',
    patterns: [
      /\b(review|opinion|thoughts|experience|impressions|feedback|think about|feel about)\b/i,
      /^(is|are|was|were)\b.*\b(good|bad|worth|recommend)\b/i,
      /리뷰|후기|의견|추천/i,
    ],
    weight: 0.4,
  },
  {
    subType: 'location',
    patterns: [
      /\b(near me|nearby|close to|around|in|at)\b.*\b(city|town|area|location|place)\b/i,
      /\b(restaurant|cafe|hotel|store|park|hospital|bank)\b.*\b(near|in|at)\b/i,
      /근처|주변|가까운/i,
    ],
    weight: 0.5,
  },
  {
    subType: 'academic',
    patterns: [
      /\b(paper|research|study|journal|arxiv|thesis|dissertation|citation|reference|bibliography)\b/i,
      /\b(DOI|ISSN|ISBN|conference|proceedings|preprint)\b/i,
    ],
    weight: 0.5,
  },
]

// ============================================================
// Script Detection
// ============================================================

export function detectScript(query: string): ScriptType {
  const hasKorean = /[\uAC00-\uD7A3]/.test(query)
  const hasChinese = /[\u4E00-\u9FFF]/.test(query)
  const hasJapanese = /[\u3040-\u309F\u30A0-\u30FF]/.test(query)
  const hasLatin = /[a-zA-Z]/.test(query)

  const scripts = [hasKorean, hasChinese, hasJapanese, hasLatin].filter(Boolean).length
  if (scripts > 1) return 'mixed'
  if (hasKorean) return 'korean'
  if (hasChinese) return 'chinese'
  if (hasJapanese) return 'japanese'
  if (hasLatin) return 'latin'
  return 'other'
}

// ============================================================
// Question Detection
// ============================================================

const QUESTION_PATTERNS = [
  // English question words
  /^(what|who|when|where|why|how|which|whose|whom)\b/i,
  // English question marks
  /\?$/,
  // Korean question markers
  /[?？]\s*$/,
  /(무엇|누가|언제|어디|왜|어떻게|몇|무슨|어느)/,
  // Chinese question patterns
  /(什么|谁|什么时候|哪里|为什么|怎么|几|哪|吗|呢|吗|嘛)/,
  // Japanese question markers
  /(何|誰|いつ|どこ|なぜ|どう|いくつ|どの|か[？?]?\s*$)/,
]

// ============================================================
// Complexity Patterns
// ============================================================

const COMPLEXITY_PRO_PATTERNS = [
  { pattern: /\b(vs|versus|compare|comparison|difference between|better than|worse than)\b/i, weight: 0.3 },
  { pattern: /\b(what|how|why|when|where|who).*\b(what|how|why|when|where|who)\b/i, weight: 0.3 },
  { pattern: /\b(and|also|additionally|furthermore).*\b(what|how|why|when|where|who)\b/i, weight: 0.25 },
  { pattern: /\b(analyze|analysis|evaluate|assessment|pros and cons|trade.?offs|impact)\b/i, weight: 0.3 },
  { pattern: /\b(step.?by.?step|walk.?through|guide|tutorial).*(?:and|also|then|next)\b/i, weight: 0.2 },
  { pattern: /\b(forecast|predict|outlook|future|trend|will|expect).*(?:202[4-9]|next|future)\b/i, weight: 0.25 },
  { pattern: /\b(best practice|recommended|should i|which is better|optimal)\b/i, weight: 0.15 },
  { pattern: /\b(cause|effect|relationship|correlation|theory|explanation|implication)\b/i, weight: 0.2 },
  { pattern: /\b(architecture|internals|implementation|under the hood|how it works|deep dive)\b/i, weight: 0.2 },
  { pattern: /^.{80,}$/, weight: 0.15 },
  { pattern: /(비교|분석|전망|장단점|차이점|영향|추천).*(?:그리고|또한|이어서)/, weight: 0.25 },
  // Individual Korean complexity keywords
  { pattern: /비교|분석|전망|장단점|차이점|영향|추천|어떻게|왜|무엇이|어느/i, weight: 0.2 },
  // Chinese complexity keywords
  { pattern: /比较|分析|区别|影响|关系|原因|结果/i, weight: 0.15 },
  { pattern: /(比较|分析|区别|影响|关系|原因|结果).*(?:以及|和|并且|此外)/, weight: 0.25 },
]

const COMPLEXITY_FAST_PATTERNS = [
  { pattern: /\b(what is|who is|when did|where is|define|definition of)\b/i, weight: -0.3 },
  { pattern: /^(what|who|when|where|which)\s+\w+\s*$/i, weight: -0.25 },
  { pattern: /^\d+[+\-*/]\d+$/, weight: -0.4 },
  { pattern: /^[\w.-]+\.[a-z]{2,}\s*$/, weight: -0.3 },
]

// ============================================================
// Temporal Context Detection
// ============================================================

const TEMPORAL_PATTERNS = [
  /\b(20\d{2})\b/,          // years: 2024, 2025, etc.
  /\b(today|yesterday|tomorrow|this week|this month|this year|last week|next week)\b/i,
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\b/i,
  /\b(Q[1-4])\b/,           // quarters: Q1, Q2, etc.
  /\b(H1|H2)\b/,            // half-year: H1, H2
  /\d{1,2}[/-]\d{1,2}[/-]\d{2,4}/,  // dates: 01/15/2024
]

// ============================================================
// Main Classifier
// ============================================================

/**
 * Classify a query's intent, sub-type, script, and complexity.
 * Pure regex-based — works without any external dependencies.
 */
export function classifyUnderstanding(
  query: string,
): UnderstandingResult {
  const trimmed = query.trim()

  // --- Script Detection ---
  const script = detectScript(trimmed)

  // --- Question Detection ---
  const isQuestion = QUESTION_PATTERNS.some((p) => p.test(trimmed))

  // --- Intent Detection ---
  let intentScores: Record<SearchIntent, number> = {
    informational: 0.3,  // base assumption
    navigational: 0,
    transactional: 0,
    commercial: 0,
  }

  for (const { intent, patterns, weight } of INTENT_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        intentScores[intent] += weight
        break
      }
    }
  }

  // Intent refinement based on question type
  if (isQuestion) {
    const isWhat = /^(what|which)\b/i.test(trimmed)
    const isHow = /^how\b/i.test(trimmed)
    const isWhy = /^why\b/i.test(trimmed)

    if (isWhat || isHow || isWhy) {
      intentScores.informational += 0.3
    }
  }

  // Pick highest scoring intent
  const intent = (Object.entries(intentScores) as [SearchIntent, number][])
    .reduce((a, b) => (a[1] >= b[1] ? a : b))[0]
  const intentConfidence = Math.min(1, intentScores[intent])

  // --- Sub-Type Detection ---
  let subTypeScores: Record<QuerySubType, number> = {
    definition: 0, 'how-to': 0, tutorial: 0, comparison: 0,
    analysis: 0, troubleshooting: 0, list: 0, factual: 0,
    news: 0, academic: 0, financial: 0, opinion: 0,
    location: 0, download: 0, general: 0.1,
  }

  for (const { subType, patterns, weight } of SUBTYPE_PATTERNS) {
    for (const pattern of patterns) {
      if (pattern.test(trimmed)) {
        subTypeScores[subType] += weight
        break
      }
    }
  }

  // Sub-type to intent consistency adjustment
  const intentToSubType: Partial<Record<SearchIntent, QuerySubType[]>> = {
    navigational: ['definition'],
    transactional: ['download', 'how-to', 'opinion'],
    commercial: ['comparison', 'list', 'opinion'],
    informational: ['definition', 'how-to', 'tutorial', 'analysis', 'troubleshooting',
      'factual', 'news', 'academic', 'financial', 'location'],
  }

  const compatible = intentToSubType[intent] || ['general']
  for (const st of Object.keys(subTypeScores) as QuerySubType[]) {
    if (!compatible.includes(st)) {
      subTypeScores[st] *= 0.5  // penalize incompatible subtypes
    }
  }

  const subType = (Object.entries(subTypeScores) as [QuerySubType, number][])
    .reduce((a, b) => (a[1] >= b[1] ? a : b))[0]
  const subTypeConfidence = Math.min(1, subTypeScores[subType])

  // --- Complexity Score (for pro routing) ---
  let complexityScore = 0
  const detectedPatterns: string[] = []

  for (const { pattern, weight } of COMPLEXITY_PRO_PATTERNS) {
    if (pattern.test(trimmed)) {
      complexityScore += weight
    }
  }

  for (const { pattern, weight } of COMPLEXITY_FAST_PATTERNS) {
    if (pattern.test(trimmed)) {
      complexityScore += weight
    }
  }

  // Word count boost: longer queries are more complex
  const wordCount = trimmed.split(/\s+/).length
  if (wordCount > 12) complexityScore += 0.1
  if (wordCount > 20) complexityScore += 0.1

  // Clamp
  complexityScore = Math.max(0, Math.min(1, complexityScore + 0.3))

  // --- Temporal Context ---
  const hasTemporalContext = TEMPORAL_PATTERNS.some((p) => p.test(trimmed))

  // --- Build detected patterns ---
  if (subType !== 'general') detectedPatterns.push(subType)
  if (complexityScore > 0.5) detectedPatterns.push('complex')

  const confidence = Math.max(intentConfidence, subTypeConfidence)

  return {
    intent,
    subType,
    confidence: Math.min(1, confidence),
    script,
    isComplex: complexityScore > 0.5,
    complexityScore,
    detectedPatterns,
    reasoning: `Intent: ${intent} | SubType: ${subType} | Script: ${script} | Complexity: ${complexityScore.toFixed(2)} | Question: ${isQuestion}`,
    hasTemporalContext,
    isQuestion,
    aiEnhanced: false,
  }
}

// ============================================================
// LLM-Enhanced Classification
// ============================================================

const CLASSIFICATION_SYSTEM_PROMPT = `You are a query understanding classifier. Analyze the user's search query and output a JSON object with these fields:
- "intent": "informational" | "navigational" | "transactional" | "commercial"
- "subType": "definition" | "how-to" | "tutorial" | "comparison" | "analysis" | "troubleshooting" | "list" | "factual" | "news" | "academic" | "financial" | "opinion" | "location" | "download" | "general"
- "entities": array of { "text": string, "type": "person" | "organization" | "place" | "product" | "technology" | "date" | "number" | "concept", "confidence": 0-1 }
- "isComplex": boolean
- "hasTemporalContext": boolean
- "reasoning": string (brief, one sentence)
- "keyTerms": array of strings (important query terms for search)

Respond with ONLY the JSON object, no other text.`

export interface LLMEntity {
  text: string
  type: 'person' | 'organization' | 'place' | 'product' | 'technology' | 'date' | 'number' | 'concept'
  confidence: number
}

export interface LLMEnhancedResult extends UnderstandingResult {
  entities: LLMEntity[]
  keyTerms: string[]
}

/**
 * Classify with LLM enhancement. Falls back to regex-based classifier.
 */
export async function classifyUnderstandingWithAI(
  query: string,
  ai: Ai | undefined,
): Promise<LLMEnhancedResult> {
  const base = classifyUnderstanding(query)

  if (!ai) {
    return { ...base, entities: [], keyTerms: query.split(/\s+/).filter((t) => t.length > 2) }
  }

  try {
    const response = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        { role: 'system', content: CLASSIFICATION_SYSTEM_PROMPT },
        { role: 'user', content: query },
      ],
      max_tokens: 300,
      temperature: 0.1,
      stream: false,
    })

    const responseObj = response as { response?: string }
    const text = responseObj?.response || ''
    const parsed = JSON.parse(text.trim())

    // Map LLM intent to our types
    const llmIntent = ['informational', 'navigational', 'transactional', 'commercial'].includes(parsed.intent)
      ? parsed.intent as SearchIntent
      : base.intent

    const llmSubType = [
      'definition', 'how-to', 'tutorial', 'comparison', 'analysis',
      'troubleshooting', 'list', 'factual', 'news', 'academic',
      'financial', 'opinion', 'location', 'download', 'general',
    ].includes(parsed.subType)
      ? parsed.subType as QuerySubType
      : base.subType

    const entities: LLMEntity[] = Array.isArray(parsed.entities)
      ? parsed.entities.filter(
          (e: { text?: unknown; type?: unknown; confidence?: unknown }) =>
            e && typeof e.text === 'string' && typeof e.type === 'string' && typeof e.confidence === 'number'
        ).map((e: { text: string; type: string; confidence: number }) => ({
          text: e.text,
          type: e.type as LLMEntity['type'],
          confidence: Math.min(1, Math.max(0, e.confidence)),
        }))
      : []

    return {
      ...base,
      intent: llmIntent,
      subType: llmSubType,
      isComplex: parsed.isComplex ?? base.isComplex,
      hasTemporalContext: parsed.hasTemporalContext ?? base.hasTemporalContext,
      reasoning: parsed.reasoning || base.reasoning,
      confidence: 0.8, // LLM-enhanced gets higher base confidence
      aiEnhanced: true,
      entities,
      keyTerms: Array.isArray(parsed.keyTerms) ? parsed.keyTerms.filter((t: unknown) => typeof t === 'string') : [],
    }
  } catch (err) {
    logger.warn('[Understanding] AI classification failed, using heuristic:', { error: toError(err) })
    return { ...base, entities: [], keyTerms: query.split(/\s+/).filter((t) => t.length > 2) }
  }
}
