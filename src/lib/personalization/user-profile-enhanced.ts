/**
 * Enhanced User Profile System (Phase 2)
 *
 * Improvements over basic UserProfileDO:
 * - Search history tracking with timestamps
 * - Interest tagging based on query patterns
 * - Session-based real-time personalization
 * - Recommendation engine based on user behavior
 * - Topic affinity scoring
 *
 * Architecture:
 * - D1 DB for persistent storage (cross-device sync)
 * - Durable Object for real-time session state
 * - Redis for fast caching (optional)
 */

import { logger, toError } from '../logger'
import type { Env, SearchRequest, SearchResult } from '../../types'

// ============================================================
// Enhanced Types
// ============================================================

export interface EnhancedUserProfile {
  user_id: string
  // Basic info
  created_at: number
  updated_at: number
  last_active_at: number

  // Search history
  search_history: SearchHistoryEntry[]
  total_searches: number

  // Interest profile
  interests: InterestProfile
  topic_affinities: Record<string, number> // topic -> score (0-1)

  // Domain preferences
  domain_preferences: DomainPreference[]
  blocked_domains: string[]

  // Session data
  current_session: SessionData | null

  // Personalization settings
  personalization_enabled: boolean
  learning_enabled: boolean
}

export interface SearchHistoryEntry {
  query: string
  timestamp: number
  results_clicked: string[] // URLs clicked
  results_count: number
  response_time_ms: number
  topic?: string
  language?: string
}

export interface InterestProfile {
  topics: TopicInterest[]
  keywords: KeywordInterest[]
  categories: CategoryInterest[]
}

export interface TopicInterest {
  topic: string
  score: number // 0-1, higher = more interested
  last_seen: number
  query_count: number
}

export interface KeywordInterest {
  keyword: string
  score: number
  last_seen: number
}

export interface CategoryInterest {
  category: string // e.g., 'technology', 'finance', 'news'
  score: number
  last_seen: number
  query_count: number
}

export interface DomainPreference {
  domain: string
  visit_count: number
  click_through_rate: number // clicks / impressions
  avg_dwell_time_ms: number
  last_visited: number
  trust_score: number // 0-1
}

export interface SessionData {
  session_id: string
  started_at: number
  last_active_at: number
  queries: string[]
  topics: string[]
  domains_visited: string[]
  intent_stack: string[] // stack of user intents
}

// ============================================================
// Interest extraction
// ============================================================

const TOPIC_KEYWORDS: Record<string, string[]> = {
  technology: ['programming', 'software', 'hardware', 'ai', 'machine learning', 'coding', 'developer', 'api', 'javascript', 'python', 'react', 'typescript'],
  finance: ['stock', 'investment', 'crypto', 'bitcoin', 'trading', 'market', 'portfolio', 'dividend', 'earnings', 'revenue'],
  news: ['breaking', 'latest', 'today', 'yesterday', 'recent', 'update', 'announcement', 'report'],
  science: ['research', 'study', 'experiment', 'hypothesis', 'theory', 'discovery', 'journal', 'paper'],
  health: ['health', 'medical', 'doctor', 'treatment', 'symptom', 'disease', 'wellness', 'fitness'],
  entertainment: ['movie', 'music', 'game', 'celebrity', 'streaming', 'netflix', 'spotify', 'youtube'],
  travel: ['travel', 'hotel', 'flight', 'destination', 'vacation', 'trip', 'tourism', 'booking'],
  education: ['learn', 'course', 'tutorial', 'university', 'student', 'exam', 'degree', 'certificate'],
}

const CATEGORY_MAP: Record<string, string[]> = {
  'tech': ['github.com', 'stackoverflow.com', 'dev.to', 'medium.com', 'hackernews.com'],
  'news': ['cnn.com', 'bbc.com', 'reuters.com', 'nytimes.com', 'apnews.com'],
  'finance': ['finance.yahoo.com', 'bloomberg.com', 'investing.com', 'coinmarketcap.com'],
  'academic': ['arxiv.org', 'scholar.google.com', 'researchgate.net', 'jstor.org'],
  'social': ['reddit.com', 'twitter.com', 'facebook.com', 'linkedin.com'],
}

// ============================================================
// Profile Manager
// ============================================================

export class EnhancedProfileManager {
  private env: Env

  constructor(env: Env) {
    this.env = env
  }

  /**
   * Get or create user profile.
   */
  async getOrCreateProfile(userId: string): Promise<EnhancedUserProfile> {
    const existing = await this.getProfile(userId)
    if (existing) return existing

    const profile: EnhancedUserProfile = {
      user_id: userId,
      created_at: Date.now(),
      updated_at: Date.now(),
      last_active_at: Date.now(),
      search_history: [],
      total_searches: 0,
      interests: { topics: [], keywords: [], categories: [] },
      topic_affinities: {},
      domain_preferences: [],
      blocked_domains: [],
      current_session: null,
      personalization_enabled: true,
      learning_enabled: true,
    }

    await this.saveProfile(profile)
    return profile
  }

  /**
   * Get user profile from D1 DB.
   */
  async getProfile(userId: string): Promise<EnhancedUserProfile | null> {
    if (!this.env.SEARCH_INDEX_DB) return null

    try {
      const result = await this.env.SEARCH_INDEX_DB.prepare(
        'SELECT profile_data FROM user_profiles WHERE user_id = ?'
      ).bind(userId).first<{ profile_data: string }>()

      if (!result) return null
      return JSON.parse(result.profile_data) as EnhancedUserProfile
    } catch (err) {
      logger.warn('[Profile] Failed to get profile:', { error: toError(err) })
      return null
    }
  }

  /**
   * Save user profile to D1 DB.
   */
  async saveProfile(profile: EnhancedUserProfile): Promise<void> {
    if (!this.env.SEARCH_INDEX_DB) return

    profile.updated_at = Date.now()

    try {
      await this.env.SEARCH_INDEX_DB.prepare(
        `INSERT OR REPLACE INTO user_profiles (user_id, profile_data, updated_at)
         VALUES (?, ?, ?)`
      ).bind(
        profile.user_id,
        JSON.stringify(profile),
        profile.updated_at,
      ).run()
    } catch (err) {
      logger.warn('[Profile] Failed to save profile:', { error: toError(err) })
    }
  }

  /**
   * Record search query and update interests.
   */
  async recordSearch(
    userId: string,
    query: string,
    results: SearchResult[],
    clickedUrls: string[],
    responseTimeMs: number,
  ): Promise<void> {
    const profile = await this.getOrCreateProfile(userId)
    if (!profile.learning_enabled) return

    // Add to search history
    const entry: SearchHistoryEntry = {
      query,
      timestamp: Date.now(),
      results_clicked: clickedUrls,
      results_count: results.length,
      response_time_ms: responseTimeMs,
      topic: this.extractTopic(query),
      language: this.detectLanguage(query),
    }

    profile.search_history.unshift(entry) // newest first
    profile.total_searches++

    // Keep only last 1000 searches
    if (profile.search_history.length > 1000) {
      profile.search_history = profile.search_history.slice(0, 1000)
    }

    // Update interests
    this.updateInterests(profile, query, results, clickedUrls)

    // Update domain preferences
    this.updateDomainPreferences(profile, results, clickedUrls)

    // Update session
    this.updateSession(profile, query)

    await this.saveProfile(profile)
  }

  /**
   * Get personalized search results.
   */
  async personalizeResults(
    userId: string,
    results: SearchResult[],
  ): Promise<SearchResult[]> {
    const profile = await this.getProfile(userId)
    if (!profile || !profile.personalization_enabled) return results

    // Boost results from preferred domains
    const boosted = results.map(r => {
      const domain = this.extractDomain(r.url)
      const pref = profile.domain_preferences.find(d => d.domain === domain)

      let boost = 0
      if (pref) {
        // Boost based on visit count and CTR
        boost = Math.min(0.1, pref.visit_count * 0.01 + pref.click_through_rate * 0.05)
      }

      // Boost based on topic affinity
      const topic = this.extractTopic(r.title + ' ' + r.content)
      const topicScore = profile.topic_affinities[topic] ?? 0
      boost += topicScore * 0.05

      return {
        ...r,
        score: Math.min(1, (r.score ?? 0) + boost),
      }
    })

    // Sort by boosted score
    boosted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0))

    return boosted
  }

  /**
   * Get personalized query suggestions.
   */
  async getPersonalizedSuggestions(
    userId: string,
    partialQuery: string,
  ): Promise<string[]> {
    const profile = await this.getProfile(userId)
    if (!profile) return []

    const suggestions: string[] = []

    // From search history
    for (const entry of profile.search_history.slice(0, 100)) {
      if (entry.query.toLowerCase().includes(partialQuery.toLowerCase())) {
        suggestions.push(entry.query)
      }
    }

    // From interests
    for (const interest of profile.interests.topics.slice(0, 5)) {
      const suggestion = `${partialQuery} ${interest.topic}`
      if (!suggestions.includes(suggestion)) {
        suggestions.push(suggestion)
      }
    }

    return suggestions.slice(0, 10)
  }

  /**
   * Get user's interest summary.
   */
  async getInterestSummary(userId: string): Promise<{
    topTopics: Array<{ topic: string; score: number }>
    topDomains: Array<{ domain: string; visits: number }>
    recentQueries: string[]
    searchPatterns: {
      avgQueriesPerDay: number
      peakHours: number[]
      preferredLanguages: string[]
    }
  }> {
    const profile = await this.getProfile(userId)
    if (!profile) {
      return {
        topTopics: [],
        topDomains: [],
        recentQueries: [],
        searchPatterns: { avgQueriesPerDay: 0, peakHours: [], preferredLanguages: [] },
      }
    }

    // Top topics
    const topTopics = Object.entries(profile.topic_affinities)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 10)
      .map(([topic, score]) => ({ topic, score }))

    // Top domains
    const topDomains = profile.domain_preferences
      .sort((a, b) => b.visit_count - a.visit_count)
      .slice(0, 10)
      .map(d => ({ domain: d.domain, visits: d.visit_count }))

    // Recent queries
    const recentQueries = profile.search_history
      .slice(0, 20)
      .map(e => e.query)

    // Search patterns
    const now = Date.now()
    const oneDayAgo = now - 24 * 60 * 60 * 1000
    const recentSearches = profile.search_history.filter(e => e.timestamp > oneDayAgo)

    const hourCounts = new Array(24).fill(0)
    const langCounts = new Map<string, number>()
    for (const entry of recentSearches) {
      const hour = new Date(entry.timestamp).getHours()
      hourCounts[hour]++
      if (entry.language) {
        langCounts.set(entry.language, (langCounts.get(entry.language) ?? 0) + 1)
      }
    }

    const peakHours = hourCounts
      .map((count, hour) => ({ hour, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map(h => h.hour)

    const preferredLanguages = [...langCounts.entries()]
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([lang]) => lang)

    return {
      topTopics,
      topDomains,
      recentQueries,
      searchPatterns: {
        avgQueriesPerDay: recentSearches.length,
        peakHours,
        preferredLanguages,
      },
    }
  }

  // ============================================================
  // Private helpers
  // ============================================================

  private extractTopic(text: string): string {
    const lower = text.toLowerCase()
    for (const [topic, keywords] of Object.entries(TOPIC_KEYWORDS)) {
      for (const keyword of keywords) {
        if (lower.includes(keyword)) return topic
      }
    }
    return 'general'
  }

  private detectLanguage(text: string): string {
    if (/[\uAC00-\uD7AF]/.test(text)) return 'ko'
    if (/[\u4E00-\u9FFF]/.test(text)) return 'zh'
    if (/[\u3040-\u30FF]/.test(text)) return 'ja'
    return 'en'
  }

  private extractDomain(url: string): string {
    try {
      return new URL(url).hostname.replace(/^www\./, '')
    } catch {
      return ''
    }
  }

  private updateInterests(
    profile: EnhancedUserProfile,
    query: string,
    results: SearchResult[],
    clickedUrls: string[],
  ): void {
    const topic = this.extractTopic(query)
    const now = Date.now()

    // Update topic interest
    const existingTopic = profile.interests.topics.find(t => t.topic === topic)
    if (existingTopic) {
      existingTopic.score = Math.min(1, existingTopic.score + 0.1)
      existingTopic.last_seen = now
      existingTopic.query_count++
    } else {
      profile.interests.topics.push({
        topic,
        score: 0.1,
        last_seen: now,
        query_count: 1,
      })
    }

    // Update topic affinities
    profile.topic_affinities[topic] = Math.min(
      1,
      (profile.topic_affinities[topic] ?? 0) + 0.05,
    )

    // Extract keywords from query
    const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 2)
    for (const keyword of keywords) {
      const existingKeyword = profile.interests.keywords.find(k => k.keyword === keyword)
      if (existingKeyword) {
        existingKeyword.score = Math.min(1, existingKeyword.score + 0.05)
        existingKeyword.last_seen = now
      } else {
        profile.interests.keywords.push({
          keyword,
          score: 0.05,
          last_seen: now,
        })
      }
    }

    // Decay old interests
    for (const interest of profile.interests.topics) {
      const daysSinceLastSeen = (now - interest.last_seen) / (24 * 60 * 60 * 1000)
      interest.score *= Math.pow(0.95, daysSinceLastSeen) // 5% decay per day
    }
  }

  private updateDomainPreferences(
    profile: EnhancedUserProfile,
    results: SearchResult[],
    clickedUrls: string[],
  ): void {
    const now = Date.now()

    // Track impressions
    for (const r of results) {
      const domain = this.extractDomain(r.url)
      if (!domain) continue

      let pref = profile.domain_preferences.find(d => d.domain === domain)
      if (!pref) {
        pref = {
          domain,
          visit_count: 0,
          click_through_rate: 0,
          avg_dwell_time_ms: 0,
          last_visited: now,
          trust_score: 0.5,
        }
        profile.domain_preferences.push(pref)
      }

      // Update CTR
      const wasClicked = clickedUrls.some(u => this.extractDomain(u) === domain)
      if (wasClicked) {
        pref.visit_count++
        pref.click_through_rate = Math.min(1, pref.click_through_rate + 0.1)
        pref.last_visited = now
      } else {
        pref.click_through_rate = Math.max(0, pref.click_through_rate - 0.01)
      }
    }

    // Keep only top 100 domains
    profile.domain_preferences.sort((a, b) => b.visit_count - a.visit_count)
    if (profile.domain_preferences.length > 100) {
      profile.domain_preferences = profile.domain_preferences.slice(0, 100)
    }
  }

  private updateSession(profile: EnhancedUserProfile, query: string): void {
    const now = Date.now()
    const sessionId = profile.current_session?.session_id ?? this.generateSessionId()

    // Check if session expired (30 minutes)
    if (profile.current_session && now - profile.current_session.last_active_at > 30 * 60 * 1000) {
      profile.current_session = null
    }

    if (!profile.current_session) {
      profile.current_session = {
        session_id: sessionId,
        started_at: now,
        last_active_at: now,
        queries: [],
        topics: [],
        domains_visited: [],
        intent_stack: [],
      }
    }

    profile.current_session.last_active_at = now
    profile.current_session.queries.push(query)

    const topic = this.extractTopic(query)
    if (!profile.current_session.topics.includes(topic)) {
      profile.current_session.topics.push(topic)
    }
  }

  private generateSessionId(): string {
    return `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
  }
}
