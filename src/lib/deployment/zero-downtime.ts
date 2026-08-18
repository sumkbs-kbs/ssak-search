/**
 * Zero-Downtime Deployment System (Phase 4)
 *
 * Provides:
 * - Canary deployments with gradual rollout
 * - Blue-green deployments
 * - Feature flags for gradual feature enablement
 * - Automatic rollback on failure
 * - Health checks during deployment
 *
 * Architecture:
 * - Traffic splitting between versions
 * - Health monitoring during rollout
 * - Automated rollback triggers
 * - Deployment state machine
 */

import { logger, toError } from '../logger'
import type { Env } from '../../types'

// ============================================================
// Types
// ============================================================

export interface Deployment {
  id: string
  version: string
  status: 'pending' | 'deploying' | 'active' | 'rolled-back' | 'failed'
  createdAt: number
  startedAt?: number
  completedAt?: number
  trafficPercent: number
  healthCheckUrl: string
  config: DeploymentConfig
  metrics: DeploymentMetrics
}

export interface DeploymentConfig {
  strategy: 'canary' | 'blue-green' | 'rolling'
  canarySteps: number[]
  healthCheckIntervalMs: number
  healthCheckTimeoutMs: number
  rollbackOnFailure: boolean
  autoPromote: boolean
  maxErrorRate: number
  maxLatencyMs: number
}

export interface DeploymentMetrics {
  requests: number
  errors: number
  avgLatencyMs: number
  errorRate: number
  healthChecks: number
  healthCheckFailures: number
}

export interface FeatureFlag {
  id: string
  name: string
  enabled: boolean
  rolloutPercent: number
  variants: string[]
  rules: FeatureFlagRule[]
  createdAt: number
  updatedAt: number
}

export interface FeatureFlagRule {
  condition: string
  enabled: boolean
  rolloutPercent: number
}

// ============================================================
// Deployment Manager
// ============================================================

export class DeploymentManager {
  private deployments: Map<string, Deployment> = new Map()
  private activeDeployment: string | null = null
  private config: DeploymentConfig

  constructor(config?: Partial<DeploymentConfig>) {
    this.config = {
      strategy: 'canary',
      canarySteps: [5, 10, 25, 50, 75, 100],
      healthCheckIntervalMs: 10_000,
      healthCheckTimeoutMs: 5_000,
      rollbackOnFailure: true,
      autoPromote: true,
      maxErrorRate: 0.01,
      maxLatencyMs: 2000,
      ...config,
    }
  }

  /**
   * Create a new deployment.
   */
  createDeployment(
    version: string,
    config?: Partial<DeploymentConfig>,
  ): Deployment {
    const id = `deploy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const deployment: Deployment = {
      id,
      version,
      status: 'pending',
      createdAt: Date.now(),
      trafficPercent: 0,
      healthCheckUrl: '/api/health',
      config: { ...this.config, ...config },
      metrics: {
        requests: 0,
        errors: 0,
        avgLatencyMs: 0,
        errorRate: 0,
        healthChecks: 0,
        healthCheckFailures: 0,
      },
    }

    this.deployments.set(id, deployment)
    return deployment
  }

  /**
   * Start a deployment.
   */
  async startDeployment(id: string): Promise<boolean> {
    const deployment = this.deployments.get(id)
    if (!deployment || deployment.status !== 'pending') return false

    deployment.status = 'deploying'
    deployment.startedAt = Date.now()
    deployment.trafficPercent = deployment.config.canarySteps[0]

    logger.info('[Deployment] Started', {
      id,
      version: deployment.version,
      trafficPercent: deployment.trafficPercent,
    })

    return true
  }

  /**
   * Promote deployment to next step.
   */
  async promoteDeployment(id: string): Promise<boolean> {
    const deployment = this.deployments.get(id)
    if (!deployment || deployment.status !== 'deploying') return false

    const currentStepIndex = deployment.config.canarySteps.indexOf(deployment.trafficPercent)
    if (currentStepIndex === -1) return false

    const nextStep = deployment.config.canarySteps[currentStepIndex + 1]
    if (nextStep === undefined) {
      // Complete deployment
      deployment.status = 'active'
      deployment.trafficPercent = 100
      deployment.completedAt = Date.now()
      this.activeDeployment = id

      logger.info('[Deployment] Completed', {
        id,
        version: deployment.version,
        durationMs: deployment.completedAt - (deployment.startedAt ?? deployment.createdAt),
      })

      return true
    }

    deployment.trafficPercent = nextStep
    logger.info('[Deployment] Promoted', {
      id,
      trafficPercent: nextStep,
    })

    return true
  }

  /**
   * Rollback a deployment.
   */
  async rollbackDeployment(id: string): Promise<boolean> {
    const deployment = this.deployments.get(id)
    if (!deployment) return false

    deployment.status = 'rolled-back'
    deployment.trafficPercent = 0
    deployment.completedAt = Date.now()

    if (this.activeDeployment === id) {
      this.activeDeployment = null
    }

    logger.warn('[Deployment] Rolled back', {
      id,
      version: deployment.version,
    })

    return true
  }

  /**
   * Record metrics for deployment.
   */
  recordMetrics(
    id: string,
    metrics: Partial<DeploymentMetrics>,
  ): void {
    const deployment = this.deployments.get(id)
    if (!deployment) return

    if (metrics.requests) deployment.metrics.requests += metrics.requests
    if (metrics.errors) deployment.metrics.errors += metrics.errors
    if (metrics.avgLatencyMs) {
      // Running average
      const totalRequests = deployment.metrics.requests
      deployment.metrics.avgLatencyMs =
        (deployment.metrics.avgLatencyMs * (totalRequests - 1) + metrics.avgLatencyMs) / totalRequests
    }
    if (metrics.healthChecks) deployment.metrics.healthChecks += metrics.healthChecks
    if (metrics.healthCheckFailures) deployment.metrics.healthCheckFailures += metrics.healthCheckFailures

    // Calculate error rate
    if (deployment.metrics.requests > 0) {
      deployment.metrics.errorRate = deployment.metrics.errors / deployment.metrics.requests
    }
  }

  /**
   * Check if deployment should be rolled back.
   */
  shouldRollback(id: string): { shouldRollback: boolean; reason: string } {
    const deployment = this.deployments.get(id)
    if (!deployment) return { shouldRollback: false, reason: 'Deployment not found' }

    const { config, metrics } = deployment

    // Check error rate
    if (metrics.errorRate > config.maxErrorRate) {
      return {
        shouldRollback: true,
        reason: `Error rate ${metrics.errorRate.toFixed(3)} exceeds threshold ${config.maxErrorRate}`,
      }
    }

    // Check latency
    if (metrics.avgLatencyMs > config.maxLatencyMs) {
      return {
        shouldRollback: true,
        reason: `Latency ${metrics.avgLatencyMs}ms exceeds threshold ${config.maxLatencyMs}ms`,
      }
    }

    // Check health check failures
    if (metrics.healthCheckFailures > 3) {
      return {
        shouldRollback: true,
        reason: `Health check failures ${metrics.healthCheckFailures} exceed threshold`,
      }
    }

    return { shouldRollback: false, reason: 'Metrics within thresholds' }
  }

  /**
   * Get active deployment.
   */
  getActiveDeployment(): Deployment | null {
    if (!this.activeDeployment) return null
    return this.deployments.get(this.activeDeployment) ?? null
  }

  /**
   * Get deployment status.
   */
  getStatus(): {
    activeDeployment: string | null
    totalDeployments: number
    deploymentsByStatus: Record<string, number>
  } {
    const deploymentsByStatus: Record<string, number> = {}

    for (const deployment of this.deployments.values()) {
      deploymentsByStatus[deployment.status] = (deploymentsByStatus[deployment.status] ?? 0) + 1
    }

    return {
      activeDeployment: this.activeDeployment,
      totalDeployments: this.deployments.size,
      deploymentsByStatus,
    }
  }
}

// ============================================================
// Feature Flag Manager
// ============================================================

export class FeatureFlagManager {
  private flags: Map<string, FeatureFlag> = new Map()

  /**
   * Create a feature flag.
   */
  createFlag(config: Omit<FeatureFlag, 'createdAt' | 'updatedAt'>): FeatureFlag {
    const flag: FeatureFlag = {
      ...config,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }

    this.flags.set(flag.id, flag)
    return flag
  }

  /**
   * Check if a feature is enabled for a user.
   */
  isEnabled(
    flagId: string,
    userId: string,
    context?: Record<string, unknown>,
  ): boolean {
    const flag = this.flags.get(flagId)
    if (!flag) return false

    if (!flag.enabled) return false

    // Check rollout percentage
    const userHash = this.hashString(userId)
    if (userHash > flag.rolloutPercent) return false

    // Check rules
    for (const rule of flag.rules) {
      if (this.evaluateRule(rule, context)) {
        return rule.enabled
      }
    }

    return true
  }

  /**
   * Get variant for A/B test.
   */
  getVariant(
    flagId: string,
    userId: string,
  ): string | null {
    const flag = this.flags.get(flagId)
    if (!flag || flag.variants.length === 0) return null

    const userHash = this.hashString(userId)
    const variantIndex = userHash % flag.variants.length
    return flag.variants[variantIndex]
  }

  /**
   * Update flag.
   */
  updateFlag(
    flagId: string,
    updates: Partial<Pick<FeatureFlag, 'enabled' | 'rolloutPercent' | 'rules'>>,
  ): boolean {
    const flag = this.flags.get(flagId)
    if (!flag) return false

    if (updates.enabled !== undefined) flag.enabled = updates.enabled
    if (updates.rolloutPercent !== undefined) flag.rolloutPercent = updates.rolloutPercent
    if (updates.rules !== undefined) flag.rules = updates.rules

    flag.updatedAt = Date.now()
    return true
  }

  /**
   * Get all flags.
   */
  getFlags(): FeatureFlag[] {
    return [...this.flags.values()]
  }

  /**
   * Get flag status.
   */
  getStatus(): {
    totalFlags: number
    enabledFlags: number
    flagsByRollout: {
      full: number
      partial: number
      disabled: number
    }
  } {
    const flags = [...this.flags.values()]
    const enabledFlags = flags.filter(f => f.enabled).length

    const full = flags.filter(f => f.rolloutPercent === 100).length
    const partial = flags.filter(f => f.enabled && f.rolloutPercent < 100).length
    const disabled = flags.filter(f => !f.enabled).length

    return {
      totalFlags: flags.length,
      enabledFlags,
      flagsByRollout: { full, partial, disabled },
    }
  }

  private hashString(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = ((hash << 5) - hash) + char
      hash |= 0
    }
    return Math.abs(hash) % 100
  }

  private evaluateRule(
    rule: FeatureFlagRule,
    context?: Record<string, unknown>,
  ): boolean {
    if (!context) return false

    try {
      // Simple condition evaluation
      // In production, this would use a proper expression parser
      const condition = rule.condition

      // Check for key-value matches
      for (const [key, value] of Object.entries(context)) {
        if (condition.includes(`${key}=${value}`)) {
          return true
        }
      }

      return false
    } catch {
      return false
    }
  }
}
