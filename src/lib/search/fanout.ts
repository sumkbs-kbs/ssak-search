/**
 * Backend Fan-out with Progressive Timeout Collection
 *
 * Runs all backend tasks in parallel with per-backend timeouts, collecting
 * results in phases (1.5s → 3.0s → 5.0s). Returns early once enough results
 * are gathered, reducing p50 latency.
 *
 * Extracted from orchestrator.ts lines 703-833.
 */

import type { SearchResult } from '../../types'
import type { BackendTask } from './context'

// Progressive collection phases — each phase waits up to waitMs, then checks
// if we have enough results (≥ minResults). Phase 3 has minResults=0 so it
// always breaks (final safety net).
//
// Tuned for the agent-friendly "≤2s p50" target. The original 1.5/3.0/5.0s
// cadence produced 6s+ p95 because phase 3 acted as a near-default wait when
// backends were slow. Pulling phase 1 down to 800ms means a healthy fan-out
// returns as soon as ONE primary backend (naver/bing/brave) resolves, which
// typically happens in 300-700ms. Phase 2/3 still give slow backends room,
// but the early-exit threshold at phase 1 is "enough to fill a page".
const PHASES = [
  { waitMs: 800, minResults: -1 },  // -1 → computed from maxResults at call time
  { waitMs: 1800, minResults: -1 },
  { waitMs: 3500, minResults: 0 },
] as const

// Per-backend maximum wait times (ms). Individual backends don't delay the
// entire orchestration — the phased collection provides the overall timeout.
// Trimmed from the original 3-6s ceilings: a backend that hasn't answered in
// 2s is either rate-limited or down, and waiting longer just inflates p95
// without improving result quality (the slower backend's results are usually
// lower-relevance anyway). self-index/naver-finance keep longer ceilings
// because they're high-value and consistently fast when healthy.
const BACKEND_TIMEOUT_MS: Record<string, number> = {
  'self-index': 2500,
  'bing': 2000,
  'bing-news': 2000,
  'bing-cleaned': 2000,
  'bing-finance': 2000,
  'bing-writing': 2000,
  'bing-youtube': 2000,
  'naver': 2500,
  'naver-finance': 4000,
  'wikipedia': 3000,
  'github': 2000,
  'hackernews': 1800,
  'reddit': 2000,
  'arxiv': 2500,
  'google-scholar': 2000,
  'searxng': 3000,
  'duckduckgo': 2000,
  'brave': 2000,
  'yahoo-finance': 2000,
}

interface TaskResult {
  name: string
  value: SearchResult[]
  resolved: boolean
  rejected: boolean
}

export interface FanoutResult {
  resultSets: SearchResult[][]
  usedBackends: string[]
}

/**
 * Run all backend tasks with progressive timeout collection.
 *
 * @param tasks  Named backend tasks to execute in parallel
 * @param maxResults  The requested result count (drives early-exit thresholds)
 * @returns Collected result sets and the names of backends that produced them
 */
export async function fanoutBackends(
  tasks: BackendTask[],
  maxResults: number,
): Promise<FanoutResult> {
  if (tasks.length === 0) {
    return { resultSets: [], usedBackends: [] }
  }

  // Compute phase thresholds from maxResults (was inline in the God Function).
  // Phase 1 threshold is deliberately loose (just one full page worth) so a
  // healthy primary backend resolves the request in ~800ms instead of waiting
  // for an over-fetch that only helps ranking marginally.
  const phases = [
    { waitMs: PHASES[0].waitMs, minResults: Math.max(maxResults, 8) },
    { waitMs: PHASES[1].waitMs, minResults: Math.max(maxResults + 3, 10) },
    { waitMs: PHASES[2].waitMs, minResults: 0 },
  ]

  // Initialize task state
  const taskState: TaskResult[] = tasks.map((task) => ({
    name: task.name,
    value: [],
    resolved: false,
    rejected: false,
  }))

  // Start all tasks with per-backend timeout (fire-and-forget — they update taskState)
  for (let idx = 0; idx < tasks.length; idx++) {
    const backendTimeout = BACKEND_TIMEOUT_MS[tasks[idx].name] ?? 4000
    const task = tasks[idx]
    const state = taskState[idx]

    const bgPromise = new Promise<void>((resolve) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        state.resolved = true
        state.rejected = true
        resolve()
      }, backendTimeout)

      task.run()
        .then((value) => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          state.value = value
          state.resolved = true
          resolve()
        })
        .catch(() => {
          if (settled) return
          settled = true
          clearTimeout(timer)
          state.resolved = true
          state.rejected = true
          resolve()
        })
    })

    bgPromise.catch(() => {})
  }

  // Progressive phase collection — wait up to each phase's timeout, break early
  // if we have enough results.
  const startPhaseTime = Date.now()

  for (const phase of phases) {
    const elapsed = Date.now() - startPhaseTime
    const remainingMs = phase.waitMs - elapsed

    if (remainingMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, remainingMs))
    }

    const resolvedResults = taskState.filter((s) => s.resolved && !s.rejected && s.value.length > 0)
    const totalRawResults = resolvedResults.reduce((sum, s) => sum + s.value.length, 0)

    if (totalRawResults >= phase.minResults || phase.minResults === 0) {
      break
    }
  }

  // Collect results
  const resultSets: SearchResult[][] = []
  const usedBackends: string[] = []

  for (const s of taskState) {
    if (s.resolved && !s.rejected && s.value.length > 0) {
      resultSets.push(s.value)
      usedBackends.push(s.name)
    }
  }

  return { resultSets, usedBackends }
}
