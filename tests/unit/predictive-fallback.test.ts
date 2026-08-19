import { describe, it, expect, beforeEach } from 'vitest'
import { BackendHealthTracker, PredictiveFallbackManager, resetPredictiveFallbackManager } from '../../src/lib/resilience/predictive-fallback'

describe('BackendHealthTracker', () => {
  let tracker: BackendHealthTracker

  beforeEach(() => {
    tracker = new BackendHealthTracker({
      minSuccessRate: 0.9,
      maxConsecutiveFailures: 3,
      predictionWindowMs: 60_000,
    })
  })

  it('should record success', () => {
    tracker.recordSuccess('backend1', 100)
    const health = tracker.getHealth('backend1')
    
    expect(health).not.toBeNull()
    expect(health?.successRate).toBeGreaterThan(0.9)
    expect(health?.consecutiveFailures).toBe(0)
    expect(health?.isHealthy).toBe(true)
  })

  it('should record failure', () => {
    tracker.recordFailure('backend1', 'Connection timeout')
    const health = tracker.getHealth('backend1')
    
    expect(health).not.toBeNull()
    expect(health?.consecutiveFailures).toBe(1)
    expect(health?.lastError).toBe('Connection timeout')
  })

  it('should mark backend unhealthy after max consecutive failures', () => {
    for (let i = 0; i < 3; i++) {
      tracker.recordFailure('backend1', `Error ${i}`)
    }
    
    expect(tracker.isHealthy('backend1')).toBe(false)
  })

  it('should reset consecutive failures on success', () => {
    tracker.recordFailure('backend1', 'Error 1')
    tracker.recordFailure('backend1', 'Error 2')
    tracker.recordSuccess('backend1', 100)
    
    const health = tracker.getHealth('backend1')
    expect(health?.consecutiveFailures).toBe(0)
  })

  it('should predict failure probability', () => {
    // Initially low probability
    expect(tracker.getFailureProbability('backend1')).toBe(0)
    
    // After failures, probability increases
    tracker.recordFailure('backend1', 'Error')
    const prob = tracker.getFailureProbability('backend1')
    expect(prob).toBeGreaterThan(0)
  })

  it('should sort backends by health', () => {
    tracker.recordSuccess('good-backend', 50)
    tracker.recordSuccess('good-backend', 50)
    
    tracker.recordFailure('bad-backend', 'Error')
    tracker.recordFailure('bad-backend', 'Error')
    
    const sorted = tracker.getBackendsByHealth()
    expect(sorted[0].name).toBe('good-backend')
    expect(sorted[sorted.length - 1].name).toBe('bad-backend')
  })

  it('should return healthy backends only', () => {
    tracker.recordSuccess('healthy', 50)
    tracker.recordFailure('unhealthy', 'Error')
    tracker.recordFailure('unhealthy', 'Error')
    tracker.recordFailure('unhealthy', 'Error')
    
    const healthy = tracker.getHealthyBackends()
    expect(healthy).toContain('healthy')
    expect(healthy).not.toContain('unhealthy')
  })

  it('should reset health', () => {
    tracker.recordFailure('backend1', 'Error')
    expect(tracker.isHealthy('backend1')).toBe(true) // 1 failure is below threshold
    
    tracker.resetHealth('backend1')
    expect(tracker.getHealth('backend1')).toBeNull()
  })
})

describe('PredictiveFallbackManager', () => {
  let manager: PredictiveFallbackManager

  beforeEach(() => {
    resetPredictiveFallbackManager()
    manager = new PredictiveFallbackManager({
      maxRetries: 2,
      baseRetryDelayMs: 10, // Fast for tests
    })
  })

  it('should execute with fallback', async () => {
    const result = await manager.executeWithFallback(
      ['backend1', 'backend2'],
      async (backend) => {
        if (backend === 'backend1') throw new Error('Failed')
        return 'success'
      },
    )
    
    expect(result.results).toContain('success')
    expect(result.backend).toBe('backend2')
  })

  it('should retry on failure', async () => {
    let attempts = 0
    const result = await manager.executeWithFallback(
      ['backend1'],
      async () => {
        attempts++
        if (attempts < 3) throw new Error('Failed')
        return 'success'
      },
    )
    
    expect(result.results).toContain('success')
    expect(attempts).toBe(3)
  })

  it('should skip unhealthy backends', async () => {
    // Mark backend1 as unhealthy
    manager.getHealthTracker().recordFailure('backend1', 'Error')
    manager.getHealthTracker().recordFailure('backend1', 'Error')
    manager.getHealthTracker().recordFailure('backend1', 'Error')
    
    const result = await manager.executeWithFallback(
      ['backend1', 'backend2'],
      async (backend) => `result from ${backend}`,
    )
    
    expect(result.results).toContain('result from backend2')
  })

  it('should select best backend', () => {
    manager.getHealthTracker().recordSuccess('good', 50)
    manager.getHealthTracker().recordFailure('bad', 'Error')
    
    const best = manager.selectBestBackend(['good', 'bad'])
    expect(best).toBe('good')
  })

  it('should return stats', () => {
    const stats = manager.getStats()
    expect(stats).toHaveProperty('healthyBackends')
    expect(stats).toHaveProperty('unhealthyBackends')
    expect(stats).toHaveProperty('avgSuccessRate')
  })
})
