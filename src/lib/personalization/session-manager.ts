/**
 * Session Manager (Phase 2)
 *
 * Manages real-time user sessions for personalization:
 * - Tracks current search context
 * - Maintains intent stack for multi-turn queries
 * - Provides real-time recommendations
 * - Handles session expiry and cleanup
 *
 * Architecture:
 * - In-memory cache for fast access
 * - Durable Object for persistence
 * - Redis for cross-isolate sharing (optional)
 */

import { logger, toError } from '../logger'
import type { Env, SearchRequest, SearchResult } from '../../types'

// ============================================================
// Types
// ============================================================

export interface UserSession {
  session_id: string
  user_id: string
  started_at: number
  last_active_at: number

  // Current context
  current_query: string | null
  current_topic: string | null
  current_intent: string | null

  // History within session
  query_history: QueryHistoryEntry[]
  topics_seen: string[]
  domains_visited: string[]

  // Intent stack (for multi-turn)
  intent_stack: IntentFrame[]

  // Real-time signals
  dwell_times: Record<string, number> // url -> dwell time in ms
  scroll_depths: Record<string, number> // url -> scroll depth (0-1)
  back_count: number // number of times user went back

  // Preferences discovered in session
  session_preferences: SessionPreferences
}

export interface QueryHistoryEntry {
  query: string
  timestamp: number
  results_count: number
  clicked_url: string | null
  response_time_ms: number
}

export interface IntentFrame {
  intent: string // e.g., 'search', 'compare', 'verify', 'explore'
  topic: string
  query: string
  timestamp: number
  depth: number // nesting depth
}

export interface SessionPreferences {
  preferred_result_count: number
  preferred_sources: string[]
  preferred_language: string | null
  min_relevance_score: number
}

// ============================================================
// Intent detection
// ============================================================

const INTENT_PATTERNS: Record<string, RegExp[]> = {
  search: [/^(what|who|where|when|how|why)\s/i, /search\sfor/i, /find/i],
  compare: [/(compare|versus|vs\.?|difference between|better)/i],
  verify: [/(is it true|fact check|verify|confirm|really)/i],
  explore: [/(tell me more|explain|elaborate|examples of|learn about)/i],
  navigate: [/(go to|open|show me|take me to)/i],
  purchase: [/(buy|price|cost|cheap|deal|discount|coupon)/i],
}

function detectIntent(query: string): string {
  const lower = query.toLowerCase()
  for (const [intent, patterns] of Object.entries(INTENT_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(lower)) return intent
    }
  }
  return 'search'
}

// ============================================================
// Session Manager
// ============================================================

export class SessionManager {
  private sessions = new Map<string, UserSession>()
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  /**
   * Get or create session for user.
   */
  getOrCreateSession(userId: string, sessionId?: string): UserSession {
    const id = sessionId ?? this.generateSessionId(userId)
    let session = this.sessions.get(id)

    if (!session) {
      session = {
        session_id: id,
        user_id: userId,
        started_at: Date.now(),
        last_active_at: Date.now(),
        current_query: null,
        current_topic: null,
        current_intent: null,
        query_history: [],
        topics_seen: [],
        domains_visited: [],
        intent_stack: [],
        dwell_times: {},
        scroll_depths: {},
        back_count: 0,
        session_preferences: {
          preferred_result_count: 10,
          preferred_sources: [],
          preferred_language: null,
          min_relevance_score: 0.5,
        },
      }
      this.sessions.set(id, session)
    }

    // Check if session expired (30 minutes)
    if (Date.now() - session.last_active_at > 30 * 60 * 1000) {
      // Reset session but keep user_id
      session.started_at = Date.now()
      session.query_history = []
      session.topics_seen = []
      session.intent_stack = []
    }

    session.last_active_at = Date.now()
    return session
  }

  /**
   * Record search in session.
   */
  recordSearch(
    sessionId: string,
    query: string,
    resultsCount: number,
    responseTimeMs: number,
  ): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    const intent = detectIntent(query)
    const topic = this.extractTopic(query)

    // Update current state
    session.current_query = query
    session.current_topic = topic
    session.current_intent = intent

    // Add to history
    session.query_history.push({
      query,
      timestamp: Date.now(),
      results_count: resultsCount,
      clicked_url: null,
      response_time_ms: responseTimeMs,
    })

    // Keep only last 50 queries
    if (session.query_history.length > 50) {
      session.query_history = session.query_history.slice(-50)
    }

    // Update topics
    if (!session.topics_seen.includes(topic)) {
      session.topics_seen.push(topic)
    }

    // Update intent stack
    const lastIntent = session.intent_stack[session.intent_stack.length - 1]
    if (!lastIntent || lastIntent.intent !== intent || lastIntent.topic !== topic) {
      session.intent_stack.push({
        intent,
        topic,
        query,
        timestamp: Date.now(),
        depth: session.intent_stack.length,
      })

      // Keep stack size manageable
      if (session.intent_stack.length > 10) {
        session.intent_stack = session.intent_stack.slice(-10)
      }
    }
  }

  /**
   * Record click in session.
   */
  recordClick(sessionId: string, url: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    // Update history entry
    const lastEntry = session.query_history[session.query_history.length - 1]
    if (lastEntry) {
      lastEntry.clicked_url = url
    }

    // Update domains
    const domain = this.extractDomain(url)
    if (domain && !session.domains_visited.includes(domain)) {
      session.domains_visited.push(domain)
    }
  }

  /**
   * Record dwell time for a URL.
   */
  recordDwellTime(sessionId: string, url: string, dwellTimeMs: number): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.dwell_times[url] = dwellTimeMs

    // Update session preferences based on dwell time
    if (dwellTimeMs > 30000) { // 30+ seconds = high interest
      const domain = this.extractDomain(url)
      if (domain && !session.session_preferences.preferred_sources.includes(domain)) {
        session.session_preferences.preferred_sources.push(domain)
        // Keep only top 5
        if (session.session_preferences.preferred_sources.length > 5) {
          session.session_preferences.preferred_sources.shift()
        }
      }
    }
  }

  /**
   * Record back navigation.
   */
  recordBack(sessionId: string): void {
    const session = this.sessions.get(sessionId)
    if (!session) return

    session.back_count++

    // Pop intent stack on back
    if (session.intent_stack.length > 1) {
      session.intent_stack.pop()
      const newTop = session.intent_stack[session.intent_stack.length - 1]
      if (newTop) {
        session.current_intent = newTop.intent
        session.current_topic = newTop.topic
      }
    }
  }

  /**
   * Get session context for personalization.
   */
  getSessionContext(sessionId: string): {
    currentIntent: string | null
    currentTopic: string | null
    topicHistory: string[]
    preferredSources: string[]
    recentQueries: string[]
  } | null {
    const session = this.sessions.get(sessionId)
    if (!session) return null

    return {
      currentIntent: session.current_intent,
      currentTopic: session.current_topic,
      topicHistory: session.topics_seen,
      preferredSources: session.session_preferences.preferred_sources,
      recentQueries: session.query_history.slice(-5).map(h => h.query),
    }
  }

  /**
   * Get real-time recommendations based on session.
   */
  getRecommendations(sessionId: string): {
    suggestedQueries: string[]
    suggestedDomains: string[]
    topicSuggestions: string[]
  } {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return { suggestedQueries: [], suggestedDomains: [], topicSuggestions: [] }
    }

    // Suggest queries based on topic history
    const suggestedQueries = this.generateQuerySuggestions(session)

    // Suggest domains based on visited domains
    const suggestedDomains = session.session_preferences.preferred_sources.slice(0, 3)

    // Suggest topics based on intent stack
    const topicSuggestions = session.topics_seen.slice(-3)

    return { suggestedQueries, suggestedDomains, topicSuggestions }
  }

  /**
   * Get session stats for monitoring.
   */
  getStats(): {
    activeSessions: number
    avgSessionDuration: number
    avgQueriesPerSession: number
    topIntents: Array<{ intent: string; count: number }>
  } {
    const sessions = [...this.sessions.values()]
    const now = Date.now()

    // Only count sessions active in last hour
    const activeSessions = sessions.filter(s => now - s.last_active_at < 60 * 60 * 1000)

    const avgDuration = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + (s.last_active_at - s.started_at), 0) / activeSessions.length
      : 0

    const avgQueries = activeSessions.length > 0
      ? activeSessions.reduce((sum, s) => sum + s.query_history.length, 0) / activeSessions.length
      : 0

    // Count intents
    const intentCounts = new Map<string, number>()
    for (const session of activeSessions) {
      for (const intent of session.intent_stack) {
        intentCounts.set(intent.intent, (intentCounts.get(intent.intent) ?? 0) + 1)
      }
    }

    const topIntents = [...intentCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 5)
      .map(([intent, count]) => ({ intent, count }))

    return {
      activeSessions: activeSessions.length,
      avgSessionDuration: avgDuration,
      avgQueriesPerSession: avgQueries,
      topIntents,
    }
  }

  /**
   * Cleanup expired sessions.
   */
  cleanup(): number {
    const now = Date.now()
    const expiryMs = 30 * 60 * 1000 // 30 minutes
    let cleaned = 0

    for (const [id, session] of this.sessions) {
      if (now - session.last_active_at > expiryMs) {
        this.sessions.delete(id)
        cleaned++
      }
    }

    return cleaned
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private generateSessionId(userId: string): string {
    return `sess_${userId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }

  private extractTopic(text: string): string {
    const lower = text.toLowerCase()
    const topics = ['technology', 'finance', 'news', 'science', 'health', 'entertainment', 'travel', 'education']
    for (const topic of topics) {
      if (lower.includes(topic)) return topic
    }
    return 'general'
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }

  private generateQuerySuggestions(session: SessionManager['sessions'] extends Map<string, infer V> ? V : never): string[] {
    const suggestions: string[] = []
    const lastQueries = session.query_history.slice(-3).map(h => h.query)

    // Generate follow-up queries based on intent
    if (session.current_intent === 'search') {
      suggestions.push(`more about ${session.current_topic}`)
      suggestions.push(`${session.current_topic} examples`)
    } else if (session.current_intent === 'compare') {
      suggestions.push(`${session.current_topic} pros and cons`)
      suggestions.push(`best ${session.current_topic}`)
    } else if (session.current_intent === 'explore') {
      suggestions.push(`${session.current_topic} tutorial`)
      suggestions.push(`how to use ${session.current_topic}`)
    }

    // Add topic-based suggestions
    for (const topic of session.topics_seen.slice(-2)) {
      suggestions.push(`latest ${topic} news`)
    }

    return suggestions.slice(0, 5)
  }
}

// ============================================================
// Singleton
// ============================================================

let sessionManagerInstance: SessionManager | null = null

export function getSessionManager(env: Env): SessionManager {
  if (!sessionManagerInstance) {
    sessionManagerInstance = new SessionManager(env)
  }
  return sessionManagerInstance
}

export function resetSessionManager(): void {
  sessionManagerInstance = null
}
