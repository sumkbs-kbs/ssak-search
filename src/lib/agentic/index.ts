/**
 * Agentic Search Pipeline — Full Integration
 *
 * Orchestrates the complete Perplexity-style Answer Engine pipeline:
 * 1. Classify query (Fast vs Pro)
 * 2. If Pro: Plan → Execute → Quality Gate → Synthesize
 * 3. If Fast: Single-pass retrieval + extractive summary
 * 4. Return unified response with citations
 */

import type { SearchResponse, SearchAnswer, Topic, TimeRange, SortBy, Env } from '../../types'
import {
  classifyQuery,
  classifyWithAI,
  DEFAULT_CLASSIFIER_CONFIG,
  type ClassificationResult,
  type ClassifierConfig,
} from './classifier'
import { createPlan, type SubQueryPlan } from './planner'
import { executePlan, type StepResult } from './executor'
import { synthesizeAnswer, type SynthesizedAnswer } from './synthesizer'
import { runQualityGate, DEFAULT_QUALITY_CONFIG, type QualityGateResult } from './quality-gate'
import { withResultRetry } from '../../lib/resilience/retry'
import { recordAgenticGapFillResearches } from '../metrics'
import { logger, toError } from '../../lib/logger'
import { generateSpanId } from '../../middleware/tracing'
import type { Ai } from '@cloudflare/workers-types'

// ============================================================
// Types
// ============================================================

export interface AgenticSearchOptions {
  /** Query (required) */
  query: string
  /** Search mode override: 'fast' | 'pro' | 'auto' */
  mode?: 'fast' | 'pro' | 'auto'
  /** Maximum results to return */
  maxResults?: number
  /** Include AI-generated answer */
  includeAnswer?: boolean
  /** Search depth: 'basic' | 'advanced' */
  searchDepth?: 'basic' | 'advanced'
  /** Topic category */
  topic?: Topic
  /** Time range filter */
  timeRange?: TimeRange
  /** Sort by: 'relevance' | 'date' */
  sortBy?: SortBy
  /** Page number for pagination */
  page?: number
  /** Results per page */
  pageSize?: number
  /** Include domains filter */
  includeDomains?: string[]
  /** Exclude domains filter */
  excludeDomains?: string[]
  /** Classifier config */
  classifierConfig?: Partial<ClassifierConfig>
}

export interface AgenticSearchResult {
  /** Original query */
  query: string
  /** Search mode used */
  mode: 'fast' | 'pro'
  /** Classification details (if auto) */
  classification?: ClassificationResult
  /** Traditional search results */
  results: SearchResponse['results']
  /** AI-generated answer (if requested) */
  answer?: SearchAnswer
  /** Synthesized answer with citations (Pro mode) */
  synthesizedAnswer?: SynthesizedAnswer
  /** Quality gate evaluation (Pro mode) */
  qualityGate?: QualityGateResult
  /** Plan used (Pro mode) */
  plan?: SubQueryPlan
  /** Step execution details (Pro mode) */
  stepResults?: StepResult[]
  /** Response time in ms */
  responseTimeMs: number
  /** Backend used */
  backend: string
  /** Whether fallback was used */
  fallbackUsed?: boolean
  /** Related queries */
  relatedQueries?: string[]
  /** Pagination */
  pagination: {
    page: number
    pageSize: number
    totalResults: number
    totalPages: number
  }
}

// ============================================================
// Agentic Pipeline Context
// ============================================================

/** Dependencies injected by the orchestrator */
export interface AgenticPipelineContext {
  /** Workers AI binding */
  ai?: Ai
  /** Cloudflare environment bindings */
  env?: Env
  /** Jina API key for content extraction */
  jinaApiKey?: string
  /**
   * Trace ID (Action Item 1.1) — propagated from the request (cf-ray) through
   * every pipeline stage's logs so one search request is traceable end-to-end.
   */
  traceId?: string
}

// ============================================================
// Full Pipeline Entry Point
// ============================================================

/**
 * Execute the full agentic search pipeline:
 * 1. Classify query (fast vs pro)
 * 2. If pro: Plan → Execute → Quality Gate → Synthesize
 * 3. If fast: single-pass retrieval
 * 4. Return unified result
 */
export async function executeAgenticSearch(
  options: AgenticSearchOptions,
  ctx: AgenticPipelineContext,
): Promise<AgenticSearchResult> {
  const startTime = Date.now()
  const {
    query,
    mode = 'auto',
    maxResults = 10,
    includeAnswer = false,
    searchDepth = 'basic',
    topic = 'general',
    timeRange,
    sortBy = 'relevance',
    page = 1,
    pageSize,
    includeDomains,
    excludeDomains,
    classifierConfig,
  } = options

  // Step 1: Classify query
  const mergedConfig = { ...DEFAULT_CLASSIFIER_CONFIG, ...classifierConfig }
  const classification =
    mode === 'pro'
      ? classifyQuery(query, { ...mergedConfig, mode: 'pro' })
      : mode === 'fast'
        ? classifyQuery(query, { ...mergedConfig, mode: 'fast' })
        : ctx.ai
          ? await classifyWithAI(query, ctx.ai, mergedConfig)
          : classifyQuery(query, mergedConfig)

  const resolvedMode = searchDepth === 'advanced' ? 'pro' : classification.mode === 'pro' ? 'pro' : 'fast'

  // Trace-scoped logger — when the orchestrator passes a traceId, every
  // pipeline log line carries it (plus a per-pipeline span_id).
  const traceId = ctx.traceId
  const log = traceId ? logger.child({ traceId, spanId: generateSpanId(), span: 'agentic' }) : logger

  log.info('[AgenticSearch] Classification complete', {
    query: query.slice(0, 80),
    mode: resolvedMode,
    confidence: classification.confidence,
    complexity: classification.complexityScore,
  })

  // Step 2: If pro mode, run full pipeline; otherwise single-pass
  if (resolvedMode === 'pro') {
    return executeProPipeline(query, {
      maxResults,
      topic,
      timeRange,
      sortBy,
      page,
      pageSize: pageSize ?? maxResults,
      includeDomains,
      excludeDomains,
      includeAnswer,
      ctx,
      classification,
      startTime,
      log,
    })
  }

  // Fast mode: simple retrieval
  return executeFastPipeline(query, {
    maxResults,
    topic,
    timeRange,
    sortBy,
    page,
    pageSize: pageSize ?? maxResults,
    includeAnswer,
    ctx,
    classification,
    startTime,
    log,
  })
}

// ============================================================
// Pro Pipeline: Plan → Execute → Quality Gate → Synthesize
// ============================================================

async function executeProPipeline(
  query: string,
  opts: {
    maxResults: number
    topic: Topic
    timeRange?: TimeRange
    sortBy: SortBy
    page: number
    pageSize: number
    includeDomains?: string[]
    excludeDomains?: string[]
    includeAnswer: boolean
    ctx: AgenticPipelineContext
    classification: ClassificationResult
    startTime: number
    log: typeof logger
  },
): Promise<AgenticSearchResult> {
  const { ctx, startTime, classification, log } = opts
  const traceId = ctx.traceId

  try {
    // Step 2a: Create plan
    const plan = await createPlan(query, ctx.ai as Ai | undefined, undefined, traceId)

    log.info('[AgenticSearch] Plan created', {
      steps: plan.steps.length,
      complexity: plan.complexity,
      confidence: plan.confidence,
    })

    // Step 2b: Execute plan
    const execution = await executePlan(plan, {
      ai: ctx.ai as Ai | undefined,
      maxParallel: 3,
      logger: traceId ? logger.child({ traceId, spanId: generateSpanId(), span: 'executor' }) : undefined,
    })

    log.info('[AgenticSearch] Plan executed', {
      stepsCompleted: execution.stepResults.length,
      success: execution.success,
      citations: execution.allCitations.length,
    })

    // Step 2c: Quality gate with the Phase 6 gap-fill re-query loop, unified
    // under the shared result-gated retry (withResultRetry — the same
    // retryable/onRetry vocabulary as withRetry). The gate's RESULT decides
    // whether to keep re-querying: each non-final pass evaluates the current
    // results and — when below threshold with a reformulation plan — executes
    // that plan and merges its findings into the main context. The FINAL pass
    // always accepts its evaluation (withResultRetry's last-attempt rule), so
    // the re-query count is bounded by DEFAULT_QUALITY_CONFIG.maxRetries (= 1).
    const maxReQueries = DEFAULT_QUALITY_CONFIG.maxRetries
    const gateCycle = async (attempt: number): Promise<QualityGateResult> => {
      const evaluation = await runQualityGate(query, execution.stepResults, undefined, ctx.ai, traceId)
      if (
        attempt < maxReQueries &&
        !evaluation.passed &&
        evaluation.reQueryPlan &&
        evaluation.reQueryPlan.steps.length > 0
      ) {
        log.info('[AgenticSearch] Quality gate failed — running gap-fill re-query', {
          originalScore: evaluation.avgScore,
          reQuerySteps: evaluation.reQueryPlan.steps.length,
        })
        try {
          const gapFill = await executePlan(evaluation.reQueryPlan, {
            ai: ctx.ai as Ai | undefined,
            maxParallel: 3,
            logger: traceId ? logger.child({ traceId, spanId: generateSpanId(), span: 'executor' }) : undefined,
          })
          // Merge gap-fill results into the main execution context
          for (const step of gapFill.stepResults) {
            execution.stepResults.push(step)
            execution.allCitations.push(...step.citations)
            if (step.success) execution.context.completedSteps.add(step.stepId)
          }
        } catch (err) {
          log.warn('[AgenticSearch] Gap-fill re-query failed (non-critical)', {
            error: err instanceof Error ? err.message : String(err),
          })
        }
      }
      return evaluation
    }

    const quality = await withResultRetry(gateCycle, {
      maxRetries: maxReQueries,
      // Nothing to re-query (no plan) → accept the failure honestly, don't spin.
      retryable: (q) => !q.passed && !!q.reQueryPlan && q.reQueryPlan.steps.length > 0,
      // Structured failure reason (below-threshold score + quality warnings)
      // surfaced through withResultRetry's onRetry third argument — same
      // pattern as the synthesizer's regeneration loop.
      reasonFor: (q) => ({ kind: 'gap-fill', score: q.avgScore, warnings: q.warnings }),
      onRetry: (attempt, q, reason) => {
        log.info('[AgenticSearch] Quality gate still below threshold — re-evaluating after gap-fill', {
          attempt,
          avgScore: q.avgScore,
          warnings: q.warnings,
        })
        // gap-fill 재검색률 지표 — one re-search cycle per onRetry (bounded by
        // DEFAULT_QUALITY_CONFIG.maxRetries).
        recordAgenticGapFillResearches({ reason })
      },
    })

    log.info('[AgenticSearch] Quality gate', {
      passed: quality.passed,
      avgScore: quality.avgScore,
    })

    // Step 2d: Synthesize answer
    let synthesized: SynthesizedAnswer | undefined
    if (opts.includeAnswer) {
      synthesized = await synthesizeAnswer(plan, execution.stepResults, ctx.ai as Ai | undefined, undefined, traceId)
    }

    // Collect all results from step outputs
    const allResults: SearchResponse['results'] = []
    for (const step of execution.stepResults) {
      if (step.citations) {
        for (const citation of step.citations) {
          allResults.push({
            title: citation.title,
            url: citation.url,
            content: citation.snippet,
            score: 0.5,
            domain: new URL(citation.url).hostname.replace('www.', ''),
          })
        }
      }
    }

    return {
      query,
      mode: 'pro',
      classification,
      results: allResults,
      answer: synthesized
        ? {
            text: synthesized.text,
            confidence: synthesized.confidence,
            sources: synthesized.citations.map((cite) => ({
              index: cite.sourceId,
              url: cite.url,
              title: cite.title,
              snippet: cite.snippet,
            })),
          }
        : undefined,
      synthesizedAnswer: synthesized,
      qualityGate: quality,
      plan,
      stepResults: execution.stepResults,
      responseTimeMs: Date.now() - startTime,
      backend: 'agentic-pro',
      pagination: {
        page: opts.page,
        pageSize: opts.pageSize,
        totalResults: allResults.length,
        totalPages: Math.ceil(allResults.length / opts.pageSize),
      },
    }
  } catch (err) {
    log.warn('[AgenticSearch] Pro pipeline failed, falling back to fast:', { error: toError(err) })
    return executeFastPipeline(query, {
      maxResults: opts.maxResults,
      topic: opts.topic,
      timeRange: opts.timeRange,
      sortBy: opts.sortBy,
      page: opts.page,
      pageSize: opts.pageSize,
      includeAnswer: opts.includeAnswer,
      ctx,
      classification,
      startTime,
      log,
    })
  }
}

// ============================================================
// Fast Pipeline: Single-pass retrieval
// ============================================================

async function executeFastPipeline(
  query: string,
  opts: {
    maxResults: number
    topic: Topic
    timeRange?: TimeRange
    sortBy: SortBy
    page: number
    pageSize: number
    includeAnswer: boolean
    ctx: AgenticPipelineContext
    classification: ClassificationResult
    startTime: number
    log: typeof logger
  },
): Promise<AgenticSearchResult> {
  const { ctx, startTime, classification, log } = opts
  const traceId = ctx.traceId

  try {
    // Single-pass search using searchWeb
    const { searchWeb } = await import('./search-tools')
    const results = await searchWeb(
      {
        query,
        maxResults: opts.maxResults,
        topic: opts.topic as 'general' | 'news' | 'finance',
      },
      ctx.env,
      ctx.ai,
      traceId,
    )

    return {
      query,
      mode: 'fast',
      classification,
      results: results.map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content,
        score: r.score,
        domain: r.domain,
        published_date: r.published_date,
      })),
      responseTimeMs: Date.now() - startTime,
      backend: 'agentic-fast',
      pagination: {
        page: opts.page,
        pageSize: opts.pageSize,
        totalResults: results.length,
        totalPages: Math.ceil(results.length / opts.pageSize),
      },
    }
  } catch (err) {
    log.warn('[AgenticSearch] Fast pipeline failed:', { error: toError(err) })
    return {
      query,
      mode: 'fast',
      classification,
      results: [],
      responseTimeMs: Date.now() - startTime,
      backend: 'agentic-fast-failed',
      fallbackUsed: true,
      pagination: {
        page: opts.page,
        pageSize: opts.pageSize,
        totalResults: 0,
        totalPages: 0,
      },
    }
  }
}
