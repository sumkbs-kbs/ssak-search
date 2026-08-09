import { logger, toError } from './logger'
/**
 * LLM Router — Multi-Model Routing & Cost Control
 *
 * Manages a registry of available LLM models with cost estimates,
 * provides smart routing based on availability/cost/quality constraints,
 * tracks cost per request for budget control.
 *
 * Providers:
 *   - openai:    GPT-4o, GPT-4o-mini (requires OPENAI_API_KEY)
 *   - anthropic: Claude 3.5 Haiku, Claude 3 Haiku (requires ANTHROPIC_API_KEY)
 *   - ollama:    Local models via Ollama (Qwen 3.6 35B, Gemma 2 9B, etc.)
 *                (requires OLLAMA_BASE_URL, default: http://localhost:11434)
 *   - workers-ai: Llama 3.1 8B, Mistral 7B (requires AI binding)
 *   - extractive: Keyword-based fallback (always available)
 */

export type LLMProvider = 'openai' | 'anthropic' | 'ollama' | 'workers-ai' | 'openrouter' | 'extractive'
export type LLMTier = 'premium' | 'standard' | 'budget' | 'free'

export interface ModelConfig {
  /** Model identifier used in API calls */
  id: string
  /** Provider name */
  provider: LLMProvider
  /** Quality/cost tier */
  tier: LLMTier
  /** USD per 1K output tokens */
  costPer1KOutput: number
  /** USD per 1K input tokens */
  costPer1KInput: number
  /** Max output tokens supported */
  maxTokens: number
  /** Whether the model supports streaming */
  supportsStreaming: boolean
  /** Estimated quality 0-1 */
  quality: number
  /** Estimated median latency in ms */
  latencyP50Ms: number
  /** Human-readable label */
  label: string
  /** Required env var or binding name to check availability */
  requiredKey?: string
}

/**
 * Full model registry with cost estimates.
 * Ordered by quality tier (premium → free) for routing.
 */
export const MODEL_REGISTRY: ModelConfig[] = [
  // ── Premium Tier ──
  {
    id: 'gpt-4o',
    provider: 'openai',
    tier: 'premium',
    costPer1KOutput: 0.015,
    costPer1KInput: 0.005,
    maxTokens: 4096,
    supportsStreaming: true,
    quality: 0.95,
    latencyP50Ms: 2000,
    label: 'GPT-4o',
    requiredKey: 'OPENAI_API_KEY',
  },
  // ── Local Ollama Tier (무료, 로컬 실행) ──
  {
    id: 'hf.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive:Q6_K_P',
    provider: 'ollama',
    tier: 'standard',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 8192,
    supportsStreaming: true,
    quality: 0.88,
    latencyP50Ms: 150,
    label: 'Qwen 3.6 35B-A3B (Local, MoE)',
    requiredKey: 'OLLAMA_BASE_URL',
  },
  {
    id: 'gemma2:27b',
    provider: 'ollama',
    tier: 'standard',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 8192,
    supportsStreaming: true,
    quality: 0.85,
    latencyP50Ms: 200,
    label: 'Gemma 2 27B (Local)',
    requiredKey: 'OLLAMA_BASE_URL',
  },
  {
    id: 'gemma2:9b',
    provider: 'ollama',
    tier: 'budget',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 8192,
    supportsStreaming: true,
    quality: 0.72,
    latencyP50Ms: 100,
    label: 'Gemma 2 9B (Local)',
    requiredKey: 'OLLAMA_BASE_URL',
  },
  {
    id: 'qwen2.5:7b',
    provider: 'ollama',
    tier: 'budget',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 8192,
    supportsStreaming: true,
    quality: 0.68,
    latencyP50Ms: 80,
    label: 'Qwen 2.5 7B (Local)',
    requiredKey: 'OLLAMA_BASE_URL',
  },
  {
    id: 'llava:latest',
    provider: 'ollama',
    tier: 'budget',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 4096,
    supportsStreaming: true,
    quality: 0.5,
    latencyP50Ms: 150,
    label: 'LLaVA 7B (Local, Vision)',
    requiredKey: 'OLLAMA_BASE_URL',
  },
  // ── OpenRouter Free Tier (external API, no CPU cost) ──
  // OpenRouter provides free access to strong models. API is 100% OpenAI-compatible.
  // Key benefit: external HTTP calls don't consume Workers CPU time (unlike Workers AI),
  // so answer generation works even on the free Cloudflare plan.
  // Get a free API key at https://openrouter.ai/keys
  {
    id: 'nvidia/nemotron-3-ultra-550b-a55b:free',
    provider: 'openrouter',
    tier: 'standard',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 8192,
    supportsStreaming: true,
    quality: 0.92,
    latencyP50Ms: 3000,
    label: 'Nemotron 3 Ultra 550B (Free)',
    requiredKey: 'OPENROUTER_API_KEY',
  },
  // ── Standard Tier ──
  {
    id: 'gpt-4o-mini',
    provider: 'openai',
    tier: 'standard',
    costPer1KOutput: 0.0006,
    costPer1KInput: 0.00015,
    maxTokens: 16384,
    supportsStreaming: true,
    quality: 0.85,
    latencyP50Ms: 800,
    label: 'GPT-4o Mini',
    requiredKey: 'OPENAI_API_KEY',
  },
  {
    id: 'claude-3-5-haiku',
    provider: 'anthropic',
    tier: 'standard',
    costPer1KOutput: 0.00125,
    costPer1KInput: 0.0008,
    maxTokens: 8192,
    supportsStreaming: true,
    quality: 0.87,
    latencyP50Ms: 1200,
    label: 'Claude 3.5 Haiku',
    requiredKey: 'ANTHROPIC_API_KEY',
  },
  {
    id: 'claude-3-haiku',
    provider: 'anthropic',
    tier: 'standard',
    costPer1KOutput: 0.00025,
    costPer1KInput: 0.00025,
    maxTokens: 4096,
    supportsStreaming: true,
    quality: 0.8,
    latencyP50Ms: 1000,
    label: 'Claude 3 Haiku',
    requiredKey: 'ANTHROPIC_API_KEY',
  },
  // ── Budget Tier (free, Workers AI) ──
  {
    id: '@cf/meta/llama-3.1-8b-instruct',
    provider: 'workers-ai',
    tier: 'budget',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 4096,
    supportsStreaming: true,
    quality: 0.55,
    latencyP50Ms: 400,
    label: 'Llama 3.1 8B (Free)',
    requiredKey: 'AI_BINDING',
  },
  {
    id: '@cf/meta/llama-3.2-3b-instruct',
    provider: 'workers-ai',
    tier: 'budget',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 4096,
    supportsStreaming: true,
    quality: 0.45,
    latencyP50Ms: 300,
    label: 'Llama 3.2 3B (Free)',
    requiredKey: 'AI_BINDING',
  },
  {
    id: '@cf/mistral/mistral-7b-instruct-v0.1',
    provider: 'workers-ai',
    tier: 'budget',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 4096,
    supportsStreaming: true,
    quality: 0.5,
    latencyP50Ms: 350,
    label: 'Mistral 7B (Free)',
    requiredKey: 'AI_BINDING',
  },
  // ── Free Tier (extractive, no model needed) ──
  {
    id: 'extractive',
    provider: 'extractive',
    tier: 'free',
    costPer1KOutput: 0,
    costPer1KInput: 0,
    maxTokens: 2000,
    supportsStreaming: false,
    quality: 0.3,
    latencyP50Ms: 50,
    label: 'Extractive Summary (Free)',
  },
]

/**
 * Runtime cost tracking for a single request.
 */
export interface CostTracking {
  /** Model ID used */
  modelId: string
  /** Model label */
  modelLabel: string
  /** Provider name */
  provider: LLMProvider
  /** Quality tier used */
  tier: LLMTier
  /** Estimated input tokens */
  inputTokens: number
  /** Estimated output tokens */
  outputTokens: number
  /** Estimated cost in USD */
  estimatedCostUSD: number
  /** Actual latency in ms */
  latencyMs: number
  /** Whether the request succeeded */
  success: boolean
}

/**
 * Check which models are available based on configured API keys/bindings.
 * When OLLAMA_BASE_URL is set, auto-discovers installed models via /api/tags
 * and dynamically adds them to the available set — no more hardcoded model guessing.
 */
export async function getAvailableModels(env?: {
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  OLLAMA_BASE_URL?: string
  OPENROUTER_API_KEY?: string
  AI?: unknown
}): Promise<ModelConfig[]> {
  // Non-Ollama models: filter by available env keys/bindings
  const nonOllamaModels = MODEL_REGISTRY.filter((m) => {
    if (m.provider === 'ollama') return false // handled separately below
    if (m.requiredKey === 'AI_BINDING') return !!env?.AI
    if (m.requiredKey === 'OPENAI_API_KEY') return !!env?.OPENAI_API_KEY
    if (m.requiredKey === 'ANTHROPIC_API_KEY') return !!env?.ANTHROPIC_API_KEY
    if (m.requiredKey === 'OPENROUTER_API_KEY') return !!env?.OPENROUTER_API_KEY
    if (m.provider === 'extractive') return true
    return true
  })

  // Ollama models: auto-discover via /api/tags when OLLAMA_BASE_URL is set
  if (env?.OLLAMA_BASE_URL) {
    const baseUrl = getOllamaBaseUrl(env)
    const discovered = await discoverOllamaModels(baseUrl)

    if (discovered.length > 0) {
      // Blend discovered models with hardcoded registry for hand-tuned quality scores
      const seenIds = new Set<string>()
      const ollamaModels: ModelConfig[] = []

      for (const model of discovered) {
        if (!seenIds.has(model.id)) {
          const registryEntry = MODEL_REGISTRY.find((m) => m.id === model.id)
          if (registryEntry) {
            // Use hand-tuned quality/tier for known models
            ollamaModels.push({ ...model, quality: registryEntry.quality, tier: registryEntry.tier })
          } else {
            // Use auto-estimated quality for unknown models
            ollamaModels.push(model)
          }
          seenIds.add(model.id)
        }
      }

      return [...ollamaModels, ...nonOllamaModels]
    }

    // Discovery failed but URL is set — include hardcoded Ollama models as best-effort
    logger.warn('[Ollama Discovery] Failed to discover models, using hardcoded fallback')
    const hardcodedOllama = MODEL_REGISTRY.filter((m) => m.provider === 'ollama')
    return [...hardcodedOllama, ...nonOllamaModels]
  }

  // No OLLAMA_BASE_URL — exclude all Ollama models
  return nonOllamaModels
}

/**
 * Resolve the Ollama base URL from env or default to localhost.
 */
export function getOllamaBaseUrl(env?: { OLLAMA_BASE_URL?: string }): string {
  // Ollama의 OpenAI 호환 API는 /v1/chat/completions
  // 기본 URL에 /v1을 포함시켜 반환
  const base = env?.OLLAMA_BASE_URL?.replace(/\/+$/, '') || 'http://localhost:11434'
  return base.includes('/v1') ? base : `${base}/v1`
}

/**
 * Select the best available model based on various constraints.
 */
export function selectBestModel(
  availableModels: ModelConfig[],
  options: {
    requireStreaming?: boolean
    minQuality?: number
    maxCostPerRequestUSD?: number
    preferTier?: LLMTier
  } = {},
): ModelConfig {
  let candidates = [...availableModels]

  if (options.requireStreaming) {
    candidates = candidates.filter((m) => m.supportsStreaming)
  }

  const minQ = options.minQuality
  if (minQ !== undefined) {
    candidates = candidates.filter((m) => m.quality >= minQ)
  }

  if (options.maxCostPerRequestUSD !== undefined) {
    const maxCost = options.maxCostPerRequestUSD
    candidates = candidates.filter((m) => {
      const estimatedOutputTokens = 600
      const estimatedInputTokens = 2000
      const cost = (estimatedInputTokens / 1000) * m.costPer1KInput + (estimatedOutputTokens / 1000) * m.costPer1KOutput
      return cost <= maxCost
    })
  }

  if (options.preferTier) {
    const tierCandidates = candidates.filter((m) => m.tier === options.preferTier)
    if (tierCandidates.length > 0) {
      candidates = tierCandidates
    }
  }

  candidates.sort((a, b) => {
    if (b.quality !== a.quality) return b.quality - a.quality
    return a.latencyP50Ms - b.latencyP50Ms
  })

  return candidates[0] || MODEL_REGISTRY[MODEL_REGISTRY.length - 1]
}

/**
 * Compute estimated cost for a model run.
 */
export function estimateCost(model: ModelConfig, inputTokens: number, outputTokens: number): number {
  return (inputTokens / 1000) * model.costPer1KInput + (outputTokens / 1000) * model.costPer1KOutput
}

/**
 * Rough token estimation: ~1.3 tokens per word for English, ~2.5 for CJK.
 */
export function estimateTokenCount(text: string): number {
  const cjkCount = (text.match(/[\u4e00-\u9fff\uac00-\ud7af]/g) || []).length
  const wordCount = text.split(/\s+/).filter(Boolean).length
  return Math.ceil(wordCount * 1.3 + cjkCount * 2.5)
}

export interface RouterResult<T> {
  model: ModelConfig
  cost: CostTracking
  result: T
  attempts: CostTracking[]
}

/**
 * Build a routing fallback chain from available models.
 * Sorted by tier: premium → standard → budget → free.
 */
export function buildFallbackChain(availableModels: ModelConfig[]): ModelConfig[] {
  const tierOrder: LLMTier[] = ['premium', 'standard', 'budget', 'free']
  const sorted = [...availableModels].sort((a, b) => {
    const aIdx = tierOrder.indexOf(a.tier)
    const bIdx = tierOrder.indexOf(b.tier)
    if (aIdx !== bIdx) return aIdx - bIdx
    return b.quality - a.quality
  })
  return sorted
}

// ============================================================
// Ollama Model Auto-Discovery
// ============================================================

interface OllamaModelTag {
  name: string
  size: number
  digest: string
  details?: {
    parameter_size?: string
    quantization_level?: string
    families?: string[]
  }
}

// Module-level cache for discovered models to avoid repeated /api/tags calls
let discoveredModelsCache: { models: ModelConfig[]; timestamp: number } | null = null
const DISCOVERY_CACHE_TTL = 60_000 // 60 seconds

/**
 * Auto-discover installed Ollama models via the /api/tags endpoint.
 * Dynamically creates ModelConfig entries for each installed model
 * with quality scores estimated from parameter count and model name.
 *
 * Results are cached for DISCOVERY_CACHE_TTL to avoid repeated API calls.
 */
export async function discoverOllamaModels(baseUrl: string): Promise<ModelConfig[]> {
  // Check cache
  if (discoveredModelsCache && Date.now() - discoveredModelsCache.timestamp < DISCOVERY_CACHE_TTL) {
    return discoveredModelsCache.models
  }

  try {
    // Ollama /api/tags lives at the root, not under /v1
    const rootUrl = baseUrl.replace(/\/v1\/?$/, '')
    const response = await fetch(`${rootUrl}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      logger.warn(`[Ollama Discovery] /api/tags returned ${response.status}`)
      return []
    }

    const data = (await response.json()) as { models?: OllamaModelTag[] }
    if (!data.models || data.models.length === 0) return []

    const models = data.models
      .filter((m) => {
        const name = m.name.toLowerCase()
        // Skip embedding-only models (unusable for text generation)
        return !name.includes('embed') && !name.includes('nomic')
      })
      .map((m) => {
        const paramCount = extractParamCount(m)
        const quality = estimateModelQuality(paramCount)
        const tier = estimateModelTier(paramCount)
        return {
          id: m.name,
          provider: 'ollama' as LLMProvider,
          tier,
          costPer1KOutput: 0,
          costPer1KInput: 0,
          maxTokens: paramCount >= 10 ? 8192 : 4096,
          supportsStreaming: true,
          quality,
          latencyP50Ms: estimateLatency(paramCount),
          label: formatModelLabel(m.name, paramCount),
          requiredKey: 'OLLAMA_BASE_URL',
        }
      })
      .sort((a, b) => b.quality - a.quality)

    // Update cache
    discoveredModelsCache = { models, timestamp: Date.now() }
    return models
  } catch (err) {
    logger.warn('[Ollama Discovery] Failed to fetch /api/tags:', { error: toError(err) })
    return []
  }
}

/**
 * Extract parameter count from Ollama model metadata.
 * Tries details.parameter_size first, then model name, then estimates from file size.
 */
function extractParamCount(model: OllamaModelTag): number {
  // 1. Most reliable: details.parameter_size (e.g., "35.2B", "7B")
  if (model.details?.parameter_size) {
    const match = model.details.parameter_size.match(/(\d+(?:\.\d+)?)\s*([bB])/)
    if (match) return Math.round(parseFloat(match[1]))
  }

  // 2. Extract from model name (e.g., "35B", "70b", "7b")
  const nameMatch = model.name.match(/(\d+(?:\.\d+)?)([bB])/)
  if (nameMatch) return Math.round(parseFloat(nameMatch[1]))

  // 3. Estimate from file size (typically ~0.5-0.8 GB per 1B params for quantized)
  const sizeGB = model.size / (1024 * 1024 * 1024)
  return Math.round(sizeGB / 0.65) // rough Q4/Q5 quantized average
}

/**
 * Estimate model quality (0-1) from parameter count.
 * Higher params → higher quality, with diminishing returns.
 */
function estimateModelQuality(paramCount: number): number {
  if (paramCount >= 100) return Math.min(0.95, 0.8 + (paramCount - 100) * 0.002)
  if (paramCount >= 70) return 0.88
  if (paramCount >= 30) return 0.82
  if (paramCount >= 20) return 0.75
  if (paramCount >= 10) return 0.65
  if (paramCount >= 7) return 0.58
  if (paramCount >= 3) return 0.48
  return 0.35
}

/**
 * Estimate model tier from parameter count.
 */
function estimateModelTier(paramCount: number): LLMTier {
  if (paramCount >= 20) return 'standard'
  if (paramCount >= 3) return 'budget'
  return 'free'
}

/**
 * Estimate median latency (ms) from parameter count.
 * Smaller models are faster.
 */
function estimateLatency(paramCount: number): number {
  if (paramCount >= 70) return 500
  if (paramCount >= 30) return 250
  if (paramCount >= 10) return 150
  if (paramCount >= 3) return 80
  return 50
}

/**
 * Format a user-friendly model label from the Ollama model name.
 * Strips hf.co/ prefix and GGUF quantization suffixes for readability.
 */
function formatModelLabel(name: string, paramCount: number): string {
  // Remove hf.co/ prefix for readability
  let label = name.replace(/^hf\.co\//, '')
  // Remove GGUF quantization suffix (e.g., :Q6_K_P)
  label = label.replace(/:[A-Za-z0-9_]+$/, '')
  // Truncate if too long
  if (label.length > 40) {
    const parts = label.split('/')
    label = parts[parts.length - 1] || label.substring(0, 40)
  }
  // Add param count if not already in label
  if (!label.toLowerCase().includes(`${paramCount}b`)) {
    label += ` (${paramCount}B)`
  }
  return label
}

// ============================================================
// Streaming Implementations
// ============================================================

/**
 * Generic OpenAI-compatible streaming SSE parser.
 * Used by streamOpenAI, streamOllama, and any other OpenAI-compatible API.
 *
 * Ollama is 100% OpenAI-compatible, so this function works for both
 * OpenAI API and local Ollama instances — only the base URL differs.
 */
async function* streamOpenAICompatible(
  baseUrl: string,
  apiKey: string | undefined,
  prompt: string,
  systemMsg: string,
  options: {
    model?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  } = {},
): AsyncGenerator<string, CostTracking, undefined> {
  const model = options.model || 'gpt-4o-mini'
  const maxTokens = options.maxTokens || 600
  const temperature = options.temperature ?? 0.3

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  }
  // OpenAI requires Bearer token; Ollama ignores it but accepts it
  if (apiKey) {
    headers['Authorization'] = `Bearer ${apiKey}`
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature,
      stream: true,
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`Ollama/OpenAI API error ${response.status}: ${errText || response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Streaming response body is null')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let outputTokens = 0
  let inputTokens = 0
  let totalContent = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data === '[DONE]') break

          try {
            const parsed = JSON.parse(data)
            const delta = parsed.choices?.[0]?.delta
            const finishReason = parsed.choices?.[0]?.finish_reason

            if (delta?.content) {
              yield delta.content
              totalContent += delta.content
              outputTokens++
            }

            if (finishReason === 'stop') {
              if (parsed.usage) {
                inputTokens = parsed.usage.prompt_tokens || 0
                outputTokens = parsed.usage.completion_tokens || 0
              } else {
                inputTokens = estimateTokenCount(prompt + systemMsg)
                outputTokens = estimateTokenCount(totalContent)
              }
            }
          } catch (err) {
            logger.debug('[LLMRouter] Non-JSON SSE line (expected):', { error: toError(err) })
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (inputTokens === 0) {
    inputTokens = estimateTokenCount(prompt + systemMsg)
    outputTokens = estimateTokenCount(totalContent)
  }

  const modelConfig = MODEL_REGISTRY.find((m) => m.id === model) || MODEL_REGISTRY[MODEL_REGISTRY.length - 1]
  return {
    modelId: model,
    modelLabel: modelConfig.label,
    provider: modelConfig.provider,
    tier: modelConfig.tier,
    inputTokens,
    outputTokens,
    estimatedCostUSD: estimateCost(modelConfig, inputTokens, outputTokens),
    latencyMs: 0,
    success: true,
  }
}

/**
 * Stream from OpenAI API.
 * Uses the generic OpenAI-compatible streaming parser with OpenAI's base URL.
 */
export async function* streamOpenAI(
  apiKey: string,
  prompt: string,
  systemMsg: string,
  options: {
    model?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  } = {},
): AsyncGenerator<string, CostTracking, undefined> {
  return yield* streamOpenAICompatible('https://api.openai.com/v1', apiKey, prompt, systemMsg, options)
}

/**
 * Stream from local Ollama instance.
 * Uses the generic OpenAI-compatible streaming parser with Ollama's base URL.
 * Ollama exposes /v1/chat/completions which is 100% OpenAI-compatible.
 *
 * No API key needed — Ollama runs locally. Pass empty string.
 */
export async function* streamOllama(
  baseUrl: string,
  prompt: string,
  systemMsg: string,
  options: {
    model?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  } = {},
): AsyncGenerator<string, CostTracking, undefined> {
  return yield* streamOpenAICompatible(
    baseUrl,
    undefined, // Ollama doesn't need API key
    prompt,
    systemMsg,
    options,
  )
}

/**
 * Stream from OpenRouter (free models).
 * OpenRouter is 100% OpenAI-compatible, so we reuse streamOpenAICompatible
 * with the OpenRouter base URL and API key.
 *
 * Key benefit: OpenRouter calls are external HTTP requests that DON'T consume
 * Workers CPU time — so answer generation works even on the free Cloudflare plan
 * (unlike Workers AI which hits the 10ms CPU limit).
 *
 * Free models available: DeepSeek R1, Qwen3 235B, Llama 4 Scout, etc.
 * Get a free API key at https://openrouter.ai/keys
 */
export async function* streamOpenRouter(
  apiKey: string,
  prompt: string,
  systemMsg: string,
  options: {
    model?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  } = {},
): AsyncGenerator<string, CostTracking, undefined> {
  return yield* streamOpenAICompatible('https://openrouter.ai/api/v1', apiKey, prompt, systemMsg, options)
}

/**
 * Generate answer using Ollama (synchronous, non-streaming).
 * Makes a POST to Ollama's OpenAI-compatible /v1/chat/completions.
 */
export async function generateOllamaAnswer(
  baseUrl: string,
  prompt: string,
  systemMsg: string,
  modelId: string,
  maxTokens = 600,
): Promise<string> {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`Ollama API error ${response.status}: ${errText || response.statusText}`)
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text || text.length < 10) throw new Error('Ollama returned empty response')
  return text
}

/**
 * Generate answer using OpenRouter (synchronous, non-streaming).
 * Uses OpenRouter's OpenAI-compatible /api/v1/chat/completions endpoint.
 * Free models (e.g. deepseek-r1:free, qwen3-235b:free) cost $0.
 */
export async function generateOpenRouterAnswer(
  apiKey: string,
  prompt: string,
  systemMsg: string,
  modelId: string,
  maxTokens = 600,
): Promise<string> {
  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    signal: AbortSignal.timeout(10_000), // 10s cap — prevents indefinite hang on slow free models
    body: JSON.stringify({
      model: modelId,
      messages: [
        { role: 'system', content: systemMsg },
        { role: 'user', content: prompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.3,
      stream: false,
    }),
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`OpenRouter API error ${response.status}: ${errText || response.statusText}`)
  }

  const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  const text = data.choices?.[0]?.message?.content?.trim()
  if (!text || text.length < 10) throw new Error('OpenRouter returned empty response')
  return text
}

/**
 * Parse Anthropic streaming SSE chunks into text tokens.
 */
export async function* streamAnthropic(
  apiKey: string,
  prompt: string,
  systemMsg: string,
  options: {
    model?: string
    maxTokens?: number
    temperature?: number
    signal?: AbortSignal
  } = {},
): AsyncGenerator<string, CostTracking, undefined> {
  const model = options.model || 'claude-3-5-haiku-20241022'
  const maxTokens = options.maxTokens || 600
  const temperature = options.temperature ?? 0.3

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      temperature,
      system: systemMsg,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
    }),
    signal: options.signal,
  })

  if (!response.ok) {
    const errText = await response.text().catch(() => '')
    throw new Error(`Anthropic API error ${response.status}: ${errText || response.statusText}`)
  }

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Anthropic streaming response body is null')
  }

  const decoder = new TextDecoder()
  let buffer = ''
  let outputTokens = 0
  let inputTokens = 0
  let totalContent = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      for (const line of lines) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (!data) continue

          try {
            const parsed = JSON.parse(data)
            const eventType = parsed.type

            if (eventType === 'content_block_delta') {
              const text = parsed.delta?.text
              if (text) {
                yield text
                totalContent += text
                outputTokens++
              }
            } else if (eventType === 'message_start') {
              if (parsed.message?.usage) {
                inputTokens = parsed.message.usage.input_tokens || 0
              }
            } else if (eventType === 'message_delta') {
              if (parsed.usage) {
                outputTokens = parsed.usage.output_tokens || 0
              } else if (parsed.delta?.usage) {
                outputTokens = parsed.delta.usage.output_tokens || 0
              }
            }
          } catch (err) {
            logger.debug('[LLMRouter] Non-JSON SSE line (expected):', { error: toError(err) })
          }
        }
      }
    }
  } finally {
    reader.releaseLock()
  }

  if (inputTokens === 0) {
    inputTokens = estimateTokenCount(prompt + systemMsg)
  }
  if (outputTokens === 0) {
    outputTokens = estimateTokenCount(totalContent)
  }

  const modelConfig =
    MODEL_REGISTRY.find((m) => m.id === model || m.id.includes('claude')) || MODEL_REGISTRY[MODEL_REGISTRY.length - 1]
  return {
    modelId: model,
    modelLabel: modelConfig.label,
    provider: 'anthropic',
    tier: modelConfig.tier,
    inputTokens,
    outputTokens,
    estimatedCostUSD: estimateCost(modelConfig, inputTokens, outputTokens),
    latencyMs: 0,
    success: true,
  }
}
