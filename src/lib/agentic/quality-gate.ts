/**
 * Quality Gate — Evidence Validation & Fail-fast Re-query
 *
 * Implements Perplexity-style quality threshold (0.7) with fail-fast behavior:
 * - If evidence score < 0.7, discard all results and re-query with reformulated query
 * - Maximum 1 re-query attempt to prevent infinite loops
 * - Logs quality metrics for monitoring
 */

import type { SubQueryPlan } from './planner'
import { logger, toError } from '../../lib/logger'
import type { StepResult } from './executor'

// ============================================================
// Types
// ============================================================

export interface QualityGateConfig {
  /** Minimum evidence score to pass (Perplexity uses ~0.7) */
  minScore: number
  /** Maximum re-query attempts */
  maxRetries: number
  /** Score below which to trigger full re-query */
  reQueryThreshold: number
}

export interface QualityGateResult {
  /** Whether evidence passes quality threshold */
  passed: boolean
  /** Average evidence score */
  avgScore: number
  /** Number of evidence items evaluated */
  evidenceCount: number
  /** Whether a re-query was attempted */
  reQueried: boolean
  /** Original query that was evaluated */
  originalQuery: string
  /** Reformulated query if re-query happened */
  reformulatedQuery?: string
  /** Re-query plan for gap-filling (Phase 6) */
  reQueryPlan?: SubQueryPlan
  /** Quality warnings */
  warnings: string[]
}

/**
 * Quality gate thresholds (matching Perplexity's L3 reranker behavior)
 */
export const DEFAULT_QUALITY_CONFIG: QualityGateConfig = {
  minScore: 0.08, // Minimum individual evidence score to keep
  maxRetries: 1, // Maximum re-query attempts
  reQueryThreshold: 0.7, // If avg evidence score < 0.7, trigger re-query
}

// ============================================================
// Evidence Quality Evaluation
// ============================================================

export interface EvidenceItem {
  title: string
  url: string
  content: string
  score: number
  domain: string
  stepId: number
  sourceId: number
}

/**
 * Evaluate evidence quality for a single step's results
 */
export function evaluateStepEvidence(
  stepResults: StepResult[],
  minScore: number = DEFAULT_QUALITY_CONFIG.minScore,
): { passed: boolean; avgScore: number; count: number; kept: EvidenceItem[] } {
  const allEvidence: EvidenceItem[] = []

  for (const result of stepResults) {
    if (!result.success || !result.evidence) continue

    const evidence = result.evidence as Array<{
      title: string
      url: string
      content: string
      score: number
      domain: string
    }>

    for (let i = 0; i < evidence.length; i++) {
      const item = evidence[i]
      if ((item.score ?? 0) >= minScore) {
        allEvidence.push({
          title: item.title,
          url: item.url,
          content: item.content,
          score: item.score ?? 0,
          domain: item.domain,
          stepId: result.stepId,
          sourceId: i + 1,
        })
      }
    }
  }

  if (allEvidence.length === 0) {
    return { passed: false, avgScore: 0, count: 0, kept: [] }
  }

  const avgScore = allEvidence.reduce((sum, e) => sum + e.score, 0) / allEvidence.length

  return {
    passed: avgScore >= DEFAULT_QUALITY_CONFIG.reQueryThreshold,
    avgScore,
    count: allEvidence.length,
    kept: allEvidence,
  }
}

/**
 * Evaluate overall plan execution quality
 */
export function evaluatePlanQuality(
  stepResults: StepResult[],
  config: QualityGateConfig = DEFAULT_QUALITY_CONFIG,
): QualityGateResult {
  const allEvidence: EvidenceItem[] = []
  const warnings: string[] = []

  // Collect all evidence from successful steps
  for (const result of stepResults) {
    if (!result.success || !result.evidence) {
      warnings.push(`Step ${result.stepId} (${result.tool}) failed: ${result.error}`)
      continue
    }

    const evidence = result.evidence as Array<{
      title: string
      url: string
      content: string
      score: number
      domain: string
    }>

    for (let i = 0; i < evidence.length; i++) {
      const item = evidence[i]
      if ((item.score ?? 0) >= config.minScore) {
        allEvidence.push({
          title: item.title,
          url: item.url,
          content: item.content,
          score: item.score ?? 0,
          domain: item.domain,
          stepId: result.stepId,
          sourceId: i + 1,
        })
      }
    }
  }

  if (allEvidence.length === 0) {
    return {
      passed: false,
      avgScore: 0,
      evidenceCount: 0,
      reQueried: false,
      originalQuery: '',
      warnings: ['No evidence passed minimum score threshold'],
    }
  }

  const avgScore = allEvidence.reduce((sum, e) => sum + e.score, 0) / allEvidence.length
  const passed = avgScore >= config.reQueryThreshold

  if (!passed) {
    warnings.push(
      `Average evidence score (${avgScore.toFixed(2)}) below quality threshold (${config.reQueryThreshold})`,
    )
  }

  // Check for domain diversity
  const uniqueDomains = new Set(allEvidence.map((e) => e.domain))
  if (uniqueDomains.size < 2 && allEvidence.length > 3) {
    warnings.push(`Low domain diversity: only ${uniqueDomains.size} unique domains`)
  }

  // Check for recency (if dates available)
  const datedEvidence = allEvidence.filter((e) => e.content.includes('2024') || e.content.includes('2025'))
  if (datedEvidence.length === 0 && allEvidence.length > 2) {
    warnings.push('No recent evidence found (no 2024/2025 dates)')
  }

  return {
    passed,
    avgScore,
    evidenceCount: allEvidence.length,
    reQueried: false,
    originalQuery: '',
    warnings,
  }
}

/**
 * Reformulate query for re-query attempt
 * Uses LLM or heuristic to improve query specificity
 */
export async function reformulateQuery(
  originalQuery: string,
  failedResults: StepResult[],
  ai?: unknown,
): Promise<string> {
  // If AI available, use it for intelligent reformulation
  if (ai) {
    try {
      const aiBinding = ai as Ai
      const failedSteps = failedResults
        .filter((r) => !r.success || (r.citations?.length ?? 0) < 2)
        .map((r) => r.question)
        .slice(0, 5)

      const prompt = `You are a search query optimizer. The user asked: "${originalQuery}"

The following sub-queries returned insufficient or low-quality results:
${failedSteps.map((s, i) => `${i + 1}. ${s}`).join('\n')}

Generate ONE improved search query that:
1. Uses more specific or technical terms
2. Adds authoritative source hints if relevant
3. Removes ambiguity
4. Stays in the same language as the original query

Reply with ONLY the reformulated query, nothing else.`

      const response = await aiBinding.run('@cf/meta/llama-3.1-8b-instruct', {
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.3,
      })

      const text = extractText(response)
      if (text) {
        const cleaned = text
          .trim()
          .replace(/^["']|["']$/g, '')
          .split('\n')[0]
          .trim()
        if (cleaned.length > 5 && cleaned.length < 200 && cleaned !== originalQuery) {
          logger.info(`[QualityGate] AI reformulated query: "${originalQuery}" -> "${cleaned}"`)
          return cleaned
        }
      }
    } catch (err) {
      logger.warn('[QualityGate] AI reformulation failed, using heuristic:', { error: toError(err) })
    }
  }

  // Heuristic reformulation strategies (fallback when AI unavailable or failed)
  const strategies = [
    // Add "official" / "documentation" for technical queries
    (q: string) => (q.includes('api') || q.includes('sdk') ? `${q} official documentation` : null),
    // Add "latest" / "2025" for time-sensitive queries
    (q: string) => (!/20[0-9][0-9]/.test(q) ? `${q} 2025` : null),
    // Add "comparison" / "vs" for evaluation queries
    (q: string) => (/best|better|worst|compare/.test(q.toLowerCase()) ? `${q} comparison review` : null),
    // Simplify - remove filler words
    (q: string) =>
      q.split(' ').length > 8
        ? q
            .split(' ')
            .filter((w) => w.length > 3)
            .join(' ')
        : null,
  ]

  for (const strategy of strategies) {
    const result = strategy(originalQuery)
    if (result && result !== originalQuery) {
      logger.info(`[QualityGate] Heuristic reformulated query: "${originalQuery}" -> "${result}"`)
      return result
    }
  }

  // Fallback: add "comprehensive" modifier
  return `${originalQuery} comprehensive guide`
}

/** Extract text from various Workers AI response shapes. */
function extractText(response: unknown): string | null {
  if (typeof response === 'string') return response
  if (response && typeof response === 'object') {
    const r = response as Record<string, unknown>
    if (typeof r.response === 'string') return r.response
    const choices = r.choices as Array<{ message?: { content?: string } }> | undefined
    if (choices?.[0]?.message?.content) return choices[0].message.content
    if (typeof r.result === 'string') return r.result
  }
  return null
}

/**
 * Execute quality gate with optional re-query
 * Returns evaluation result and potentially reformulated query
 */
export async function runQualityGate(
  originalQuery: string,
  stepResults: StepResult[],
  config: QualityGateConfig = DEFAULT_QUALITY_CONFIG,
  ai?: unknown,
): Promise<QualityGateResult & { reQueryPlan?: SubQueryPlan }> {
  const evaluation = evaluatePlanQuality(stepResults, config)
  evaluation.originalQuery = originalQuery

  if (!evaluation.passed && config.maxRetries > 0) {
    // Try to reformulate and re-query
    const reformulated = await reformulateQuery(originalQuery, stepResults, ai)

    if (reformulated !== originalQuery) {
      evaluation.reQueried = true
      evaluation.reformulatedQuery = reformulated
      evaluation.warnings.push(`Triggered re-query with reformulated query: "${reformulated}"`)

      // Phase 6: Build an actual re-query plan so the caller (executeProPipeline)
      // can execute it. Previously this function only set the reformulated query
      // string but never produced a SubQueryPlan — so the gap-fill loop in
      // index.ts never had anything to execute.
      evaluation.reQueryPlan = {
        original_query: reformulated,
        complexity: 'moderate',
        estimated_steps: 2,
        steps: [
          {
            id: 1,
            question: reformulated,
            tool: 'web_search',
            params: { query: reformulated, max_results: 10 },
            output_role: 'evidence',
            depends_on: [],
          },
        ],
        synthesis_instruction: `Supplement the original answer with findings from: ${reformulated}`,
        confidence: 0.5,
      }
    }
  }

  return evaluation
}

/**
 * Quality gate for individual search results (used in retriever)
 */
export function filterByQuality(
  results: Array<{ score: number; [key: string]: unknown }>,
  threshold: number = DEFAULT_QUALITY_CONFIG.minScore,
): typeof results {
  return results.filter((r) => (r.score ?? 0) >= threshold)
}
