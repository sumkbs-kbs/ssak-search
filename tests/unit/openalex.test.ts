/**
 * OpenAlex academic backend unit tests (S96, 2026-08-11).
 *
 * Covers the keyless /works API mapping and — most importantly — gold-domain
 * matching: the URL-selection helper must surface domains the eval matcher's
 * label-suffix rule (D === G || D.endsWith('.' + G)) scores directly
 * (openreview.net, aclanthology.org, jmlr.org, nature.com, ieeexplore.ieee.org,
 * arxiv.org, semanticscholar.org, paperswithcode.com, doi.org).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import {
  ACADEMIC_PREFERRED_DOMAINS,
  pickWorkUrl,
  workUrlCandidates,
  openAlexWorkToResult,
  openalexSearch,
  type OpenAlexWork,
} from '../../src/lib/openalex'
import { extractDomain } from '../../src/lib/util'
import { logger } from '../../src/lib/logger'

/** Same label-suffix rule the eval matcher uses (eval/metrics.ts isRelevant). */
function matchesGold(domain: string, gold: string[]): boolean {
  return gold.some((g) => domain === g || domain.endsWith(`.${g}`))
}

const BASE_WORK = (over: Partial<OpenAlexWork> = {}): OpenAlexWork => ({
  display_name: 'Attention Is All You Need',
  publication_date: '2017-06-12',
  publication_year: 2017,
  doi: 'https://doi.org/10.48550/arxiv.1706.03762',
  primary_location: { landing_page_url: 'https://arxiv.org/abs/1706.03762' },
  best_oa_location: { landing_page_url: 'https://arxiv.org/abs/1706.03762' },
  ids: { openalex: 'https://openalex.org/W1', doi: 'https://doi.org/10.48550/arxiv.1706.03762' },
  authorships: [{ author: { display_name: 'Ashish Vaswani' } }, { author: { display_name: 'Noam Shazeer' } }],
  ...over,
})

const WORK_WITH = (url: string): OpenAlexWork =>
  BASE_WORK({ primary_location: { landing_page_url: url }, best_oa_location: null, doi: null })

// ── pickWorkUrl — gold-domain URL selection ──

describe('pickWorkUrl', () => {
  it('prefers an openreview.net landing page over a doi.org primary (openreview is gold)', () => {
    const work = BASE_WORK({
      primary_location: { landing_page_url: 'https://doi.org/10.5555/123' },
      best_oa_location: { landing_page_url: 'https://openreview.net/forum?id=abc123' },
      doi: 'https://doi.org/10.5555/123',
    })
    expect(pickWorkUrl(work, ['openreview.net', 'doi.org'])).toBe('https://openreview.net/forum?id=abc123')
  })

  it('prefers an arxiv best-oa copy over a doi.org primary (arxiv outranks doi in the preferred order)', () => {
    const work = BASE_WORK({
      primary_location: { landing_page_url: 'https://doi.org/10.1038/s42256-023-00626-4' },
      best_oa_location: { landing_page_url: 'http://arxiv.org/abs/2304.0001' },
      doi: 'https://doi.org/10.1038/s42256-023-00626-4',
    })
    expect(pickWorkUrl(work, ACADEMIC_PREFERRED_DOMAINS)).toBe('https://arxiv.org/abs/2304.0001')
  })

  it('falls back to the primary landing page when no preferred domain matches', () => {
    const work = BASE_WORK({
      primary_location: { landing_page_url: 'https://example.org/papers/1' },
      best_oa_location: null,
      doi: null,
    })
    expect(pickWorkUrl(work, ['openreview.net'])).toBe('https://example.org/papers/1')
  })

  it('falls back to the DOI when primary and best-oa are missing', () => {
    const work = BASE_WORK({
      primary_location: null,
      best_oa_location: null,
      doi: 'https://doi.org/10.1000/xyz',
    })
    expect(pickWorkUrl(work)).toBe('https://doi.org/10.1000/xyz')
  })

  it('never returns an api.openalex.org URL as a result link', () => {
    const work = BASE_WORK({
      primary_location: { landing_page_url: 'https://api.openalex.org/works/W1' },
      best_oa_location: null,
      doi: null,
      ids: { openalex: 'https://openalex.org/W1' },
    })
    expect(pickWorkUrl(work)).toBeNull()
  })

  it('dedups identical candidates', () => {
    const work = BASE_WORK({
      primary_location: { landing_page_url: 'https://arxiv.org/abs/1706.03762' },
      best_oa_location: { landing_page_url: 'https://arxiv.org/abs/1706.03762' },
      doi: 'https://arxiv.org/abs/1706.03762',
    })
    expect(workUrlCandidates(work)).toEqual(['https://arxiv.org/abs/1706.03762'])
  })

  it('matches gold via label-suffix: ieeexplore.ieee.org counts as ieee.org', () => {
    const work = WORK_WITH('https://ieeexplore.ieee.org/document/123456')
    const url = pickWorkUrl(work, ACADEMIC_PREFERRED_DOMAINS)
    expect(url).toBe('https://ieeexplore.ieee.org/document/123456')
    expect(matchesGold(extractDomain(url!), ['ieee.org'])).toBe(true)
  })

  it('matches api.semanticscholar.org against gold semanticscholar.org', () => {
    const work = BASE_WORK({
      primary_location: { landing_page_url: 'https://doi.org/10.5555/99' },
      best_oa_location: null,
      ids: { semantic_scholar: 'https://api.semanticscholar.org/CorpusID:42' },
    })
    const url = pickWorkUrl(work, ACADEMIC_PREFERRED_DOMAINS)
    expect(matchesGold(extractDomain(url!), ['semanticscholar.org'])).toBe(true)
  })

  it('returns null when a work has no usable URL', () => {
    expect(pickWorkUrl({})).toBeNull()
  })
})

// ── openAlexWorkToResult — SearchResult mapping ──

describe('openAlexWorkToResult', () => {
  it('maps a work to a SearchResult with the picked domain', () => {
    const r = openAlexWorkToResult(WORK_WITH('https://openreview.net/forum?id=abc'), 'query')
    expect(r).not.toBeNull()
    expect(r!.domain).toBe('openreview.net')
    expect(r!.url).toBe('https://openreview.net/forum?id=abc')
    expect(r!.title).toBe('Attention Is All You Need')
    expect(r!.published_date).toBe('2017-06-12')
    expect(r!.author).toContain('Ashish Vaswani')
  })

  it('returns null for a work with no title', () => {
    expect(openAlexWorkToResult(BASE_WORK({ display_name: '' }), 'query')).toBeNull()
  })

  it('returns null for a work with no usable URL', () => {
    expect(openAlexWorkToResult({ display_name: 'No URL here' }, 'query')).toBeNull()
  })
})

// ── openalexSearch — fetch-mocked API mapping ──

describe('openalexSearch', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  const jsonResponse = (results: OpenAlexWork[]) => ({
    ok: true,
    json: () => Promise.resolve({ results }),
  })

  it('maps works to SearchResults whose domains hit academic gold sets', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse([
        WORK_WITH('https://openreview.net/forum?id=xyz'),
        WORK_WITH('https://aclanthology.org/2023.eacl-main.239/'),
        WORK_WITH('https://www.nature.com/articles/s41591-024-02855-5'),
        WORK_WITH('https://jmlr.org/papers/v24/23-0069.html'),
      ]),
    )
    const results = await openalexSearch('transformer attention')
    expect(results).toHaveLength(4)
    const domains = results.map((r) => r.domain)
    // gold sets used by en-acad-08..17 / en-acad-01/02/05 — label-suffix match
    expect(matchesGold(domains[0], ['openreview.net', 'acm.org'])).toBe(true)
    expect(matchesGold(domains[1], ['aclanthology.org'])).toBe(true)
    expect(matchesGold(domains[2], ['nature.com'])).toBe(true)
    expect(matchesGold(domains[3], ['jmlr.org'])).toBe(true)
    expect(ACADEMIC_PREFERRED_DOMAINS).toContain('openreview.net')
  })

  it('respects maxResults', async () => {
    mockFetchWithTimeout.mockResolvedValue(
      jsonResponse([
        WORK_WITH('https://arxiv.org/abs/1'),
        WORK_WITH('https://arxiv.org/abs/2'),
        WORK_WITH('https://arxiv.org/abs/3'),
      ]),
    )
    const results = await openalexSearch('query', { maxResults: 2 })
    expect(results).toHaveLength(2)
  })

  it('returns [] on a non-200 response', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 500, json: () => Promise.reject(new Error('no body')) })
    expect(await openalexSearch('query')).toEqual([])
  })

  it('returns [] on a 429 rate limit without throwing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    mockFetchWithTimeout.mockResolvedValue({ ok: false, status: 429, json: () => Promise.reject(new Error('no body')) })
    expect(await openalexSearch('query')).toEqual([])
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('returns [] on malformed JSON', async () => {
    mockFetchWithTimeout.mockResolvedValue({ ok: true, json: () => Promise.reject(new Error('bad json')) })
    expect(await openalexSearch('query')).toEqual([])
  })

  it('returns [] when the fetch itself throws (circuit open / timeout)', async () => {
    mockFetchWithTimeout.mockRejectedValue(
      new Error('Upstream unavailable (circuit open or at capacity): https://api.openalex.org/works'),
    )
    expect(await openalexSearch('query')).toEqual([])
  })
})
