/**
 * Naver News Search Backend (No API Key Required)
 *
 * Dedicated Korean news backend hitting Naver's NEWS search endpoint
 * (where=m_news). The general naverSearch backend (where=m) is the PRIMARY
 * Korean source but surfaces mostly blogs/cafes for news queries — eval showed
 * kr-news-02/04 returning zero n.news.naver.com articles in the top 10 (NDCG
 * 0.000), because blog posts outranked articles before the per-context news
 * authority bonus existed.
 *
 * This backend collects ONLY n.news.naver.com article links (the gold domain
 * for all kr-news eval queries) with their media source, publish time, and
 * snippet. Combined with the KOREAN_NEWS_AUTHORITY bonus in ranking.ts
 * (+0.18 for n.news.naver.com on korean news queries) and the
 * KOREAN_BLOG_PENALTY_NEWS demotion, real news articles surface above blogs.
 *
 * Endpoint: https://m.search.naver.com/search.naver?where=m_news&query=...
 * UA: iPhone Safari (mobile)
 */

import type { SearchResult, Env, ExtractedContent } from '../types'
import { logger, toError } from './logger'
import {
  fetchWithTimeout,
  extractDomain,
  stripHtml,
  decodeEntities,
  computeScore,
  truncateToTokens,
  parseFlexibleDate,
  parseRelativeTime,
} from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'
import { BACKEND_TIMEOUT_MS } from './search/fanout'

// ============================================================
// Naver News Result Cache (LRU + TTL)
// ============================================================

interface NaverNewsCacheEntry {
  results: SearchResult[]
  createdAt: number
  hitCount: number
}

const NAVER_NEWS_CACHE = new Map<string, NaverNewsCacheEntry>()
const NAVER_NEWS_CACHE_MAX = 100 // max cached queries
const NAVER_NEWS_CACHE_TTL_MS = 180_000 // 3 minutes (news is time-sensitive)

function naverNewsCacheKey(query: string, maxResults: number, sortByRecency: boolean): string {
  return `${query.trim().toLowerCase().replace(/\s+/g, ' ')}:${maxResults}:${sortByRecency ? 'r' : 'rel'}`
}

function naverNewsCacheGet(key: string): SearchResult[] | null {
  const entry = NAVER_NEWS_CACHE.get(key)
  if (!entry) return null
  if (Date.now() - entry.createdAt > NAVER_NEWS_CACHE_TTL_MS) {
    NAVER_NEWS_CACHE.delete(key)
    return null
  }
  entry.hitCount++
  return entry.results
}

function naverNewsCacheSet(key: string, results: SearchResult[]): void {
  if (NAVER_NEWS_CACHE.size >= NAVER_NEWS_CACHE_MAX) {
    let leastKey = ''
    let leastHits = Infinity
    for (const [k, v] of NAVER_NEWS_CACHE) {
      if (v.hitCount < leastHits) {
        leastHits = v.hitCount
        leastKey = k
      }
    }
    if (leastKey) NAVER_NEWS_CACHE.delete(leastKey)
  }
  NAVER_NEWS_CACHE.set(key, { results, createdAt: Date.now(), hitCount: 0 })
}

const NAVER_NEWS_SEARCH_URL = 'https://m.search.naver.com/search.naver'

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** Thrown for a transient Naver throttle/overload status (429/5xx) so withRetry retries it. */
class NaverNewsThrottledError extends Error {
  readonly status: number
  constructor(status: number) {
    super(`Naver news HTTP ${status}`)
    this.status = status
    this.name = 'NaverNewsThrottledError'
  }
}

export interface NaverNewsSearchOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
  /**
   * Recency intent (최신순). When true the backend fetches the sort=1
   * (newest-first) page IN PARALLEL with the default relevance page and
   * merges them. The relevance page keeps broad coverage (7–21 unique
   * articles) while the recency page guarantees genuinely fresh articles are
   * in the pool — downstream news ranking (recency-dominant) then lifts them
   * to the top. Never fetch ONLY sort=1: it returns ~4 unique articles.
   */
  sortByRecency?: boolean
}

/**
 * Korean news recency markers — queries containing these mean the user wants
 * the LATEST articles, not Naver's relevance-sorted (often week-old) picks.
 */
const RECENCY_MARKERS = [
  '최신',
  '최근',
  '오늘',
  '속보',
  '실시간',
  '오늘자',
  '오늘의',
  '이번주',
  '이번 주',
  '방금',
  '업데이트',
  'breaking',
  'latest',
  'today',
  'recent',
  'newest',
]

/**
 * Detect recency intent in a (typically Korean) news query.
 * Exported for unit tests.
 */
export function isRecencyNewsQuery(query: string): boolean {
  const q = query.toLowerCase()
  return RECENCY_MARKERS.some((m) => q.includes(m))
}

/**
 * Search Naver NEWS (where=m_news) and return only n.news.naver.com articles.
 * No API key required. Best for Korean news queries.
 *
 * When sortByRecency is set, fetches BOTH the relevance page (coverage) and
 * the sort=1 newest-first page (freshness) in parallel and merges them —
 * see NaverNewsSearchOptions.sortByRecency for the rationale.
 */
export async function naverNewsSearch(query: string, opts: NaverNewsSearchOptions = {}): Promise<SearchResult[]> {
  const { sortByRecency = false, maxResults = 15 } = opts

  // Check cache first
  const cacheKey = naverNewsCacheKey(query, maxResults, sortByRecency)
  const cached = naverNewsCacheGet(cacheKey)
  if (cached) {
    logger.debug('[NaverNews] Cache hit', { query: query.slice(0, 50) })
    return cached
  }

  let finalResults: SearchResult[]

  // Recency intent: dual-fetch relevance + 최신순, then merge. Each page goes
  // through fetchNaverNewsPage (own retry/backoff). Both run concurrently so
  // wall time stays ≈ max(page1, page2), not the sum.
  if (sortByRecency) {
    const [relevance, recency] = await Promise.all([
      fetchNaverNewsPage(query, opts, false),
      fetchNaverNewsPage(query, opts, true),
    ])
    finalResults = mergeNaverNewsPages(relevance, recency, maxResults)
  } else {
    finalResults = await fetchNaverNewsPage(query, opts, false)
  }

  // Cache successful results
  if (finalResults.length > 0) {
    naverNewsCacheSet(cacheKey, finalResults)
  }

  return finalResults
}

/**
 * Fetch + parse ONE Naver m_news page. sortByRecency=true appends sort=1
 * (최신순). Contains the retry/backoff logic (moved here from naverNewsSearch
 * so a dual-fetch retries each page independently instead of the whole batch).
 */
async function fetchNaverNewsPage(
  query: string,
  opts: NaverNewsSearchOptions,
  sortByRecency: boolean,
): Promise<SearchResult[]> {
  const { maxResults = 15, timeoutMs = 12000, env } = opts
  const results: SearchResult[] = []

  // Ceiling-safe per-attempt budget: fanout's naver-news ceiling is 4000ms;
  // with the 1200ms beat reserved, (4000−1200)/2 = 1400ms per attempt makes
  // the chain's worst case (2 timeouts + beat) land exactly on the ceiling.
  // In recency dual-fetch the two pages run in PARALLEL, so wall time is
  // max(page1, page2) = 4000ms — still inside the fanout window.
  const naverNewsCeiling = BACKEND_TIMEOUT_MS['naver-news'] ?? 4000
  const perAttempt = splitRetryBudget(Math.min(timeoutMs, naverNewsCeiling), 2, 1200, 500)

  try {
    const params = new URLSearchParams()
    params.append('query', query)
    params.append('where', 'm_news')
    params.append('sm', 'mtb_nws')
    // sort=1 = 최신순 (newest first). Only used when recency intent is
    // detected AND only as one half of a dual-fetch — on its own it returns
    // too few unique articles (~4 vs 7–21 relevance), which would starve the
    // eval gold domains (the Phase 6.2 finding).
    if (sortByRecency) params.append('sort', '1')

    // Retry once on 429 (throttle) or 5xx (overload) with a beat, via the
    // shared withRetry decorator. The old `_retry` recursion guard is replaced
    // by maxRetries=1 — the second attempt never retries again. 403
    // (Cloudflare challenge) and other 4xx fail fast (returned, handled
    // below); network/timeout errors are NOT retried (matches the old catch).
    const response = await withRetry(
      async () => {
        const res = await fetchWithTimeout(
          env,
          `${NAVER_NEWS_SEARCH_URL}?${params.toString()}`,
          {
            method: 'GET',
            headers: {
              'User-Agent': MOBILE_UA,
              Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
              'Cache-Control': 'no-cache',
            },
          },
          perAttempt,
        )
        if (res.ok) return res
        if (res.status === 429 || res.status >= 500) {
          throw new NaverNewsThrottledError(res.status)
        }
        return res // 403 / other 4xx — fail fast
      },
      {
        maxRetries: 1,
        delaysMs: [1200], // ceiling-safe beat (see perAttempt above)
        jitter: false,
        retryable: (err) => err instanceof NaverNewsThrottledError,
        onRetry: (_attempt, _delayMs, err) => {
          const status = err instanceof NaverNewsThrottledError ? err.status : '?'
          logger.info(`[ssak] Retrying Naver news (status=${status})`)
        },
      },
    ).catch((err) => {
      // Network error / timeout — not retryable, matches the old outer catch.
      logger.warn('Naver news search failed:', { error: toError(err) })
      return null
    })

    if (!response) return results
    if (!response.ok) {
      if (response.status === 403) {
        logger.warn('[ssak] Naver news returned 403 — Cloudflare challenge detected; skipping this backend')
      } else {
        logger.warn('[ssak] Naver news non-OK:', { status: response.status })
      }
      return results
    }

    const html = await response.text()
    return parseNaverNewsHtml(html, query, maxResults)
  } catch (err) {
    logger.warn('Naver news search failed:', { error: toError(err) })
  }

  return results
}

/**
 * Merge a relevance page + a recency page: dedupe by URL keeping the highest
 * score, cap at maxResults. Fresh articles from the sort=1 page survive
 * because downstream ranking re-sorts news by recency anyway — here we just
 * guarantee they're present in the pool alongside the relevance coverage.
 * Exported for unit tests.
 */
export function mergeNaverNewsPages(
  relevance: SearchResult[],
  recency: SearchResult[],
  maxResults: number,
): SearchResult[] {
  const byUrl = new Map<string, SearchResult>()
  // Iterate recency FIRST so that when the maxResults cap binds, the sort=1
  // (fresh) articles survive instead of being evicted by the relevance page's
  // (often week-old) picks. Downstream news ranking re-sorts by recency
  // anyway, so pool order doesn't matter — membership does.
  for (const r of [...recency, ...relevance]) {
    const existing = byUrl.get(r.url)
    if (!existing || r.score > existing.score) byUrl.set(r.url, r)
  }
  return [...byUrl.values()].slice(0, maxResults)
}

// ============================================================
// Article body extraction — research/chat pipeline evidence
// ============================================================

/**
 * True when the URL is a Naver news article page (n.news.naver.com/article/...).
 * Used by the extractor to route Naver article URLs to the dedicated article
 * body extraction path instead of generic readers, which often return shell
 * HTML / dynamic-content stubs for Naver's JS-rendered article pages.
 * Exported for unit tests.
 */
export function isNaverNewsUrl(input: string): boolean {
  if (!input || typeof input !== 'string') return false
  try {
    const url = new URL(input.trim())
    return url.hostname === 'n.news.naver.com' && /^\/article\//.test(url.pathname)
  } catch {
    return false
  }
}

/**
 * Normalize a Naver article timestamp to ISO 8601 UTC.
 *
 * Handles the timestamp formats Naver actually emits (verified by live
 * probing, Phase 6.5) plus the relative/datestamp forms seen in the wild
 * (Phase 6.8):
 *   "2026-08-04 14:18:13"            — span data-date-time, KST local
 *   "2026-08-04T14:18:13+09:00"      — article:published_time meta
 *   "20260804141813"                 — og:regDate compact form, KST
 *   "2026.08.04. 오후 2:18"           — datestamp span display text, KST
 *   "2026-08-04"                     — date-only (midnight KST)
 *   "방금 전" / "5분 전" / "1시간 전" / "어제" — relative time, resolved
 *                                          against `now`
 *
 * KST-local strings are interpreted as +09:00 (Naver publishes in Korean
 * standard time). Relative strings delegate to parseRelativeTime (util.ts —
 * the same resolver the search-result parser uses) so a freshness timestamp
 * never silently drops out of the evidence block. Returns undefined when
 * nothing parseable is given.
 * EXPORTED FOR TESTING.
 */
export function parseNaverArticleDate(raw: string, now: number = Date.now()): string | undefined {
  const s = (raw || '').trim()
  if (!s) return undefined

  let iso: string | null = null
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    // "2026-08-04T14:18:13+09:00" / "2026-08-04T14:18+09:00" / "...Z" —
    // already zoned ISO (seconds optional), passthrough
    iso = s
  } else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(s)) {
    // "2026-08-04 14:18:13" — KST local time, no zone → treat as +09:00
    iso = `${s.replace(' ', 'T')}${s.length === 16 ? ':00' : ''}+09:00`
  } else if (/^\d{14}$/.test(s)) {
    // "20260804141813" — compact KST
    iso = `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}+09:00`
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    // "2026-08-04" — date-only, midnight KST
    iso = `${s}T00:00:00+09:00`
  } else if (/^\d{4}\.\d{2}\.\d{2}\.?\s*(오전|오후)\s*\d{1,2}:\d{2}/.test(s)) {
    // "2026.08.04. 오후 2:18" — the datestamp span's human-readable display
    // text (KST, 12h clock). Convert to 24h, then treat as KST.
    const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})\.?\s*(오전|오후)\s*(\d{1,2}):(\d{2})/)
    if (m) {
      let hour = Number(m[5])
      if (m[4] === '오후' && hour !== 12) hour += 12
      if (m[4] === '오전' && hour === 12) hour = 0
      iso = `${m[1]}-${m[2]}-${m[3]}T${String(hour).padStart(2, '0')}:${m[6]}:00+09:00`
    }
  } else if (/^\d{4}\.\d{2}\.\d{2}\.?$/.test(s)) {
    // "2026.08.04." — dot-separated date-only
    const m = s.match(/^(\d{4})\.(\d{2})\.(\d{2})\.?$/)
    if (m) iso = `${m[1]}-${m[2]}-${m[3]}T00:00:00+09:00`
  }

  if (iso !== null) {
    const d = new Date(iso)
    if (!isNaN(d.getTime())) return d.toISOString()
  }

  // Relative time ("방금 전", "5분 전", "1시간 전", "어제", ...) — resolved
  // against `now` so "방금 전" is not treated as 1970. This covers datestamp
  // spans that render relative labels instead of absolute times.
  const rel = parseRelativeTime(s, now)
  if (rel) return rel

  return undefined
}

/**
 * Parse the article body out of a Naver news article page (n.news.naver.com).
 *
 * Live probing (Phase 6.4) showed Naver article pages embed the full body in:
 *   <article id="dic_area" class="go_trans _article_content">…</article>
 * with paragraphs separated by <br><br>, a summary in <strong class=
 * "media_end_summary">, and subheadings in <div class="ab_sub_heading">.
 * og:title / og:description meta supply the headline + lead as a fallback.
 *
 * The publish time comes from the datestamp span the mobile page renders:
 *   <span class="media_end_head_info_datestamp_time _ARTICLE_DATE_TIME"
 *         data-date-time="2026-08-04 14:18:13">2026.08.04. 오후 2:18</span>
 * with article:published_time / og:regDate meta as fallbacks — so the
 * research/chat evidence can state WHEN the article was published (freshness
 * judgment for news queries).
 *
 * EXPORTED FOR TESTING — parser regression detection.
 */
export function parseNaverArticleHtml(html: string): {
  title: string
  summary: string
  body: string
  datePublished?: string
} {
  let title = ''
  const ogTitle = html.match(/<meta[^>]*property="og:title"[^>]*content="([^"]*)"/)
  if (ogTitle) title = decodeEntities(ogTitle[1]).trim()
  if (!title) {
    const t = html.match(/<title>([^<]*)<\/title>/)
    if (t) title = decodeEntities(t[1]).trim()
  }

  // Summary (media_end_summary) — the article's lede, separate from the body.
  let summary = ''
  const s = html.match(/<strong[^>]*class="media_end_summary"[^>]*>([\s\S]*?)<\/strong>/i)
  if (s) summary = decodeEntities(stripHtml(s[1])).replace(/\s+/g, ' ').trim()

  // Body: <article id="dic_area">…</article>. If missing, fall back to the
  // og:description lead (still valuable evidence over nothing).
  // NOTE: media_end_summary lives INSIDE dic_area, so it is stripped from the
  // body HTML here to avoid duplicating the lede in the evidence block
  // (Summary line + body would otherwise repeat the same text).
  let body = ''
  const article = html.match(/<article[^>]*id="dic_area"[^>]*>([\s\S]*?)<\/article>/i)
  if (article) {
    const bodyHtml = article[1].replace(/<strong[^>]*class="media_end_summary"[^>]*>[\s\S]*?<\/strong>/i, '')
    // stripHtml already converts <br>/<p> block tags to \n and collapses
    // runs of newlines — no additional <br> handling needed here.
    body = decodeEntities(stripHtml(bodyHtml)).trim()
  }
  if (!body) {
    const ogDesc = html.match(/<meta[^>]*property="og:description"[^>]*content="([^"]*)"/)
    if (ogDesc) body = decodeEntities(ogDesc[1]).trim()
  }

  // Published time — primary: the _ARTICLE_DATE_TIME span's data-date-time
  // (verified live, Phase 6.5). Fallbacks: the span's own display text
  // ("2026.08.04. 오후 2:18" — now parseable via parseNaverArticleDate),
  // then article:published_time meta, then the compact og:regDate meta.
  // Normalized to ISO UTC via parseNaverArticleDate.
  // NOTE: the span regex is deliberately attribute-ORDER independent — matching
  // the whole tag by class token and pulling data-date-time anywhere in it, so
  // Naver reshuffling attribute order can't silently drop the publish date.
  let datePublished: string | undefined
  const dt = html.match(/<[^>]*_ARTICLE_DATE_TIME[^>]*data-date-time="([^"]+)"/)
  if (dt) datePublished = parseNaverArticleDate(dt[1])
  if (!datePublished) {
    // Some render paths omit data-date-time but keep the display text, which
    // still carries the full KST date ("2026.08.04. 오후 2:18").
    const display = html.match(/<[^>]*_ARTICLE_DATE_TIME[^>]*>([^<]{8,})</)
    if (display) datePublished = parseNaverArticleDate(display[1])
  }
  if (!datePublished) {
    const meta = html.match(/<meta[^>]*property="article:published_time"[^>]*content="([^"]*)"/)
    if (meta) datePublished = parseNaverArticleDate(meta[1])
  }
  if (!datePublished) {
    const reg = html.match(/<meta[^>]*property="og:regDate"[^>]*content="([^"]*)"/)
    if (reg) datePublished = parseNaverArticleDate(reg[1])
  }

  return {
    title,
    summary,
    body,
    ...(datePublished ? { datePublished } : {}),
  }
}

/**
 * Format a parsed Naver article into a self-contained evidence block for the
 * research/chat pipeline — headline, summary (lede), and the full body,
 * truncated to maxTokens. Exported separately from naverNewsExtract so it can
 * be unit-tested without network access.
 */
export function buildNaverNewsEvidenceText(
  parsed: { title: string; summary: string; body: string; datePublished?: string },
  opts: { maxTokens?: number } = {},
): string {
  const { maxTokens = 4000 } = opts
  const parts: string[] = []

  if (parsed.title) parts.push(`Title: ${parsed.title}`)
  // Publish date so the LLM can judge article freshness (news queries hinge
  // on how recent a source is — a week-old article is weak evidence for
  // "최신" intent). ISO UTC is unambiguous across locales.
  if (parsed.datePublished) parts.push(`Published: ${parsed.datePublished}`)
  if (parsed.summary) parts.push(`Summary: ${parsed.summary}`)
  if (parsed.body) parts.push(`Article body:\n${parsed.body}`)

  return truncateToTokens(parts.join('\n\n'), maxTokens)
}

/**
 * Extract a Naver news article's full body as evidence content, shaped like
 * extractor.ts's ExtractedContent so n.news.naver.com URLs are handled as a
 * first-class strategy in the content extraction pipeline.
 *
 * This is what makes research/chat evidence work for Naver article links:
 * the orchestrator's include_raw_content path extracts every result via
 * extractContent(), and generic readers (Jina / HTMLRewriter / sidecar) can
 * return shell HTML for Naver's JS-rendered article pages. This path parses
 * the embedded dic_area article body directly, so LLM synthesis gets real
 * article text.
 *
 * @param url An n.news.naver.com/article/... URL
 * @param opts.maxTokens Cap on the returned evidence text (default 4000)
 * @param opts.timeoutMs Combined timeout for the article page fetch
 */
export async function naverNewsExtract(
  url: string,
  opts: { maxTokens?: number; timeoutMs?: number; env?: Env } = {},
): Promise<ExtractedContent> {
  const { maxTokens = 4000, timeoutMs = 15000, env } = opts
  if (!isNaverNewsUrl(url)) {
    return { url, raw_content: '', success: false, error: 'Not a Naver news article URL' }
  }

  // Transient-failure retry + backoff, mirroring fetchYahooJson (Phase 6.1):
  // Naver intermittently returns 429/5xx under fan-out, and a single dropped
  // article fetch silently removed the body evidence from the pool — the
  // en-stock-06-style availability noise for the research/chat pipeline.
  // Only transient statuses (429, 5xx) and network/timeout errors are
  // retried; 4xx (genuinely missing) fail fast. The caller's total timeout
  // budget is split across attempts so the retry chain can't balloon past
  // the extractor's ceiling. The retry policy is the shared withRetry
  // decorator with the same hand-tuned 150/350ms beat as the old loop.
  const maxRetries = 2
  // Reserve the 150/350ms beats before dividing, so the chain's worst case
  // (3 timeouts + beats) fits the caller's budget: 3×4833 + 500 = 15000.
  const perAttempt = splitRetryBudget(timeoutMs, maxRetries + 1, 150 + 350, 800)

  return withRetry(
    async () => {
      const response = await fetchWithTimeout(
        env,
        url,
        {
          method: 'GET',
          headers: {
            'User-Agent': MOBILE_UA,
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            'Cache-Control': 'no-cache',
          },
        },
        perAttempt,
      )

      // Transient under fan-out — throw so withRetry backs off and retries.
      if (response.status === 429 || response.status >= 500) {
        // Free the subrequest slot: on Workers an unconsumed response body
        // holds the slot until GC, so every retry would otherwise leak one.
        response.body?.cancel().catch(() => {})
        throw new Error(`Naver article HTTP ${response.status}`)
      }

      // Non-transient HTTP failure — fail fast (returned, never retried).
      if (!response.ok) {
        return { url, raw_content: '', success: false, error: `HTTP ${response.status}` }
      }
      const html = await response.text()
      const parsed = parseNaverArticleHtml(html)
      if (!parsed.body) {
        return {
          url,
          raw_content: '',
          success: false,
          error: 'No article body could be extracted (blocked or layout changed)',
        }
      }
      const content = buildNaverNewsEvidenceText(parsed, { maxTokens })
      return {
        url,
        title: parsed.title || undefined,
        raw_content: content,
        success: true,
      }
    },
    {
      maxRetries,
      delaysMs: [150, 350], // same hand-tuned beat as the old backoffDelay
      jitter: false,
      // Every thrown error is retryable: transient HTTP (429/5xx) above plus
      // network/timeout errors (incl. response.text()) — exactly the old loop.
    },
  ).catch((err) => {
    // Network error / abort / timeout — exhausted retries.
    return { url, raw_content: '', success: false, error: toError(err) }
  })
}

/** Skip titles that are navigation/boilerplate, not article headlines. */
function isNavTitle(title: string): boolean {
  return /^(더보기|전체보기|다음|이전|목록으로|바로가기|접기|펼치기|로그인|회원가입|검색|옵션|보내기|공유|댓글)$/i.test(
    title,
  )
}

/**
 * Parse Naver mobile NEWS search results.
 *
 * Naver's mobile news results render each article as a block containing:
 *   - a media profile anchor: <a href="https://media.naver.com/press/NNN"><span>뉴시스</span></a>
 *   - a relative publish time: <span class="...">1시간 전</span>
 *   - the headline anchor:     <a href="https://n.news.naver.com/article/...">HEADLINE</a>
 *   - a snippet anchor to the SAME url with the article summary
 *
 * This parser collects n.news.naver.com/article/... links, dedupes them
 * (headline anchor + snippet anchor share one URL), attaches the media name
 * and publish date, and uses the longest text as the content snippet.
 *
 * EXPORTED FOR TESTING — parser regression detection.
 */
export function parseNaverNewsHtml(html: string, query: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = []

  // Pre-extract media press links with offsets: <a href="https://media.naver.com/press/NNN"...>NAME</a>
  const mediaMarkers: Array<{ offset: number; name: string }> = []
  const mediaRegex = /<a[^>]*href="https:\/\/media\.naver\.com\/press\/\d+"[^>]*>([\s\S]*?)<\/a>/gi
  let mm: RegExpExecArray | null
  while ((mm = mediaRegex.exec(html)) !== null) {
    const name = decodeEntities(stripHtml(mm[1])).trim()
    if (name && name.length >= 2 && !/프로필 이미지|이미지/i.test(name)) {
      mediaMarkers.push({ offset: mm.index, name })
    }
  }

  // Pre-extract relative time markers with offsets: "1시간 전", "방금 전", "어제", "2026.08.04."
  const timeMarkers: Array<{ offset: number; iso: string | null }> = []
  const timeRegex = />([^<>]{0,20}?(?:전|어제|오늘|방금|[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.?))<\/span>/gi
  let tm: RegExpExecArray | null
  while ((tm = timeRegex.exec(html)) !== null) {
    const candidate = tm[1].trim()
    // Accept only recognizable time strings (relative or absolute Korean dates)
    if (!/^(방금\s*전|[0-9]+\s*(분|시간|일|주)\s*전|어제|오늘|[0-9]{4}\.[0-9]{2}\.[0-9]{2}\.?)$/i.test(candidate))
      continue
    timeMarkers.push({ offset: tm.index, iso: parseFlexibleDate(candidate) })
  }

  // Collect article anchors (headline + snippet share the URL — dedupe below).
  // Title anchors have the headline; snippet anchors carry the longer summary.
  // Track the media prefix per URL so a snippet upgrade doesn't lose it.
  const mediaByUrl = new Map<string, string>()
  const linkRegex = /<a[^>]*href="(https:\/\/n\.news\.naver\.com\/article\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = linkRegex.exec(html)) !== null) {
    const url = match[1]
    const text = decodeEntities(stripHtml(match[2])).trim().replace(/\s+/g, ' ')
    if (!text || text.length < 6) continue
    if (isNavTitle(text)) continue

    // Resolve the media name once per URL (nearest PRECEDING press link ≤ 8KB).
    if (!mediaByUrl.has(url)) {
      let mediaName: string | undefined
      for (let i = mediaMarkers.length - 1; i >= 0; i--) {
        const marker = mediaMarkers[i]
        if (marker.offset < match.index && match.index - marker.offset <= 8192) {
          mediaName = marker.name
          break
        }
      }
      mediaByUrl.set(url, mediaName ? `[${mediaName}] ` : '')
    }

    const existingIdx = results.findIndex((r) => r.url === url)
    if (existingIdx !== -1) {
      // Snippet anchor: upgrade content if this text is longer (the summary),
      // keeping the media prefix so the source badge survives the upgrade.
      const existing = results[existingIdx]
      if (text.length > existing.content.length) {
        results[existingIdx] = {
          ...existing,
          content: truncateToTokens((mediaByUrl.get(url) ?? '') + text, 500),
        }
      }
      continue
    }

    if (results.length >= maxResults) break

    // Nearest PRECEDING time marker within the same article block (≤ 8KB).
    let publishedDate: string | undefined
    for (let i = timeMarkers.length - 1; i >= 0; i--) {
      const marker = timeMarkers[i]
      if (marker.offset < match.index && match.index - marker.offset <= 8192) {
        if (marker.iso) publishedDate = marker.iso
        break
      }
    }

    const title = text.slice(0, 120)
    const prefix = mediaByUrl.get(url) ?? ''
    const result: SearchResult = {
      title,
      url,
      content: truncateToTokens(prefix + text, 500),
      score: computeScore(title, text, query),
      domain: extractDomain(url),
    }
    if (publishedDate) result.published_date = publishedDate

    results.push(result)
  }

  return results
}
