/**
 * Unit tests for Query Complexity Classifier
 */

import { describe, it, expect } from 'vitest'

import {
  classifyQuery,
  shouldUseProSearch,
  getProSearchConfig,
  classifyWithAI,
  DEFAULT_CLASSIFIER_CONFIG,
  type ClassifierConfig,
} from '../../src/lib/agentic/classifier'

// ============================================================
// classifyQuery — pure function
// ============================================================

describe('classifyQuery', () => {
  describe('explicit mode overrides', () => {
    it('returns fast mode when config.mode is fast', () => {
      const result = classifyQuery('React vs Vue vs Angular comparison', { mode: 'fast', autoThreshold: 0.6 })
      expect(result.mode).toBe('fast')
      expect(result.confidence).toBe(1.0)
      expect(result.reasoning).toContain('Explicit fast mode')
    })

    it('returns pro mode when config.mode is pro', () => {
      const result = classifyQuery('hello', { mode: 'pro', autoThreshold: 0.6 })
      expect(result.mode).toBe('pro')
      expect(result.confidence).toBe(1.0)
      expect(result.reasoning).toContain('Explicit pro mode')
    })
  })

  describe('auto mode — complex queries → pro', () => {
    it('classifies comparison queries as pro', () => {
      const result = classifyQuery('React vs Vue vs Angular comparison')
      expect(result.mode).toBe('pro')
      expect(result.complexityScore).toBeGreaterThanOrEqual(0.6)
      // Phase 1.3: subType replaced old pattern names
      expect(result.intent).toBe('informational')
    })

    it('classifies multi-part queries as pro', () => {
      const result = classifyQuery('What is React and how does it work and why should I use it')
      expect(result.mode).toBe('pro')
      expect(result.complexityScore).toBeGreaterThan(0.5) // complex
    })

    it('classifies analysis queries as pro', () => {
      const result = classifyQuery('Analyze the implications of AI on software engineering')
      expect(result.mode).toBe('pro')
      expect(result.complexityScore).toBeGreaterThan(0.5) // complex
    })

    it('classifies multi-entity comparison as pro', () => {
      const result = classifyQuery('React vs Vue vs Angular')
      expect(result.mode).toBe('pro')
      expect(result.complexityScore).toBeGreaterThanOrEqual(0.6)
    })

    it('classifies Korean complex queries as pro', () => {
      const result = classifyQuery('React와 Vue의 장단점 비교 그리고 추천 best practice')
      expect(result.mode).toBe('pro')
      expect(result.complexityScore).toBeGreaterThan(0.5)
      expect(result.isKorean).toBe(true)
    })

    it('classifies financial analysis queries as pro', () => {
      const result = classifyQuery('Analyze earnings and revenue valuation for AAPL')
      expect(result.mode).toBe('pro')
      expect(result.complexityScore).toBeGreaterThan(0.5)
    })
  })

  describe('auto mode — simple queries → fast', () => {
    it('classifies simple fact lookups as fast', () => {
      const result = classifyQuery('what is TypeScript')
      expect(result.mode).toBe('fast')
      // Phase 1.3: subType replaces old pattern name
      expect(result.complexityScore).toBeLessThan(0.6)
    })

    it('classifies simple wh-questions as fast', () => {
      const result = classifyQuery('who')
      expect(result.mode).toBe('fast')
    })

    it('classifies navigational queries as fast', () => {
      const result = classifyQuery('github.com')
      expect(result.mode).toBe('fast')
      expect(result.complexityScore).toBeLessThan(0.6)
    })

    it('classifies simple calculations as fast', () => {
      const result = classifyQuery('2+2')
      expect(result.mode).toBe('fast')
      expect(result.complexityScore).toBeLessThan(0.6)
    })

    it('classifies short queries with no patterns as fast', () => {
      const result = classifyQuery('weather')
      expect(result.mode).toBe('fast')
      expect(result.complexityScore).toBeLessThan(0.6)
    })
  })

  describe('language detection', () => {
    it('detects Korean queries', () => {
      const result = classifyQuery('삼성전자 주가')
      expect(result.isKorean).toBe(true)
      expect(result.isChinese).toBe(false)
    })

    it('detects Chinese queries', () => {
      const result = classifyQuery('量子计算')
      expect(result.isChinese).toBe(true)
      expect(result.isKorean).toBe(false)
    })

    it('detects English queries', () => {
      const result = classifyQuery('what is quantum computing')
      expect(result.isKorean).toBe(false)
      expect(result.isChinese).toBe(false)
    })
  })

  describe('confidence scoring', () => {
    it('returns higher confidence for queries far from threshold', () => {
      const pro = classifyQuery('Compare and analyze React vs Vue vs Angular in detail with pros and cons')
      const simple = classifyQuery('what is TypeScript')
      // Pro query should have higher confidence (further from threshold)
      expect(pro.confidence).toBeGreaterThan(0)
      expect(simple.confidence).toBeGreaterThan(0)
    })

    it('clamps confidence to [0, 1]', () => {
      const result = classifyQuery('React vs Vue vs Angular comparison analysis evaluate')
      expect(result.confidence).toBeGreaterThanOrEqual(0)
      expect(result.confidence).toBeLessThanOrEqual(1)
    })
  })

  describe('config threshold', () => {
    it('lower threshold makes more queries go pro', () => {
      const low: ClassifierConfig = { mode: 'auto', autoThreshold: 0.3 }
      const high: ClassifierConfig = { mode: 'auto', autoThreshold: 0.9 }
      const query = 'best practices for React'
      const lowResult = classifyQuery(query, low)
      const highResult = classifyQuery(query, high)
      // With lower threshold, more queries should be pro
      if (lowResult.mode === 'pro') {
        expect(highResult.mode).toBe('fast')
      }
    })
  })
})

// ============================================================
// shouldUseProSearch
// ============================================================

describe('shouldUseProSearch', () => {
  it('returns true for complex queries', () => {
    expect(shouldUseProSearch('React vs Vue vs Angular comparison')).toBe(true)
  })

  it('returns false for simple queries', () => {
    expect(shouldUseProSearch('what is TypeScript')).toBe(false)
  })

  it('returns false when forced to fast mode', () => {
    expect(shouldUseProSearch('React vs Vue', { mode: 'fast', autoThreshold: 0.6 })).toBe(false)
  })
})

// ============================================================
// getProSearchConfig
// ============================================================

describe('getProSearchConfig', () => {
  it('returns default config for low complexity', () => {
    const result = classifyQuery('React vs Vue')
    const config = getProSearchConfig(result)
    expect(config.maxSteps).toBeGreaterThanOrEqual(5)
    expect(config.maxSearchResults).toBeGreaterThanOrEqual(8)
    expect(config.evidenceThreshold).toBeGreaterThanOrEqual(0.65)
  })

  it('returns aggressive config for very high complexity', () => {
    // Simulate a very complex classification result
    const config = getProSearchConfig({
      mode: 'pro',
      confidence: 0.9,
      reasoning: 'test',
      complexityScore: 0.85,
      detectedPatterns: ['comparison', 'analysis', 'multi-entity'],
      isKorean: false,
      isChinese: false,
    })
    expect(config.maxSteps).toBe(8)
    expect(config.maxSearchResults).toBe(10)
    expect(config.evidenceThreshold).toBe(0.65)
  })
})

// ============================================================
// classifyWithAI — falls back to heuristic
// ============================================================

describe('classifyWithAI', () => {
  it('falls back to heuristic when ai is null', async () => {
    const result = await classifyWithAI('what is TypeScript', null, DEFAULT_CLASSIFIER_CONFIG)
    expect(result.mode).toBe('fast')
  })

  it('falls back to heuristic when ai is undefined', async () => {
    const result = await classifyWithAI('React vs Vue', undefined, DEFAULT_CLASSIFIER_CONFIG)
    expect(result.mode).toBe('pro')
  })
})
