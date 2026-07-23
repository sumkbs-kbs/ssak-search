/**
 * Unit tests for Orchestrator helpers
 *
 * Tests the pure helper functions exported from orchestrator.ts:
 * isKoreanQuery, isChineseQuery, detectWikiLanguage, cleanChineseQuery,
 * normalizeUrlForDedup, normalizeTitleForDedup, mergeAndDeduplicate,
 * toBingTimeRange.
 */

import { describe, it, expect } from 'vitest'
import {
  isKoreanQuery,
  isChineseQuery,
  detectWikiLanguage,
  cleanChineseQuery,
  normalizeUrlForDedup,
  normalizeTitleForDedup,
  mergeAndDeduplicate,
  toBingTimeRange,
} from '../../src/lib/orchestrator'
import type { SearchResult } from '../../src/types'

// ============================================================
// isKoreanQuery
// ============================================================

describe('isKoreanQuery', () => {
  it('returns true for Hangul characters', () => {
    expect(isKoreanQuery('삼성전자 주가')).toBe(true)
    expect(isKoreanQuery('안녕하세요')).toBe(true)
    expect(isKoreanQuery('hello 세계')).toBe(true)
  })

  it('returns false for English-only queries', () => {
    expect(isKoreanQuery('react hooks')).toBe(false)
    expect(isKoreanQuery('')).toBe(false)
  })

  it('returns false for Chinese-only queries', () => {
    expect(isKoreanQuery('量子计算')).toBe(false)
    expect(isKoreanQuery('什么是量子计算')).toBe(false)
  })
})

// ============================================================
// isChineseQuery
// ============================================================

describe('isChineseQuery', () => {
  it('returns true for CJK characters without Hangul', () => {
    expect(isChineseQuery('量子计算')).toBe(true)
    expect(isChineseQuery('什么是量子计算')).toBe(true)
  })

  it('returns false for Korean queries (has Hangul)', () => {
    expect(isChineseQuery('삼성전자')).toBe(false)
  })

  it('returns false for English-only queries', () => {
    expect(isChineseQuery('quantum computing')).toBe(false)
  })

  it('returns false for empty query', () => {
    expect(isChineseQuery('')).toBe(false)
  })
})

// ============================================================
// detectWikiLanguage
// ============================================================

describe('detectWikiLanguage', () => {
  it('returns ko for Korean queries', () => {
    expect(detectWikiLanguage('삼성전자 주가')).toBe('ko')
  })

  it('returns zh for Chinese queries', () => {
    expect(detectWikiLanguage('量子计算')).toBe('zh')
  })

  it('returns en for English queries', () => {
    expect(detectWikiLanguage('quantum computing')).toBe('en')
  })

  it('returns en for empty query', () => {
    expect(detectWikiLanguage('')).toBe('en')
  })
})

// ============================================================
// cleanChineseQuery
// ============================================================

describe('cleanChineseQuery', () => {
  it('strips 什么是 prefix', () => {
    expect(cleanChineseQuery('什么是量子计算')).toBe('量子计算')
  })

  it('strips 什么 prefix', () => {
    expect(cleanChineseQuery('什么是最新的AI技术')).toBe('最新的AI技术')
  })

  it('strips 什麼是 prefix (Traditional)', () => {
    expect(cleanChineseQuery('什麼是量子計算')).toBe('量子計算')
  })

  it('strips 什麼 prefix (Traditional)', () => {
    expect(cleanChineseQuery('什麼是最新科技')).toBe('最新科技')
  })

  it('strips 怎么 prefix', () => {
    expect(cleanChineseQuery('怎么学习编程')).toBe('学习编程')
  })

  it('strips 如何 prefix', () => {
    expect(cleanChineseQuery('如何学习编程')).toBe('学习编程')
  })

  it('strips 为什么 prefix', () => {
    expect(cleanChineseQuery('为什么天空是蓝的')).toBe('天空是蓝的')
  })

  it('returns original if nothing matches', () => {
    expect(cleanChineseQuery('量子计算')).toBe('量子计算')
  })

  it('returns original if stripping results in empty string', () => {
    expect(cleanChineseQuery('什么是')).toBe('什么是')
  })
})

// ============================================================
// normalizeUrlForDedup
// ============================================================

describe('normalizeUrlForDedup', () => {
  it('strips protocol and trailing slash', () => {
    const result = normalizeUrlForDedup('https://example.com/path/')
    expect(result).toBe('example.com/path')
  })

  it('removes tracking parameters', () => {
    const result = normalizeUrlForDedup('https://example.com/page?utm_source=google&id=123')
    expect(result).not.toContain('utm_source')
    expect(result).toContain('id=123')
  })

  it('lowercases hostname', () => {
    const result = normalizeUrlForDedup('https://EXAMPLE.COM/Test')
    expect(result).toBe('example.com/test')
  })

  it('handles malformed URLs gracefully', () => {
    const result = normalizeUrlForDedup('not-a-url')
    expect(result).toBe('not-a-url')
  })

  it('removes fragments', () => {
    const result = normalizeUrlForDedup('https://example.com/page#section')
    expect(result).not.toContain('section')
  })
})

// ============================================================
// normalizeTitleForDedup
// ============================================================

describe('normalizeTitleForDedup', () => {
  it('lowercases and strips punctuation', () => {
    const result = normalizeTitleForDedup('Hello World! (Test)')
    expect(result).not.toMatch(/[!()]/)
    expect(result).toBe(result.toLowerCase())
  })

  it('preserves CJK characters', () => {
    const result = normalizeTitleForDedup('삼성전자 주가 정보')
    expect(result).toContain('삼')
    expect(result).toContain('성')
  })

  it('preserves Chinese characters', () => {
    const result = normalizeTitleForDedup('量子计算简介')
    expect(result).toContain('量')
    expect(result).toContain('子')
  })

  it('normalizes whitespace', () => {
    const result = normalizeTitleForDedup('hello   world')
    expect(result).not.toMatch(/  /)
  })

  it('truncates to 80 characters', () => {
    const long = 'a'.repeat(200)
    const result = normalizeTitleForDedup(long)
    expect(result.length).toBeLessThanOrEqual(80)
  })

  it('produces same output for similar titles', () => {
    const a = normalizeTitleForDedup('React Hooks Tutorial')
    const b = normalizeTitleForDedup('react hooks tutorial')
    expect(a).toBe(b)
  })
})

// ============================================================
// mergeAndDeduplicate
// ============================================================

describe('mergeAndDeduplicate', () => {
  function makeResult(url: string, title: string, score: number): SearchResult {
    return { title, url, content: 'content', score, domain: 'example.com' }
  }

  it('merges multiple result sets', () => {
    const set1 = [makeResult('https://a.com/1', 'Title A', 0.8)]
    const set2 = [makeResult('https://b.com/2', 'Title B', 0.7)]
    const merged = mergeAndDeduplicate([set1, set2])
    expect(merged.length).toBe(2)
  })

  it('deduplicates by URL, keeps highest score', () => {
    const set1 = [makeResult('https://a.com/1', 'Title', 0.5)]
    const set2 = [makeResult('https://a.com/1', 'Title', 0.9)]
    const merged = mergeAndDeduplicate([set1, set2])
    expect(merged.length).toBe(1)
    expect(merged[0].score).toBe(0.9)
  })

  it('deduplicates by normalized title', () => {
    const set1 = [makeResult('https://a.com/1', 'React Hooks Guide', 0.8)]
    const set2 = [makeResult('https://b.com/2', 'React Hooks Guide', 0.6)]
    const merged = mergeAndDeduplicate([set1, set2])
    expect(merged.length).toBe(1)
    expect(merged[0].score).toBe(0.8) // higher score wins
  })

  it('handles empty result sets', () => {
    expect(mergeAndDeduplicate([])).toEqual([])
    expect(mergeAndDeduplicate([[], []])).toEqual([])
  })

  it('handles single result set', () => {
    const set = [makeResult('https://a.com/1', 'A', 0.5), makeResult('https://b.com/2', 'B', 0.6)]
    const merged = mergeAndDeduplicate([set])
    expect(merged.length).toBe(2)
  })

  it('CJK title dedup preserves both results', () => {
    const set1 = [makeResult('https://a.com/1', '삼성전자 주가', 0.8)]
    const set2 = [makeResult('https://b.com/2', '삼성전자 주식', 0.7)]
    const merged = mergeAndDeduplicate([set1, set2])
    // Different CJK titles should NOT be deduped
    expect(merged.length).toBe(2)
  })
})

// ============================================================
// toBingTimeRange
// ============================================================

describe('toBingTimeRange', () => {
  it('converts valid ranges', () => {
    expect(toBingTimeRange('day')).toBe('day')
    expect(toBingTimeRange('week')).toBe('week')
    expect(toBingTimeRange('month')).toBe('month')
    expect(toBingTimeRange('year')).toBe('year')
  })

  it('returns undefined for undefined', () => {
    expect(toBingTimeRange(undefined)).toBeUndefined()
  })

  it('returns undefined for "any"', () => {
    expect(toBingTimeRange('any')).toBeUndefined()
  })

  it('returns undefined for unknown ranges', () => {
    expect(toBingTimeRange('decade')).toBeUndefined()
    expect(toBingTimeRange('hour')).toBeUndefined()
  })
})
