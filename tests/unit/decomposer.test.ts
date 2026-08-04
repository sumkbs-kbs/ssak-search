/**
 * Unit tests for Query Decomposer (understanding module)
 */

import { describe, it, expect } from 'vitest'

import { decomposeQuery } from '../../src/lib/understanding/decomposer'

// ============================================================
// comparison strategy
// ============================================================

describe('decomposeQuery — comparison', () => {
  it('decomposes "A vs B" with shared context (roadmap example)', () => {
    const d = decomposeQuery('삼성전자 vs SK하이닉스 2024 실적')
    expect(d.strategy).toBe('comparison')
    expect(d.comparison).toEqual({ left: '삼성전자', right: 'SK하이닉스' })
    expect(d.subQueries).toContain('삼성전자 2024 실적')
    expect(d.subQueries).toContain('SK하이닉스 2024 실적')
    expect(d.subQueries).toContain('삼성전자 vs SK하이닉스 2024 실적')
    expect(d.subQueries).toHaveLength(3)
  })

  it('decomposes English "A vs B" with context', () => {
    const d = decomposeQuery('React vs Vue performance benchmark')
    expect(d.strategy).toBe('comparison')
    expect(d.comparison).toEqual({ left: 'React', right: 'Vue' })
    expect(d.subQueries).toContain('React performance benchmark')
    expect(d.subQueries).toContain('Vue performance benchmark')
  })

  it('decomposes bare "A vs B"', () => {
    const d = decomposeQuery('React vs Vue')
    expect(d.strategy).toBe('comparison')
    expect(d.subQueries).toEqual(['React', 'Vue', 'React vs Vue'])
  })

  it('decomposes Korean "A와 B 비교"', () => {
    const d = decomposeQuery('삼성전자와 SK하이닉스 비교')
    expect(d.strategy).toBe('comparison')
    expect(d.comparison).toEqual({ left: '삼성전자', right: 'SK하이닉스' })
    expect(d.subQueries).toContain('삼성전자')
    expect(d.subQueries).toContain('SK하이닉스')
  })

  it('decomposes Chinese "A和B的区别"', () => {
    const d = decomposeQuery('Python和JavaScript的区别')
    expect(d.strategy).toBe('comparison')
    expect(d.comparison).toEqual({ left: 'Python', right: 'JavaScript' })
    expect(d.subQueries).toContain('Python')
    expect(d.subQueries).toContain('JavaScript')
  })
})

// ============================================================
// entity strategy
// ============================================================

describe('decomposeQuery — entity', () => {
  it('decomposes multi-entity query into per-entity sub-queries', () => {
    const d = decomposeQuery('React Vue Angular')
    expect(d.strategy).toBe('entity')
    expect(d.entities).toHaveLength(3)
    expect(d.subQueries).toContain('React')
    expect(d.subQueries).toContain('Vue')
    expect(d.subQueries).toContain('Angular')
    expect(d.subQueries).toContain('React Vue Angular')
  })
})

// ============================================================
// single strategy
// ============================================================

describe('decomposeQuery — single', () => {
  it('returns single query for Korean financial query', () => {
    const d = decomposeQuery('삼성전자 주가')
    expect(d.strategy).toBe('single')
    expect(d.subQueries).toEqual(['삼성전자 주가'])
  })

  it('returns single query for definition query', () => {
    const d = decomposeQuery('what is quantum computing')
    expect(d.strategy).toBe('single')
    expect(d.subQueries).toEqual(['what is quantum computing'])
  })

  it('returns single query for Chinese question', () => {
    const d = decomposeQuery('什么是量子计算')
    expect(d.strategy).toBe('single')
    expect(d.subQueries).toEqual(['什么是量子计算'])
  })

  it('returns single query for empty input', () => {
    const d = decomposeQuery('   ')
    expect(d.strategy).toBe('single')
    expect(d.subQueries).toEqual([''])
  })

  it('preserves original query in result', () => {
    const d = decomposeQuery('삼성전자 vs SK하이닉스 2024 실적')
    expect(d.originalQuery).toBe('삼성전자 vs SK하이닉스 2024 실적')
  })
})
