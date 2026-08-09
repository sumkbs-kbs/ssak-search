/**
 * Query Understanding Module — Entry Point
 *
 * Provides multi-dimensional query understanding:
 * - Intent, sub-type, script classification
 * - Named entity recognition
 * - LLM-enhanced understanding (when Workers AI available)
 */

export { classifyUnderstanding, classifyUnderstandingWithAI, detectScript } from './classifier'

export type {
  UnderstandingResult,
  LLMEnhancedResult,
  LLMEntity,
  SearchIntent,
  QuerySubType,
  ScriptType,
} from './classifier'

export { extractEntities, extractEntityHints, extractKeyTerms } from './entity-extractor'

export type { ExtractedEntity, ExtractionResult, EntityType } from './entity-extractor'

export { decomposeQuery } from './decomposer'

export type { DecomposedQuery } from './decomposer'
