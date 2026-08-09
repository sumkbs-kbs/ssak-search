/**
 * Embedding Service — Custom Embedding Generation
 *
 * Supports multiple embedding models with query/passage separation.
 * Provides fallback chain: Custom fine-tuned → BGE-M3 → Built-in Workers AI.
 *
 * For Korean/Chinese queries, uses query/passage separation for better retrieval.
 */

import type { Env } from '../../types'
import { logger, toError } from '../../lib/logger'
import { EMBEDDING_MODELS, type EmbeddingModelConfig } from './types'

// ============================================================
// Types
// ============================================================

export interface EmbeddingRequest {
  /** Texts to embed */
  texts: string[]
  /** Model to use (defaults to best available for language) */
  model?: string
  /** Whether these are queries (vs passages) - for query/passage separation */
  isQuery?: boolean
  /** Language hint for model selection */
  language?: string
  /** Truncate to max tokens */
  truncate?: boolean
}

export interface EmbeddingResponse {
  /** Embeddings (one per input text) */
  embeddings: number[][]
  /** Model used */
  model: string
  /** Dimensions */
  dimensions: number
  /** Tokens used (approx) */
  tokensUsed: number
}

export interface EmbeddingServiceConfig {
  /** Preferred model name */
  preferredModel?: string
  /** Fallback models in order */
  fallbackModels?: string[]
  /** Default language */
  defaultLanguage?: string
  /** Enable query/passage separation when supported */
  useQueryPassageSeparation?: boolean
  /** Max batch size */
  maxBatchSize?: number
}

// ============================================================
// Embedding Service
// ============================================================

export class EmbeddingService {
  private config: Required<EmbeddingServiceConfig>
  private env?: Env

  constructor(config: EmbeddingServiceConfig = {}, env?: Env) {
    this.env = env
    this.config = {
      preferredModel: config.preferredModel ?? 'pplx-embed-v1-0.6b',
      fallbackModels: config.fallbackModels ?? ['bge-m3'],
      defaultLanguage: config.defaultLanguage ?? 'en',
      useQueryPassageSeparation: config.useQueryPassageSeparation ?? true,
      maxBatchSize: config.maxBatchSize ?? 32,
    }
  }

  /**
   * Generate embeddings for texts
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const { texts, model: requestedModel, isQuery = false, language, truncate = true } = request

    if (texts.length === 0) {
      return { embeddings: [], model: '', dimensions: 0, tokensUsed: 0 }
    }

    // Batch processing
    const batches = this.chunkArray(texts, this.config.maxBatchSize)
    const allEmbeddings: number[][] = []
    let totalTokens = 0
    let modelUsed = ''
    let dimensions = 0

    // Determine best model
    const model = this.selectModel(requestedModel, language, isQuery)

    for (const batch of batches) {
      const result = await this.embedBatch(batch, model, isQuery, language, truncate)
      allEmbeddings.push(...result.embeddings)
      totalTokens += result.tokensUsed
      if (!modelUsed) {
        modelUsed = result.model
        dimensions = result.dimensions
      }
    }

    return {
      embeddings: allEmbeddings,
      model: modelUsed,
      dimensions,
      tokensUsed: totalTokens,
    }
  }

  /**
   * Select best model based on language and query/passage separation support
   */
  private selectModel(requested?: string, language?: string, isQuery = false): string {
    // Use requested if available and valid
    if (requested && requested in EMBEDDING_MODELS) {
      return requested
    }

    const lang = language ?? this.config.defaultLanguage
    const models = Object.values(EMBEDDING_MODELS)

    // Prefer models supporting query/passage separation for queries
    if (isQuery && this.config.useQueryPassageSeparation) {
      const withSep = models.filter((m) => m.queryPassageSeparation && m.languages.includes(lang))
      if (withSep.length > 0) return withSep[0].name
    }

    // Prefer models supporting the language
    const withLang = models.filter((m) => m.languages.includes(lang))
    if (withLang.length > 0) return withLang[0].name

    // Fallback chain
    for (const fallback of this.config.fallbackModels) {
      if (fallback in EMBEDDING_MODELS) return fallback
    }

    return models[0].name
  }

  /**
   * Embed a batch of texts
   *
   * Fallback chain (first available provider wins):
   *   1. Workers AI    — Cloudflare production (env.AI binding)
   *   2. Ollama        — local-first setups (OLLAMA_BASE_URL, nomic-embed-text)
   *   3. Custom endpoint — fine-tuned/self-hosted models (EMBEDDING_ENDPOINT)
   *   4. Hash fallback  — deterministic pseudo-embeddings (dev/test only)
   *
   * Provider selection is environment-driven: Cloudflare uses Workers AI,
   * local dev uses Ollama. The active provider determines the embedding
   * space, so index-time and query-time MUST resolve to the same provider
   * — otherwise vectors are dimension-compatible but semantically mismatched.
   */
  private async embedBatch(
    texts: string[],
    modelName: string,
    _isQuery: boolean,
    _language?: string,
    truncate = true,
  ): Promise<EmbeddingResponse> {
    const modelConfig = EMBEDDING_MODELS[modelName]
    if (!modelConfig) {
      throw new Error(`Unknown embedding model: ${modelName}`)
    }

    // 1. Workers AI (Cloudflare production)
    if (this.env?.AI) {
      try {
        return await this.embedWithWorkersAI(texts, modelConfig, _isQuery, truncate)
      } catch (err) {
        logger.warn(`[EmbeddingService] Workers AI failed for ${modelName}:`, { error: toError(err) })
      }
    }

    // 2. Ollama (local-first). Uses nomic-embed-text (768-dim) regardless of
    //    the requested modelName — what matters is that the dimension matches
    //    the Vectorize index, and that index-time and query-time agree.
    if (this.env?.OLLAMA_BASE_URL) {
      try {
        return await this.embedWithOllama(texts, modelConfig, truncate)
      } catch (err) {
        logger.warn(`[EmbeddingService] Ollama failed for ${modelName}:`, { error: toError(err) })
      }
    }

    // 3. Custom endpoint (for fine-tuned models)
    try {
      return await this.embedWithCustomEndpoint(texts, modelConfig, truncate)
    } catch (err) {
      logger.warn(`[EmbeddingService] Custom endpoint failed for ${modelName}:`, { error: toError(err) })
    }

    // 4. Fallback: simple hash-based embedding (deterministic, no external deps)
    logger.warn(`[EmbeddingService] Using fallback hash embeddings for ${modelName}`)
    return this.fallbackHashEmbed(texts, modelConfig.dimensions)
  }

  /**
   * Embed using Workers AI
   */ private async embedWithWorkersAI(
    texts: string[],
    config: EmbeddingModelConfig,
    isQuery: boolean,
    truncate: boolean,
  ): Promise<EmbeddingResponse> {
    if (!this.env?.AI) throw new Error('Workers AI not available')

    const modelId = this.mapToWorkersAIModel(config.name)
    if (!modelId) throw new Error(`No Workers AI mapping for ${config.name}`)

    // Process in smaller batches for Workers AI
    const batchSize = Math.min(texts.length, 16)
    const allEmbeddings: number[][] = []
    let totalTokens = 0

    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize)
      const response = await this.env.AI.run(modelId, {
        inputs: batch,
        // Some models support query/passage separation
        ...(config.queryPassageSeparation && { is_query: isQuery }),
        truncate,
      })

      // Extract embeddings from response
      const embeddings = this.extractEmbeddings(response)
      allEmbeddings.push(...embeddings)
      totalTokens += batch.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0)
    }

    return {
      embeddings: allEmbeddings,
      model: config.name,
      dimensions: config.dimensions,
      tokensUsed: totalTokens,
    }
  }

  /**
   * Embed using custom fine-tuned endpoint
   */
  private async embedWithCustomEndpoint(
    texts: string[],
    config: EmbeddingModelConfig,
    truncate: boolean,
  ): Promise<EmbeddingResponse> {
    // This would call your fine-tuned model endpoint
    // Example: https://api.your-domain.com/embed
    // Requires EMBEDDING_ENDPOINT and EMBEDDING_API_KEY secrets

    const endpoint = this.env?.EMBEDDING_ENDPOINT
    const apiKey = this.env?.EMBEDDING_API_KEY

    if (!endpoint || !apiKey) {
      throw new Error('Custom embedding endpoint not configured')
    }

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        texts,
        model: config.name,
        is_query: false,
        truncate,
      }),
    })

    if (!response.ok) {
      throw new Error(`Custom embedding endpoint returned ${response.status}`)
    }

    const data = (await response.json()) as { embeddings: number[][]; model: string; dimensions: number }

    return {
      embeddings: data.embeddings,
      model: data.model,
      dimensions: data.dimensions,
      tokensUsed: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
    }
  }

  /**
   * Embed using a local Ollama instance (nomic-embed-text).
   *
   * Local-first setups have no Workers AI binding, so this is the primary
   * embedding provider when OLLAMA_BASE_URL is set. Ollama exposes an
   * OpenAI-compatible /v1/embeddings endpoint, returning:
   *   { data: [{ embedding: number[] }] }
   *
   * We always use `nomic-embed-text` (768-dim) here regardless of the
   * requested model — the dimension is what matters for Vectorize
   * compatibility, and nomic-embed-text matches the configured index.
   * The caller's modelConfig.dimensions is authoritative for the response.
   */
  private async embedWithOllama(
    texts: string[],
    config: EmbeddingModelConfig,
    _truncate: boolean,
  ): Promise<EmbeddingResponse> {
    const base = this.env?.OLLAMA_BASE_URL
    if (!base) throw new Error('OLLAMA_BASE_URL not configured')

    // Normalize to the /v1 OpenAI-compatible API (matches llm-router pattern).
    const baseUrl = base.replace(/\/+$/, '').includes('/v1')
      ? base.replace(/\/+$/, '')
      : `${base.replace(/\/+$/, '')}/v1`

    const OLLAMA_EMBED_MODEL = 'nomic-embed-text'
    // Process in batches of 32 (Ollama handles larger batches, but keep sane).
    const BATCH = 32
    const allEmbeddings: number[][] = []

    for (let i = 0; i < texts.length; i += BATCH) {
      const batch = texts.slice(i, i + BATCH)
      const response = await fetch(`${baseUrl}/embeddings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: OLLAMA_EMBED_MODEL,
          input: batch,
        }),
        signal: AbortSignal.timeout(30_000),
      })

      if (!response.ok) {
        const errText = await response.text().catch(() => '')
        throw new Error(`Ollama embeddings API ${response.status}: ${errText || response.statusText}`)
      }

      const data = (await response.json()) as { data?: Array<{ embedding?: number[] }> }
      const embeddings = this.extractEmbeddings(data)
      if (embeddings.length !== batch.length) {
        throw new Error(`Ollama returned ${embeddings.length} embeddings for ${batch.length} inputs`)
      }
      allEmbeddings.push(...embeddings)
    }

    return {
      embeddings: allEmbeddings,
      model: OLLAMA_EMBED_MODEL,
      // config.dimensions is authoritative (768 for nomic-embed-text).
      // We trust it over the raw response so the Vectorize index dimensions
      // stay consistent with EMBEDDING_MODELS.
      dimensions: config.dimensions,
      tokensUsed: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
    }
  }

  /**
   * Fallback: deterministic hash-based embeddings
   * Useful for development/testing when no external embedding service available
   */
  private fallbackHashEmbed(texts: string[], dimensions: number): EmbeddingResponse {
    const embeddings: number[][] = []

    for (const text of texts) {
      // Simple hash-based embedding (deterministic, no ML)
      const hash = this.stringHash(text)
      const embedding = new Array(dimensions)

      for (let i = 0; i < dimensions; i++) {
        // Use different parts of hash for each dimension
        const seed = (hash + i * 0x9e3779b9) >>> 0
        // Convert to [-1, 1] range
        embedding[i] = (seed % 10000) / 5000 - 1
      }

      // Normalize to unit length
      const norm = Math.sqrt(embedding.reduce((sum, v) => sum + v * v, 0))
      embeddings.push(embedding.map((v) => v / (norm || 1)))
    }

    return {
      embeddings,
      model: 'fallback-hash',
      dimensions,
      tokensUsed: texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0),
    }
  }

  private stringHash(str: string): number {
    let hash = 0
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash // Convert to 32bit integer
    }
    return hash >>> 0
  }

  private mapToWorkersAIModel(modelName: string): string | null {
    const mapping: Record<string, string> = {
      'pplx-embed-v1-0.6b': '@cf/baai/bge-base-en-v1.5',
      'bge-m3': '@cf/baai/bge-base-en-v1.5',
    }
    return mapping[modelName] ?? '@cf/baai/bge-base-en-v1.5'
  }

  private extractEmbeddings(response: unknown): number[][] {
    if (Array.isArray(response)) {
      return response as number[][]
    }
    if (response && typeof response === 'object') {
      const r = response as Record<string, unknown>
      if (Array.isArray(r.data)) {
        return r.data.map((d: unknown) => {
          if (typeof d === 'object' && d !== null && 'embedding' in d) {
            return (d as { embedding: number[] }).embedding
          }
          return d as number[]
        })
      }
      if (Array.isArray(r.embeddings)) {
        return r.embeddings as number[][]
      }
    }
    throw new Error('Unexpected embedding response format')
  }

  private chunkArray<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
      chunks.push(arr.slice(i, i + size))
    }
    return chunks
  }
}

// ============================================================
// Convenience function
// ============================================================

export async function createEmbeddings(
  texts: string[],
  options: {
    model?: string
    isQuery?: boolean
    language?: string
    env?: Env
  } = {},
): Promise<number[][]> {
  const service = new EmbeddingService({}, options.env)
  const result = await service.embed({
    texts,
    model: options.model,
    isQuery: options.isQuery,
    language: options.language,
  })
  return result.embeddings
}
