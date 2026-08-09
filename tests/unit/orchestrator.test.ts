/**
 * Unit tests for Orchestrator helpers
 *
 * Tests the pure helper functions exported from orchestrator.ts:
 * isKoreanQuery, isChineseQuery, detectWikiLanguage, cleanChineseQuery,
 * normalizeUrlForDedup, normalizeTitleForDedup, mergeAndDeduplicate,
 * toBingTimeRange, isEvalMode.
 */

import { describe, it, expect } from 'vitest'
import {
  isKoreanQuery,
  isChineseQuery,
  isJapaneseQuery,
  detectWikiLanguage,
  cleanChineseQuery,
  normalizeUrlForDedup,
  normalizeTitleForDedup,
  mergeAndDeduplicate,
  toBingTimeRange,
  isEvalMode,
} from '../../src/lib/orchestrator'
import type { SearchResult } from '../../src/types'

// ============================================================
// isEvalMode (S9 — knowledge-panel skip gate + rate-limiter bypass)
// ============================================================

describe('isEvalMode', () => {
  it('returns true for EVAL_MODE=true (the eval harness flag)', () => {
    expect(isEvalMode({ EVAL_MODE: 'true' })).toBe(true)
  })

  it('returns true for EVAL_MODE=1 (boolean-string variant)', () => {
    expect(isEvalMode({ EVAL_MODE: '1' })).toBe(true)
  })

  it('returns false when EVAL_MODE is unset', () => {
    expect(isEvalMode({})).toBe(false)
    expect(isEvalMode(undefined)).toBe(false)
  })

  it('returns false for non-eval values', () => {
    expect(isEvalMode({ EVAL_MODE: 'false' })).toBe(false)
    expect(isEvalMode({ EVAL_MODE: '0' })).toBe(false)
  })

  it('matches the rate-limiter isEvalMode judgment (shared flag semantics)', () => {
    // The orchestrator skips the knowledge panel and the rate limiter bypasses
    // its wikipedia window/circuit under the SAME flag — keep them in sync or
    // eval runs would either trip wikipedia 429s or starve the panel path.
    expect(isEvalMode({ EVAL_MODE: 'true' })).toBe(isEvalMode({ EVAL_MODE: '1' }))
  })
})

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
// isJapaneseQuery (Phase 6.7)
// ============================================================

describe('isJapaneseQuery', () => {
  it('returns true for kana queries', () => {
    expect(isJapaneseQuery('量子コンピュータとは')).toBe(true)
    expect(isJapaneseQuery('東京観光スポット')).toBe(true)
  })

  it('returns true for kana-less shinjitai-kanji queries (ja-news fix)', () => {
    expect(isJapaneseQuery('任天堂Switch 2 発売')).toBe(true)
    expect(isJapaneseQuery('円安 影響')).toBe(true)
    expect(isJapaneseQuery('半導体不足 最新')).toBe(true)
    expect(isJapaneseQuery('京都紅葉時期')).toBe(true)
  })

  it('returns false for Chinese queries', () => {
    expect(isJapaneseQuery('中国AI最新进展')).toBe(false)
    expect(isJapaneseQuery('华为最新手机发布')).toBe(false)
    expect(isJapaneseQuery('北京旅游攻略')).toBe(false)
    expect(isJapaneseQuery('上海美食推荐')).toBe(false)
  })

  it('returns false for traditional Chinese (shared-glyph protection)', () => {
    expect(isJapaneseQuery('台灣銀行匯率')).toBe(false)
    expect(isJapaneseQuery('香港經濟新聞')).toBe(false)
    expect(isJapaneseQuery('日本旅遊攻略')).toBe(false)
  })

  it('catches Japanese via shinjitai glyphs AND place-word composites', () => {
    expect(isJapaneseQuery('日本経済新聞')).toBe(true) // 済 shinjitai
    expect(isJapaneseQuery('京都紅葉時期')).toBe(true) // 京都/紅葉 place words
  })

  it('catches kana-less Japanese tech compounds that were misrouted to zh (Phase 6.12)', () => {
    // ja-tech-10/ja-news-05/ja-tech-03/ja-tech-06/ja-tech-12/ja-tech-05/ja-tech-02
    // have NO kana and NO shinjitai glyphs, so they previously fell into the
    // zh-CN bucket and bing served Chinese results (NDCG 0.000 root cause).
    expect(isJapaneseQuery('機械学習入門')).toBe(true) // 機械学習 compound
    expect(isJapaneseQuery('Python機械学習入門')).toBe(true)
    expect(isJapaneseQuery('TypeScript 入門')).toBe(true) // 入門 compound
    expect(isJapaneseQuery('Docker 入門')).toBe(true)
    expect(isJapaneseQuery('Web API 設計')).toBe(true) // 設計 compound
    expect(isJapaneseQuery('AI規制 最新')).toBe(true) // 規制 compound
  })

  it('keeps genuinely-ambiguous shared-glyph queries (Kubernetes 基本) out of the zh bucket', () => {
    // 基本 is a shared glyph (Chinese writes 基本概念 too), so it is NOT in the
    // compound list — a Latin+kanji tech query like this stays ambiguous and
    // routes to zh rather than risking a Chinese false positive. Documented
    // tradeoff: the 6 unambiguous compounds above fix the eval 0.000 cases.
    expect(isJapaneseQuery('Kubernetes 基本')).toBe(false)
  })

  it('does NOT misroute simplified-Chinese queries that use the simplified glyphs', () => {
    // Simplified Chinese writes the same concepts as 机器/入门/设计/规制/学习 —
    // these are the exact glyph pairs the compound markers exclude.
    expect(isJapaneseQuery('机器学习入门教程')).toBe(false)
    expect(isJapaneseQuery('Docker 入门教程')).toBe(false)
    expect(isJapaneseQuery('网页设计教程')).toBe(false)
    expect(isJapaneseQuery('什么是机器学习')).toBe(false)
  })

  it('traditional-Chinese shared-glyph queries remain ambiguous by design (documented tradeoff)', () => {
    // 入門/設計/規制 are shared with traditional Chinese (台灣/香港). The
    // compound markers accept this rare ambiguity to fix the eval 0.000 cases
    // (TypeScript 入門 / Web API 設計 / AI規制 最新). These protection cases
    // pin the KNOWN behavior so a future change must consciously widen it.
    expect(isJapaneseQuery('網頁設計')).toBe(true) // shared glyph — documented ambiguity
    expect(isJapaneseQuery('Python入門')).toBe(true) // shared glyph — documented ambiguity
    expect(isJapaneseQuery('台灣銀行匯率')).toBe(false) // no compound marker → protected
    expect(isJapaneseQuery('香港經濟新聞')).toBe(false)
  })

  it('returns false for English/Korean', () => {
    expect(isJapaneseQuery('react hooks')).toBe(false)
    expect(isJapaneseQuery('삼성전자 주가')).toBe(false)
  })
})

// ============================================================
// isChineseQuery — must NOT swallow Japanese kanji
// ============================================================

describe('isChineseQuery (Japanese exclusion)', () => {
  it('returns false for kana-less Japanese kanji queries', () => {
    expect(isChineseQuery('任天堂Switch 2 発売')).toBe(false)
    expect(isChineseQuery('半導体不足 最新')).toBe(false)
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

  it('returns ja for kana queries', () => {
    expect(detectWikiLanguage('量子コンピュータとは')).toBe('ja')
  })

  it('returns ja for kana-less shinjitai kanji queries', () => {
    expect(detectWikiLanguage('任天堂Switch 2 発売')).toBe('ja')
    expect(detectWikiLanguage('円安 影響')).toBe('ja')
    expect(detectWikiLanguage('京都紅葉時期')).toBe('ja')
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
    expect(result).not.toMatch(/ {2}/)
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
