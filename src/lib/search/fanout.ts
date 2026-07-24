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
const PHASES = [
  { waitMs: 1500, minResults: -1 }, // -1 → computed from maxResults at call time
  { waitMs: 3000, minResults: -1 },
  { waitMs: 5000, minResults: 0 },
] as const

// Per-backend maximum wait times (ms). Individual backends don't delay the
// entire orchestration — the phased collection provides the overall timeout.
const BACKEND_TIMEOUT_MS: Record<string, number> = {
  'self-index': 3500,
  'bing': 3000,
  'bing-news': 3000,
  'bing-cleaned': 3000,
  'bing-finance': 3000,
  'bing-writing': 3000,
  'bing-youtube': 3000,
  'naver': 3000,
  'naver-finance': 6000,
  'wikipedia': 5000,
  'github': 3000,
  'hackernews': 2500,
  'reddit': 3000,
  'arxiv': 4000,
  'google-scholar': 3000,
  'searxng': 5000,
  'duckduckgo': 3000,
  'brave': 3000,
  'yahoo-finance': 3000,
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

  // Compute phase thresholds from maxResults (was inline in the God Function)
  const phases = [
    { waitMs: PHASES[0].waitMs, minResults: Math.max(maxResults * 2, 15) },
    { waitMs: PHASES[1].waitMs, minResults: Math.max(maxResults + 5, 10) },
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
