/**
 * SLA Management System (Phase 5)
 *
 * Manages Service Level Agreements:
 * - Availability tracking
 * - Response time monitoring
 * - Error rate tracking
 * - Uptime reporting
 * - SLA breach notifications
 *
 * Features:
 * - Real-time SLA monitoring
 * - Historical reporting
 * - Automated breach detection
 * - Credit calculation for breaches
 */

import { logger, toError } from '../logger'

// ============================================================
// Types
// ============================================================

export interface SLAConfig {
  id: string
  name: string
  customerId: string
  commitments: SLACommitment[]
  effectiveDate: number
  expirationDate: number
}

export interface SLACommitment {
  type: 'availability' | 'response_time' | 'error_rate' | 'throughput'
  target: number
  measurementPeriod: 'daily' | 'weekly' | 'monthly'
  unit: string
}

export interface SLAMetric {
  metricId: string
  slaId: string
  commitmentType: string
  value: number
  target: number
  met: boolean
  timestamp: number
  period: string
}

export interface SLAReport {
  slaId: string
  period: string
  startDate: number
  endDate: number
  metrics: SLAMetric[]
  overallCompliance: number
  breaches: SLABreach[]
  credits: SLACredit[]
}

export interface SLABreach {
  breachId: string
  slaId: string
  commitmentType: string
  target: number
  actual: number
  duration: number
  startTime: number
  endTime: number
  severity: 'minor' | 'major' | 'critical'
}

export interface SLACredit {
  creditId: string
  breachId: string
  amount: number
  reason: string
  appliedDate: number
}

// ============================================================
// SLA Manager
// ============================================================

export class SLAManager {
  private slas: Map<string, SLAConfig> = new Map()
  private metrics: SLAMetric[] = []
  private breaches: SLABreach[] = []
  private credits: SLACredit[] = []

  /**
   * Create an SLA.
   */
  createSLA(config: SLAConfig): SLAConfig {
    this.slas.set(config.id, config)
    return config
  }

  /**
   * Record a metric.
   */
  recordMetric(
    slaId: string,
    commitmentType: string,
    value: number,
    period: string,
  ): SLAMetric {
    const sla = this.slas.get(slaId)
    if (!sla) throw new Error(`SLA not found: ${slaId}`)

    const commitment = sla.commitments.find(c => c.type === commitmentType)
    if (!commitment) throw new Error(`Commitment not found: ${commitmentType}`)

    const met = commitmentType === 'error_rate'
      ? value <= commitment.target
      : value >= commitment.target

    const metric: SLAMetric = {
      metricId: this.generateId(),
      slaId,
      commitmentType,
      value,
      target: commitment.target,
      met,
      timestamp: Date.now(),
      period,
    }

    this.metrics.push(metric)

    // Check for breach
    if (!met) {
      this.recordBreach(slaId, commitmentType, commitment.target, value)
    }

    return metric
  }

  /**
   * Get SLA report.
   */
  getReport(
    slaId: string,
    startDate: number,
    endDate: number,
  ): SLAReport {
    const sla = this.slas.get(slaId)
    if (!sla) throw new Error(`SLA not found: ${slaId}`)

    // Get metrics for period
    const periodMetrics = this.metrics.filter(
      m => m.slaId === slaId && m.timestamp >= startDate && m.timestamp <= endDate
    )

    // Calculate compliance
    const totalMetrics = periodMetrics.length
    const metMetrics = periodMetrics.filter(m => m.met).length
    const overallCompliance = totalMetrics > 0 ? metMetrics / totalMetrics : 1

    // Get breaches for period
    const periodBreaches = this.breaches.filter(
      b => b.slaId === slaId && b.startTime >= startDate && b.startTime <= endDate
    )

    // Get credits for period
    const periodCredits = this.credits.filter(
      c => c.breachId && periodBreaches.some(b => b.breachId === c.breachId)
    )

    return {
      slaId,
      period: `${new Date(startDate).toISOString()} - ${new Date(endDate).toISOString()}`,
      startDate,
      endDate,
      metrics: periodMetrics,
      overallCompliance,
      breaches: periodBreaches,
      credits: periodCredits,
    }
  }

  /**
   * Check SLA compliance.
   */
  checkCompliance(slaId: string): {
    compliant: boolean
    complianceRate: number
    breaches: SLABreach[]
  } {
    const sla = this.slas.get(slaId)
    if (!sla) throw new Error(`SLA not found: ${slaId}`)

    const now = Date.now()
    const periodMs = this.getPeriodMs(sla.commitments[0]?.measurementPeriod ?? 'monthly')
    const startDate = now - periodMs

    const report = this.getReport(slaId, startDate, now)

    return {
      compliant: report.overallCompliance >= 0.99, // 99% compliance threshold
      complianceRate: report.overallCompliance,
      breaches: report.breaches,
    }
  }

  /**
   * Calculate credit for breach.
   */
  calculateCredit(breach: SLABreach): number {
    // Standard credit calculation: 5% of monthly fee per hour of downtime
    const hourlyRate = 0.05
    const hours = breach.duration / (60 * 60 * 1000)
    return hours * hourlyRate
  }

  /**
   * Get all SLAs.
   */
  getSLAs(): SLAConfig[] {
    return [...this.slas.values()]
  }

  /**
   * Get SLA by ID.
   */
  getSLA(slaId: string): SLAConfig | null {
    return this.slas.get(slaId) ?? null
  }

  /**
   * Get metrics for SLA.
   */
  getMetrics(
    slaId: string,
    timeRange?: { start: number; end: number },
  ): SLAMetric[] {
    return this.metrics.filter(m => {
      if (m.slaId !== slaId) return false
      if (timeRange) {
        if (m.timestamp < timeRange.start || m.timestamp > timeRange.end) return false
      }
      return true
    })
  }

  /**
   * Get breaches for SLA.
   */
  getBreaches(
    slaId: string,
    timeRange?: { start: number; end: number },
  ): SLABreach[] {
    return this.breaches.filter(b => {
      if (b.slaId !== slaId) return false
      if (timeRange) {
        if (b.startTime < timeRange.start || b.startTime > timeRange.end) return false
      }
      return true
    })
  }

  // ============================================================
  // Private methods
  // ============================================================

  private recordBreach(
    slaId: string,
    commitmentType: string,
    target: number,
    actual: number,
  ): void {
    const breach: SLABreach = {
      breachId: this.generateId(),
      slaId,
      commitmentType,
      target,
      actual,
      duration: 0, // Would be calculated based on monitoring
      startTime: Date.now(),
      endTime: Date.now(),
      severity: this.calculateSeverity(target, actual) as 'minor' | 'major' | 'critical',
    }

    this.breaches.push(breach)

    // Calculate and record credit
    const creditAmount = this.calculateCredit(breach)
    if (creditAmount > 0) {
      const credit: SLACredit = {
        creditId: this.generateId(),
        breachId: breach.breachId,
        amount: creditAmount,
        reason: `SLA breach: ${commitmentType} target ${target} not met (actual: ${actual})`,
        appliedDate: Date.now(),
      }
      this.credits.push(credit)
    }

    logger.warn('[SLA] Breach recorded', {
      slaId,
      commitmentType,
      target,
      actual,
      breachSeverity: breach.severity,
    })
  }

  private calculateSeverity(target: number, actual: number): SLABreach['severity'] {
    const deviation = Math.abs(target - actual) / target

    if (deviation > 0.1) return 'critical'
    if (deviation > 0.05) return 'major'
    return 'minor'
  }

  private getPeriodMs(period: SLACommitment['measurementPeriod']): number {
    switch (period) {
      case 'daily':
        return 24 * 60 * 60 * 1000
      case 'weekly':
        return 7 * 24 * 60 * 60 * 1000
      case 'monthly':
        return 30 * 24 * 60 * 60 * 1000
    }
  }

  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`
  }
}

// ============================================================
// Uptime Monitor
// ============================================================

export class UptimeMonitor {
  private checks: Map<string, UptimeCheck> = new Map()
  private results: UptimeResult[] = []

  /**
   * Register an uptime check.
   */
  registerCheck(check: UptimeCheck): void {
    this.checks.set(check.id, check)
  }

  /**
   * Record a check result.
   */
  recordResult(result: UptimeResult): void {
    this.results.push(result)

    // Trim old results (keep last 30 days)
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000
    this.results = this.results.filter(r => r.timestamp > cutoff)
  }

  /**
   * Get uptime for a check.
   */
  getUptime(
    checkId: string,
    timeRange?: { start: number; end: number },
  ): {
    uptime: number
    downtime: number
    uptimePercent: number
    incidents: UptimeResult[]
  } {
    const results = this.results.filter(r => {
      if (r.checkId !== checkId) return false
      if (timeRange) {
        if (r.timestamp < timeRange.start || r.timestamp > timeRange.end) return false
      }
      return true
    })

    const uptime = results.filter(r => r.status === 'up').length
    const downtime = results.filter(r => r.status === 'down').length
    const total = uptime + downtime

    return {
      uptime,
      downtime,
      uptimePercent: total > 0 ? uptime / total : 1,
      incidents: results.filter(r => r.status === 'down'),
    }
  }

  /**
   * Get status page data.
   */
  getStatusPage(): {
    overall: 'operational' | 'degraded' | 'partial_outage' | 'major_outage'
    services: Array<{
      name: string
      status: 'operational' | 'degraded' | 'partial_outage' | 'major_outage'
      uptime: number
    }>
  } {
    const services: Array<{
      name: string
      status: 'operational' | 'degraded' | 'partial_outage' | 'major_outage'
      uptime: number
    }> = []

    for (const [id, check] of this.checks) {
      const { uptimePercent } = this.getUptime(id)

      let status: 'operational' | 'degraded' | 'partial_outage' | 'major_outage' = 'operational'
      if (uptimePercent < 0.99) status = 'major_outage'
      else if (uptimePercent < 0.999) status = 'partial_outage'
      else if (uptimePercent < 0.9999) status = 'degraded'

      services.push({
        name: check.name,
        status,
        uptime: uptimePercent,
      })
    }

    const overallStatus = services.every(s => s.status === 'operational')
      ? 'operational'
      : services.some(s => s.status === 'major_outage')
        ? 'major_outage'
        : services.some(s => s.status === 'partial_outage')
          ? 'partial_outage'
          : 'degraded'

    return {
      overall: overallStatus,
      services,
    }
  }
}

interface UptimeCheck {
  id: string
  name: string
  url: string
  intervalMs: number
  timeoutMs: number
}

interface UptimeResult {
  checkId: string
  status: 'up' | 'down'
  responseTimeMs: number
  statusCode?: number
  error?: string
  timestamp: number
}
