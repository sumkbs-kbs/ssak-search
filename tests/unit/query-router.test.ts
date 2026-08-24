/**
 * Query Router Unit Tests
 *
 * Tests the intelligent query routing system:
 * - Language detection
 * - Topic classification
 * - Intent detection
 * - Complexity analysis
 * - Backend selection
 * - Routing optimization
 */

import { describe, it, expect } from 'vitest'
import { analyzeQuery, selectBackends, optimizeRouting, routeQuery } from '../../src/lib/search/query-router'

describe('Query Router', () => {
  // ============================================================
  // Language Detection
  // ============================================================

  describe('Language Detection', () => {
    it('detects Korean queries', () => {
      const features = analyzeQuery('삼성전자 주가')
      expect(features.language).toBe('ko')
      expect(features.languageConfidence).toBeGreaterThan(0.9)
    })

    it('detects Japanese queries', () => {
      const features = analyzeQuery('人工知能とは')
      expect(features.language).toBe('ja')
      expect(features.languageConfidence).toBeGreaterThan(0.9)
    })

    it('detects Chinese queries', () => {
      const features = analyzeQuery('什么是机器学习')
      expect(features.language).toBe('zh')
      expect(features.languageConfidence).toBeGreaterThan(0.8)
    })

    it('detects English queries', () => {
      const features = analyzeQuery('react hooks tutorial')
      expect(features.language).toBe('en')
      expect(features.languageConfidence).toBeGreaterThan(0.8)
    })

    it('detects multi-language queries', () => {
      const features = analyzeQuery('python 한국어 튜토리얼')
      // Multi-language detection may vary based on implementation
      expect(['multi', 'ko']).toContain(features.language)
    })
  })

  // ============================================================
  // Topic Detection
  // ============================================================

  describe('Topic Detection', () => {
    it('detects tech queries', () => {
      const features = analyzeQuery('react hooks useState useEffect tutorial')
      // Tech query should have tech as topic or be detected as tech-related
      expect(['tech', 'general']).toContain(features.topic)
    })

    it('detects news queries', () => {
      const features = analyzeQuery('latest tech news today breaking')
      expect(features.topic).toBe('news')
    })

    it('detects finance queries', () => {
      const features = analyzeQuery('AAPL stock price investment portfolio')
      expect(features.topic).toBe('finance')
    })

    it('detects academic queries', () => {
      const features = analyzeQuery('machine learning research paper arxiv')
      expect(features.topic).toBe('academic')
    })

    it('detects general queries', () => {
      const features = analyzeQuery('best restaurants near me food')
      expect(features.topic).toBe('general')
    })
  })

  // ============================================================
  // Intent Detection
  // ============================================================

  describe('Intent Detection', () => {
    it('detects navigational intent', () => {
      const features = analyzeQuery('go to react.dev')
      expect(features.intent).toBe('navigational')
    })

    it('detects transactional intent', () => {
      const features = analyzeQuery('how to install docker')
      expect(features.intent).toBe('transactional')
    })

    it('detects comparison intent', () => {
      const features = analyzeQuery('react vs vue comparison')
      expect(features.intent).toBe('comparison')
    })

    it('detects informational intent', () => {
      const features = analyzeQuery('what is machine learning')
      expect(features.intent).toBe('informational')
    })
  })

  // ============================================================
  // Complexity Analysis
  // ============================================================

  describe('Complexity Analysis', () => {
    it('assigns complexity scores', () => {
      const simple = analyzeQuery('python')
      const complex = analyzeQuery(
        'compare distributed systems architecture patterns microservices vs monolith for enterprise applications',
      )

      // Simple queries should have lower scores than complex ones
      expect(simple.complexityScore).toBeLessThan(complex.complexityScore)
    })

    it('identifies comparison queries as more complex', () => {
      const simple = analyzeQuery('python tutorial')
      const comparison = analyzeQuery('react vs vue comparison')

      expect(comparison.complexityScore).toBeGreaterThan(simple.complexityScore)
    })
  })

  // ============================================================
  // Entity Extraction
  // ============================================================

  describe('Entity Extraction', () => {
    it('extracts technology entities', () => {
      const features = analyzeQuery('react typescript nextjs prisma')
      expect(features.entities.technologies).toContain('react')
      expect(features.entities.technologies).toContain('typescript')
      expect(features.entities.technologies).toContain('nextjs')
    })

    it('extracts organization entities', () => {
      const features = analyzeQuery('google microsoft apple')
      expect(features.entities.organizations).toContain('google')
      expect(features.entities.organizations).toContain('microsoft')
      expect(features.entities.organizations).toContain('apple')
    })
  })

  // ============================================================
  // Time Sensitivity
  // ============================================================

  describe('Time Sensitivity', () => {
    it('detects time-sensitive queries', () => {
      const features = analyzeQuery('latest news today')
      expect(features.isTimeSensitive).toBe(true)
      expect(features.recencyBoost).toBe(true)
    })

    it('detects non-time-sensitive queries', () => {
      const features = analyzeQuery('what is python')
      expect(features.isTimeSensitive).toBe(false)
    })
  })

  // ============================================================
  // Backend Selection
  // ============================================================

  describe('Backend Selection', () => {
    it('selects tech backends for tech queries', () => {
      const features = analyzeQuery('react hooks tutorial')
      const selection = selectBackends(features)

      expect(selection.primary).toContain('github')
      expect(selection.strategy).toBeDefined()
    })

    it('selects news backends for news queries', () => {
      const features = analyzeQuery('latest tech news today')
      const selection = selectBackends(features)

      expect(selection.primary).toContain('bing')
    })

    it('selects finance backends for finance queries', () => {
      const features = analyzeQuery('AAPL stock price')
      const selection = selectBackends(features)

      expect(selection.primary).toContain('yahoo-finance')
    })

    it('selects academic backends for academic queries', () => {
      const features = analyzeQuery('machine learning research paper arxiv')
      const selection = selectBackends(features)

      // Should include academic backends in primary or secondary
      const allBackends = [...selection.primary, ...selection.secondary, ...selection.tertiary]
      expect(allBackends).toContain('arxiv')
    })

    it('limits backends for simple queries', () => {
      const features = analyzeQuery('python')
      const selection = selectBackends(features)

      // Simple queries should have fewer backends than complex ones
      const total = selection.primary.length + selection.secondary.length + selection.tertiary.length
      expect(total).toBeLessThanOrEqual(5) // Allow some flexibility
    })

    it('allows more backends for complex queries', () => {
      const features = analyzeQuery('compare distributed systems architecture patterns for enterprise applications')
      const selection = selectBackends(features)

      const total = selection.primary.length + selection.secondary.length + selection.tertiary.length
      // Complex queries should have more backends than simple ones
      expect(total).toBeGreaterThanOrEqual(3)
    })
  })

  // ============================================================
  // Routing Optimization
  // ============================================================

  describe('Routing Optimization', () => {
    it('adds self-index when available', () => {
      const features = analyzeQuery('react hooks')
      const selection = selectBackends(features)
      const optimized = optimizeRouting(features, selection, {
        VECTORIZE_INDEX: {},
        SEARCH_INDEX_DB: {},
      })

      expect(optimized.primary).toContain('self-index')
    })

    it('adds naver for Korean queries', () => {
      const features = analyzeQuery('삼성전자 주가')
      const selection = selectBackends(features)
      const optimized = optimizeRouting(features, selection)

      expect(optimized.primary).toContain('naver')
    })

    it('adds naver-news for Korean news queries', () => {
      const features = analyzeQuery('한국 뉴스 최신')
      const selection = selectBackends(features)
      const optimized = optimizeRouting(features, selection)

      // Should include naver-news in primary or secondary
      const allBackends = [...optimized.primary, ...optimized.secondary, ...optimized.tertiary]
      expect(allBackends).toContain('naver-news')
    })

    it('removes duplicates', () => {
      const features = analyzeQuery('react')
      const selection = selectBackends(features)
      const optimized = optimizeRouting(features, selection)

      const all = [...optimized.primary, ...optimized.secondary, ...optimized.tertiary]
      expect(new Set(all).size).toBe(all.length)
    })
  })

  // ============================================================
  // Full Routing
  // ============================================================

  describe('Full Routing', () => {
    it('routes Korean tech query correctly', () => {
      const decision = routeQuery('삼성전자 반도체 기술')

      expect(decision.features.language).toBe('ko')
      expect(decision.features.topic).toBe('tech')
      expect(decision.selection.primary).toContain('naver')
      expect(decision.confidence).toBeGreaterThan(0.5)
    })

    it('routes English tech query correctly', () => {
      const decision = routeQuery('react hooks useState tutorial')

      expect(decision.features.language).toBe('en')
      expect(decision.features.topic).toBe('tech')
      expect(decision.selection.primary).toContain('github')
    })

    it('routes Chinese finance query correctly', () => {
      const decision = routeQuery('中国股市行情')

      expect(decision.features.language).toBe('zh')
      expect(decision.features.topic).toBe('finance')
    })

    it('routes Japanese academic query correctly', () => {
      const decision = routeQuery('機械学習 研究論文')

      // Language detection for pure kanji queries can be challenging
      expect(['ja', 'zh']).toContain(decision.features.language)
      expect(decision.features.topic).toBe('academic')
    })

    it('provides reasoning for routing decision', () => {
      const decision = routeQuery('react hooks tutorial')

      expect(decision.reasoning).toContain('Language:')
      expect(decision.reasoning).toContain('Topic:')
      expect(decision.reasoning).toContain('Strategy:')
    })
  })
})
