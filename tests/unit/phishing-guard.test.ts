import { describe, it, expect, vi, beforeEach } from 'vitest'

import { assessUrlRisk, registrableDomain } from '../../src/lib/security/phishing-guard'

// Matcher convenience
const riskOf = (url: string) => assessUrlRisk(url).risk
const codesOf = (url: string) => assessUrlRisk(url).codes

describe('phishing-guard — brand impersonation (block level)', () => {
  it('blocks hostname labels claiming a finance brand on non-official domains', () => {
    expect(riskOf('https://kbstar-login.com/auth')).toBe('block')
    expect(riskOf('https://shinhan-secure.xyz/member/login')).toBe('block')
    expect(riskOf('https://kakaobank-verify.top/')).toBe('block')
    expect(codesOf('https://kbstar-login.com/auth')).toContain('BRAND_IMPERSONATION')
  })

  it('blocks brand squatting inside shared second-level suffixes (.ph.com campaign shape)', () => {
    expect(riskOf('https://kbstar.ph.com/login')).toBe('block')
    expect(riskOf('https://wooribank.gr.com/')).toBe('block')
  })

  it('blocks subdomain claims like login.kbstar-secure.example.com', () => {
    expect(riskOf('https://payco-pay.evil-example.net/verify')).toBe('block')
  })

  it('passes official domains and their subdomains untouched', () => {
    expect(riskOf('https://www.kbstar.com/banking/login')).toBe('clean')
    expect(riskOf('https://login.shinhan.com/')).toBe('clean')
    expect(riskOf('https://itp.kbfg.com/')).toBe('clean')
    expect(riskOf('https://toss.co.kr/')).toBe('clean')
  })

  it('does not flag brand mentions in paths on unrelated hosts', () => {
    expect(riskOf('https://www.boannews.com/news/kbstar-phishing-report')).toBe('clean')
    expect(riskOf('https://blog.example.com/shinhan-card-review')).toBe('clean')
  })
})

describe('phishing-guard — warn-level signals', () => {
  it('warns on punycode hostnames without blocking (legit IDN exists)', () => {
    const a = assessUrlRisk('https://xn--e1afmkfd.xn--3e0b707e/login')
    expect(a.risk).toBe('warn')
    expect(a.codes).toContain('IDN_PUNYCODE_HOST')
  })

  it('warns on shared-suffix hosts without a brand claim', () => {
    const a = assessUrlRisk('https://some-shop.ph.com/products')
    expect(a.risk).toBe('warn')
    expect(a.codes).toContain('SHARED_SUFFIX_HOST')
  })

  it('warns on URL shorteners', () => {
    expect(codesOf('https://bit.ly/3xYz')).toContain('URL_SHORTENER')
  })

  it('warns on login paths over plain http or suspicious TLDs', () => {
    expect(codesOf('http://example.com/login')).toContain('LOGIN_ON_SUSPICIOUS_HOST')
    expect(codesOf('https://free-stuff.tk/login')).toContain('LOGIN_ON_SUSPICIOUS_HOST')
  })

  it('stays clean on ordinary https sites without login-shaped suspicion', () => {
    expect(riskOf('https://github.com/owner/repo')).toBe('clean')
    expect(riskOf('https://en.wikipedia.org/wiki/Phishing')).toBe('clean')
    expect(riskOf('https://news.ycombinator.com/item?id=1')).toBe('clean')
  })
})

describe('registrableDomain — shared suffix aware', () => {
  it('treats shared suffixes as the registry itself', () => {
    expect(registrableDomain('kbstar.ph.com')).toBe('ph.com')
    expect(registrableDomain('a.b.gr.com')).toBe('gr.com')
  })
  it('returns last two labels for normal domains', () => {
    expect(registrableDomain('login.kbstar.com')).toBe('kbstar.com')
    expect(registrableDomain('example.co.uk')).toBe('co.uk')
  })
})

// ============================================================
// Integration: ranking pipeline filter
// ============================================================
import { applyFilters } from '../../src/lib/search/ranking'
import type { SearchResult } from '../../src/types'
import type { SearchContext } from '../../src/lib/search/context'

function result(url: string): SearchResult {
  return {
    title: '테스트',
    url,
    content: '내용',
    score: 0.9,
    domain: new URL(url).hostname,
  }
}

const ctx = { request: {} } as unknown as SearchContext

describe('applyFilters — phishing screen integration', () => {
  it('drops block-risk results and annotates warn-level ones', () => {
    const out = applyFilters(
      [
        result('https://www.kbstar.com/banking'),
        result('https://kbstar-login.com/auth'),
        result('https://some-shop.ph.com/products'),
        result('https://github.com/owner/repo'),
      ],
      ctx,
    )
    expect(out.map((r) => r.url)).toEqual([
      'https://www.kbstar.com/banking',
      'https://some-shop.ph.com/products',
      'https://github.com/owner/repo',
    ])
    expect(out[1].security_warning?.code).toContain('SHARED_SUFFIX_HOST')
    expect(out[2].security_warning).toBeUndefined()
  })
})

// ============================================================
// Integration: fast agent path
// ============================================================
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
import { duckDuckGoSearch } from '../../src/lib/duckduckgo'
import {
  executeFastAgentSearch,
  resetFastPathCache,
  resetFastPathInflight,
} from '../../src/lib/agent-search-orchestrator'

const mockBing = vi.mocked(bingSearch)
const mockDdg = vi.mocked(duckDuckGoSearch)
void naverSearch

beforeEach(() => {
  mockBing.mockReset()
  mockDdg.mockReset()
  resetFastPathCache()
  resetFastPathInflight()
})

describe('executeFastAgentSearch — phishing screen integration', () => {
  it('drops impersonating hits, counts them, and warns on soft signals', async () => {
    mockBing.mockResolvedValue([
      {
        title: 'KB스타 인증센터',
        url: 'https://kbstar-login.com/auth',
        content: '로그인',
        score: 0.9,
        domain: 'kbstar-login.com',
      },
      {
        title: '쇼핑몰',
        url: 'https://some-shop.ph.com/products',
        content: 'sale',
        score: 0.8,
        domain: 'some-shop.ph.com',
      },
      {
        title: '정상 문서',
        url: 'https://example.com/docs',
        content: 'docs',
        score: 0.7,
        domain: 'example.com',
      },
    ])
    mockDdg.mockResolvedValue([])

    const out = await executeFastAgentSearch('kb login', 5)

    expect(out.hits.map((h) => h.url)).toEqual(['https://some-shop.ph.com/products', 'https://example.com/docs'])
    expect(out.phishing_filtered).toBe(1)
    expect(out.hits[0].security_warning?.code).toContain('SHARED_SUFFIX_HOST')
    expect(out.hits[1].security_warning).toBeUndefined()
  })
})

// ============================================================
// Integration: extractor redirect-origin mismatch
// ============================================================
vi.mock('../../src/lib/util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/util')>()
  return { ...actual, safeFetchWithRedirects: vi.fn() }
})
vi.mock('../../src/lib/jina-search', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/jina-search')>()
  return { ...actual, jinaExtract: vi.fn() }
})

import { safeFetchWithRedirects } from '../../src/lib/util'
import { extractWithStealthEscalation } from '../../src/lib/agent-extractor'

const mockFetch = vi.mocked(safeFetchWithRedirects)

describe('extractWithStealthEscalation — cloaking signals', () => {
  beforeEach(() => {
    mockFetch.mockReset()
  })

  it('flags a redirect that landed on a different registrable domain', async () => {
    // Manually constructed Responses ignore the url option (res.url === ''),
    // but real fetch responses carry the final hop URL — override the getter.
    const res = new Response(
      '<html><body><article><p>' +
        'substantial article body text for the redirect mismatch fixture. '.repeat(10) +
        '</p></article></body></html>',
      { status: 200 },
    )
    Object.defineProperty(res, 'url', {
      value: 'https://evil-clone.example.net/page', // final hop ≠ requested origin
      configurable: true,
    })
    mockFetch.mockResolvedValue(res)
    const out = await extractWithStealthEscalation('https://kbstar.com/login', { maxTokens: 1000 })
    expect(out.success).toBe(true)
    expect(out.metadata.security_warning).toContain('different registrable domain')
  })

  it('no warning when the fetch stayed on the requested registrable domain', async () => {
    const res = new Response(
      '<html><body><article><p>' +
        'substantial article body text for the redirect mismatch fixture. '.repeat(10) +
        '</p></article></body></html>',
      { status: 200 },
    )
    Object.defineProperty(res, 'url', { value: 'https://www.kbstar.com/login', configurable: true })
    mockFetch.mockResolvedValue(res)
    const out = await extractWithStealthEscalation('https://kbstar.com/login', { maxTokens: 1000 })
    expect(out.metadata.security_warning).toBeUndefined()
  })
})

describe('phishing-guard — title corroboration escalates soft signals', () => {
  it('blocks a shared-suffix host whose title claims a finance brand', () => {
    const a = assessUrlRisk('https://secure-portal.ph.com/login', { title: 'KB스타 인증센터 로그인' })
    expect(a.risk).toBe('block')
    expect(a.codes).toContain('BRAND_IMPERSONATION_IN_TITLE')
  })

  it('keeps a plain shared-suffix host at warn when the title has no brand claim', () => {
    const a = assessUrlRisk('https://some-shop.ph.com/products', { title: '할인샵' })
    expect(a.risk).toBe('warn')
  })
})
