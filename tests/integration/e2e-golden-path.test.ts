/**
 * E2E Golden-Path Test — search → extract → answer through the FULL HTTP stack.
 *
 * Closes the "E2E 테스트 부재" gap (ANALYSIS_REPORT #56, CEO_MASTER_PLAN
 * "E2E 시나리오 부족"): no test previously exercised the complete agent
 * workflow (POST /api/search → POST /api/extract → answer) through the real
 * Hono middleware stack (auth, rate-limit, subrequest tracking, caching)
 * inside the workerd runtime.
 *
 * Deterministic by design: globalThis.fetch is mocked (same pattern as
 * orchestrator.test.ts), so NO external network is touched — the test can
 * never flake on upstream rate limits, and it pins the Tavily-compatible
 * response contract (query / results / answer / cached / X-Cache).
 *
 * Also guards the "cache hit rate 0%" finding (BENCHMARK_RESULTS 3.4):
 * test 2 proves a second identical request is served from the response
 * cache (cached: true + X-Cache: HIT) with ZERO additional backend fetches.
 *
 * Run: npx vitest run --config vitest.integration.config.ts -t "E2E Golden Path"
 */

import { exports } from 'cloudflare:workers'
import { describe, it, expect, vi } from 'vitest'

interface WorkerModule {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}
const worker = (exports as unknown as { default: WorkerModule }).default

// ---------------------------------------------------------------------------
// Deterministic backend fixtures
// ---------------------------------------------------------------------------

const GOLD_URL_1 = 'https://example.com/quantum-computing'
const GOLD_URL_2 = 'https://example.com/qubits-explained'

const BING_HTML = `
<!DOCTYPE html>
<html><body>
  <ol id="b_results">
    <li class="b_algo">
      <div class="b_algoheader">
        <a href="${GOLD_URL_1}">Quantum Computing - Example</a>
      </div>
      <div class="b_caption"><p class="b_lineclamp3">Quantum computing uses quantum bits to process information in parallel.</p></div>
    </li>
    <li class="b_algo">
      <div class="b_algoheader">
        <a href="${GOLD_URL_2}">Qubits Explained - Example</a>
      </div>
      <div class="b_caption"><p class="b_lineclamp3">An explanation of qubits, superposition and entanglement for beginners.</p></div>
    </li>
  </ol>
</body></html>
`

const JINA_CONTENT =
  'Quantum computing is a type of computation that uses quantum-mechanical ' +
  'phenomena such as superposition and entanglement to perform operations on data. ' +
  'This is the golden-path article body served by the mocked Jina reader.'

const DDG_ABSTRACT =
  'Quantum computing is a type of computation that uses quantum-mechanical ' +
  'phenomena such as superposition and entanglement to perform operations on data.'

// Host-level call counters — assert no extra backend work on cache hits.
const fetchCounts = new Map<string, number>()
function countHost(url: string): void {
  try {
    const host = new URL(url).host
    fetchCounts.set(host, (fetchCounts.get(host) ?? 0) + 1)
  } catch {
    // non-URL input — ignore
  }
}

function jinaResponse(url: string): Response {
  return new Response(
    JSON.stringify({
      data: {
        title: 'Golden Path Article',
        content: JINA_CONTENT,
        images: [],
      },
      // Echo which URL was read so the test can prove the right page was fetched.
      url,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

const mockFetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit): Promise<Response> => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
  countHost(url)

  if (url.startsWith('https://www.bing.com/search')) {
    return new Response(BING_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    })
  }
  if (url.startsWith('https://r.jina.ai/')) {
    return jinaResponse(url)
  }
  if (url.startsWith('https://api.duckduckgo.com/')) {
    return new Response(
      JSON.stringify({
        AbstractText: DDG_ABSTRACT,
        AbstractSource: 'Wikipedia',
        AbstractURL: 'https://en.wikipedia.org/wiki/Quantum_computing',
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    )
  }
  // Every other backend (wikipedia, github, HN, reddit, arxiv, naver, DDG html,
  // dbpedia mirror, ...) fails gracefully — the orchestrator is designed to
  // serve partial results when individual backends 404.
  return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain' } })
})

// Module-scope install: this test file runs in its own workerd isolate
// (vitest-pool-workers), so the mock cannot leak into other test files.
globalThis.fetch = mockFetch

// ---------------------------------------------------------------------------
// Helpers (same conventions as api.test.ts)
// ---------------------------------------------------------------------------

// The workerd pool runs every API test through ONE isolate with the same
// client IP; unique X-Forwarded-For keeps per-IP rate-limit keys isolated.
let requestSeq = 100
function withUniqueIp(init?: RequestInit): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set('X-Forwarded-For', `198.51.100.${(requestSeq++ % 250) + 1}`)
  return { ...init, headers }
}

async function fetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; headers: Headers; body: unknown }> {
  // The test worker declares SEARCH_API_KEY (see vitest.e2e.config.ts) and
  // auth.ts is fail-closed — every request carries the test tenant key.
  const initWithAuth = withUniqueIp(init)
  const headers = new Headers(initWithAuth.headers)
  if (!headers.has('X-API-Key')) headers.set('X-API-Key', 'test-key')
  initWithAuth.headers = headers
  const res = await worker.fetch(`https://ssak-search.pages.dev${path}`, initWithAuth)
  const text = await res.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    body = text
  }
  return { status: res.status, headers: res.headers, body }
}

interface SearchResponseBody {
  query?: string
  answer?: { text?: string; confidence?: number; sources?: unknown[] }
  results?: Array<{ title: string; url: string; content: string; score: number; domain: string }>
  response_time_ms?: number
  backend?: string
  fallback_used?: boolean
  cached?: boolean
  page?: number
  page_size?: number
  total_results?: number
  total_pages?: number
  no_results?: boolean
}

const SEARCH_BODY = {
  query: 'quantum computing',
  max_results: 5,
  search_depth: 'basic',
}

/**
 * The route writes the response cache via executionCtx.waitUntil (async), so
 * the very next request can race the write. Poll until the cache layer
 * actually serves the response — bounded, so a real regression still fails.
 */
async function waitForCachedSearch(
  body: Record<string, unknown>,
  attempts = 20,
  delayMs = 100,
): Promise<{ status: number; headers: Headers; body: SearchResponseBody; attempts: number }> {
  for (let i = 1; i <= attempts; i++) {
    const out = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (out.status === 200 && (out.body as SearchResponseBody).cached === true) {
      return { ...out, body: out.body as SearchResponseBody, attempts: i }
    }
    await new Promise((r) => setTimeout(r, delayMs))
  }
  const out = await fetchJson('/api/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { ...out, body: out.body as SearchResponseBody, attempts: attempts + 1 }
}

// ---------------------------------------------------------------------------
// E2E Golden Path
// ---------------------------------------------------------------------------

describe('E2E Golden Path (search → extract → answer)', () => {
  it('1. search: full HTTP stack returns Tavily-compatible results from the backend', async () => {
    const { status, body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(SEARCH_BODY),
    })
    const data = body as SearchResponseBody

    expect(status).toBe(200)
    // First call — must be a fresh computation, not a cache replay.
    expect(data.cached).not.toBe(true)
    expect(data.query).toBe('quantum computing')
    expect(Array.isArray(data.results)).toBe(true)
    expect(data.results && data.results.length).toBeGreaterThan(0)
    expect(data.no_results).toBe(false)
    expect(typeof data.response_time_ms).toBe('number')
    expect(data.backend).toBeDefined()
    expect(data.backend).toContain('bing')
    expect(data.fallback_used).toBe(false)
    expect(data.page).toBe(1)
    expect(data.page_size).toBe(5)
    expect(typeof data.total_results).toBe('number')
    expect(typeof data.total_pages).toBe('number')

    // Every result must carry the full Tavily contract fields.
    for (const r of data.results!) {
      expect(r.url).toMatch(/^https?:\/\//)
      expect(r.title.length).toBeGreaterThan(0)
      expect(typeof r.score).toBe('number')
      expect(r.domain).toContain('.')
    }

    // The mocked Bing fixture must be what actually surfaced.
    const urls = data.results!.map((r) => r.url)
    expect(urls).toContain(GOLD_URL_1)
    expect(urls).toContain(GOLD_URL_2)
  })

  it('2. cache round-trip: identical second request is served from cache with zero backend work', async () => {
    const bingBefore = fetchCounts.get('www.bing.com') ?? 0

    const { status, body, attempts } = await waitForCachedSearch(SEARCH_BODY)
    const data = body

    expect(status).toBe(200)
    expect(attempts).toBeLessThanOrEqual(20) // bounded — a real miss would exhaust retries
    expect(data.cached).toBe(true)
    // Cached response must be byte-equivalent in results (same top hits).
    expect(data.results && data.results.length).toBeGreaterThan(0)
    expect(data.results!.map((r) => r.url)).toContain(GOLD_URL_1)

    // The cache must have absorbed the request — NO new Bing fetch.
    const bingAfter = fetchCounts.get('www.bing.com') ?? 0
    expect(bingAfter).toBe(bingBefore)
  })

  it('3. cache key isolation: different params (max_results) are NOT served from the same entry', async () => {
    const bingBefore = fetchCounts.get('www.bing.com') ?? 0

    const { status, body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SEARCH_BODY, max_results: 2 }),
    })
    const data = body as SearchResponseBody

    expect(status).toBe(200)
    // A different max_results must recompute — never a stale 5-result cache.
    expect(data.cached).not.toBe(true)
    expect(data.page_size).toBe(2)
    const bingAfter = fetchCounts.get('www.bing.com') ?? 0
    expect(bingAfter).toBeGreaterThan(bingBefore)
  })

  it('4. answer: include_answer=true produces a non-empty answer through the full pipeline', async () => {
    const { status, body } = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...SEARCH_BODY, max_results: 3, include_answer: true }),
    })
    const data = body as SearchResponseBody

    expect(status).toBe(200)
    expect(data.answer).toBeDefined()
    expect(typeof data.answer?.text).toBe('string')
    const answerText = data.answer?.text ?? ''
    expect(answerText.length).toBeGreaterThan(50)
    // The mocked DDG instant answer must be the source of the text.
    expect(answerText).toContain('quantum-mechanical')
    expect(data.results && data.results.length).toBeGreaterThan(0)
  })

  it('5. extract: POST /api/extract returns clean content for a search-result URL', async () => {
    const { status, body } = await fetchJson('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [GOLD_URL_1] }),
    })
    const data = body as {
      results?: Array<{ url: string; title?: string; raw_content: string; success: boolean }>
      response_time_ms?: number
      failed_results?: unknown[]
    }

    expect(status).toBe(200)
    expect(Array.isArray(data.results)).toBe(true)
    expect(data.results!.length).toBe(1)
    expect(data.results![0].url).toBe(GOLD_URL_1)
    expect(data.results![0].success).toBe(true)
    expect(data.results![0].raw_content).toContain('golden-path article body')
    expect(data.results![0].title).toBe('Golden Path Article')
    expect(typeof data.response_time_ms).toBe('number')
  })

  it('6. full chain: search → top result → extract (the agent workflow end to end)', async () => {
    // Step A — search.
    const search = await fetchJson('/api/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'quantum computing', max_results: 3, search_depth: 'basic' }),
    })
    expect(search.status).toBe(200)
    const results = (search.body as SearchResponseBody).results!
    expect(results.length).toBeGreaterThan(0)
    const topUrl = results[0].url

    // Step B — extract the top result (exactly what an agent does next).
    const extract = await fetchJson('/api/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ urls: [topUrl] }),
    })
    expect(extract.status).toBe(200)
    const extracted = (extract.body as { results: Array<{ url: string; success: boolean; raw_content: string }> })
      .results
    expect(extracted.length).toBe(1)
    expect(extracted[0].url).toBe(topUrl)
    expect(extracted[0].success).toBe(true)
    expect(extracted[0].raw_content.length).toBeGreaterThan(50)
  })
})
