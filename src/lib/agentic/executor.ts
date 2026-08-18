/**
 * Executor Module — Sequential Plan Execution with Context Passing
 *
 * Runs the SubQueryPlan step by step, passing results from earlier steps
 * as context to later steps. Handles tool invocation, error recovery,
 * and evidence aggregation.
 */

import type { SubQueryPlan, SubQueryStep } from './planner'
import { logger, toError, type Logger } from '../../lib/logger'
import type { Ai } from '@cloudflare/workers-types'
import { searchWeb, fetchUrl, compute } from './search-tools'

// ============================================================
// Types
// ============================================================

export interface StepResult {
  stepId: number
  question: string
  tool: string
  success: boolean
  evidence?: unknown
  error?: string
  citations: Citation[]
}

export interface Citation {
  stepId: number
  sourceId: number
  title: string
  url: string
  snippet: string
  timestamp: string
}

export interface ExecutionContext {
  plan: SubQueryPlan
  stepResults: Map<number, StepResult>
  allCitations: Citation[]
  completedSteps: Set<number>
  failedSteps: Set<number>
}

export interface ExecutorOptions {
  /** Workers AI binding for compute tool */
  ai?: Ai
  /** Max parallel steps (default 1 for true sequential) */
  maxParallel?: number
  /** Timeout per step in ms */
  stepTimeoutMs?: number
  /** Max results per search step */
  maxSearchResults?: number
  /** Trace-scoped logger (Action Item 1.1) — carries traceId/spanId */
  logger?: Logger
}

// Internal options with required defaults but optional ai
interface InternalExecutorOptions {
  ai: Ai | undefined
  maxParallel: number
  stepTimeoutMs: number
  maxSearchResults: number
  log: Logger
}

// ============================================================
// Tool Implementations
// ============================================================

/** Execute a single step using the appropriate tool */
async function executeStep(
  step: SubQueryStep,
  context: ExecutionContext,
  opts: InternalExecutorOptions,
): Promise<StepResult> {
  const citations: Citation[] = []

  try {
    let evidence: unknown

    switch (step.tool) {
      case 'web_search': {
        const params = step.params as {
          query: string
          recency_days?: number
          max_results?: number
          topic?: 'general' | 'news' | 'finance'
          timeout_ms?: number
          language?: string
        }
        // Resolve query template with context from dependencies
        const resolvedQuery = resolveTemplate(params.query, context)

        const results = await searchWeb({
          query: resolvedQuery,
          recencyDays: params.recency_days,
          maxResults: params.max_results ?? opts.maxSearchResults ?? 8,
          // Forward the planner's topic so searchWeb can route to the
          // finance/news backends (planner financial steps set topic='finance').
          topic: params.topic,
          // Forward the remaining SearchOptions fields — per-step fetch timeout
          // override and language (used by e.g. wikipediaSearch).
          timeoutMs: params.timeout_ms,
          language: params.language,
        })

        evidence = results
        // Create citations from search results
        results.forEach((r: { title: string; url: string; content: string }, idx: number) => {
          citations.push({
            stepId: step.id,
            sourceId: idx + 1,
            title: r.title,
            url: r.url,
            snippet: r.content.slice(0, 300),
            timestamp: new Date().toISOString(),
          })
        })
        break
      }

      case 'fetch_url': {
        const params = step.params as { url: string; max_tokens?: number }
        const resolvedUrl = resolveTemplate(params.url, context)

        const content = await fetchUrl({
          url: resolvedUrl,
          maxTokens: params.max_tokens ?? 8000,
        })

        evidence = { url: resolvedUrl, content }
        citations.push({
          stepId: step.id,
          sourceId: 1,
          title: resolvedUrl,
          url: resolvedUrl,
          snippet: content.slice(0, 300),
          timestamp: new Date().toISOString(),
        })
        break
      }

      case 'compute': {
        const params = step.params as { formula: string; context?: Record<string, unknown> }
        // Gather context from dependency steps
        const depContext: Record<string, unknown> = {}
        for (const depId of step.depends_on) {
          const depResult = context.stepResults.get(depId)
          if (depResult?.evidence) {
            depContext[`step_${depId}`] = depResult.evidence
          }
        }
        const mergedContext = { ...params.context, ...depContext }

        evidence = await compute(params.formula, mergedContext)
        break
      }

      default:
        throw new Error(`Unknown tool: ${(step as { tool: string }).tool}`)
    }

    return {
      stepId: step.id,
      question: step.question,
      tool: step.tool,
      success: true,
      evidence,
      citations,
    }
  } catch (err) {
    const error = toError(err)
    return {
      stepId: step.id,
      question: step.question,
      tool: step.tool,
      success: false,
      error,
      citations: [],
    }
  }
}

/** Resolve template variables in strings using context from previous steps */
function resolveTemplate(template: string, context: ExecutionContext): string {
  return template.replace(/\{\{step_(\d+)\.(.+?)\}\}/g, (match, stepIdStr, path) => {
    const stepId = parseInt(stepIdStr, 10)
    const result = context.stepResults.get(stepId)
    if (!result?.evidence) return match

    // Navigate to the path in evidence
    const value = getNestedValue(result.evidence, path)
    return value !== undefined ? String(value) : match
  })
}

function getNestedValue(obj: unknown, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj
  for (const part of parts) {
    if (current === null || current === undefined) return undefined
    if (Array.isArray(current)) {
      const idx = parseInt(part, 10)
      if (!isNaN(idx)) current = current[idx]
      else return undefined
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

// ============================================================
// Executor Class
// ============================================================

export class PlanExecutor {
  private opts: InternalExecutorOptions

  constructor(opts: ExecutorOptions = {}) {
    this.opts = {
      ai: opts.ai,
      maxParallel: opts.maxParallel ?? 1,
      stepTimeoutMs: opts.stepTimeoutMs ?? 30000,
      maxSearchResults: opts.maxSearchResults ?? 8,
      log: opts.logger ?? logger,
    }
  }

  /**
   * Execute a full plan sequentially, returning aggregated results
   */
  async execute(plan: SubQueryPlan): Promise<{
    context: ExecutionContext
    allCitations: Citation[]
    stepResults: StepResult[]
    success: boolean
    failedSteps: number[]
  }> {
    const context: ExecutionContext = {
      plan,
      stepResults: new Map(),
      allCitations: [],
      completedSteps: new Set(),
      failedSteps: new Set(),
    }

    // Sort steps by dependencies (topological sort for safety)
    const sortedSteps = this.topologicalSort(plan.steps)

    // Phase 6: Execute steps in parallel batches, respecting depends_on.
    // Group steps into "waves" — each wave contains steps whose dependencies
    // are all satisfied by the previous wave. Steps within a wave run in
    // parallel up to maxParallel concurrency.
    const remaining = new Set(sortedSteps)

    while (remaining.size > 0) {
      // Find all steps whose dependencies are met by completed steps
      const ready = [...remaining].filter((step) => step.depends_on.every((depId) => context.completedSteps.has(depId)))
      if (ready.length === 0) {
        // Deadlock — remaining steps have unmet deps (circular or failed deps)
        this.opts.log.warn(`[Executor] ${remaining.size} steps have unmet dependencies, running anyway`)
        ready.push(...remaining)
      }

      // Remove ready steps from remaining
      for (const step of ready) remaining.delete(step)

      // Execute this wave in parallel, limited by maxParallel
      const waveEntries = ready.map((step) => ({
        stepId: step.id,
        question: step.question,
        tool: step.tool,
        promise: (async (): Promise<StepResult> => {
          const stepPromise = executeStep(step, context, this.opts)
          const timeoutPromise = new Promise<StepResult>((_, reject) =>
            setTimeout(() => reject(new Error(`Step ${step.id} timeout`)), this.opts.stepTimeoutMs),
          )
          try {
            return await Promise.race([stepPromise, timeoutPromise])
          } catch (err) {
            return {
              stepId: step.id,
              question: step.question,
              tool: step.tool,
              success: false,
              error: toError(err),
              citations: [],
            } as StepResult
          }
        })(),
      }))

      // Limit concurrency: chunk the wave into groups of maxParallel
      const maxParallel = this.opts.maxParallel ?? 1
      for (let i = 0; i < waveEntries.length; i += maxParallel) {
        const chunk = waveEntries.slice(i, i + maxParallel)
        const settled = await Promise.allSettled(chunk.map((e) => e.promise))

        for (let j = 0; j < settled.length; j++) {
          const entry = chunk[j]
          const s = settled[j]
          const result: StepResult =
            s.status === 'fulfilled'
              ? s.value
              : {
                  stepId: entry.stepId,
                  question: entry.question,
                  tool: entry.tool,
                  success: false,
                  error: String((settled[j] as PromiseRejectedResult).reason),
                  citations: [],
                }
          context.stepResults.set(result.stepId, result)
          context.allCitations.push(...result.citations)
          if (result.success) {
            context.completedSteps.add(result.stepId)
          } else {
            context.failedSteps.add(result.stepId)
            this.opts.log.warn(`[Executor] Step ${result.stepId} failed: ${result.error}`)
          }
        }
      }
    }

    const success = context.failedSteps.size === 0
    const failedSteps = Array.from(context.failedSteps).sort((a, b) => a - b)

    return {
      context,
      allCitations: context.allCitations,
      stepResults: Array.from(context.stepResults.values()).sort((a, b) => a.stepId - b.stepId),
      success,
      failedSteps,
    }
  }

  /**
   * Topological sort of steps by depends_on
   */
  private topologicalSort(steps: SubQueryStep[]): SubQueryStep[] {
    const visited = new Set<number>()
    const result: SubQueryStep[] = []
    const stepMap = new Map(steps.map((s) => [s.id, s]))

    function visit(stepId: number) {
      if (visited.has(stepId)) return
      const step = stepMap.get(stepId)
      if (!step) return

      for (const depId of step.depends_on) {
        visit(depId)
      }
      visited.add(stepId)
      result.push(step)
    }

    for (const step of steps) {
      visit(step.id)
    }
    return result
  }
}

// ============================================================
// Convenience function
// ============================================================

export async function executePlan(
  plan: SubQueryPlan,
  opts: ExecutorOptions = {},
): Promise<{
  context: ExecutionContext
  allCitations: Citation[]
  stepResults: StepResult[]
  success: boolean
  failedSteps: number[]
}> {
  const executor = new PlanExecutor(opts)
  return executor.execute(plan)
}
