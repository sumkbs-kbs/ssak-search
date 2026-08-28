import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock all three fast-path backends — orchestrator logic (provider selection,
// scoring, dedup, streaming) is what's under test, not the scrapers.
vi.mock('../../src/lib/naver-search', () => ({ naverSearch: vi.fn() }))
vi.mock('../../src/lib/bing-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/bing-search')>()
  return { ...actual, bingSearch: vi.fn() }
})
vi.mock('../../src/lib/duckduckgo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/duckduckgo')>()
  return { ...actual, duckDuckGoSearch: vi.fn(), isDuckDuckGoCoolingDown: vi.fn(() => false) }
})
vi.mock('../../src/lib/wikipedia-backbone', () => ({ wikipediaBackboneSearch: vi.fn() }))

import { naverSearch } from '../../src/lib/naver-search'
import { bingSearch } from '../../src/lib/bing-search'
import { duckDuckGoSearch, isDuckDuckGoCoolingDown } from '../../src/lib/duckduckgo'
import { wikipediaBackboneSearch } from '../../src/lib/wikipedia-backbone'
import { executeFastAgentSearch, generateSubqueries, resetFastPathCache } from '../../src/lib/agent-search-orchestrator'
import type { SearchResult } from '../../src/types'

const mockNaver = vi.mocked(naverSearch)
const mockBing = vi.mocked(bingSearch)
const mockDdg = vi.mocked(duckDuckGoSearch)
const mockDdgCooldown = vi.mocked(isDuckDuckGoCoolingDown)
const mockWiki = vi.mocked(wikipediaBackboneSearch)

function hit(backend: string, i: number, overrides: Partial<SearchResult> = {}): SearchResult {
  return {
    title: `${backend} ${i}`,
    url: `https://${backend}.example.com/${i}`,
    content: `${backend} content ${i}`,
    score: 0.9,
    domain: `${backend}.example.com`,
    ...overrides,
  }
}

beforeEach(() => {
  mockNaver.mockReset()
  mockBing.mockReset()
  mockDdg.mockReset()
  mockDdgCooldown.mockReset()
  mockDdgCooldown.mockReturnValue(false) // default: healthy
  mockWiki.mockReset()
  mockWiki.mockResolvedValue([]) // default: no backbone results
  resetFastPathCache() // tests reuse the same query strings
})

describe('generateSubqueries — language-matched augmentation', () => {
  it('appends Korean suffixes only to Korean queries', () => {
    expect(generateSubqueries('삼성전자', 'news')[1]).toBe('삼성전자 속보 뉴스')
    expect(generateSubqueries('Fed rate decision', 'news')[1]).toBe('Fed rate decision latest news')
    expect(generateSubqueries('AAPL', 'finance')[1]).toBe('AAPL earnings stock price')
  })

  it('skips augmentation facets the query already covers', () => {
    // covers the solution facet and the docs facet → nothing is added
    expect(generateSubqueries('fix module error docs', 'code')).toHaveLength(1)
    // docs covered, solution not → exactly the solution facet is added
    expect(generateSubqueries('react hooks docs', 'code')).toEqual([
      'react hooks docs',
      'react hooks docs example solution',
    ])
  })
})

describe('executeFastAgentSearch provider selection', () => {
  it('uses bing+duckduckgo for English queries — naver is noise there', async () => {
    mockBing.mockResolvedValue([hit('bing', 0)])
    mockDdg.mockResolvedValue([hit('ddg', 0)])

    await executeFastAgentSearch('cloudflare workers limits', 5)

    expect(mockBing).toHaveBeenCalledTimes(1)
    expect(mockDdg).toHaveBeenCalledTimes(1)
    expect(mockNaver).not.toHaveBeenCalled()
  })

  it('uses naver+bing(ko-KR) for Korean queries', async () => {
    mockNaver.mockResolvedValue([hit('naver', 0)])
    mockBing.mockResolvedValue([hit('bing', 0)])

    await executeFastAgentSearch('클라우드플레어 제한', 5)

    expect(mockNaver).toHaveBeenCalledTimes(1)
    expect(mockBing).toHaveBeenCalledTimes(1)
    expect(mockBing).toHaveBeenCalledWith('클라우드플레어 제한', expect.objectContaining({ region: 'ko-KR' }))
    expect(mockDdg).not.toHaveBeenCalled()
  })
})

describe('scoring honesty', () => {
  it('applies a rank-decayed prior when the backend returns no score', async () => {
    mockBing.mockResolvedValue([
      hit('bing', 0, { score: 0 }),
      hit('bing', 1, { score: 0 }),
      hit('bing', 2, { score: 0 }),
    ])
    mockDdg.mockResolvedValue([])

    const out = await executeFastAgentSearch('q', 5)

    expect(out.hits[0].score).toBeCloseTo(0.8, 10) // rank 0 prior — was a flat 0.85 HIGH-by-default
    expect(out.hits[1].score).toBeCloseTo(0.75, 10)
    expect(out.hits[2].score).toBeCloseTo(0.7, 10)
  })

  it('reports HIGH only with ≥2 strong hits, LOW on nothing', async () => {
    mockBing.mockResolvedValue([hit('bing', 0, { score: 0.9 }), hit('bing', 1, { score: 0.8 })])
    mockDdg.mockResolvedValue([])
    const strong = await executeFastAgentSearch('conf-strong', 5)
    expect(strong.signal_confidence).toBe('HIGH')

    mockBing.mockResolvedValue([hit('bing', 0, { score: 0.4 })])
    const weak = await executeFastAgentSearch('conf-weak', 5)
    expect(weak.signal_confidence).toBe('MEDIUM')

    mockBing.mockResolvedValue([])
    const none = await executeFastAgentSearch('conf-none', 5)
    expect(none.signal_confidence).toBe('LOW')
  })
})

describe('code authority boosting — hostname semantics', () => {
  it('boosts first-party hosts and records authority_boost', async () => {
    mockBing.mockResolvedValue([
      hit('bing', 0, { url: 'https://github.com/owner/repo', score: 0.7 }),
      hit('bing', 1, { url: 'https://developer.mozilla.org/en-US/docs/Web', score: 0.7 }),
    ])
    mockDdg.mockResolvedValue([])

    const out = await executeFastAgentSearch('react useeffect cleanup', 5, 2500, undefined, 'code')

    expect(out.hits[0].score).toBeCloseTo(0.8, 10) // 0.7 + 0.1
    expect(out.hits[0].authority_boost).toBe(true)
    expect(out.hits[1].authority_boost).toBe(true)
  })

  it('does not boost aggregator blogs or substring/path matches', async () => {
    mockBing.mockResolvedValue([
      hit('bing', 0, { url: 'https://medium.com/@someone/react-tips', score: 0.7 }),
      hit('bing', 1, { url: 'https://evil.com/github.com/path-trick', score: 0.7 }),
      hit('bing', 2, { url: 'https://mydocs.example.com/guide', score: 0.7 }),
    ])
    mockDdg.mockResolvedValue([])

    const out = await executeFastAgentSearch('react tips', 5, 2500, undefined, 'code')

    expect(out.hits.every((h) => !h.authority_boost)).toBe(true)
    expect(out.hits.every((h) => h.score === 0.7)).toBe(true)
  })
})

describe('onHits streaming callback', () => {
  it('emits each provider batch on arrival, before the race completes', async () => {
    let resolveSlow: (v: SearchResult[]) => void
    const slow = new Promise<SearchResult[]>((r) => {
      resolveSlow = r
    })
    mockBing.mockReturnValue(new Promise((r) => setTimeout(() => r([hit('bing', 0)]), 5)))
    mockDdg.mockReturnValue(slow)

    const batches: Array<{ source: string; n: number }> = []
    const done = executeFastAgentSearch('q', 5, 2500, undefined, 'general', false, (batch, source) => {
      batches.push({ source, n: batch.length })
      // First batch must land while the slow provider is still pending
      if (batches.length === 1) {
        expect(batches[0]).toEqual({ source: 'bing_mobile', n: 1 })
        resolveSlow!([hit('ddg', 0)])
      }
    })

    const out = await done
    expect(batches.map((b) => b.source).sort()).toEqual(['bing_mobile', 'duckduckgo'])
    expect(out.hits).toHaveLength(2)
  })

  it('dedupes the same URL across providers', async () => {
    mockBing.mockResolvedValue([hit('bing', 0)])
    mockDdg.mockResolvedValue([hit('bing', 0)]) // same normalized URL

    const out = await executeFastAgentSearch('q', 5)
    expect(out.hits).toHaveLength(1)
  })
})

describe('noise floor and provider-outage visibility', () => {
  it('filters zero-overlap hits below the 0.10 floor', async () => {
    mockBing.mockResolvedValue([hit('bing', 0, { score: 0.05 }), hit('bing', 1, { score: 0.4 })])
    mockDdg.mockResolvedValue([])

    const out = await executeFastAgentSearch('q', 5)
    expect(out.hits).toHaveLength(1)
    expect(out.hits[0].score).toBeCloseTo(0.4, 10)
  })

  it('attributes empty DDG to the anti-bot cooldown, not to "no results"', async () => {
    mockBing.mockResolvedValue([hit('bing', 0)])
    mockDdg.mockResolvedValue([]) // cooldown makes DDG return []
    mockDdgCooldown.mockReturnValue(true)

    const out = await executeFastAgentSearch('q', 5)
    expect(out.hits).toHaveLength(1)
    expect(out.aborted_backends).toContain('duckduckgo(antibot-cooldown)')
  })

  it('does not blame the cooldown when DDG is healthy but empty', async () => {
    mockBing.mockResolvedValue([hit('bing', 0)])
    mockDdg.mockResolvedValue([])
    mockDdgCooldown.mockReturnValue(false)

    const out = await executeFastAgentSearch('q', 5)
    expect(out.aborted_backends).not.toContain('duckduckgo(antibot-cooldown)')
  })
})

describe('wikipedia knowledge backbone', () => {
  it('rescues the empty path with wikipedia hits (language-matched)', async () => {
    mockBing.mockResolvedValue([])
    mockDdg.mockResolvedValue([])
    mockWiki.mockResolvedValue([hit('wiki', 0, { score: 0.8 }), hit('wiki', 1, { score: 0.7 })])

    const streamed: string[] = []
    const out = await executeFastAgentSearch('q', 5, 2500, undefined, 'general', false, (b, src) => {
      streamed.push(src)
    })

    expect(mockWiki).toHaveBeenCalledWith('q', expect.objectContaining({ language: 'en', maxResults: 5 }))
    expect(out.hits).toHaveLength(2)
    expect(out.hits[0].source).toBe('wikipedia')
    expect(streamed).toContain('wikipedia')
    expect(out.signal_confidence).toBe('MEDIUM') // 1 strong hit at 0.8 → MEDIUM, honest
  })

  it('uses ko.wikipedia for Korean queries', async () => {
    mockNaver.mockResolvedValue([])
    mockBing.mockResolvedValue([])
    mockWiki.mockResolvedValue([hit('wiki', 0, { score: 0.9 }), hit('wiki', 1, { score: 0.8 })])

    await executeFastAgentSearch('클라우드플레어', 5)
    expect(mockWiki).toHaveBeenCalledWith('클라우드플레어', expect.objectContaining({ language: 'ko' }))
  })

  it('is not called when primary providers produced hits', async () => {
    mockBing.mockResolvedValue([hit('bing', 0)])
    mockDdg.mockResolvedValue([])

    await executeFastAgentSearch('q', 5)
    expect(mockWiki).not.toHaveBeenCalled()
  })

  it('lands a wikipedia failure in aborted_backends without throwing', async () => {
    mockBing.mockResolvedValue([])
    mockDdg.mockResolvedValue([])
    mockWiki.mockRejectedValue(new Error('429'))

    const out = await executeFastAgentSearch('q', 5)
    expect(out.hits).toHaveLength(0)
    expect(out.signal_confidence).toBe('LOW')
    expect(out.aborted_backends).toContain('wikipedia')
  })
})

describe('micro cache', () => {
  it('serves a repeat query from cache with an age stamp, skipping backends', async () => {
    mockBing.mockResolvedValue([hit('bing', 0), hit('bing', 1)])
    mockDdg.mockResolvedValue([])

    const first = await executeFastAgentSearch('cache me', 5)
    expect(first.cached).toBeUndefined()
    expect(mockBing).toHaveBeenCalledTimes(1)

    const second = await executeFastAgentSearch('cache me', 5)
    expect(second.cached).toBe(true)
    expect(typeof second.cache_age_ms).toBe('number')
    expect(second.hits).toEqual(first.hits)
    expect(mockBing).toHaveBeenCalledTimes(1) // no re-fetch
  })

  it('keys on maxResults/topic/decompose', async () => {
    mockBing.mockResolvedValue([hit('bing', 0)])
    mockDdg.mockResolvedValue([])

    await executeFastAgentSearch('keyed', 5)
    await executeFastAgentSearch('keyed', 3)
    expect(mockBing).toHaveBeenCalledTimes(2)
  })

  it('replays cached hits through the onHits listener', async () => {
    mockBing.mockResolvedValue([hit('bing', 0)])
    mockDdg.mockResolvedValue([hit('ddg', 0)])

    await executeFastAgentSearch('stream cache', 5)
    const replayed: string[] = []
    await executeFastAgentSearch('stream cache', 5, 2500, undefined, 'general', false, (_b, src) => {
      replayed.push(src)
    })
    expect(replayed.sort()).toEqual(['bing_mobile', 'duckduckgo'])
  })

  it('does not cache empty results — a scraper hiccup stays retryable', async () => {
    mockBing.mockResolvedValue([])
    mockDdg.mockResolvedValue([])
    mockWiki.mockResolvedValue([])

    await executeFastAgentSearch('empty', 5)
    await executeFastAgentSearch('empty', 5)
    expect(mockBing).toHaveBeenCalledTimes(2)
  })
})
