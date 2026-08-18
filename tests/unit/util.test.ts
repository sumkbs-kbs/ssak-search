import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  assertSafeFetchUrl,
  isPublicHostname,
  normalizeUrl,
  simplifyQuery,
  computeScore,
  generateRelatedQueries,
  getDomainAuthority,
  safeFetchWithRedirects,
  naturalLanguageToKeywords,
} from '../../src/lib/util'

describe('normalizeUrl', () => {
  it('adds https:// to bare hostnames', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/path?q=1')).toBe('https://example.com/path?q=1')
  })

  it('preserves existing http/https', () => {
    expect(normalizeUrl('http://example.com')).toBe('http://example.com')
    expect(normalizeUrl('https://example.com')).toBe('https://example.com')
  })

  it('prefixes // with https:', () => {
    expect(normalizeUrl('//cdn.example.com/lib.js')).toBe('https://cdn.example.com/lib.js')
  })

  it('rejects non-http(s) schemes', () => {
    expect(() => normalizeUrl('file:///etc/passwd')).toThrow(/Unsupported URL scheme/)
    expect(() => normalizeUrl('javascript:alert(1)')).toThrow(/Unsupported URL scheme/)
    expect(() => normalizeUrl('data:text/html,<script>')).toThrow(/Unsupported URL scheme/)
    expect(() => normalizeUrl('ftp://example.com/')).toThrow(/Unsupported URL scheme/)
  })
})

describe('isPublicHostname', () => {
  // Public — should pass
  it('allows public domain hostnames', () => {
    expect(isPublicHostname('example.com')).toBe(true)
    expect(isPublicHostname('sub.example.co.uk')).toBe(true)
    expect(isPublicHostname('wikipedia.org')).toBe(true)
    expect(isPublicHostname('1.1.1.1')).toBe(true) // Cloudflare DNS, public
    expect(isPublicHostname('8.8.8.8')).toBe(true) // Google DNS, public
  })

  // Loopback
  it('blocks 127.0.0.0/8', () => {
    for (let i = 0; i < 256; i++) {
      expect(isPublicHostname(`127.0.${i}.1`)).toBe(false)
    }
    expect(isPublicHostname('localhost')).toBe(false)
    expect(isPublicHostname('myapp.localhost')).toBe(false)
  })

  // Private
  it('blocks 10.0.0.0/8', () => {
    expect(isPublicHostname('10.0.0.1')).toBe(false)
    expect(isPublicHostname('10.255.255.255')).toBe(false)
  })

  it('blocks 172.16.0.0/12', () => {
    expect(isPublicHostname('172.16.0.1')).toBe(false)
    expect(isPublicHostname('172.31.255.255')).toBe(false)
  })

  it('blocks 192.168.0.0/16', () => {
    expect(isPublicHostname('192.168.0.1')).toBe(false)
    expect(isPublicHostname('192.168.1.1')).toBe(false)
    expect(isPublicHostname('192.168.255.255')).toBe(false)
  })

  it('blocks 0.0.0.0/8', () => {
    expect(isPublicHostname('0.0.0.0')).toBe(false)
    expect(isPublicHostname('0.1.2.3')).toBe(false)
  })

  // Link-local / metadata
  it('blocks 169.254.0.0/16 (link-local + cloud metadata)', () => {
    expect(isPublicHostname('169.254.169.254')).toBe(false) // AWS/GCP metadata
    expect(isPublicHostname('169.254.1.1')).toBe(false)
  })

  it('blocks CGNAT 100.64.0.0/10', () => {
    expect(isPublicHostname('100.64.0.1')).toBe(false)
    expect(isPublicHostname('100.127.255.255')).toBe(false)
  })

  it('returns 0 for unknown domains', () => {
    expect(getDomainAuthority('https://example.com/test')).toBe(0)
    expect(getDomainAuthority('https://myblog.com/post')).toBe(0)
  })
})

describe('computeScore — symbol-bearing token preservation (B2 fix)', () => {
  it('matches S&P 500 against a title containing the literal ampersand', () => {
    // Regression: the old tokenizer stripped & → "s&p" became "sp", and a
    // search for "S&P 500" scored badly against titles that literally say
    // "S&P 500" (phrase bonus was the only thing catching it).
    const high = computeScore(
      'S&P 500 Index Funds — how they work',
      'S&P 500 index funds: the complete guide for 2026. Expense ratios, dividends.',
      'S&P 500 index funds',
    )
    const low = computeScore(
      'Why the 500 best albums are ranked',
      'The 500 best albums ranked by critics this year.',
      'S&P 500 index funds',
    )
    // Note: "500" alone also matches an unrelated "500 best albums" title
    // (0.27) — the fix is that "S&P 500 index funds" now CLEARLY outscores
    // it thanks to the preserved "s&p" token + phrase bonus, instead of
    // being dragged down to near-tie by the mangled "sp 500" tokenization.
    expect(high).toBeGreaterThan(low)
    expect(high - low).toBeGreaterThan(0.3)
  })

  it('keeps C++ / C# style tokens matchable', () => {
    const cpp = computeScore(
      'C++ reference — cppreference.com',
      'C++ standard library reference documentation.',
      'C++ reference',
    )
    const c = computeScore(
      'C programming language — intro',
      'The C programming language explained for beginners.',
      'C++ reference',
    )
    // "c++" must beat plain "c" for a C++ query.
    expect(cpp).toBeGreaterThan(c)
  })
})

describe('simplifyQuery', () => {
  it('keeps significant terms and strips filler', () => {
    expect(simplifyQuery('Cloudflare Workers D1 tutorial 2025')).toBe('cloudflare workers d1')
    // "practices" is a content word (not noise) — only filler is stripped.
    expect(simplifyQuery('React state management best practices')).toBe('react state management practices')
  })

  it('strips question auxiliaries before keyword simplification (en-fact-11 extension)', () => {
    // Every keyword-API consumer (HN/reddit/github/dbpedia/arxiv/stack-exchange)
    // funnels through simplifyQuery — the auxiliary must be gone so the API
    // matches on 'gps work', not 'does gps work' (45 vs 327 HN hits, live).
    expect(simplifyQuery('how does GPS work', 4)).toBe('gps work')
    expect(simplifyQuery('how do solar panels work', 5)).toBe('solar panels work')
    // 'what does DNA do' → 'what DNA do' → noise-strip 'what' → 'dna do'.
    // The trailing 'do' (verb) survives — only the question auxiliary is
    // guaranteed gone; the API now matches on the subject instead of 'does'.
    expect(simplifyQuery('what does DNA do', 4)).toBe('dna do')
  })

  it('leaves technical do/does phrases untouched in non-question queries', () => {
    // naturalLanguageToKeywords only fires on question-word + auxiliary;
    // 'do' is NOT in QUERY_NOISE_WORDS, so a bare technical phrase keeps it
    // intact ('do while loop' must not lose its keyword).
    expect(simplifyQuery('do while loop javascript', 5)).toBe('do while loop javascript')
    expect(simplifyQuery('haskell do notation', 5)).toBe('haskell do notation')
  })
})

describe('naturalLanguageToKeywords (en-fact-11: bing "does" keyword misfire)', () => {
  it('strips does/do/did after a question word', () => {
    expect(naturalLanguageToKeywords('how does GPS work')).toBe('how GPS work')
    expect(naturalLanguageToKeywords('how do solar panels work')).toBe('how solar panels work')
    expect(naturalLanguageToKeywords('why did the Titanic sink')).toBe('why the Titanic sink')
    expect(naturalLanguageToKeywords('what does DNA do')).toBe('what DNA do')
    expect(naturalLanguageToKeywords('where does pandas live')).toBe('where pandas live')
  })

  it('is case-insensitive', () => {
    expect(naturalLanguageToKeywords('How Does GPS Work')).toBe('How GPS Work')
    expect(naturalLanguageToKeywords('HOW DOES GPS WORK')).toBe('HOW GPS WORK')
  })

  it('KEEPS is/are/was/were — stripping them degrades results (live-verified)', () => {
    // "what is blockchain" is handled correctly by bing; the stripped
    // "what blockchain technology" returns qoo10/ja.wikipedia junk.
    expect(naturalLanguageToKeywords('what is blockchain')).toBe('what is blockchain')
    expect(naturalLanguageToKeywords('what is blockchain technology')).toBe('what is blockchain technology')
    expect(naturalLanguageToKeywords('why was the war fought')).toBe('why was the war fought')
  })

  it('leaves non-question and keyword queries untouched', () => {
    expect(naturalLanguageToKeywords('GPS navigation system')).toBe('GPS navigation system')
    expect(naturalLanguageToKeywords('does anyone sell GPS trackers')).toBe('does anyone sell GPS trackers')
    expect(naturalLanguageToKeywords('do does did grammar')).toBe('do does did grammar')
    expect(naturalLanguageToKeywords('site:youtube.com how does GPS work')).toBe('site:youtube.com how does GPS work')
  })

  it('never returns an empty or degenerate query', () => {
    // "how does" with nothing after → the trailing-token requirement fails,
    // so the query stays untouched rather than being reduced to just "how".
    expect(naturalLanguageToKeywords('how does')).toBe('how does')
    expect(naturalLanguageToKeywords('what do')).toBe('what do')
  })
})

describe('generateRelatedQueries — Korean comparison detection (byte-corruption regression)', () => {
  it('detects Korean comparison queries ending in 비교/차이/대비', () => {
    // Regression: the isComparison regex had a raw backspace byte (0x08) where
    // the closing \b word boundary belonged, so Korean comparison queries were
    // never detected and fell through to the default "정리/설명/최신" templates.
    const ko = generateRelatedQueries('React vs Vue 비교', [])
    expect(ko.some((q) => q.includes('장단점'))).toBe(true)
    expect(ko.some((q) => q.includes('대안'))).toBe(true)

    const ko2 = generateRelatedQueries('아이폰 vs 갤럭시 차이', [])
    expect(ko2.some((q) => q.includes('장단점'))).toBe(true)

    const ko3 = generateRelatedQueries('쿠팡과 네이버쇼핑 대비', [])
    expect(ko3.some((q) => q.includes('장단점'))).toBe(true)
  })

  it('still detects English comparison queries (vs)', () => {
    const en = generateRelatedQueries('Rust vs Go performance', [])
    expect(en.some((q) => q.includes('comparison'))).toBe(true)
    expect(en.some((q) => q.includes('pros and cons'))).toBe(true)
  })

  it('does not force comparison templates onto non-comparison Korean queries', () => {
    const plain = generateRelatedQueries('삼성전자 주가', [])
    expect(plain.some((q) => q.includes('장단점'))).toBe(false)
  })
})

describe('assertSafeFetchUrl — SSRF DNS-rebinding guards (P0-6 hardening)', () => {
  afterEach(() => vi.restoreAllMocks())

  const rcode3_body = Promise.resolve({ Status: 3, Answer: [] })
  const nxdomainStub = vi.fn().mockResolvedValue({ ok: true, json: () => rcode3_body })

  it('blocks a hostname whose DoH authoritatively returns NXDOMAIN (RFC1035 RCODE=3)', async () => {
    vi.stubGlobal('fetch', nxdomainStub)

    await expect(assertSafeFetchUrl('http://definitely-does-not-exist-98765.com')).rejects.toThrow(/NXDOMAIN/)
  })

  it('allows transient NOERROR + empty-answer responses (fail-open by design)', async () => {
    const noerror_body = Promise.resolve({ Status: 0 /* RFC1035 NOERROR */ }) // NOT a definitive NXDOMAIN → permitted to fail-open. Only downstream private-IP matches would then block.
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => noerror_body }))

    await assertSafeFetchUrl('http://transient.example.com') // resolves; only a resolved-to-private IP below would throw "Blocked hostname"
  })

  it('still validates every resolved IP — blocks DoH responses resolving to private addresses', async () => {
    const body_with_private_ip = Promise.resolve({ Status: 0, Answer: [{ type: 1 /* A */, data: '169.254.169.254' }] }) // AWS IMDSv1 metadata endpoint — must block

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => body_with_private_ip }))

    await expect(assertSafeFetchUrl('http://metadata.internal')).rejects.toThrow(/private|internal/)
  })

  it('blocks the classic DNS-rebinding pattern — attacker-controlled hostname resolves to loopback', async () => {
    const rebinding_body = Promise.resolve({
      Status: 0,
      Answer: [{ type: 1, data: '127.0.0.1' }],
    })

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: () => rebinding_body }))

    await expect(assertSafeFetchUrl('http://evil.attacker.com/admin')).rejects.toThrow(
      /private\/internal IP: 127\.0\.0\.1/,
    )
  })
})

describe('safeFetchWithRedirects (P0-2 SSRF redirect-pivot defense)', () => {
  afterEach(() => vi.restoreAllMocks())

  function stubFetchChain(statuses: Array<{ status: number; location?: string }>) {
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        calls.push(String(input))
        const step = statuses.shift()
        if (!step) throw new Error('unexpected extra fetch call')
        if (step.status >= 300 && step.status < 400) {
          return new Response(null, { status: step.status, headers: { location: step.location ?? '' } })
        }
        return new Response('ok', { status: step.status })
      }),
    )
    return calls
  }

  it('re-validates every redirect hop and follows with redirect:manual', async () => {
    const calls = stubFetchChain([{ status: 301, location: 'https://public.example/next' }, { status: 200 }])
    const validated: string[] = []
    const validate = vi.fn().mockImplementation(async (u: string) => {
      validated.push(u)
    })

    const resp = await safeFetchWithRedirects(undefined, 'https://example.com/start', {}, { validate })

    expect(resp.status).toBe(200)
    expect(validated).toEqual(['https://example.com/start', 'https://public.example/next'])
    // Every hop is fetched with manual redirect handling — never internal follow.
    expect(calls).toEqual(['https://example.com/start', 'https://public.example/next'])
  })

  it('aborts the chain when a redirect target fails the SSRF guard (private IP hop)', async () => {
    stubFetchChain([{ status: 302, location: 'http://127.0.0.1/admin' }])
    const validate = vi.fn().mockImplementation(async (u: string) => {
      if (u.includes('127.0.0.1')) throw new Error(`Blocked hostname (SSRF guard): 127.0.0.1`)
    })

    await expect(safeFetchWithRedirects(undefined, 'https://example.com/start', {}, { validate })).rejects.toThrow(
      /Blocked hostname/,
    )
    // The private hop must never be fetched.
    expect(vi.mocked(fetch).mock.calls.map((c) => String(c[0]))).toEqual(['https://example.com/start'])
  })

  it('enforces the redirect hop limit', async () => {
    stubFetchChain([
      { status: 301, location: 'https://a.example/1' },
      { status: 301, location: 'https://b.example/2' },
      { status: 301, location: 'https://c.example/3' },
      { status: 301, location: 'https://d.example/4' },
      { status: 301, location: 'https://e.example/5' },
      { status: 301, location: 'https://f.example/6' },
    ])
    const validate = vi.fn().mockResolvedValue(undefined)

    await expect(
      safeFetchWithRedirects(undefined, 'https://example.com/start', {}, { maxRedirects: 5, validate }),
    ).rejects.toThrow(/redirect limit exceeded \(5 hops\)/)
  })

  it('returns 3xx as-is when no Location header is present', async () => {
    stubFetchChain([{ status: 304 }])
    const validate = vi.fn().mockResolvedValue(undefined)
    const resp = await safeFetchWithRedirects(undefined, 'https://example.com/start', {}, { validate })
    expect(resp.status).toBe(304)
  })
})
