/**
 * Wave 5 (B3) — memory-cache key parity tests.
 *
 * The B3 TTL alignment raised the orchestrator memory tier to 30 min, the
 * same window the Cache API tier serves. A key that omits a field the Cache
 * API keys on would serve a stale/stripped response for the whole aligned
 * window (e.g. a `include_raw_content=false` entry answering a
 * `include_raw_content=true` request). These tests lock the memory key's
 * field coverage against cache.ts's cacheKey contract.
 */
import { describe, it, expect } from 'vitest'
import { getMemoryCacheKey } from '../../src/lib/orchestrator'
import { cacheKey } from '../../src/lib/cache'
import type { SearchRequest } from '../../src/types'

function req(over: Partial<SearchRequest>): SearchRequest {
  return { query: 'test query', ...over }
}

describe('getMemoryCacheKey (B3 parity with cache.ts)', () => {
  it('distinguishes include_raw_content (irc parity — stripped-response guard)', () => {
    const a = getMemoryCacheKey(req({ include_raw_content: false }))
    const b = getMemoryCacheKey(req({ include_raw_content: true }))
    expect(a).not.toBe(b)
    // And it must agree with the Cache API tier on the same distinction.
    expect(cacheKey(req({ include_raw_content: false }))).not.toBe(cacheKey(req({ include_raw_content: true })))
  })

  it('distinguishes location (loc parity)', () => {
    const a = getMemoryCacheKey(req({ location: 'Seoul' }))
    const b = getMemoryCacheKey(req({ location: 'Tokyo' }))
    expect(a).not.toBe(b)
  })

  it('keys on the same fields the Cache API tier keys on', () => {
    // Both tiers must differentiate these request shapes.
    const pairs: Array<Partial<SearchRequest>> = [
      { max_results: 5 },
      { topic: 'news' },
      { search_depth: 'advanced' },
      { time_range: 'week' },
      { sort_by: 'date' },
      { page: 2 },
      { include_answer: true },
      { include_fact_check: true },
      { country: 'KR' },
      { language: 'ko' },
      { focus: 'academic' },
      { include_domains: ['a.com', 'b.com'] },
      { exclude_domains: ['c.com'] },
    ]
    for (const over of pairs) {
      const base = req({})
      const varied = req(over)
      expect(getMemoryCacheKey(base), `memory key: ${JSON.stringify(over)}`).not.toBe(getMemoryCacheKey(varied))
      expect(cacheKey(base), `cache key: ${JSON.stringify(over)}`).not.toBe(cacheKey(varied))
    }
  })

  it('ignores the experiment variant consistently across both tiers', () => {
    const memControl = getMemoryCacheKey(req({}), 'control')
    const memVariant = getMemoryCacheKey(req({}), 'b')
    expect(memControl).not.toBe(memVariant)
    const cacheControl = cacheKey(req({}), 'control')
    const cacheVariant = cacheKey(req({}), 'b')
    expect(cacheControl).not.toBe(cacheVariant)
  })
})
