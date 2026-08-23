/**
 * Multi-turn Conversation Manager (Phase 2)
 *
 * Handles follow-up queries and context carryover:
 * - Tracks conversation context across turns
 * - Resolves pronouns and references
 * - Maintains topic continuity
 * - Supports clarification requests
 *
 * Example:
 *   Turn 1: "What is React?" → explains React
 *   Turn 2: "How does it compare to Vue?" → resolves "it" to React
 *   Turn 3: "What about performance?" → continues React vs Vue topic
 */

import type { Env, SearchResult } from '../../types'

// ============================================================
// Types
// ============================================================

export interface Conversation {
  conversation_id: string
  user_id: string
  started_at: number
  last_active_at: number

  turns: ConversationTurn[]
  context: ConversationContext
  state: ConversationState
}

export interface ConversationTurn {
  turn_id: number
  query: string
  timestamp: number
  results: SearchResult[]
  selected_result: string | null
  response_summary: string | null
  intent: string
  entities: string[]
}

export interface ConversationContext {
  // Topic tracking
  current_topic: string
  topic_history: string[]

  // Entity tracking (resolved references)
  entities: Map<string, ResolvedEntity>

  // Pronoun resolution
  last_mentioned: {
    subject: string | null
    object: string | null
    topic: string | null
  }

  // Comparison tracking
  comparison_items: string[]

  // Question history
  question_types: string[] // 'what', 'how', 'why', etc.
}

export interface ResolvedEntity {
  name: string
  type: string
  first_mentioned_turn: number
  last_mentioned_turn: number
  mention_count: number
  aliases: string[]
}

export interface ConversationState {
  phase: 'exploration' | 'deep-dive' | 'comparison' | 'verification' | 'conclusion'
  depth: number // how deep in subtopics
  satisfaction_score: number // estimated user satisfaction (0-1)
  needs_clarification: boolean
  suggested_followups: string[]
}

// ============================================================
// Pronoun resolution
// ============================================================

const PRONOUN_PATTERNS = {
  subject: /\b(it|they|this|that|these|those|he|she|we)\b/i,
  possessive: /\b(its|their|this|that|his|her|our)\b/i,
  object: /\b(it|them|this|that|these|those|him|her|us)\b/i,
}

// ============================================================
// Conversation Manager
// ============================================================

export class ConversationManager {
  private conversations = new Map<string, Conversation>()
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  /**
   * Get or create conversation.
   */
  getOrCreateConversation(userId: string, conversationId?: string): Conversation {
    const id = conversationId ?? this.generateConversationId(userId)
    let conversation = this.conversations.get(id)

    if (!conversation) {
      conversation = {
        conversation_id: id,
        user_id: userId,
        started_at: Date.now(),
        last_active_at: Date.now(),
        turns: [],
        context: {
          current_topic: '',
          topic_history: [],
          entities: new Map(),
          last_mentioned: { subject: null, object: null, topic: null },
          comparison_items: [],
          question_types: [],
        },
        state: {
          phase: 'exploration',
          depth: 0,
          satisfaction_score: 0.5,
          needs_clarification: false,
          suggested_followups: [],
        },
      }
      this.conversations.set(id, conversation)
    }

    // Check if conversation expired (1 hour)
    if (Date.now() - conversation.last_active_at > 60 * 60 * 1000) {
      // Start new conversation but keep user_id
      conversation.started_at = Date.now()
      conversation.turns = []
      conversation.context = {
        current_topic: '',
        topic_history: [],
        entities: new Map(),
        last_mentioned: { subject: null, object: null, topic: null },
        comparison_items: [],
        question_types: [],
      }
    }

    conversation.last_active_at = Date.now()
    return conversation
  }

  /**
   * Process a new turn in the conversation.
   */
  async processTurn(
    conversationId: string,
    query: string,
    results: SearchResult[],
  ): Promise<{
    resolvedQuery: string
    contextSummary: string
    suggestedFollowups: string[]
  }> {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) {
      return { resolvedQuery: query, contextSummary: '', suggestedFollowups: [] }
    }

    // Resolve references in query
    const resolvedQuery = this.resolveReferences(query, conversation)

    // Extract entities from query
    const entities = this.extractEntities(query)

    // Detect intent
    const intent = this.detectIntent(query)

    // Update conversation context
    this.updateContext(conversation, query, resolvedQuery, entities, intent)

    // Add turn
    const turn: ConversationTurn = {
      turn_id: conversation.turns.length + 1,
      query: resolvedQuery,
      timestamp: Date.now(),
      results,
      selected_result: null,
      response_summary: null,
      intent,
      entities,
    }
    conversation.turns.push(turn)

    // Update conversation state
    this.updateState(conversation, query)

    // Generate follow-up suggestions
    const suggestedFollowups = this.generateFollowups(conversation)

    // Generate context summary
    const contextSummary = this.generateContextSummary(conversation)

    return {
      resolvedQuery,
      contextSummary,
      suggestedFollowups,
    }
  }

  /**
   * Record user feedback on a turn.
   */
  recordFeedback(
    conversationId: string,
    turnId: number,
    selectedResult: string,
    satisfactionScore?: number,
  ): void {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return

    const turn = conversation.turns.find(t => t.turn_id === turnId)
    if (turn) {
      turn.selected_result = selectedResult
    }

    if (satisfactionScore !== undefined) {
      // Update rolling satisfaction score
      const alpha = 0.3 // smoothing factor
      conversation.state.satisfaction_score =
        alpha * satisfactionScore + (1 - alpha) * conversation.state.satisfaction_score
    }
  }

  /**
   * Get conversation context for search.
   */
  getSearchContext(conversationId: string): {
    topic: string
    entities: string[]
    excludeResults: string[] // already seen URLs
    expandQuery: string // additional query terms from context
  } | null {
    const conversation = this.conversations.get(conversationId)
    if (!conversation) return null

    const context = conversation.context

    // Collect already-seen URLs
    const seenUrls = new Set<string>()
    for (const turn of conversation.turns) {
      for (const r of turn.results) {
        seenUrls.add(r.url)
      }
    }

    // Build expanded query from context
    const expandTerms: string[] = []
    if (context.current_topic) {
      expandTerms.push(context.current_topic)
    }
    for (const [, entity] of context.entities) {
      if (entity.mention_count > 1) {
        expandTerms.push(entity.name)
      }
    }

    return {
      topic: context.current_topic,
      entities: [...context.entities.keys()],
      excludeResults: [...seenUrls],
      expandQuery: expandTerms.join(' '),
    }
  }

  /**
   * Get conversation stats.
   */
  getStats(): {
    activeConversations: number
    avgTurnsPerConversation: number
    avgConversationDuration: number
    topTopics: Array<{ topic: string; count: number }>
  } {
    const conversations = [...this.conversations.values()]
    const now = Date.now()

    // Only count conversations active in last hour
    const active = conversations.filter(c => now - c.last_active_at < 60 * 60 * 1000)

    const avgTurns = active.length > 0
      ? active.reduce((sum, c) => sum + c.turns.length, 0) / active.length
      : 0

    const avgDuration = active.length > 0
      ? active.reduce((sum, c) => sum + (c.last_active_at - c.started_at), 0) / active.length
      : 0

    // Count topics
    const topicCounts = new Map<string, number>()
    for (const conv of active) {
      for (const topic of conv.context.topic_history) {
        topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1)
      }
    }

    const topTopics = [...topicCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count }))

    return {
      activeConversations: active.length,
      avgTurnsPerConversation: avgTurns,
      avgConversationDuration: avgDuration,
      topTopics,
    }
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private generateConversationId(userId: string): string {
    return `conv_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  private resolveReferences(query: string, conversation: Conversation): string {
    const context = conversation.context
    let resolved = query

    // Resolve subject pronouns
    if (PRONOUN_PATTERNS.subject.test(query) && context.last_mentioned.subject) {
      resolved = resolved.replace(
        PRONOUN_PATTERNS.subject,
        context.last_mentioned.subject,
      )
    }

    // Resolve possessive pronouns
    if (PRONOUN_PATTERNS.possessive.test(query) && context.last_mentioned.topic) {
      resolved = resolved.replace(
        PRONOUN_PATTERNS.possessive,
        `${context.last_mentioned.topic}'s`,
      )
    }

    return resolved
  }

  private extractEntities(query: string): string[] {
    const entities: string[] = []
    const seen = new Set<string>()

    // Simple capitalization-based extraction
    const words = query.split(/\s+/)
    for (let i = 0; i < words.length; i++) {
      const word = words[i]
      if (/^[A-Z][a-z]/.test(word) && !seen.has(word.toLowerCase())) {
        seen.add(word.toLowerCase())
        entities.push(word)
      }
    }

    // Known product/brand names
    const knownEntities = [
      'React', 'Vue', 'Angular', 'Python', 'JavaScript', 'TypeScript',
      'Google', 'Microsoft', 'Apple', 'Amazon', 'Meta', 'OpenAI',
      'iPhone', 'Galaxy', 'MacBook', 'Windows', 'Linux',
    ]

    for (const entity of knownEntities) {
      if (query.toLowerCase().includes(entity.toLowerCase()) && !seen.has(entity.toLowerCase())) {
        seen.add(entity.toLowerCase())
        entities.push(entity)
      }
    }

    return entities
  }

  private detectIntent(query: string): string {
    const lower = query.toLowerCase()

    if (/^(what|who|where|when|why|how)\s/i.test(lower)) return 'question'
    if (/\b(compare|versus|vs\.?|difference)\b/i.test(lower)) return 'comparison'
    if (/\b(explain|tell me about|describe)\b/i.test(lower)) return 'explanation'
    if (/\b(example|sample|demo)\b/i.test(lower)) return 'example'
    if (/\b(how to|guide|tutorial)\b/i.test(lower)) return 'howto'
    if (/\b(review|opinion)\b/i.test(lower)) return 'review'

    return 'search'
  }

  private updateContext(
    conversation: Conversation,
    originalQuery: string,
    resolvedQuery: string,
    entities: string[],
    intent: string,
  ): void {
    const context = conversation.context
    const turnNumber = conversation.turns.length + 1

    // Update topic
    const topic = this.extractTopic(resolvedQuery)
    if (topic && topic !== context.current_topic) {
      if (context.current_topic) {
        context.topic_history.push(context.current_topic)
      }
      context.current_topic = topic
    }

    // Update entities
    for (const entityName of entities) {
      const existing = context.entities.get(entityName.toLowerCase())
      if (existing) {
        existing.last_mentioned_turn = turnNumber
        existing.mention_count++
      } else {
        context.entities.set(entityName.toLowerCase(), {
          name: entityName,
          type: 'unknown',
          first_mentioned_turn: turnNumber,
          last_mentioned_turn: turnNumber,
          mention_count: 1,
          aliases: [],
        })
      }
    }

    // Update last mentioned
    if (entities.length > 0) {
      context.last_mentioned.subject = entities[0]
      context.last_mentioned.topic = context.current_topic
    }

    // Track question types
    const questionMatch = originalQuery.match(/^(what|who|where|when|why|how)/i)
    if (questionMatch) {
      context.question_types.push(questionMatch[1].toLowerCase())
    }

    // Track comparison items
    if (intent === 'comparison') {
      const vsMatch = resolvedQuery.match(/(.+?)\s+(?:vs\.?|versus|compared to|and)\s+(.+)/i)
      if (vsMatch) {
        context.comparison_items = [vsMatch[1].trim(), vsMatch[2].trim()]
      }
    }
  }

  private updateState(conversation: Conversation, query: string): void {
    const state = conversation.state
    const context = conversation.context
    const turnCount = conversation.turns.length

    // Update depth based on subtopic exploration
    if (/\b(more about|specifically|in particular|details about)\b/i.test(query)) {
      state.depth = Math.min(5, state.depth + 1)
    } else if (/\b(general|overview|summary|big picture)\b/i.test(query)) {
      state.depth = Math.max(0, state.depth - 1)
    }

    // Update phase
    if (turnCount === 1) {
      state.phase = 'exploration'
    } else if (context.comparison_items.length > 0) {
      state.phase = 'comparison'
    } else if (state.depth > 2) {
      state.phase = 'deep-dive'
    } else if (/\b(is it true|verify|confirm|really)\b/i.test(query)) {
      state.phase = 'verification'
    } else if (turnCount > 5) {
      state.phase = 'conclusion'
    }

    // Estimate satisfaction based on interaction patterns
    if (state.satisfaction_score < 0.3) {
      state.needs_clarification = true
    } else {
      state.needs_clarification = false
    }
  }

  private generateFollowups(conversation: Conversation): string[] {
    const followups: string[] = []
    const context = conversation.context
    const state = conversation.state

    // Based on current phase
    if (state.phase === 'exploration') {
      followups.push(`Tell me more about ${context.current_topic}`)
      followups.push(`What are the alternatives?`)
    } else if (state.phase === 'comparison') {
      followups.push(`Which one is better for beginners?`)
      followups.push(`What about pricing?`)
    } else if (state.phase === 'deep-dive') {
      followups.push(`Can you give an example?`)
      followups.push(`What are the best practices?`)
    } else if (state.phase === 'verification') {
      followups.push(`Are there any counterarguments?`)
      followups.push(`What do experts say?`)
    }

    // Based on entities
    for (const [_entityName, entity] of context.entities) {
      if (entity.mention_count === 1) {
        followups.push(`Tell me more about ${entity.name}`)
      }
    }

    return followups.slice(0, 5)
  }

  private generateContextSummary(conversation: Conversation): string {
    const context = conversation.context
    const turnCount = conversation.turns.length

    if (turnCount === 0) return ''

    const parts: string[] = []

    if (context.current_topic) {
      parts.push(`Topic: ${context.current_topic}`)
    }

    if (context.entities.size > 0) {
      const entityNames = [...context.entities.values()]
        .filter(e => e.mention_count > 1)
        .map(e => e.name)
      if (entityNames.length > 0) {
        parts.push(`Key entities: ${entityNames.join(', ')}`)
      }
    }

    if (context.comparison_items.length > 0) {
      parts.push(`Comparing: ${context.comparison_items.join(' vs ')}`)
    }

    return parts.join(' | ')
  }

  private extractTopic(query: string): string {
    const lower = query.toLowerCase()
    const topics = [
      'technology', 'finance', 'health', 'education', 'entertainment',
      'science', 'news', 'travel', 'food', 'sports',
    ]

    for (const topic of topics) {
      if (lower.includes(topic)) return topic
    }

    // Try to extract topic from question words
    const questionTopic = lower.match(/(?:what|who|how|why|when|where)\s+(?:is|are|was|were|do|does|did|can|could|will|would|should)\s+(.+?)(?:\?|$)/)
    if (questionTopic) {
      return questionTopic[1].trim().split(/\s+/).slice(0, 2).join(' ')
    }

    return ''
  }
}

// ============================================================
// Singleton
// ============================================================

let conversationManagerInstance: ConversationManager | null = null

export function getConversationManager(env: Env): ConversationManager {
  if (!conversationManagerInstance) {
    conversationManagerInstance = new ConversationManager(env)
  }
  return conversationManagerInstance
}

export function resetConversationManager(): void {
  conversationManagerInstance = null
}
