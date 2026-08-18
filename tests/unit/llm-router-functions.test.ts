/**
 * Unit tests: llm-router pure functions + html-rewriter selectors.
 *
 * llm-router: getAvailableModels (key/binding gating, extractive always,
 * Ollama discovery path), getOllamaBaseUrl, selectBestModel (streaming,
 * minQuality, cost cap, tier preference, quality sort), estimateCost,
 * estimateTokenCount (CJK weighting), buildFallbackChain (tier ordering).
 *
 * html-rewriter: generateFallbackSelectors (stock/news/search + generic).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

import {
  getAvailableModels,
  getOllamaBaseUrl,
  selectBestModel,
  estimateCost,
  estimateTokenCount,
  buildFallbackChain,
  generateOpenRouterAnswer,
  MODEL_REGISTRY,
  type ModelConfig,
} from '../../src/lib/llm-router'
import { retryAfterMsFromError } from '../../src/lib/resilience/retry'
import { generateFallbackSelectors } from '../../src/lib/html-rewriter'

describe('fetch 기반 게이트웨이 429 → Retry-After 오류 변환', () => {
  it('generateOpenRouterAnswer가 429 응답의 Retry-After 헤더를 retryAfterMs로 실어 던진다', async () => {
    fetchMock.mockResolvedValue(
      new Response('Rate limit exceeded', { status: 429, headers: { 'retry-after': '2' } }),
    )
    await expect(
      generateOpenRouterAnswer('sk-test', 'prompt', 'system', 'deepseek-r1:free'),
    ).rejects.toMatchObject({
      message: expect.stringContaining('429'),
      status: 429,
      retryAfterMs: 2000,
    })
    // synthesizer의 getRetryAfterMs가 같은 오류를 소비해 2초 대기를 얻는다.
    try {
      await generateOpenRouterAnswer('sk-test', 'prompt', 'system', 'deepseek-r1:free')
    } catch (err) {
      expect(retryAfterMsFromError(err)).toBe(2000)
    }
  })

  it('Retry-After가 없는 429는 status만 실린 오류를 던진다 (백오프 폴백)', async () => {
    fetchMock.mockResolvedValue(new Response('quota', { status: 429 }))
    try {
      await generateOpenRouterAnswer('sk-test', 'prompt', 'system', 'deepseek-r1:free')
    } catch (err) {
      expect((err as { status: number }).status).toBe(429)
      expect((err as { retryAfterMs?: number }).retryAfterMs).toBeUndefined()
      expect(retryAfterMsFromError(err)).toBeUndefined()
    }
  })
})

describe('getAvailableModels', () => {
  it('gates models by configured keys/bindings and always includes extractive', async () => {
    const models = await getAvailableModels({ OPENAI_API_KEY: 'sk' })
    const ids = models.map((m) => m.provider)
    expect(ids).toContain('openai')
    expect(ids).not.toContain('anthropic')
    expect(ids).toContain('extractive')
    expect(ids).not.toContain('ollama') // no OLLAMA_BASE_URL
  })

  it('includes Workers AI only when the AI binding exists', async () => {
    const without = await getAvailableModels({})
    expect(without.some((m) => m.provider === 'workers-ai')).toBe(false)
    const withAi = await getAvailableModels({ AI: {} })
    expect(withAi.some((m) => m.provider === 'workers-ai')).toBe(true)
  })

  it('discovers Ollama models when OLLAMA_BASE_URL is set', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ models: [{ name: 'llama3.2:3b', size: 2e9, digest: 'x' }] }), { status: 200 }),
    )
    const models = await getAvailableModels({ OLLAMA_BASE_URL: 'http://ollama:11434' })
    expect(models.some((m) => m.provider === 'ollama')).toBe(true)
    expect(models.some((m) => m.provider === 'extractive')).toBe(true)
  })

  it('falls back to hardcoded Ollama models when discovery fails', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const models = await getAvailableModels({ OLLAMA_BASE_URL: 'http://ollama:11434' })
    expect(models.some((m) => m.provider === 'ollama')).toBe(true)
  })
})

describe('getOllamaBaseUrl', () => {
  it('defaults to localhost and appends /v1', () => {
    expect(getOllamaBaseUrl()).toBe('http://localhost:11434/v1')
  })

  it('appends /v1 only once and trims trailing slashes', () => {
    expect(getOllamaBaseUrl({ OLLAMA_BASE_URL: 'http://host:8080///' })).toBe('http://host:8080/v1')
    expect(getOllamaBaseUrl({ OLLAMA_BASE_URL: 'http://host:8080/v1' })).toBe('http://host:8080/v1')
  })
})

describe('selectBestModel', () => {
  it('returns the highest-quality model by default', () => {
    const best = selectBestModel(MODEL_REGISTRY)
    expect(best).toBeDefined()
  })

  it('filters by streaming support and minQuality', () => {
    const chosen = selectBestModel(MODEL_REGISTRY, { requireStreaming: true, minQuality: 0.5 })
    expect(chosen.supportsStreaming).toBe(true)
    expect(chosen.quality).toBeGreaterThanOrEqual(0.5)
  })

  it('respects a hard cost cap', () => {
    const chosen = selectBestModel(MODEL_REGISTRY, { maxCostPerRequestUSD: 0.0001 })
    const cost = estimateCost(chosen, 2000, 600)
    expect(cost).toBeLessThanOrEqual(0.0001)
  })

  it('prefers the requested tier when present', () => {
    const chosen = selectBestModel(MODEL_REGISTRY, { preferTier: 'free' })
    expect(chosen.tier).toBe('free')
  })

  it('falls back to the last registry entry when no candidates match', () => {
    const impossible = MODEL_REGISTRY.map((m) => ({ ...m, quality: 0 }))
    const chosen = selectBestModel(impossible, { minQuality: 0.9 })
    expect(chosen).toBe(MODEL_REGISTRY[MODEL_REGISTRY.length - 1])
  })
})

describe('estimateCost / estimateTokenCount', () => {
  it('computes cost from per-1K rates', () => {
    const model: ModelConfig = { costPer1KInput: 1, costPer1KOutput: 2, id: 'x', label: 'X', provider: 'openai', tier: 'standard', quality: 0.8, supportsStreaming: true, latencyP50Ms: 100, maxTokens: 1000 } as ModelConfig
    expect(estimateCost(model, 1000, 500)).toBe(2) // 1 + 1
  })

  it('weights CJK characters more heavily than words', () => {
    const korean = estimateTokenCount('안녕하세요 세계')
    const english = estimateTokenCount('hello world')
    expect(korean).toBeGreaterThan(english)
    expect(estimateTokenCount('')).toBe(0)
  })
})

describe('buildFallbackChain', () => {
  it('orders premium → standard → budget → free, then by quality', () => {
    const chain = buildFallbackChain(MODEL_REGISTRY)
    const tierOrder = ['premium', 'standard', 'budget', 'free']
    const idx = chain.map((m) => tierOrder.indexOf(m.tier))
    for (let i = 1; i < idx.length; i++) {
      expect(idx[i]).toBeGreaterThanOrEqual(idx[i - 1])
    }
  })
})

describe('generateFallbackSelectors', () => {
  it('returns stock selectors for stock-related targets', () => {
    const s = generateFallbackSelectors('주식 카드')
    expect(s).toContain('div.stock_top')
    expect(s).toContain('strong.item_name')
  })

  it('returns news selectors for news targets', () => {
    const s = generateFallbackSelectors('news')
    expect(s).toContain('a.news_tit')
  })

  it('returns search selectors for search targets', () => {
    const s = generateFallbackSelectors('검색')
    expect(s).toContain('ul.lst_total li')
  })

  it('returns generic selectors for unknown targets', () => {
    const s = generateFallbackSelectors('custom-block')
    expect(s).toEqual(['[class*="custom-block"]', '#custom-block', 'a[href*="custom-block"]'])
  })
})
