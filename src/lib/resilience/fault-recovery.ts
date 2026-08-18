/**
 * Fault Recovery System (Phase 4)
 *
 * Provides automatic failover and recovery for:
 * - Backend failures
 * - Database outages
 * - Cache failures
 * - Network partitions
 *
 * Features:
 * - Circuit breaker pattern
 * - Retry with exponential backoff
 * - Fallback chains
 * - Health monitoring
 * - Automatic recovery
 */

import { logger, toError } from '../logger'

// ============================================================
// Types
// ============================================================

export interface HealthCheck {
  name: string
  check: () => Promise<boolean>
  intervalMs: number
  timeoutMs: number
  lastCheck: number
  lastStatus: boolean
  consecutiveFailures: number
}

export interface FailoverConfig {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  backoffMultiplier: number
  jitter: boolean
}

export interface RecoveryAction {
  name: string
  action: () => Promise<void>
  condition: (error: Error) => boolean
  priority: number
}

export interface CircuitState {
  state: 'closed' | 'open' | 'half-open'
  failures: number
  lastFailure: number
  lastSuccess: number
  successCount: number
}

// ============================================================
// Circuit Breaker
// ============================================================

export class CircuitBreaker {
  private state: CircuitState = {
    state: 'closed',
    failures: 0,
    lastFailure: 0,
    lastSuccess: 0,
    successCount: 0,
  }

  private failureThreshold: number
  private resetTimeoutMs: number
  private halfOpenMaxAttempts: number

  constructor(config?: {
    failureThreshold?: number
    resetTimeoutMs?: number
    halfOpenMaxAttempts?: number
  }) {
    this.failureThreshold = config?.failureThreshold ?? 5
    this.resetTimeoutMs = config?.resetTimeoutMs ?? 30000
    this.halfOpenMaxAttempts = config?.halfOpenMaxAttempts ?? 3
  }

  /**
   * Check if request is allowed.
   */
  canRequest(): boolean {
    if (this.state.state === 'closed') return true

    if (this.state.state === 'open') {
      // Check if timeout has passed
      if (Date.now() - this.state.lastFailure > this.resetTimeoutMs) {
        this.state.state = 'half-open'
        this.state.successCount = 0
        return true
      }
      return false
    }

    // half-open: allow limited requests
    return this.state.successCount < this.halfOpenMaxAttempts
  }

  /**
   * Record a successful request.
   */
  recordSuccess(): void {
    this.state.lastSuccess = Date.now()

    if (this.state.state === 'half-open') {
      this.state.successCount++
      if (this.state.successCount >= this.halfOpenMaxAttempts) {
        this.state.state = 'closed'
        this.state.failures = 0
        logger.info('[CircuitBreaker] Circuit closed')
      }
    } else {
      this.state.failures = 0
    }
  }

  /**
   * Record a failed request.
   */
  recordFailure(): void {
    this.state.failures++
    this.state.lastFailure = Date.now()

    if (this.state.state === 'half-open') {
      this.state.state = 'open'
      logger.warn('[CircuitBreaker] Circuit opened from half-open')
    } else if (this.state.failures >= this.failureThreshold) {
      this.state.state = 'open'
      logger.warn('[CircuitBreaker] Circuit opened', {
        failures: this.state.failures,
      })
    }
  }

  /**
   * Get current state.
   */
  getState(): CircuitState {
    return { ...this.state }
  }

  /**
   * Reset circuit breaker.
   */
  reset(): void {
    this.state = {
      state: 'closed',
      failures: 0,
      lastFailure: 0,
      lastSuccess: 0,
      successCount: 0,
    }
  }
}

// ============================================================
// Retry with Backoff
// ============================================================

export class RetryManager {
  private config: FailoverConfig

  constructor(config?: Partial<FailoverConfig>) {
    this.config = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      backoffMultiplier: 2,
      jitter: true,
      ...config,
    }
  }

  /**
   * Execute with retry.
   */
  async executeWithRetry<T>(
    fn: () => Promise<T>,
    shouldRetry?: (error: Error) => boolean,
  ): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn()
      } catch (err) {
        lastError = err as Error

        // Check if we should retry
        if (shouldRetry && !shouldRetry(lastError)) {
          throw lastError
        }

        // Don't retry on last attempt
        if (attempt === this.config.maxRetries) {
          throw lastError
        }

        // Calculate delay
        const delay = this.calculateDelay(attempt)
        logger.debug('[Retry] Retrying after delay', {
          attempt: attempt + 1,
          delayMs: delay,
          error: lastError.message,
        })

        await new Promise(resolve => setTimeout(resolve, delay))
      }
    }

    throw lastError
  }

  private calculateDelay(attempt: number): number {
    let delay = this.config.baseDelayMs * Math.pow(this.config.backoffMultiplier, attempt)
    delay = Math.min(delay, this.config.maxDelayMs)

    if (this.config.jitter) {
      delay = delay * (0.5 + Math.random() * 0.5)
    }

    return delay
  }
}

// ============================================================
// Health Monitor
// ============================================================

export class HealthMonitor {
  private checks: Map<string, HealthCheck> = new Map()
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map()

  /**
   * Register a health check.
   */
  register(check: Omit<HealthCheck, 'lastCheck' | 'lastStatus' | 'consecutiveFailures'>): void {
    this.checks.set(check.name, {
      ...check,
      lastCheck: 0,
      lastStatus: true,
      consecutiveFailures: 0,
    })
  }

  /**
   * Start monitoring.
   */
  start(): void {
    for (const [name, check] of this.checks) {
      const interval = setInterval(async () => {
        await this.runCheck(name)
      }, check.intervalMs)

      this.intervals.set(name, interval)
    }
  }

  /**
   * Stop monitoring.
   */
  stop(): void {
    for (const interval of this.intervals.values()) {
      clearInterval(interval)
    }
    this.intervals.clear()
  }

  /**
   * Run a single health check.
   */
  async runCheck(name: string): Promise<boolean> {
    const check = this.checks.get(name)
    if (!check) return false

    try {
      const result = await Promise.race([
        check.check(),
        new Promise<boolean>((_, reject) =>
          setTimeout(() => reject(new Error('Health check timeout')), check.timeoutMs)
        ),
      ])

      check.lastCheck = Date.now()
      check.lastStatus = result

      if (result) {
        check.consecutiveFailures = 0
      } else {
        check.consecutiveFailures++
      }

      return result
    } catch (err) {
      check.lastCheck = Date.now()
      check.lastStatus = false
      check.consecutiveFailures++

      logger.warn('[HealthMonitor] Health check failed', {
        name,
        error: (err as Error).message,
        consecutiveFailures: check.consecutiveFailures,
      })

      return false
    }
  }

  /**
   * Get health status.
   */
  getStatus(): Record<string, {
    status: 'healthy' | 'degraded' | 'down'
    lastCheck: number
    consecutiveFailures: number
  }> {
    const status: Record<string, {
      status: 'healthy' | 'degraded' | 'down'
      lastCheck: number
      consecutiveFailures: number
    }> = {}

    for (const [name, check] of this.checks) {
      let healthStatus: 'healthy' | 'degraded' | 'down' = 'healthy'

      if (!check.lastStatus) {
        if (check.consecutiveFailures >= 3) {
          healthStatus = 'down'
        } else {
          healthStatus = 'degraded'
        }
      }

      status[name] = {
        status: healthStatus,
        lastCheck: check.lastCheck,
        consecutiveFailures: check.consecutiveFailures,
      }
    }

    return status
  }

  /**
   * Check if all systems are healthy.
   */
  isHealthy(): boolean {
    return [...this.checks.values()].every(c => c.lastStatus)
  }
}

// ============================================================
// Fault Recovery Manager
// ============================================================

export class FaultRecoveryManager {
  private circuitBreakers: Map<string, CircuitBreaker> = new Map()
  private retryManager: RetryManager
  private healthMonitor: HealthMonitor
  private recoveryActions: RecoveryAction[] = []

  constructor(config?: Partial<FailoverConfig>) {
    this.retryManager = new RetryManager(config)
    this.healthMonitor = new HealthMonitor()
  }

  /**
   * Get or create circuit breaker for a service.
   */
  getCircuitBreaker(service: string): CircuitBreaker {
    if (!this.circuitBreakers.has(service)) {
      this.circuitBreakers.set(service, new CircuitBreaker())
    }
    return this.circuitBreakers.get(service)!
  }

  /**
   * Execute with circuit breaker and retry.
   */
  async executeWithRecovery<T>(
    service: string,
    fn: () => Promise<T>,
    fallback?: () => Promise<T>,
  ): Promise<T> {
    const circuitBreaker = this.getCircuitBreaker(service)

    // Check circuit breaker
    if (!circuitBreaker.canRequest()) {
      logger.warn('[FaultRecovery] Circuit open, using fallback', { service })
      if (fallback) return fallback()
      throw new Error(`Circuit breaker open for ${service}`)
    }

    try {
      const result = await this.retryManager.executeWithRetry(fn)
      circuitBreaker.recordSuccess()
      return result
    } catch (err) {
      circuitBreaker.recordFailure()

      // Try recovery actions
      for (const action of this.recoveryActions) {
        if (action.condition(err as Error)) {
          try {
            await action.action()
            logger.info('[FaultRecovery] Recovery action executed', {
              action: action.name,
            })
          } catch (recoveryErr) {
            logger.warn('[FaultRecovery] Recovery action failed', {
              action: action.name,
              error: toError(recoveryErr),
            })
          }
        }
      }

      // Try fallback
      if (fallback) {
        return fallback()
      }

      throw err
    }
  }

  /**
   * Register a recovery action.
   */
  registerRecovery(action: RecoveryAction): void {
    this.recoveryActions.push(action)
    this.recoveryActions.sort((a, b) => b.priority - a.priority)
  }

  /**
   * Register a health check.
   */
  registerHealthCheck(check: Omit<HealthCheck, 'lastCheck' | 'lastStatus' | 'consecutiveFailures'>): void {
    this.healthMonitor.register(check)
  }

  /**
   * Start health monitoring.
   */
  startMonitoring(): void {
    this.healthMonitor.start()
  }

  /**
   * Stop health monitoring.
   */
  stopMonitoring(): void {
    this.healthMonitor.stop()
  }

  /**
   * Get system health status.
   */
  getHealthStatus(): {
    overall: 'healthy' | 'degraded' | 'down'
    services: Record<string, {
      circuitState: CircuitState
      health: 'healthy' | 'degraded' | 'down'
    }>
  } {
    const services: Record<string, {
      circuitState: CircuitState
      health: 'healthy' | 'degraded' | 'down'
    }> = {}

    let overallHealthy = true
    let anyDown = false

    for (const [service, circuitBreaker] of this.circuitBreakers) {
      const healthStatus = this.healthMonitor.getStatus()[service]
      services[service] = {
        circuitState: circuitBreaker.getState(),
        health: healthStatus?.status ?? 'healthy',
      }

      if (healthStatus?.status === 'degraded') overallHealthy = false
      if (healthStatus?.status === 'down') anyDown = true
    }

    return {
      overall: anyDown ? 'down' : overallHealthy ? 'healthy' : 'degraded',
      services,
    }
  }

  /**
   * Get recovery stats.
   */
  getStats(): {
    circuitBreakers: number
    openCircuits: number
    recoveryActions: number
    healthChecks: number
  } {
    const openCircuits = [...this.circuitBreakers.values()]
      .filter(cb => cb.getState().state === 'open').length

    return {
      circuitBreakers: this.circuitBreakers.size,
      openCircuits,
      recoveryActions: this.recoveryActions.length,
      healthChecks: this.healthMonitor.getStatus() ? Object.keys(this.healthMonitor.getStatus()).length : 0,
    }
  }
}
