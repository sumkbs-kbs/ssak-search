/**
 * Advanced Analytics System (Phase 5)
 *
 * Provides user behavior analysis:
 * - User journey tracking
 * - Funnel analysis
 * - Cohort analysis
 * - Retention analysis
 * - A/B test analytics
 * - Custom event tracking
 *
 * Architecture:
 * - Event-driven data collection
 * - Real-time aggregation
 * - Batch processing for complex analytics
 * - Export to external analytics tools
 */


// ============================================================
// Types
// ============================================================

export interface AnalyticsEvent {
  eventId: string
  eventName: string
  userId?: string
  sessionId?: string
  timestamp: number
  properties: Record<string, unknown>
  context: EventContext
}

export interface EventContext {
  platform: string
  userAgent: string
  ip?: string
  country?: string
  language?: string
  referrer?: string
}

export interface UserJourney {
  userId: string
  events: AnalyticsEvent[]
  duration: number
  conversions: string[]
  segments: string[]
}

export interface FunnelStep {
  name: string
  event: string
  condition?: (event: AnalyticsEvent) => boolean
}

export interface FunnelResult {
  steps: Array<{
    name: string
    users: number
    conversionRate: number
    dropoffRate: number
  }>
  overallConversion: number
  totalUsers: number
}

export interface CohortData {
  cohort: string
  period: number
  users: number
  retention: number
}

export interface AnalyticsMetrics {
  activeUsers: {
    daily: number
    weekly: number
    monthly: number
  }
  engagement: {
    avgSessionDuration: number
    avgEventsPerSession: number
    bounceRate: number
  }
  conversion: {
    totalConversions: number
    conversionRate: number
    avgTimeToConvert: number
  }
  retention: {
    day1: number
    day7: number
    day30: number
  }
}

// ============================================================
// Analytics Collector
// ============================================================

export class AnalyticsCollector {
  private events: AnalyticsEvent[] = []
  private maxEvents: number

  constructor(maxEvents: number = 100000) {
    this.maxEvents = maxEvents
  }

  /**
   * Track an event.
   */
  track(
    eventName: string,
    properties: Record<string, unknown> = {},
    context: Partial<EventContext> = {},
  ): AnalyticsEvent {
    const event: AnalyticsEvent = {
      eventId: this.generateId(),
      eventName,
      userId: properties.userId as string,
      sessionId: properties.sessionId as string,
      timestamp: Date.now(),
      properties,
      context: {
        platform: 'web',
        userAgent: '',
        ...context,
      },
    }

    this.events.push(event)

    // Trim if too many events
    if (this.events.length > this.maxEvents) {
      this.events = this.events.slice(-this.maxEvents)
    }

    return event
  }

  /**
   * Get events by name.
   */
  getEventsByName(
    eventName: string,
    timeRange?: { start: number; end: number },
  ): AnalyticsEvent[] {
    return this.events.filter(e => {
      if (e.eventName !== eventName) return false
      if (timeRange) {
        if (e.timestamp < timeRange.start || e.timestamp > timeRange.end) return false
      }
      return true
    })
  }

  /**
   * Get user events.
   */
  getUserEvents(
    userId: string,
    timeRange?: { start: number; end: number },
  ): AnalyticsEvent[] {
    return this.events.filter(e => {
      if (e.userId !== userId) return false
      if (timeRange) {
        if (e.timestamp < timeRange.start || e.timestamp > timeRange.end) return false
      }
      return true
    })
  }

  /**
   * Get session events.
   */
  getSessionEvents(sessionId: string): AnalyticsEvent[] {
    return this.events.filter(e => e.sessionId === sessionId)
  }

  /**
   * Clear old events.
   */
  clearOldEvents(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs
    const initialCount = this.events.length
    this.events = this.events.filter(e => e.timestamp > cutoff)
    return initialCount - this.events.length
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }
}

// ============================================================
// Funnel Analyzer
// ============================================================

export class FunnelAnalyzer {
  /**
   * Analyze a conversion funnel.
   */
  analyze(
    steps: FunnelStep[],
    events: AnalyticsEvent[],
  ): FunnelResult {
    const usersByStep: Map<string, Set<string>> = new Map()

    // Initialize step counters
    for (const step of steps) {
      usersByStep.set(step.name, new Set())
    }

    // Process events
    for (const event of events) {
      const userId = event.userId ?? event.sessionId
      if (!userId) continue

      for (const step of steps) {
        if (event.eventName === step.event) {
          if (!step.condition || step.condition(event)) {
            usersByStep.get(step.name)?.add(userId)
          }
        }
      }
    }

    // Calculate step results
    const stepResults: FunnelResult['steps'] = []
    let previousUsers = 0

    for (const step of steps) {
      const users = usersByStep.get(step.name)?.size ?? 0
      const conversionRate = previousUsers > 0 ? users / previousUsers : 1
      const dropoffRate = 1 - conversionRate

      stepResults.push({
        name: step.name,
        users,
        conversionRate,
        dropoffRate,
      })

      previousUsers = users
    }

    // Calculate overall conversion
    const firstStepUsers = stepResults[0]?.users ?? 0
    const lastStepUsers = stepResults[stepResults.length - 1]?.users ?? 0
    const overallConversion = firstStepUsers > 0 ? lastStepUsers / firstStepUsers : 0

    return {
      steps: stepResults,
      overallConversion,
      totalUsers: firstStepUsers,
    }
  }
}

// ============================================================
// Cohort Analyzer
// ============================================================

export class CohortAnalyzer {
  /**
   * Analyze user retention by cohort.
   */
  analyzeRetention(
    events: AnalyticsEvent[],
    cohortPeriod: 'day' | 'week' | 'month' = 'week',
  ): CohortData[] {
    // Group users by first seen date
    const userFirstSeen = new Map<string, number>()
    const userEvents = new Map<string, AnalyticsEvent[]>()

    for (const event of events) {
      const userId = event.userId ?? event.sessionId
      if (!userId) continue

      // Track first seen
      const firstSeen = userFirstSeen.get(userId)
      if (firstSeen === undefined || event.timestamp < firstSeen) {
        userFirstSeen.set(userId, event.timestamp)
      }

      // Group events by user
      const userEvts = userEvents.get(userId) ?? []
      userEvts.push(event)
      userEvents.set(userId, userEvts)
    }

    // Calculate cohort periods
    const cohortData: CohortData[] = []
    const periodMs = this.getPeriodMs(cohortPeriod)

    // Group users by cohort
    const cohorts = new Map<number, Set<string>>()
    for (const [userId, firstSeen] of userFirstSeen) {
      const cohortPeriod = Math.floor(firstSeen / periodMs)
      const cohort = cohorts.get(cohortPeriod) ?? new Set()
      cohort.add(userId)
      cohorts.set(cohortPeriod, cohort)
    }

    // Calculate retention for each cohort
    for (const [cohortPeriod, users] of cohorts) {
      const cohortStart = cohortPeriod * periodMs

      // For each subsequent period
      for (let period = 0; period < 12; period++) {
        const periodStart = cohortStart + period * periodMs
        const periodEnd = periodStart + periodMs

        // Count users who returned in this period
        let returnedUsers = 0
        for (const userId of users) {
          const userEvts = userEvents.get(userId) ?? []
          const hasActivity = userEvts.some(
            e => e.timestamp >= periodStart && e.timestamp < periodEnd
          )
          if (hasActivity) returnedUsers++
        }

        cohortData.push({
          cohort: new Date(cohortStart).toISOString().split('T')[0],
          period,
          users: users.size,
          retention: users.size > 0 ? returnedUsers / users.size : 0,
        })
      }
    }

    return cohortData
  }

  private getPeriodMs(period: 'day' | 'week' | 'month'): number {
    switch (period) {
      case 'day':
        return 24 * 60 * 60 * 1000
      case 'week':
        return 7 * 24 * 60 * 60 * 1000
      case 'month':
        return 30 * 24 * 60 * 60 * 1000
    }
  }
}

// ============================================================
// Analytics Dashboard
// ============================================================

export class AnalyticsDashboard {
  private collector: AnalyticsCollector
  private funnelAnalyzer: FunnelAnalyzer
  private cohortAnalyzer: CohortAnalyzer

  constructor(collector?: AnalyticsCollector) {
    this.collector = collector ?? new AnalyticsCollector()
    this.funnelAnalyzer = new FunnelAnalyzer()
    this.cohortAnalyzer = new CohortAnalyzer()
  }

  /**
   * Get analytics metrics.
   */
  getMetrics(timeRange?: { start: number; end: number }): AnalyticsMetrics {
    const events = timeRange
      ? this.collector.getEventsByName('page_view', timeRange)
      : this.collector.getEventsByName('page_view')

    // Calculate active users
    const _uniqueUsers = new Set(events.map(e => e.userId ?? e.sessionId))
    const now = Date.now()
    const dayAgo = now - 24 * 60 * 60 * 1000
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000

    const dailyUsers = new Set(events.filter(e => e.timestamp > dayAgo).map(e => e.userId ?? e.sessionId))
    const weeklyUsers = new Set(events.filter(e => e.timestamp > weekAgo).map(e => e.userId ?? e.sessionId))
    const monthlyUsers = new Set(events.filter(e => e.timestamp > monthAgo).map(e => e.userId ?? e.sessionId))

    // Calculate engagement metrics
    const sessions = new Map<string, AnalyticsEvent[]>()
    for (const event of events) {
      const sessionId = event.sessionId ?? event.userId
      if (!sessionId) continue
      const sessionEvents = sessions.get(sessionId) ?? []
      sessionEvents.push(event)
      sessions.set(sessionId, sessionEvents)
    }

    let totalSessionDuration = 0
    let totalEventsPerSession = 0
    let bounceCount = 0

    for (const sessionEvents of sessions.values()) {
      if (sessionEvents.length === 0) continue

      const sorted = sessionEvents.sort((a, b) => a.timestamp - b.timestamp)
      const duration = sorted[sorted.length - 1].timestamp - sorted[0].timestamp
      totalSessionDuration += duration
      totalEventsPerSession += sessionEvents.length

      if (sessionEvents.length === 1) {
        bounceCount++
      }
    }

    const sessionCount = sessions.size
    const avgSessionDuration = sessionCount > 0 ? totalSessionDuration / sessionCount : 0
    const avgEventsPerSession = sessionCount > 0 ? totalEventsPerSession / sessionCount : 0
    const bounceRate = sessionCount > 0 ? bounceCount / sessionCount : 0

    // Calculate conversion metrics
    const conversionEvents = this.collector.getEventsByName('conversion')
    const totalConversions = conversionEvents.length
    const conversionRate = events.length > 0 ? totalConversions / events.length : 0

    // Calculate retention (simplified)
    const retention = {
      day1: this.calculateRetention(events, 1),
      day7: this.calculateRetention(events, 7),
      day30: this.calculateRetention(events, 30),
    }

    return {
      activeUsers: {
        daily: dailyUsers.size,
        weekly: weeklyUsers.size,
        monthly: monthlyUsers.size,
      },
      engagement: {
        avgSessionDuration,
        avgEventsPerSession,
        bounceRate,
      },
      conversion: {
        totalConversions,
        conversionRate,
        avgTimeToConvert: 0, // Would need more complex calculation
      },
      retention,
    }
  }

  /**
   * Analyze a funnel.
   */
  analyzeFunnel(
    steps: FunnelStep[],
    timeRange?: { start: number; end: number },
  ): FunnelResult {
    const events = timeRange
      ? this.collector.getEventsByName('*', timeRange)
      : this.collector.getEventsByName('*')

    return this.funnelAnalyzer.analyze(steps, events)
  }

  /**
   * Get retention analysis.
   */
  getRetentionAnalysis(
    timeRange?: { start: number; end: number },
  ): CohortData[] {
    const events = timeRange
      ? this.collector.getEventsByName('*', timeRange)
      : this.collector.getEventsByName('*')

    return this.cohortAnalyzer.analyzeRetention(events)
  }

  /**
   * Export analytics data.
   */
  exportData(format: 'json' | 'csv'): string {
    const metrics = this.getMetrics()

    if (format === 'json') {
      return JSON.stringify(metrics, null, 2)
    }

    // CSV format
    const rows = [
      'Metric,Value',
      `Daily Active Users,${metrics.activeUsers.daily}`,
      `Weekly Active Users,${metrics.activeUsers.weekly}`,
      `Monthly Active Users,${metrics.activeUsers.monthly}`,
      `Avg Session Duration,${metrics.engagement.avgSessionDuration}`,
      `Avg Events Per Session,${metrics.engagement.avgEventsPerSession}`,
      `Bounce Rate,${metrics.engagement.bounceRate}`,
      `Total Conversions,${metrics.conversion.totalConversions}`,
      `Conversion Rate,${metrics.conversion.conversionRate}`,
      `Day 1 Retention,${metrics.retention.day1}`,
      `Day 7 Retention,${metrics.retention.day7}`,
      `Day 30 Retention,${metrics.retention.day30}`,
    ]

    return rows.join('\n')
  }

  private calculateRetention(events: AnalyticsEvent[], days: number): number {
    const now = Date.now()
    const cutoff = now - days * 24 * 60 * 60 * 1000

    const usersWhoStarted = new Set<string>()
    const usersWhoReturned = new Set<string>()

    for (const event of events) {
      const userId = event.userId ?? event.sessionId
      if (!userId) continue

      if (event.timestamp < cutoff) {
        usersWhoStarted.add(userId)
      } else {
        usersWhoReturned.add(userId)
      }
    }

    const intersection = [...usersWhoStarted].filter(u => usersWhoReturned.has(u))
    return usersWhoStarted.size > 0 ? intersection.length / usersWhoStarted.size : 0
  }
}
