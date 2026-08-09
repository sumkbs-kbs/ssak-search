/**
 * Unit tests for LLM Router (src/lib/llm-router.ts)
 *
 * Tests pure functions: MODEL_REGISTRY, getAvailableModels, buildFallbackChain,
 * selectBestModel, estimateTokenCount, estimateCost, getOllamaBaseUrl, discoverOllamaModels
 */

import { describe, it, expect, vi } from 'vitest'

async function getModule() {
  return await import('../../src/lib/llm-router')
}

// ============================================================
// MODEL_REGISTRY
// ============================================================
describe('MODEL_REGISTRY', () => {
  it('contains at least one model from each provider', async () => {
    const mod = await getModule()
    const providers = new Set(mod.MODEL_REGISTRY.map((m: any) => m.provider))
    expect(providers.has('openai')).toBe(true)
    expect(providers.has('anthropic')).toBe(true)
    expect(providers.has('ollama')).toBe(true)
    expect(providers.has('workers-ai')).toBe(true)
    expect(providers.has('extractive')).toBe(true)
  })

  it('contains models in correct tier order', async () => {
    const mod = await getModule()
    const tiers = mod.MODEL_REGISTRY.map((m: any) => m.tier)
    expect(tiers[0]).toBe('premium')
    expect(tiers[tiers.length - 1]).toBe('free')
  })

  it('every model has required fields', async () => {
    const mod = await getModule()
    for (const m of mod.MODEL_REGISTRY) {
      expect(typeof m.id).toBe('string')
      expect(m.id.length).toBeGreaterThan(0)
      expect(typeof m.provider).toBe('string')
      expect(typeof m.tier).toBe('string')
      expect(typeof m.quality).toBe('number')
      expect(m.quality).toBeGreaterThanOrEqual(0)
      expect(m.quality).toBeLessThanOrEqual(1)
      expect(typeof m.maxTokens).toBe('number')
      expect(m.maxTokens).toBeGreaterThan(0)
      expect(typeof m.costPer1KOutput).toBe('number')
      expect(typeof m.costPer1KInput).toBe('number')
    }
  })

  it('extractive model has quality 0.3 and zero cost', async () => {
    const mod = await getModule()
    const extractive = mod.MODEL_REGISTRY.find((m: any) => m.provider === 'extractive')
    expect(extractive).toBeDefined()
    if (!extractive) return
    expect(extractive.quality).toBe(0.3)
    expect(extractive.costPer1KOutput).toBe(0)
    expect(extractive.costPer1KInput).toBe(0)
  })
})

// ============================================================
// getAvailableModels
// ============================================================
describe('getAvailableModels', () => {
  it('returns extractive model even with no env keys', async () => {
    const mod = await getModule()
    const models = await mod.getAvailableModels({})
    const extractive = models.find((m: any) => m.provider === 'extractive')
    expect(extractive).toBeDefined()
  })

  it('includes openai models when OPENAI_API_KEY is set', async () => {
    const mod = await getModule()
    const models = await mod.getAvailableModels({ OPENAI_API_KEY: 'sk-test123' })
    const openaiModels = models.filter((m: any) => m.provider === 'openai')
    expect(openaiModels.length).toBeGreaterThan(0)
  })

  it('excludes openai models when OPENAI_API_KEY is missing', async () => {
    const mod = await getModule()
    const models = await mod.getAvailableModels({})
    const openaiModels = models.filter((m: any) => m.provider === 'openai')
    expect(openaiModels.length).toBe(0)
  })

  it('includes workers-ai models when AI binding is present', async () => {
    const mod = await getModule()
    const models = await mod.getAvailableModels({ AI: {} as any })
    const workersModels = models.filter((m: any) => m.provider === 'workers-ai')
    expect(workersModels.length).toBeGreaterThan(0)
  })

  it('includes ollama models when OLLAMA_BASE_URL is set (hardcoded fallback)', async () => {
    const mod = await getModule()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'))
    const models = await mod.getAvailableModels({ OLLAMA_BASE_URL: 'http://localhost:11434' })
    const ollamaModels = models.filter((m: any) => m.provider === 'ollama')
    expect(ollamaModels.length).toBeGreaterThan(0)
    globalThis.fetch = originalFetch
  })

  it('excludes ollama models when OLLAMA_BASE_URL is missing', async () => {
    const mod = await getModule()
    const models = await mod.getAvailableModels({})
    const ollamaModels = models.filter((m: any) => m.provider === 'ollama')
    expect(ollamaModels.length).toBe(0)
  })
})

// ============================================================
// buildFallbackChain
// ============================================================
describe('buildFallbackChain', () => {
  it('orders models by tier: premium -> standard -> budget -> free', async () => {
    const mod = await getModule()
    const models = [
      { id: 'free-model', provider: 'extractive', tier: 'free', quality: 0.3 },
      { id: 'premium-model', provider: 'openai', tier: 'premium', quality: 0.95 },
      { id: 'budget-model', provider: 'workers-ai', tier: 'budget', quality: 0.55 },
      { id: 'standard-model', provider: 'anthropic', tier: 'standard', quality: 0.8 },
    ] as any[]
    const chain = mod.buildFallbackChain(models)
    const tiers = chain.map((m: any) => m.tier)
    expect(tiers).toEqual(['premium', 'standard', 'budget', 'free'])
  })

  it('sorts by quality within the same tier', async () => {
    const mod = await getModule()
    const models = [
      { id: 'low', provider: 'openai', tier: 'budget', quality: 0.4 },
      { id: 'high', provider: 'openai', tier: 'budget', quality: 0.8 },
      { id: 'mid', provider: 'openai', tier: 'budget', quality: 0.6 },
    ] as any[]
    const chain = mod.buildFallbackChain(models)
    expect(chain[0].id).toBe('high')
    expect(chain[1].id).toBe('mid')
    expect(chain[2].id).toBe('low')
  })

  it('returns empty array for empty input', async () => {
    const mod = await getModule()
    expect(mod.buildFallbackChain([])).toEqual([])
  })
})

// ============================================================
// selectBestModel
// ============================================================
describe('selectBestModel', () => {
  it('selects highest quality model by default', async () => {
    const mod = await getModule()
    const models = [
      {
        id: 'low',
        provider: 'openai',
        tier: 'budget',
        quality: 0.3,
        costPer1KInput: 0,
        costPer1KOutput: 0,
        maxTokens: 1000,
        supportsStreaming: false,
        latencyP50Ms: 100,
        label: 'Low',
      },
      {
        id: 'high',
        provider: 'openai',
        tier: 'premium',
        quality: 0.9,
        costPer1KInput: 0,
        costPer1KOutput: 0,
        maxTokens: 1000,
        supportsStreaming: false,
        latencyP50Ms: 100,
        label: 'High',
      },
    ] as any[]
    const selected = mod.selectBestModel(models)
    expect(selected.id).toBe('high')
  })

  it('filters by streaming support when requireStreaming=true', async () => {
    const mod = await getModule()
    const models = [
      {
        id: 'streaming-ok',
        provider: 'openai',
        tier: 'budget',
        quality: 0.3,
        costPer1KInput: 0,
        costPer1KOutput: 0,
        maxTokens: 1000,
        supportsStreaming: true,
        latencyP50Ms: 100,
        label: 'S',
      },
      {
        id: 'no-stream',
        provider: 'openai',
        tier: 'premium',
        quality: 0.9,
        costPer1KInput: 0,
        costPer1KOutput: 0,
        maxTokens: 1000,
        supportsStreaming: false,
        latencyP50Ms: 100,
        label: 'NS',
      },
    ] as any[]
    const selected = mod.selectBestModel(models, { requireStreaming: true })
    expect(selected.id).toBe('streaming-ok')
  })

  it('prefers tier when preferTier is set', async () => {
    const mod = await getModule()
    const models = [
      {
        id: 'prem',
        provider: 'openai',
        tier: 'premium',
        quality: 0.9,
        costPer1KInput: 0,
        costPer1KOutput: 0,
        maxTokens: 1000,
        supportsStreaming: false,
        latencyP50Ms: 100,
        label: 'P',
      },
      {
        id: 'budget',
        provider: 'openai',
        tier: 'budget',
        quality: 0.7,
        costPer1KInput: 0,
        costPer1KOutput: 0,
        maxTokens: 1000,
        supportsStreaming: false,
        latencyP50Ms: 100,
        label: 'B',
      },
    ] as any[]
    const selected = mod.selectBestModel(models, { preferTier: 'budget' })
    expect(selected.id).toBe('budget')
  })

  it('falls back to last resort when no model matches filters', async () => {
    const mod = await getModule()
    const models = [
      {
        id: 'no-stream',
        provider: 'openai',
        tier: 'budget',
        quality: 0.3,
        costPer1KInput: 0,
        costPer1KOutput: 0,
        maxTokens: 1000,
        supportsStreaming: false,
        latencyP50Ms: 100,
        label: 'NS',
      },
    ] as any[]
    const selected = mod.selectBestModel(models, { requireStreaming: true })
    expect(selected.provider).toBe('extractive')
  })
})

// ============================================================
// estimateTokenCount
// ============================================================
describe('estimateTokenCount', () => {
  it('estimates ~1.3 tokens per word for English', async () => {
    const mod = await getModule()
    expect(mod.estimateTokenCount('hello world')).toBe(3)
  })

  it('counts CJK characters at ~2.5 tokens each + word tokens', async () => {
    const mod = await getModule()
    expect(mod.estimateTokenCount('삼성전자')).toBe(12)
  })

  it('handles mixed CJK and English', async () => {
    const mod = await getModule()
    const count = mod.estimateTokenCount('삼성전자 stock price')
    expect(count).toBeGreaterThanOrEqual(10)
    expect(count).toBeLessThanOrEqual(20)
  })

  it('returns 0 for empty string', async () => {
    const mod = await getModule()
    expect(mod.estimateTokenCount('')).toBe(0)
  })
})

// ============================================================
// estimateCost
// ============================================================
describe('estimateCost', () => {
  it('calculates cost correctly', async () => {
    const mod = await getModule()
    const model = { costPer1KInput: 0.01, costPer1KOutput: 0.03 } as any
    const cost = mod.estimateCost(model, 1000, 500)
    expect(cost).toBeCloseTo(0.025, 4)
  })

  it('returns 0 for zero tokens', async () => {
    const mod = await getModule()
    const model = { costPer1KInput: 0.01, costPer1KOutput: 0.03 } as any
    expect(mod.estimateCost(model, 0, 0)).toBe(0)
  })
})

// ============================================================
// getOllamaBaseUrl
// ============================================================
describe('getOllamaBaseUrl', () => {
  it('defaults to localhost:11434/v1', async () => {
    const mod = await getModule()
    expect(mod.getOllamaBaseUrl({})).toBe('http://localhost:11434/v1')
  })

  it('uses custom URL from env', async () => {
    const mod = await getModule()
    expect(mod.getOllamaBaseUrl({ OLLAMA_BASE_URL: 'http://192.168.1.100:11434' })).toBe(
      'http://192.168.1.100:11434/v1',
    )
  })

  it('handles URL already containing /v1', async () => {
    const mod = await getModule()
    expect(mod.getOllamaBaseUrl({ OLLAMA_BASE_URL: 'http://192.168.1.100:11434/v1' })).toBe(
      'http://192.168.1.100:11434/v1',
    )
  })

  it('strips trailing slashes before appending /v1', async () => {
    const mod = await getModule()
    expect(mod.getOllamaBaseUrl({ OLLAMA_BASE_URL: 'http://localhost:11434/' })).toBe('http://localhost:11434/v1')
  })
})

// ============================================================
// discoverOllamaModels — without fake timers (separate block)
// ============================================================
describe('discoverOllamaModels', () => {
  it('returns empty array when Ollama API is unreachable', async () => {
    const mod = await getModule()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Connection refused'))
    const result = await mod.discoverOllamaModels('http://localhost:11434/v1')
    expect(result).toEqual([])
    globalThis.fetch = originalFetch
  })

  it('returns empty array when Ollama returns empty model list', async () => {
    const mod = await getModule()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    })
    const result = await mod.discoverOllamaModels('http://localhost:11434/v1')
    expect(result).toEqual([])
    globalThis.fetch = originalFetch
  })

  it('returns models with estimated quality scores', async () => {
    const mod = await getModule()
    const originalFetch = globalThis.fetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          {
            name: 'gemma2:9b',
            size: 7340032000,
            digest: 'abc',
            details: { parameter_size: '9B', quantization_level: 'Q4_K_M' },
          },
          {
            name: 'llama3.2:3b',
            size: 2450000000,
            digest: 'def',
            details: { parameter_size: '3B', quantization_level: 'Q4_K_M' },
          },
        ],
      }),
    })
    const result = await mod.discoverOllamaModels('http://localhost:11434/v1')
    expect(result.length).toBe(2)
    expect(result[0].provider).toBe('ollama')
    expect(result[0].costPer1KOutput).toBe(0)
    expect(result[0].supportsStreaming).toBe(true)
    expect(result[0].quality).toBeGreaterThan(result[1].quality)
    globalThis.fetch = originalFetch
  })
})

// ============================================================
// discoverOllamaModels caching (separate describe, no fake timers)
// ============================================================
describe('discoverOllamaModels caching', () => {
  it('caches results so repeated calls within TTL window do not re-fetch', async () => {
    const mod = await getModule()
    const originalFetch = globalThis.fetch
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'gemma2:9b', size: 7340032000, digest: 'abc', details: { parameter_size: '9B' } }],
      }),
    })
    globalThis.fetch = fetchMock

    // First call — may hit existing test cache or call fetch
    const result1 = await mod.discoverOllamaModels('http://localhost:11434/v1')
    expect(Array.isArray(result1)).toBe(true)

    // Clear any prior fetch call count
    fetchMock.mockClear()

    // Second call — MUST use cache (TTL is 60s, so cache from first call is still fresh)
    const result2 = await mod.discoverOllamaModels('http://localhost:11434/v1')
    expect(Array.isArray(result2)).toBe(true)

    // fetchMock must NOT be called — the second call must use cache
    expect(fetchMock).not.toHaveBeenCalled()

    globalThis.fetch = originalFetch
  })
})
