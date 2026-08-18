/**
 * Cost Optimization System (Phase 4)
 *
 * Monitors and optimizes costs for:
 * - Cloudflare Workers invocations
 * - KV/R2 storage operations
 * - D1 database queries
 * - Durable Object requests
 * - AI model inference
 * - External API calls
 *
 * Features:
 * - Real-time cost tracking
 * - Budget alerts
 * - Usage optimization recommendations
 * - Anomaly detection
 */

import { logger, toError } from '../logger'
import type { Env } from '../../types'

// ============================================================
// Types
// ============================================================

export interface CostEntry {
  service: string
  operation: string
  quantity: number
  unitCost: number
  totalCost: number
  timestamp: number
  metadata?: Record<string, unknown>
}

export interface BudgetConfig {
  dailyLimitUSD: number
  monthlyLimitUSD: number
  alertThresholdPercent: number
  criticalThresholdPercent: number
}

export interface CostBreakdown {
  service: string
  totalCost: number
  operations: Array<{
    operation: string
    quantity: number
    unitCost: number
    totalCost: number
  }>
}

export interface OptimizationRecommendation {
  service: string
  type: 'reduce' | 'optimize' | 'cache' | 'remove'
  description: string
  estimatedSavingsUSD: number
  priority: 'high' | 'medium' | 'low'
}

// ============================================================
// Cloudflare Pricing (as of 2024)
// ============================================================

const PRICING: Record<string, Record<string, { unitCost: number; unit: string }>> = {
  workers: {
    requests: { unitCost: 0.30 / 1_000_000, unit: 'request' },
    cpuTime: { unitCost: 0.02 / 1_000_000, unit: 'ms' },
  },
  kv: {
    reads: { unitCost: 0.50 / 1_000_000, unit: 'read' },
    writes: { unitCost: 5.00 / 1_000_000, unit: 'write' },
    deletes: { unitCost: 0.50 / 1_000_000, unit: 'delete' },
    list: { unitCost: 0.50 / 1_000, unit: 'list' },
    storage: { unitCost: 0.50 / 1_000_000, unit: 'GB/month' },
  },
  r2: {
    reads: { unitCost: 0.36 / 1_000_000, unit: 'Class A' },
    writes: { unitCost: 4.50 / 1_000_000, unit: 'Class B' },
    storage: { unitCost: 0.015 / 1_000, unit: 'GB/month' },
  },
  d1: {
    reads: { unitCost: 0.75 / 1_000_000, unit: 'read' },
    writes: { unitCost: 1.50 / 1_000_000, unit: 'write' },
    storage: { unitCost: 0.20 / 1_000, unit: 'GB/month' },
  },
  durableObjects: {
    requests: { unitCost: 15.00 / 1_000_000, unit: 'request' },
    duration: { unitCost: 12.50 / 1_000_000, unit: 'GB-hour' },
  },
  ai: {
    inference: { unitCost: 0.01 / 1000, unit: '1000 neurons' },
  },
  analytics: {
    events: { unitCost: 1.00 / 1_000_000, unit: 'event' },
  },
}

// ============================================================
// Cost Tracker
// ============================================================

export class CostTracker {
  private entries: CostEntry[] = []
  private budget: BudgetConfig

  constructor(budget?: Partial<BudgetConfig>) {
    this.budget = {
      dailyLimitUSD: 10,
      monthlyLimitUSD: 100,
      alertThresholdPercent: 80,
      criticalThresholdPercent: 95,
      ...budget,
    }
  }

  /**
   * Record a cost entry.
   */
  record(entry: Omit<CostEntry, 'totalCost'>): void {
    const totalCost = entry.quantity * entry.unitCost
    this.entries.push({
      ...entry,
      totalCost,
      timestamp: Date.now(),
    })
  }

  /**
   * Record Cloudflare Workers cost.
   */
  recordWorkersCost(requests: number, cpuTimeMs: number): void {
    const workersPricing = PRICING.workers
    this.record({
      service: 'workers',
      operation: 'requests',
      quantity: requests,
      unitCost: workersPricing.requests.unitCost,
      timestamp: Date.now(),
    })
    this.record({
      service: 'workers',
      operation: 'cpuTime',
      quantity: cpuTimeMs,
      unitCost: workersPricing.cpuTime.unitCost,
      timestamp: Date.now(),
    })
  }

  /**
   * Record KV cost.
   */
  recordKVCost(operations: { reads?: number; writes?: number; deletes?: number; list?: number }): void {
    const kvPricing = PRICING.kv
    if (operations.reads) {
      this.record({
        service: 'kv',
        operation: 'reads',
        quantity: operations.reads,
        unitCost: kvPricing.reads.unitCost,
        timestamp: Date.now(),
      })
    }
    if (operations.writes) {
      this.record({
        service: 'kv',
        operation: 'writes',
        quantity: operations.writes,
        unitCost: kvPricing.writes.unitCost,
        timestamp: Date.now(),
      })
    }
    if (operations.deletes) {
      this.record({
        service: 'kv',
        operation: 'deletes',
        quantity: operations.deletes,
        unitCost: kvPricing.deletes.unitCost,
        timestamp: Date.now(),
      })
    }
    if (operations.list) {
      this.record({
        service: 'kv',
        operation: 'list',
        quantity: operations.list,
        unitCost: kvPricing.list.unitCost,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Record D1 cost.
   */
  recordD1Cost(operations: { reads?: number; writes?: number }): void {
    const d1Pricing = PRICING.d1
    if (operations.reads) {
      this.record({
        service: 'd1',
        operation: 'reads',
        quantity: operations.reads,
        unitCost: d1Pricing.reads.unitCost,
        timestamp: Date.now(),
      })
    }
    if (operations.writes) {
      this.record({
        service: 'd1',
        operation: 'writes',
        quantity: operations.writes,
        unitCost: d1Pricing.writes.unitCost,
        timestamp: Date.now(),
      })
    }
  }

  /**
   * Record Durable Object cost.
   */
  recordDOCost(requests: number, durationGbHours: number): void {
    const doPricing = PRICING.durableObjects
    this.record({
      service: 'durableObjects',
      operation: 'requests',
      quantity: requests,
      unitCost: doPricing.requests.unitCost,
      timestamp: Date.now(),
    })
    this.record({
      service: 'durableObjects',
      operation: 'duration',
      quantity: durationGbHours,
      unitCost: doPricing.duration.unitCost,
      timestamp: Date.now(),
    })
  }

  /**
   * Record AI inference cost.
   */
  recordAICost(neurons: number): void {
    const aiPricing = PRICING.ai
    this.record({
      service: 'ai',
      operation: 'inference',
      quantity: neurons,
      unitCost: aiPricing.inference.unitCost,
      timestamp: Date.now(),
    })
  }

  /**
   * Get daily cost.
   */
  getDailyCost(date?: Date): number {
    const targetDate = date ?? new Date()
    const dayStart = new Date(targetDate)
    dayStart.setHours(0, 0, 0, 0)

    return this.entries
      .filter(e => e.timestamp >= dayStart.getTime())
      .reduce((sum, e) => sum + e.totalCost, 0)
  }

  /**
   * Get monthly cost.
   */
  getMonthlyCost(date?: Date): number {
    const targetDate = date ?? new Date()
    const monthStart = new Date(targetDate.getFullYear(), targetDate.getMonth(), 1)

    return this.entries
      .filter(e => e.timestamp >= monthStart.getTime())
      .reduce((sum, e) => sum + e.totalCost, 0)
  }

  /**
   * Get cost breakdown by service.
   */
  getBreakdown(date?: Date): CostBreakdown[] {
    const targetDate = date ?? new Date()
    const dayStart = new Date(targetDate)
    dayStart.setHours(0, 0, 0, 0)

    const filteredEntries = this.entries.filter(e => e.timestamp >= dayStart.getTime())

    const byService = new Map<string, CostEntry[]>()
    for (const entry of filteredEntries) {
      const entries = byService.get(entry.service) ?? []
      entries.push(entry)
      byService.set(entry.service, entries)
    }

    return [...byService.entries()].map(([service, entries]) => {
      const byOperation = new Map<string, CostEntry[]>()
      for (const entry of entries) {
        const ops = byOperation.get(entry.operation) ?? []
        ops.push(entry)
        byOperation.set(entry.operation, ops)
      }

      return {
        service,
        totalCost: entries.reduce((sum, e) => sum + e.totalCost, 0),
        operations: [...byOperation.entries()].map(([operation, ops]) => ({
          operation,
          quantity: ops.reduce((sum, o) => sum + o.quantity, 0),
          unitCost: ops[0]?.unitCost ?? 0,
          totalCost: ops.reduce((sum, o) => sum + o.totalCost, 0),
        })),
      }
    })
  }

  /**
   * Check budget status.
   */
  getBudgetStatus(): {
    daily: { cost: number; limit: number; percentUsed: number; isOverBudget: boolean }
    monthly: { cost: number; limit: number; percentUsed: number; isOverBudget: boolean }
    alertLevel: 'normal' | 'warning' | 'critical'
  } {
    const dailyCost = this.getDailyCost()
    const monthlyCost = this.getMonthlyCost()

    const dailyPercent = (dailyCost / this.budget.dailyLimitUSD) * 100
    const monthlyPercent = (monthlyCost / this.budget.monthlyLimitUSD) * 100

    let alertLevel: 'normal' | 'warning' | 'critical' = 'normal'
    if (dailyPercent >= this.budget.criticalThresholdPercent || monthlyPercent >= this.budget.criticalThresholdPercent) {
      alertLevel = 'critical'
    } else if (dailyPercent >= this.budget.alertThresholdPercent || monthlyPercent >= this.budget.alertThresholdPercent) {
      alertLevel = 'warning'
    }

    return {
      daily: {
        cost: dailyCost,
        limit: this.budget.dailyLimitUSD,
        percentUsed: dailyPercent,
        isOverBudget: dailyCost > this.budget.dailyLimitUSD,
      },
      monthly: {
        cost: monthlyCost,
        limit: this.budget.monthlyLimitUSD,
        percentUsed: monthlyPercent,
        isOverBudget: monthlyCost > this.budget.monthlyLimitUSD,
      },
      alertLevel,
    }
  }

  /**
   * Get optimization recommendations.
   */
  getRecommendations(): OptimizationRecommendation[] {
    const recommendations: OptimizationRecommendation[] = []
    const breakdown = this.getBreakdown()

    // Analyze KV usage
    const kvBreakdown = breakdown.find(b => b.service === 'kv')
    if (kvBreakdown) {
      const reads = kvBreakdown.operations.find(o => o.operation === 'reads')
      if (reads && reads.totalCost > 0.1) {
        recommendations.push({
          service: 'kv',
          type: 'cache',
          description: 'Increase Cache API TTL to reduce KV reads',
          estimatedSavingsUSD: reads.totalCost * 0.3,
          priority: 'medium',
        })
      }
    }

    // Analyze D1 usage
    const d1Breakdown = breakdown.find(b => b.service === 'd1')
    if (d1Breakdown) {
      const reads = d1Breakdown.operations.find(o => o.operation === 'reads')
      if (reads && reads.quantity > 100000) {
        recommendations.push({
          service: 'd1',
          type: 'cache',
          description: 'Add Redis caching layer for frequent D1 queries',
          estimatedSavingsUSD: reads.totalCost * 0.5,
          priority: 'high',
        })
      }
    }

    // Analyze AI usage
    const aiBreakdown = breakdown.find(b => b.service === 'ai')
    if (aiBreakdown && aiBreakdown.totalCost > 1) {
      recommendations.push({
        service: 'ai',
        type: 'optimize',
        description: 'Use smaller model for simple queries',
        estimatedSavingsUSD: aiBreakdown.totalCost * 0.4,
        priority: 'high',
      })
    }

    return recommendations.sort((a, b) => b.estimatedSavingsUSD - a.estimatedSavingsUSD)
  }

  /**
   * Reset tracker.
   */
  reset(): void {
    this.entries = []
  }
}

// ============================================================
// Cost Optimization Manager
// ============================================================

export class CostOptimizationManager {
  private tracker: CostTracker
  private env: Env

  constructor(env: Env, budget?: Partial<BudgetConfig>) {
    this.env = env
    this.tracker = new CostTracker(budget)
  }

  /**
   * Get cost dashboard data.
   */
  getDashboard(): {
    current: ReturnType<CostTracker['getBudgetStatus']>
    breakdown: CostBreakdown[]
    recommendations: OptimizationRecommendation[]
    trends: {
      dailyCosts: Array<{ date: string; cost: number }>
      topServices: Array<{ service: string; cost: number }>
    }
  } {
    const current = this.tracker.getBudgetStatus()
    const breakdown = this.tracker.getBreakdown()
    const recommendations = this.tracker.getRecommendations()

    // Calculate trends (last 7 days)
    const dailyCosts: Array<{ date: string; cost: number }> = []
    for (let i = 6; i >= 0; i--) {
      const date = new Date()
      date.setDate(date.getDate() - i)
      const cost = this.tracker.getDailyCost(date)
      dailyCosts.push({
        date: date.toISOString().split('T')[0],
        cost,
      })
    }

    // Top services
    const topServices = breakdown
      .sort((a, b) => b.totalCost - a.totalCost)
      .slice(0, 5)
      .map(b => ({ service: b.service, cost: b.totalCost }))

    return {
      current,
      breakdown,
      recommendations,
      trends: {
        dailyCosts,
        topServices,
      },
    }
  }

  /**
   * Track request cost.
   */
  trackRequest(
    endpoint: string,
    workersRequests: number,
    cpuTimeMs: number,
    kvOperations?: { reads?: number; writes?: number },
    d1Operations?: { reads?: number; writes?: number },
  ): void {
    this.tracker.recordWorkersCost(workersRequests, cpuTimeMs)

    if (kvOperations) {
      this.tracker.recordKVCost(kvOperations)
    }

    if (d1Operations) {
      this.tracker.recordD1Cost(d1Operations)
    }
  }

  /**
   * Check and alert on budget.
   */
  checkBudget(): {
    shouldAlert: boolean
    alertLevel: 'normal' | 'warning' | 'critical'
    message: string
  } {
    const status = this.tracker.getBudgetStatus()

    if (status.alertLevel === 'critical') {
      return {
        shouldAlert: true,
        alertLevel: 'critical',
        message: `Critical: Daily cost $${status.daily.cost.toFixed(2)} exceeds ${status.daily.percentUsed.toFixed(0)}% of $${status.daily.limit} limit`,
      }
    }

    if (status.alertLevel === 'warning') {
      return {
        shouldAlert: true,
        alertLevel: 'warning',
        message: `Warning: Daily cost $${status.daily.cost.toFixed(2)} at ${status.daily.percentUsed.toFixed(0)}% of limit`,
      }
    }

    return {
      shouldAlert: false,
      alertLevel: 'normal',
      message: `Costs normal: $${status.daily.cost.toFixed(2)} today, $${status.monthly.cost.toFixed(2)} this month`,
    }
  }
}
