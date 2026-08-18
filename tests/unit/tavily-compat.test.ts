/**
 * Tavily compatibility layer tests (P1-5).
 *
 * Locks in the four wire-contract fixes so a future refactor can't silently
 * regress drop-in compatibility:
 *   1. `answer` flattens to a string in strict mode
 *   2. `response_time` is emitted in SECONDS
 *   3. `images` is always an array
 *   4. `results[].raw_content` is always present (null, never undefined)
 *
 * Also asserts the non-negotiable constraint that the DEFAULT projection stays
 * additive — the structured `answer` object must survive, because dashboard.tsx
 * and routes/openai.ts read `answer.text`.
 */

import { describe, it, expect } from 'vitest'
import {
  flattenAnswer,
  msToSeconds,
  toTavilyImages,
  normalizeResult,
  toTavilyResponse,
  withCompatFields,
  wantsTavilyCompat,
} from '../../src/lib/tavily-compat'
import type { SearchResponse, SearchResult, ImageResult } from '../../src/types'

const baseResult = (over: Partial<SearchResult> = {}): SearchResult => ({
  title: 'Rust',
  url: 'https://example.com/rust',
  content: 'A systems language',
  score: 0.91,
  domain: 'example.com',
  ...over,
})

const baseResponse = (over: Partial<SearchResponse> = {}): SearchResponse =>
  ({
    query: 'rust',
    results: [baseResult()],
    response_time_ms: 1918,
    backend: 'bing',
    fallback_used: false,
    ...over,
  }) as SearchResponse

describe('flattenAnswer', () => {
  it('extracts .text from the native structured answer', () => {
    expect(flattenAnswer({ text: 'Rust is fast', confidence: 0.9, sources: [] })).toBe('Rust is fast')
  })

  it('passes a plain string through (legacy/cached payloads)', () => {
    expect(flattenAnswer('already a string')).toBe('already a string')
  })

  it('returns null for missing/empty answers rather than "[object Object]"', () => {
    expect(flattenAnswer(undefined)).toBeNull()
    expect(flattenAnswer(null)).toBeNull()
    expect(flattenAnswer('')).toBeNull()
    expect(flattenAnswer({ text: '', confidence: 0, sources: [] })).toBeNull()
  })

  it('returns null for a malformed object instead of stringifying it', () => {
    // @ts-expect-error deliberately malformed to prove no "[object Object]" leak
    expect(flattenAnswer({ confidence: 1 })).toBeNull()
  })
})

describe('msToSeconds', () => {
  it('converts ms to Tavily seconds', () => {
    expect(msToSeconds(1918)).toBe(1.918)
    expect(msToSeconds(0)).toBe(0)
    expect(msToSeconds(920)).toBe(0.92)
  })

  it('is defensive about junk input', () => {
    expect(msToSeconds(undefined)).toBe(0)
    expect(msToSeconds(Number.NaN)).toBe(0)
    expect(msToSeconds(-5)).toBe(0)
  })
})

describe('toTavilyImages', () => {
  const images: ImageResult[] = [
    { url: 'https://img/1.jpg', title: 'one', source: 'bing', content: 'first' },
    { url: 'https://img/2.jpg', title: 'two', source: 'bing' },
  ]

  it('returns bare URL strings by default (Tavily default)', () => {
    expect(toTavilyImages(images)).toEqual(['https://img/1.jpg', 'https://img/2.jpg'])
  })

  it('returns {url, description} when descriptions are requested', () => {
    expect(toTavilyImages(images, true)).toEqual([
      { url: 'https://img/1.jpg', description: 'first' },
      { url: 'https://img/2.jpg', description: 'two' },
    ])
  })

  it('returns [] for missing images (never undefined)', () => {
    expect(toTavilyImages(undefined)).toEqual([])
    expect(toTavilyImages([])).toEqual([])
  })
})

describe('normalizeResult', () => {
  it('always emits raw_content, using null when absent', () => {
    const out = normalizeResult(baseResult())
    expect('raw_content' in out).toBe(true)
    expect(out.raw_content).toBeNull()
  })

  it('preserves raw_content when present', () => {
    expect(normalizeResult(baseResult({ raw_content: 'full text' })).raw_content).toBe('full text')
  })

  it('only includes published_date when the source had one', () => {
    expect(normalizeResult(baseResult()).published_date).toBeUndefined()
    expect(normalizeResult(baseResult({ published_date: '2026-01-01' })).published_date).toBe('2026-01-01')
  })

  it('coerces a missing score to 0 so the field is always numeric', () => {
    // @ts-expect-error simulating a legacy result with no score
    expect(normalizeResult({ ...baseResult(), score: undefined }).score).toBe(0)
  })
})

describe('toTavilyResponse (strict projection)', () => {
  it('emits exactly Tavily\'s documented field set', () => {
    const out = toTavilyResponse(
      baseResponse({ answer: { text: 'Rust is fast', confidence: 0.9, sources: [] } }),
    )
    expect(Object.keys(out).sort()).toEqual(
      ['answer', 'follow_up_questions', 'images', 'query', 'response_time', 'results'].sort(),
    )
  })

  it('flattens answer to a string (the headline incompatibility)', () => {
    const out = toTavilyResponse(
      baseResponse({ answer: { text: 'Rust is fast', confidence: 0.9, sources: [] } }),
    )
    expect(typeof out.answer).toBe('string')
    expect(out.answer).toBe('Rust is fast')
  })

  it('reports response_time in seconds, not milliseconds', () => {
    expect(toTavilyResponse(baseResponse({ response_time_ms: 1918 })).response_time).toBe(1.918)
  })

  it('drops native-only fields that would confuse a strict client', () => {
    const out = toTavilyResponse(baseResponse({ backend: 'bing', no_results: false })) as unknown as Record<
      string,
      unknown
    >
    expect(out.backend).toBeUndefined()
    expect(out.response_time_ms).toBeUndefined()
    expect(out.no_results).toBeUndefined()
  })

  it('maps related_queries to follow_up_questions, null when empty', () => {
    expect(toTavilyResponse(baseResponse({ related_queries: ['rust vs go'] })).follow_up_questions).toEqual([
      'rust vs go',
    ])
    expect(toTavilyResponse(baseResponse()).follow_up_questions).toBeNull()
  })
})

describe('withCompatFields (default projection)', () => {
  it('adds response_time while KEEPING response_time_ms', () => {
    const out = withCompatFields(baseResponse({ response_time_ms: 920 }))
    expect(out.response_time).toBe(0.92)
    expect(out.response_time_ms).toBe(920)
  })

  it('preserves the structured answer object (dashboard/openai depend on .text)', () => {
    const out = withCompatFields(
      baseResponse({ answer: { text: 'Rust is fast', confidence: 0.9, sources: [] } }),
    )
    expect(typeof out.answer).toBe('object')
    expect(out.answer?.text).toBe('Rust is fast')
    // ...and exposes a convenience string mirror
    expect(out.answer_text).toBe('Rust is fast')
  })

  it('normalizes raw_content to null on every result', () => {
    const out = withCompatFields(baseResponse())
    expect(out.results[0].raw_content).toBeNull()
  })

  it('guarantees images is an array', () => {
    expect(withCompatFields(baseResponse()).images).toEqual([])
  })

  it('does not drop native fields', () => {
    const out = withCompatFields(baseResponse({ backend: 'naver+bing', no_results: false }))
    expect(out.backend).toBe('naver+bing')
    expect(out.no_results).toBe(false)
  })
})

describe('wantsTavilyCompat', () => {
  it('detects the body flag', () => {
    expect(wantsTavilyCompat({ bodyFlag: 'tavily' })).toBe(true)
    expect(wantsTavilyCompat({ bodyFlag: 'TAVILY' })).toBe(true)
    expect(wantsTavilyCompat({ bodyFlag: 'native' })).toBe(false)
  })

  it('detects the X-API-Compat header', () => {
    expect(wantsTavilyCompat({ header: 'tavily' })).toBe(true)
    expect(wantsTavilyCompat({ header: 'something' })).toBe(false)
  })

  it('detects the /api/tavily path alias', () => {
    expect(wantsTavilyCompat({ path: '/api/tavily/search' })).toBe(true)
    expect(wantsTavilyCompat({ path: '/api/search' })).toBe(false)
  })

  it('defaults to false (native shape) when nothing opts in', () => {
    expect(wantsTavilyCompat({})).toBe(false)
    expect(wantsTavilyCompat({ bodyFlag: undefined, header: null, path: '/api/search' })).toBe(false)
  })
})
