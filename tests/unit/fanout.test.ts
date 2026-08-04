/**
 * Unit tests for fanoutBackends() — progressive phase collection + waitFor.
 *
 * waitFor recovers results from high-value backends (e.g. wikipedia) that
 * settle just after phase 1's 800ms early-exit. Bounded by each backend's own
 * BACKEND_TIMEOUT_MS so it can never hang indefinitely. Tests use fake timers
 * to drive phase boundaries deterministically.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { fanoutBackends } from '../../src/lib/search/fanout'
import type { BackendTask } from '../../src/lib/search/context'
import type { SearchResult } from '../../src/types'

function makeResult(name: string, i: number): SearchResult {
  return {
    title: `${name} result ${i}`,
    url: `https://${name}.example/${i}`,
    content: `content ${i}`,
    score: 0.9,
    domain: `${name}.example`,
  }
}

function fastTask(name = 'bing', count = 10): BackendTask {
  return {
    name,
    run: async () => Array.from({ length: count }, (_, i) => makeResult(name, i)),
  }
}

function slowTask(name: string, delayMs: number, count = 5): BackendTask {
  return {
    name,
    run: () =>
      new Promise<SearchResult[]>((resolve) => {
        setTimeout(() => resolve(Array.from({ length: count }, (_, i) => makeResult(name, i))), delayMs)
      }),
  }
}

function neverSettlingTask(name: string): BackendTask {
  return {
    name,
    run: () => new Promise<SearchResult[]>(() => {}),
  }
}

describe('fanoutBackends', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns early when a fast backend fills phase 1, skipping a slow non-waitFor backend', async () => {
    const tasks = [fastTask('bing', 10), slowTask('wikipedia', 2000, 5)]
    const promise = fanoutBackends(tasks, 8)
    await vi.advanceTimersByTimeAsync(800)
    const result = await promise

    expect(result.usedBackends).toEqual(['bing'])
    expect(result.resultSets).toHaveLength(1)
    expect(result.resultSets[0]).toHaveLength(10)
  })

  it('waitFor waits for a slow wikipedia backend after phase 1 early-exit', async () => {
    const tasks = [fastTask('bing', 10), slowTask('wikipedia', 2000, 5)]
    const promise = fanoutBackends(tasks, 8, { waitFor: ['wikipedia'] })

    // Phase 1 (800ms): fast bing resolves, ≥8 results → early-exit. waitFor
    // pending (wikipedia still settling in background).
    await vi.advanceTimersByTimeAsync(800)
    // Phase loop is paused at the waitFor await; advance 2000ms total so
    // wikipedia's 2000ms timer fires and the bgPromise resolves.
    await vi.advanceTimersByTimeAsync(2000)
    const result = await promise

    expect(result.usedBackends).toEqual(['bing', 'wikipedia'])
    expect(result.resultSets).toHaveLength(2)
    expect(result.resultSets[1]).toHaveLength(5)
  })

  it('waitFor is bounded by BACKEND_TIMEOUT_MS — a never-settling task does not hang', async () => {
    // BACKEND_TIMEOUT_MS.wikipedia = 4500ms. Phase 1 breaks at 800ms, then
    // waitFor awaits the wikipedia bgPromise; its timeout timer fires at 4500ms
    // marking the task rejected. Total fake time ≈ 800 + 4500 = 5300ms.
    const tasks = [fastTask('bing', 10), neverSettlingTask('wikipedia')]
    const promise = fanoutBackends(tasks, 8, { waitFor: ['wikipedia'] })

    await vi.advanceTimersByTimeAsync(800)
    await vi.advanceTimersByTimeAsync(4500)
    const result = await promise

    expect(result.usedBackends).toEqual(['bing'])
    expect(result.resultSets).toHaveLength(1)
  })

  it('waitFor skips a backend that already resolved before the waitFor block runs', async () => {
    // wikipedia resolves at 500ms — within phase 1. By the time the phase
    // loop ends (3500ms), taskState[wikipedia].resolved is true, so the
    // waitFor block's `!taskState[idx].resolved` guard skips it without
    // awaiting.
    const tasks = [fastTask('bing', 4), slowTask('wikipedia', 500, 5)]
    const promise = fanoutBackends(tasks, 8, { waitFor: ['wikipedia'] })

    await vi.advanceTimersByTimeAsync(3500)
    const result = await promise

    expect(result.usedBackends).toEqual(['bing', 'wikipedia'])
  })

  it('returns empty for an empty task list', async () => {
    const result = await fanoutBackends([], 8)
    expect(result).toEqual({ resultSets: [], usedBackends: [] })
  })

  it('waitFor name not in tasks is a no-op', async () => {
    const tasks = [fastTask('bing', 10)]
    const promise = fanoutBackends(tasks, 8, { waitFor: ['wikipedia'] })
    await vi.advanceTimersByTimeAsync(800)
    const result = await promise
    expect(result.usedBackends).toEqual(['bing'])
  })
})
