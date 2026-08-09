/**
 * Pro/Fast Router — Query Complexity Classifier (Phase 1.3 Enhanced)
 *
 * Determines whether a query needs Pro Search (multi-step agentic)
 * or Fast Search (single-pass retrieval).
 *
 * Now powered by the understanding module for richer analysis:
 * - Intent detection (informational, navigational, transactional, commercial)
 * - Granular sub-type detection
 * - Entity extraction
 * - LLM-enhanced classification via Workers AI
 *
 * Based on Perplexity's auto-classification logic.
 */

import type { Ai } from '@cloudflare/workers-types'
import { logger, toError } from '../../lib/logger'
import {
  classifyUnderstanding,
  classifyUnderstandingWithAI,
  type SearchIntent,
} from '../../lib/understanding/classifier'
import { extractEntityHints } from '../../lib/understanding/entity-extractor'

export type SearchMode = 'fast' | 'pro' | 'auto'

export interface ClassifierConfig {
  /** Mode: 'fast', 'pro', or 'auto' (default) */
  mode: SearchMode
  /** Threshold for auto mode: complexity score >= threshold -> pro */
  autoThreshold: number
  /** Whether to use LLM enhancement (default: false for speed) */
  useAI?: boolean
}

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  mode: 'auto',
  autoThreshold: 0.6,
  useAI: false,
}

export interface ClassificationResult {
  mode: 'fast' | 'pro'
  confidence: number
  reasoning: string
  complexityScore: number
  detectedPatterns: string[]
  isKorean: boolean
  isChinese: boolean
  /** Intent classification (new in Phase 1.3) */
  intent?: SearchIntent
  /** Entities extracted from query (new in Phase 1.3) */
  entities?: Array<{ text: string; type: string; confidence: number }>
  /** Whether LLM was used */
  aiEnhanced?: boolean
}

/**
 * Classify query complexity and determine search mode.
 * Powered by the understanding module for richer analysis.
 */
export function classifyQuery(
  query: string,
  config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
): ClassificationResult {
  if (config.mode === 'fast') {
    return {
      mode: 'fast',
      confidence: 1.0,
      reasoning: 'Explicit fast mode',
      complexityScore: 0,
      detectedPatterns: [],
      isKorean: /[\uAC00-\uD7A3]/.test(query),
      isChinese: /[\u4E00-\u9FFF]/.test(query),
    }
  }
  if (config.mode === 'pro') {
    return {
      mode: 'pro',
      confidence: 1.0,
      reasoning: 'Explicit pro mode',
      complexityScore: 1,
      detectedPatterns: ['explicit'],
      isKorean: /[\uAC00-\uD7A3]/.test(query),
      isChinese: /[\u4E00-\u9FFF]/.test(query),
    }
  }

  // Auto mode: use understanding module
  const understanding = classifyUnderstanding(query)

  const mode = understanding.complexityScore >= config.autoThreshold ? 'pro' : 'fast'
  const confidence = Math.min(1, Math.abs(understanding.complexityScore - config.autoThreshold) * 2)

  // Extract entities for richer classification
  const entityHints = extractEntityHints(query)
  const entities = []
  for (const org of entityHints.organizations) entities.push({ text: org, type: 'organization', confidence: 0.9 })
  for (const tech of entityHints.technologies) entities.push({ text: tech, type: 'technology', confidence: 0.9 })
  for (const product of entityHints.products) entities.push({ text: product, type: 'product', confidence: 0.8 })

  return {
    mode,
    confidence: Math.min(1, confidence),
    reasoning: `Complexity: ${understanding.complexityScore.toFixed(2)}. Intent: ${understanding.intent}. SubType: ${understanding.subType}. Script: ${understanding.script}`,
    complexityScore: understanding.complexityScore,
    detectedPatterns: understanding.detectedPatterns,
    isKorean: /[\uAC00-\uD7A3]/.test(query),
    isChinese: /[\u4E00-\u9FFF]/.test(query),
    intent: understanding.intent,
    entities: entities.length > 0 ? entities : undefined,
    aiEnhanced: false,
  }
}

/**
 * Enhanced classification with LLM (for production use)
 * Falls back to heuristic if AI unavailable.
 *
 * Phase 1.3: Now uses Workers AI for actual LLM-based classification.
 */
export async function classifyWithAI(
  query: string,
  ai: unknown,
  config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG,
): Promise<ClassificationResult> {
  if (!ai) {
    return classifyQuery(query, config)
  }

  try {
    const enhanced = await classifyUnderstandingWithAI(query, ai as Ai)

    const mode = enhanced.complexityScore >= config.autoThreshold ? 'pro' : 'fast'
    const confidence = Math.min(1, Math.abs(enhanced.complexityScore - config.autoThreshold) * 2)

    return {
      mode,
      confidence: Math.min(1, confidence),
      reasoning: enhanced.reasoning,
      complexityScore: enhanced.complexityScore,
      detectedPatterns: enhanced.detectedPatterns,
      isKorean: /[\uAC00-\uD7A3]/.test(query),
      isChinese: /[\u4E00-\u9FFF]/.test(query),
      intent: enhanced.intent,
      entities: enhanced.entities?.map((e) => ({
        text: e.text,
        type: e.type,
        confidence: e.confidence,
      })),
      aiEnhanced: true,
    }
  } catch (err) {
    logger.warn('[Classifier] AI classification failed, using heuristic:', { error: toError(err) })
    return classifyQuery(query, config)
  }
}

/**
 * Determine if a query should use Pro Search based on classification
 */
export function shouldUseProSearch(query: string, config: ClassifierConfig = DEFAULT_CLASSIFIER_CONFIG): boolean {
  const result = classifyQuery(query, config)
  return result.mode === 'pro'
}

/**
 * Get recommended Pro Search config based on query type
 */
export function getProSearchConfig(classification: ClassificationResult): {
  maxSteps: number
  maxSearchResults: number
  evidenceThreshold: number
} {
  const base = {
    maxSteps: 5,
    maxSearchResults: 8,
    evidenceThreshold: 0.7,
  }

  if (classification.complexityScore > 0.8) {
    return { ...base, maxSteps: 8, maxSearchResults: 10, evidenceThreshold: 0.65 }
  }
  if (classification.complexityScore > 0.6) {
    return { ...base, maxSteps: 6, maxSearchResults: 8, evidenceThreshold: 0.7 }
  }
  return base
}
