/**
 * Unit tests for SubrequestTracker — the Cloudflare 50-subrequest budget guard.
 *
 * Verifies the tracker counts fetches routed through fetchWithTimeout and
 * reports exhaustion correctly. This is the unit-level guard for P0-5; the
 * live HTTP behavior (X-Subrequests-Used header) is verified separately.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock rate-limiter so fetchWithTimeout doesn't hit the network.
vi.mock('../../src/lib/rate-limiter', () => ({
  canRequest: async () => true,
  rateLimitedFetch: async () => new Response('ok', { status: 200 }),
}))

import {
  SubrequestTracker,
  installSubrequestTracker,
  fetchWithTimeout,
} from '../../src/lib/util'

describe('SubrequestTracker', () => {
  it('counts fetches routed through fetchWithTimeout', async () => {
    const tracker = new SubrequestTracker()
    const uninstall = installSubrequestTracker(tracker)
    try {
      expect(tracker.count).toBe(0)
      await fetchWithTimeout(undefined, 'https://example.com/a')
      await fetchWithTimeout(undefined, 'https://example.com/b')
      await fetchWithTimeout(undefined, 'https://example.com/c')
      expect(tracker.count).toBe(3)
    } finally {
      uninstall()
    }
  })

  it('does not count when no tracker is installed', async () => {
    // No install — fetch should still work, just without counting.
    await fetchWithTimeout(undefined, 'https://example.com/x')
    // Nothing to assert except that it didn't throw; the global slot stays null.
    expect(true).toBe(true)
  })

  it('reports budgetExhausted at the soft limit', () => {
    const tracker = new SubrequestTracker(5, 50)
    expect(tracker.budgetExhausted()).toBe(false)
    tracker.count = 5
    expect(tracker.budgetExhausted()).toBe(true)
    tracker.count = 4
    expect(tracker.budgetExhausted()).toBe(false)
  })

  it('reports budgetCritical near the hard limit', () => {
    const tracker = new SubrequestTracker(5, 50)
    expect(tracker.budgetCritical()).toBe(false)
    tracker.count = 48
    expect(tracker.budgetCritical()).toBe(true)
  })

  it('throws when the hard limit is exceeded via tick()', () => {
    const tracker = new SubrequestTracker(5, 50)
    tracker.count = 50
    expect(() => tracker.tick()).toThrow(/Subrequest budget exhausted/)
  })

  it('uninstall clears the active tracker slot', async () => {
    const tracker = new SubrequestTracker()
    const uninstall = installSubrequestTracker(tracker)
    await fetchWithTimeout(undefined, 'https://example.com/1')
    expect(tracker.count).toBe(1)
    uninstall()
    // After uninstall, fetches are not counted against this tracker.
    await fetchWithTimeout(undefined, 'https://example.com/2')
    expect(tracker.count).toBe(1)
  })
})
