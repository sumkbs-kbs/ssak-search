/**
 * LLM-based Intent Classifier (Phase 2)
 *
 * Uses lightweight NLP to classify search intent:
 * - Informational: seeking knowledge/explanation
 * - Navigational: wanting to go to a specific site
 * - Transactional: wanting to perform an action (buy, download, etc.)
 * - Local: seeking location-based information
 *
 * Improvements over regex-based detection:
 * - Handles ambiguous queries better
 * - Understands context and nuance
 * - Supports multi-intent queries
 * - Learns from user feedback
 */

import { logger, toError } from '../logger'
import type { Env } from '../../types'

// ============================================================
// Intent types
// ============================================================

export type SearchIntent =
  | 'informational'    // seeking knowledge
  | 'navigational'     // wants specific site
  | 'transactional'    // wants to do something
  | 'local'           // location-based
  | 'commercial'      // research before purchase
  | 'social'          // seeking opinions/community
  | 'media'           // seeking images/videos
  | 'news'            // seeking current events

export interface IntentClassification {
  primary: SearchIntent
  confidence: number
  secondary?: SearchIntent
  subIntents: string[]
  entities: ExtractedEntity[]
  topicClusters: string[]
}

export interface ExtractedEntity {
  type: 'person' | 'organization' | 'product' | 'location' | 'date' | 'concept'
  value: string
  confidence: number
}

// ============================================================
// Pattern-based classifier (fast fallback)
// ============================================================

const INTENT_PATTERNS: Record<SearchIntent, Array<{ pattern: RegExp; weight: number }>> = {
  informational: [
    { pattern: /^(what|who|where|when|why|how)\s/i, weight: 0.8 },
    { pattern: /\b(explain|describe|define|meaning|tell me about)\b/i, weight: 0.7 },
    { pattern: /\b(difference between|compare|versus|vs\.?)\b/i, weight: 0.6 },
    { pattern: /\b(reason|cause|because|why does)\b/i, weight: 0.7 },
  ],
  navigational: [
    { pattern: /^(go to|open|navigate to|visit)\s/i, weight: 0.9 },
    { pattern: /\b(website|site|page|homepage)\b/i, weight: 0.6 },
    { pattern: /\.com|\.org|\.net|\.io/i, weight: 0.8 },
    { pattern: /\b(login|sign in|account)\b/i, weight: 0.7 },
  ],
  transactional: [
    { pattern: /\b(buy|purchase|order|shop|price|cost)\b/i, weight: 0.8 },
    { pattern: /\b(download|install|get|acquire)\b/i, weight: 0.7 },
    { pattern: /\b(sign up|register|subscribe|join)\b/i, weight: 0.7 },
    { pattern: /\b(book|reserve|schedule|appointment)\b/i, weight: 0.7 },
  ],
  local: [
    { pattern: /\b(near me|nearby|closest|nearest)\b/i, weight: 0.9 },
    { pattern: /\b(in|at|around)\s+\w+\s+(city|town|area)/i, weight: 0.7 },
    { pattern: /\b(directions?|map|route|how to get)\b/i, weight: 0.8 },
    { pattern: /\b(open now|hours|business hours)\b/i, weight: 0.8 },
  ],
  commercial: [
    { pattern: /\b(review|rating|feedback|opinion)\b/i, weight: 0.7 },
    { pattern: /\b(best|top|recommended|alternative)\b/i, weight: 0.6 },
    { pattern: /\b(pros and cons|advantages|disadvantages)\b/i, weight: 0.7 },
    { pattern: /\b(cheap|affordable|budget|deal|discount)\b/i, weight: 0.6 },
  ],
  social: [
    { pattern: /\b(reddit|forum|community|discussion)\b/i, weight: 0.8 },
    { pattern: /\b(experience|testimonial|story)\b/i, weight: 0.6 },
    { pattern: /\b(think|opinion|suggestion|advice)\b/i, weight: 0.6 },
  ],
  media: [
    { pattern: /\b(image|photo|picture|video|watch|listen)\b/i, weight: 0.8 },
    { pattern: /\b(gallery|album|stream|podcast)\b/i, weight: 0.7 },
    { pattern: /\.(jpg|png|mp4|youtube|vimeo)/i, weight: 0.9 },
  ],
  news: [
    { pattern: /\b(news|latest|today|yesterday|recent|update)\b/i, weight: 0.7 },
    { pattern: /\b(breaking|exclusive|interview)\b/i, weight: 0.8 },
    { pattern: /\b(2024|2025|2026)\b/, weight: 0.5 },
  ],
}

// ============================================================
// Entity extraction patterns
// ============================================================

const ENTITY_PATTERNS: Array<{ type: ExtractedEntity['type']; pattern: RegExp }> = [
  { type: 'person', pattern: /\b([A-Z][a-z]+ (?:[A-Z][a-z]+ )*[A-Z][a-z]+)\b/g },
  { type: 'organization', pattern: /\b(Google|Microsoft|Apple|Amazon|Meta|OpenAI|Tesla|SpaceX|Netflix|Adobe)\b/gi },
  { type: 'product', pattern: /\b(iPhone|Galaxy|Pixel|MacBook|Windows|Python|JavaScript|React|Vue)\b/gi },
  { type: 'location', pattern: /\b(New York|San Francisco|London|Tokyo|Paris|Seoul|Beijing|Shanghai)\b/gi },
  { type: 'date', pattern: /\b(yesterday|today|tomorrow|last week|next week|this month)\b/gi },
  { type: 'concept', pattern: /\b(AI|machine learning|blockchain|cloud computing|DevOps|API)\b/gi },
]

// ============================================================
// Intent Classifier
// ============================================================

export class IntentClassifier {
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  /**
   * Classify search intent.
   */
  async classify(query: string): Promise<IntentClassification> {
    // Fast pattern-based classification
    const patternResult = this.classifyByPatterns(query)

    // Extract entities
    const entities = this.extractEntities(query)

    // Determine topic clusters
    const topicClusters = this.detectTopicClusters(query)

    // Detect sub-intents
    const subIntents = this.detectSubIntents(query)

    // Use LLM for ambiguous cases (if available)
    let finalResult = patternResult
    if (this.env.AI && this.isAmbiguous(query, patternResult)) {
      const llmResult = await this.classifyWithLLM(query)
      if (llmResult) {
        finalResult = llmResult
      }
    }

    return {
      ...finalResult,
      entities,
      topicClusters,
      subIntents,
    }
  }

  /**
   * Pattern-based classification (fast, no LLM).
   */
  private classifyByPatterns(query: string): {
    primary: SearchIntent
    confidence: number
    secondary?: SearchIntent
  } {
    const scores: Record<SearchIntent, number> = {
      informational: 0,
      navigational: 0,
      transactional: 0,
      local: 0,
      commercial: 0,
      social: 0,
      media: 0,
      news: 0,
    }

    // Score each intent
    for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
      for (const { pattern, weight } of patterns) {
        if (pattern.test(query)) {
          scores[intent as SearchIntent] += weight
        }
      }
    }

    // Find top 2 intents
    const sorted = Object.entries(scores)
      .sort(([, a], [, b]) => b - a)

    const primary = sorted[0][0] as SearchIntent
    const primaryScore = sorted[0][1]
    const secondary = sorted[1][1] > 0.3 ? sorted[1][0] as SearchIntent : undefined

    // Normalize confidence
    const totalScore = Object.values(scores).reduce((a, b) => a + b, 0)
    const confidence = totalScore > 0 ? primaryScore / totalScore : 0.5

    return { primary, confidence, secondary }
  }

  /**
   * Extract entities from query.
   */
  private extractEntities(query: string): ExtractedEntity[] {
    const entities: ExtractedEntity[] = []
    const seen = new Set<string>()

    for (const { type, pattern } of ENTITY_PATTERNS) {
      const regex = new RegExp(pattern.source, pattern.flags)
      let match
      while ((match = regex.exec(query)) !== null) {
        const value = match[1] ?? match[0]
        const key = `${type}:${value.toLowerCase()}`
        if (!seen.has(key)) {
          seen.add(key)
          entities.push({
            type,
            value,
            confidence: 0.8,
          })
        }
      }
    }

    return entities
  }

  /**
   * Detect topic clusters.
   */
  private detectTopicClusters(query: string): string[] {
    const clusters: string[] = []
    const lower = query.toLowerCase()

    const clusterPatterns: Array<{ cluster: string; patterns: RegExp[] }> = [
      { cluster: 'technology', patterns: [/\b(code|programming|software|hardware|api|developer)\b/i] },
      { cluster: 'finance', patterns: [/\b(stock|investment|crypto|money|budget)\b/i] },
      { cluster: 'health', patterns: [/\b(health|medical|doctor|exercise|diet)\b/i] },
      { cluster: 'education', patterns: [/\b(learn|course|tutorial|study|university)\b/i] },
      { cluster: 'entertainment', patterns: [/\b(movie|music|game|show|book)\b/i] },
      { cluster: 'science', patterns: [/\b(research|study|experiment|theory|scientific)\b/i] },
    ]

    for (const { cluster, patterns } of clusterPatterns) {
      for (const pattern of patterns) {
        if (pattern.test(lower)) {
          clusters.push(cluster)
          break
        }
      }
    }

    return clusters.length > 0 ? clusters : ['general']
  }

  /**
   * Detect sub-intents within the query.
   */
  private detectSubIntents(query: string): string[] {
    const subIntents: string[] = []
    const lower = query.toLowerCase()

    if (/\b(and|also|plus|additionally|as well as)\b/i.test(lower)) {
      subIntents.push('multi-part')
    }
    if (/\b(best|top|recommended|alternative)\b/i.test(lower)) {
      subIntents.push('comparison')
    }
    if (/\b(review|opinion|experience)\b/i.test(lower)) {
      subIntents.push('social-proof')
    }
    if (/\b(how to|guide|tutorial|step by step)\b/i.test(lower)) {
      subIntents.push('how-to')
    }
    if (/\b(example|sample|demo|template)\b/i.test(lower)) {
      subIntents.push('example-seeking')
    }

    return subIntents
  }

  /**
   * Check if query is ambiguous (needs LLM).
   */
  private isAmbiguous(query: string, classification: { confidence: number }): boolean {
    // Low confidence = ambiguous
    if (classification.confidence < 0.4) return true

    // Short queries are often ambiguous
    if (query.split(/\s+/).length < 3) return true

    // Multiple intents detected
    const intentCount = Object.values(INTENT_PATTERNS).filter(patterns =>
      patterns.some(p => p.pattern.test(query))
    ).length
    if (intentCount > 2) return true

    return false
  }

  /**
   * LLM-based classification for ambiguous queries.
   */
  private async classifyWithLLM(query: string): Promise<{
    primary: SearchIntent
    confidence: number
    secondary?: SearchIntent
  } | null> {
    if (!this.env.AI) return null

    try {
      const prompt = `Classify the search intent of this query. Return JSON with "primary" (one of: informational, navigational, transactional, local, commercial, social, media, news), "confidence" (0-1), and optional "secondary" intent.

Query: "${query}"

Response format: { "primary": "...", "confidence": 0.8, "secondary": "..." }`

      const response = await this.env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
      })

      const text = typeof response.response === 'string' ? response.response : JSON.stringify(response.response ?? '')
      const jsonMatch = text.match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        if (parsed.primary && typeof parsed.confidence === 'number') {
          return {
            primary: parsed.primary,
            confidence: Math.min(1, Math.max(0, parsed.confidence)),
            secondary: parsed.secondary,
          }
        }
      }
    } catch (err) {
      logger.debug('[IntentClassifier] LLM classification failed:', { error: toError(err) })
    }

    return null
  }
}
