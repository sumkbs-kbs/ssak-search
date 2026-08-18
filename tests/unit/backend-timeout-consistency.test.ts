/**
 * Ceiling 단일 소스 확장 (2026-08): BACKEND_TIMEOUT_MS가 팬아웃 ceiling뿐 아니라
 * fetchWithTimeout 호출부의 기본 타임아웃과도 정합되어야 한다. fetch 기본 타임아웃이
 * 해당 백엔드의 fanout ceiling을 초과하면, ceiling 타이머가 먼저 발화해 결과를
 * 버렸는데도 fetch는 백그라운드에서 계속 도는 낭비가 발생한다 (retry-budget 세션에서
 * 재시도 체인에 대해 해결한 것과 동일한 문제를 단발 fetch에 확장).
 *
 * 모든 단언은 하드코딩 숫자 대신 backendTimeoutMs('<name>', <기존 기본값>)으로
 * "기본값이 단일 소스를 따른다"는 의미론을 직접 검증한다.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchWithTimeout = vi.fn()
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, fetchWithTimeout: (...args: unknown[]) => mockFetchWithTimeout(...args) }
})

import { backendTimeoutMs, BACKEND_TIMEOUT_MS } from '../../src/lib/search/fanout'
import { DEFAULT_BACKEND_TIMEOUT_MS } from '../../src/lib/util'
import { splitRetryBudget } from '../../src/lib/resilience/retry'
import { bingSearch, bingNewsSearch, bingImageSearch } from '../../src/lib/bing-search'
import { openalexSearch } from '../../src/lib/openalex'
import { searxngSearch } from '../../src/lib/searxng-search'
import { qiitaSearch, juejinSearch, csdnSearch } from '../../src/lib/community-search'
import { stackExchangeSearch } from '../../src/lib/stack-exchange'
import {
  wikipediaSummary,
  githubSearch,
  hackerNewsSearch,
  redditSearch,
  arxivSearch,
  duckDuckGoInstantAnswer,
  dbpediaSearch,
  wikidataWikiSearch,
} from '../../src/lib/specialized'
import { duckDuckGoImageSearch } from '../../src/lib/duckduckgo'

/** 최소한의 성공 Response mock — 파싱 결과는 이 테스트의 관심사가 아니다. */
function okResponse(payload: unknown): unknown {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => (typeof payload === 'string' ? payload : JSON.stringify(payload)),
    json: async () => payload,
  }
}

describe('backendTimeoutMs — ceiling 단일 소스 헬퍼', () => {
  it('등록된 백엔드는 BACKEND_TIMEOUT_MS 값을 반환한다', () => {
    expect(backendTimeoutMs('bing')).toBe(BACKEND_TIMEOUT_MS.bing)
    expect(backendTimeoutMs('wikipedia')).toBe(4500)
    expect(backendTimeoutMs('duckduckgo')).toBe(2000)
    expect(backendTimeoutMs('naver-finance')).toBe(4000)
  })

  it('미등록 백엔드는 fallback 값을 사용한다', () => {
    expect(backendTimeoutMs('dbpedia', 8000)).toBe(8000)
    expect(backendTimeoutMs('nonexistent', 9000)).toBe(9000)
  })

  it('fallback도 없으면 DEFAULT_BACKEND_TIMEOUT_MS를 사용한다', () => {
    expect(backendTimeoutMs('nonexistent')).toBe(DEFAULT_BACKEND_TIMEOUT_MS)
    expect(DEFAULT_BACKEND_TIMEOUT_MS).toBe(4000)
  })

  it('팬아웃에 등장하는 모든 백엔드 이름이 BACKEND_TIMEOUT_MS에 등록되어 있다 (묵시적 ?? 기본값 금지)', () => {
    const fanoutNames = [
      'bing',
      'bing-news',
      'bing-news-rss',
      'google-news-rss',
      'news-outlet',
      'bing-youtube',
      'youtube',
      'bing-finance',
      'bing-cleaned',
      'bing-writing',
      'wikipedia',
      'arxiv',
      'stack-exchange',
      'qiita',
      'juejin',
      'csdn',
      'hackernews',
      'reddit',
      'github',
      'github-issues',
      'openalex',
      'naver-finance',
      'yahoo-finance',
      'naver',
      'naver-news',
      'searxng',
      'duckduckgo',
      'brave',
    ]
    for (const name of fanoutNames) {
      expect(BACKEND_TIMEOUT_MS[name], `${name} must be registered in BACKEND_TIMEOUT_MS`).toBeDefined()
    }
  })
})

describe('fetchWithTimeout 기본 타임아웃 ≤ fanout ceiling (호출부 정합)', () => {
  beforeEach(() => {
    mockFetchWithTimeout.mockReset()
  })

  /** 첫 fetch 호출의 timeout 인자(4번째)를 반환한다. 파싱 실패는 관심사 아님. */
  async function firstFetchTimeout(fn: Promise<unknown>): Promise<number | undefined> {
    try {
      await fn
    } catch {
      // fetch 인자 검증이 목적 — 파싱/후처리 오류는 무시
    }
    return mockFetchWithTimeout.mock.calls[0]?.[3] as number | undefined
  }

  it('bing 웹: 기본 타임아웃이 bing ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse(''))
    expect(await firstFetchTimeout(bingSearch('test query'))).toBe(backendTimeoutMs('bing', 15000))
  })

  it('bing 뉴스: 기본 타임아웃이 bing-news ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse(''))
    expect(await firstFetchTimeout(bingNewsSearch('test query'))).toBe(backendTimeoutMs('bing-news', 15000))
  })

  it('bing 이미지: helper 경유 (미등록 bing-image → fallback 유지)', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse(''))
    expect(await firstFetchTimeout(bingImageSearch('test query'))).toBe(backendTimeoutMs('bing-image', 8000))
  })

  it('openalex: 재시도 체인 분할 예산이 openalex ceiling과 정합 (docs/16 §3.4)', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({ results: [] }))
    // 5xx/네트워크 1회 재시도 체인 — 시도당 타임아웃은 분할 예산이고,
    // worst case(2×분할+150ms)가 정확히 ceiling과 같아야 per-backend 타이머가
    // 체인 도중 발화하지 않는다.
    const ceiling = backendTimeoutMs('openalex', 6000)
    const perAttempt = splitRetryBudget(ceiling, 2, 150, 800)
    expect(await firstFetchTimeout(openalexSearch('test query'))).toBe(perAttempt)
    expect(2 * perAttempt + 150).toBe(ceiling)
  })

  it('searxng: 재시도 체인 분할 예산이 searxng ceiling과 정합 (docs/16 §3.2)', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse(''))
    const configured = { SEARXNG_URL: 'https://searxng.example' } as never
    // 5xx/네트워크 1회 재시도 체인 — 시도당 타임아웃은 분할 예산이고,
    // worst case(2×분할+150ms)가 정확히 ceiling(=fanout 등록값)과 같아야
    // per-backend 타이머가 체인 도중 발화하지 않는다.
    const ceiling = backendTimeoutMs('searxng', 10000)
    const perAttempt = splitRetryBudget(ceiling, 2, 150, 800)
    expect(await firstFetchTimeout(searxngSearch('test query', { env: configured }))).toBe(perAttempt)
    expect(2 * perAttempt + 150).toBe(ceiling)
  })

  it('qiita: 기본 타임아웃이 qiita ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse([]))
    expect(await firstFetchTimeout(qiitaSearch('test query'))).toBe(backendTimeoutMs('qiita', 8000))
  })

  it('juejin: 기본 타임아웃이 juejin ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse([]))
    expect(await firstFetchTimeout(juejinSearch('test query'))).toBe(backendTimeoutMs('juejin', 8000))
  })

  it('csdn: 기본 타임아웃이 csdn ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse(''))
    expect(await firstFetchTimeout(csdnSearch('test query'))).toBe(backendTimeoutMs('csdn', 8000))
  })

  it('stack-exchange: 재시도 체인 분할 예산이 stack-exchange ceiling과 정합 (docs/16 §3.9)', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({ items: [] }))
    // 5xx/네트워크 1회 재시도 체인 — 시도당 타임아웃은 분할 예산이고,
    // worst case(2×분할+150ms)가 정확히 ceiling(=fanout 등록값)과 같아야
    // per-backend 타이머가 체인 도중 발화하지 않는다.
    const ceiling = backendTimeoutMs('stack-exchange', 8000)
    const perAttempt = splitRetryBudget(ceiling, 2, 150, 800)
    expect(await firstFetchTimeout(stackExchangeSearch('test query'))).toBe(perAttempt)
    expect(2 * perAttempt + 150).toBe(ceiling)
  })

  it('wikipedia summary: 기본 타임아웃이 wikipedia ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({}))
    expect(await firstFetchTimeout(wikipediaSummary('React'))).toBe(backendTimeoutMs('wikipedia', 8000))
  })

  it('github: 기본 타임아웃이 github ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({ items: [] }))
    expect(await firstFetchTimeout(githubSearch('react'))).toBe(backendTimeoutMs('github', 8000))
  })

  it('hackernews: 기본 타임아웃이 hackernews ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({ hits: [] }))
    expect(await firstFetchTimeout(hackerNewsSearch('react'))).toBe(backendTimeoutMs('hackernews', 8000))
  })

  it('reddit: 재시도 체인 분할 예산이 reddit ceiling과 정합 (docs/16 §3.6)', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({ data: { children: [] } }))
    // 5xx/네트워크 1회 재시도 체인 — 시도당 타임아웃은 분할 예산이고,
    // worst case(2×분할+150ms)가 정확히 ceiling(=fanout 등록값)과 같아야
    // per-backend 타이머가 체인 도중 발화하지 않는다.
    const ceiling = backendTimeoutMs('reddit', 8000)
    const perAttempt = splitRetryBudget(ceiling, 2, 150, 800)
    expect(await firstFetchTimeout(redditSearch('react'))).toBe(perAttempt)
    expect(2 * perAttempt + 150).toBe(ceiling)
  })

  it('arxiv: 재시도 체인 분할 예산이 arxiv ceiling과 정합 (docs/16 §3.5)', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse(''))
    // 5xx/503 1회 재시도 체인 — 시도당 타임아웃은 분할 예산이고,
    // worst case(2×분할+150ms)가 정확히 ceiling과 같아야 per-backend 타이머가
    // 체인 도중 발화하지 않는다.
    const ceiling = backendTimeoutMs('arxiv', 10000)
    const perAttempt = splitRetryBudget(ceiling, 2, 150, 800)
    expect(await firstFetchTimeout(arxivSearch('react'))).toBe(perAttempt)
    expect(2 * perAttempt + 150).toBe(ceiling)
  })

  it('duckduckgo 인스턴트/이미지: 기본 타임아웃이 duckduckgo ceiling과 정합', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({}))
    expect(await firstFetchTimeout(duckDuckGoInstantAnswer('react'))).toBe(backendTimeoutMs('duckduckgo', 8000))
    mockFetchWithTimeout.mockReset()
    mockFetchWithTimeout.mockResolvedValue(okResponse(''))
    expect(await firstFetchTimeout(duckDuckGoImageSearch('cat'))).toBe(backendTimeoutMs('duckduckgo', 10000))
  })

  it('dbpedia/wikidata (비팬아웃 보조 백엔드): helper fallback으로 기존값 유지', async () => {
    mockFetchWithTimeout.mockResolvedValue(okResponse({ docs: [] }))
    expect(await firstFetchTimeout(dbpediaSearch('react'))).toBe(backendTimeoutMs('dbpedia', 8000))
    mockFetchWithTimeout.mockReset()
    mockFetchWithTimeout.mockResolvedValue(okResponse({ search: [] }))
    expect(await firstFetchTimeout(wikidataWikiSearch('react'))).toBe(backendTimeoutMs('wikidata', 8000))
  })
})
