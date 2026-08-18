/**
 * OpenAlex API — keyless scholarly works backend (S96, 2026-08-11).
 *
 * Replaces the Google Scholar scraper (google-scholar.ts), which is dead in
 * every eval run: scholar.google.com answers 200 with a CAPTCHA/anomaly page
 * for datacenter & unflagged IPs (live-verified 2026-08-10, scholar=N in all
 * 78 stored academic runs). OpenAlex (api.openalex.org) is the keyless
 * alternative — free, no API key, ~200ms–1s latency, and returns works whose
 * landing pages carry the academic gold domains the eval matcher needs
 * (arxiv.org, openreview.net, aclanthology.org, jmlr.org, nature.com,
 * ieeexplore.ieee.org, semanticscholar.org, paperswithcode.com, doi.org...).
 *
 * Endpoint: GET https://api.openalex.org/works?search=QUERY&per-page=N
 * Fields used: display_name, publication_date, publication_year, doi,
 * primary_location.landing_page_url, best_oa_location.landing_page_url,
 * ids.{paperswithcode,semantic_scholar}, authorships[].author.display_name,
 * primary_location.source.display_name (venue).
 *
 * A mailto= contact can be appended for the polite pool (higher rate limits);
 * pass it via opts.mailto when one is available. Without it OpenAlex still
 * serves ~10 req/s from the shared pool, which is ample for eval pacing.
 */import type { Env, SearchResult } from '../types'
import { logger, toError } from './logger'
import { backendTimeoutMs } from './search/fanout'
import { computeScore, extractDomain, fetchWithTimeout, isCircuitOpenError } from './util'
import { withRetry, splitRetryBudget } from './resilience/retry'
import { getSharedCooldown, setSharedCooldown } from './rate-limiter'

const OPENALEX_BASE = 'https://api.openalex.org/works'

// 2026-08-13: OpenAlex 429 cooldown guard (S76) — mirrors the wikipedia B1 /
// arxiv S23 pattern. OpenAlex 429s carry a truthful Retry-After (live-verified:
// a 43,186s window when the anonymous pool for an IP is exhausted), so the
// window is honoured but clamped to 1h — beyond that we accept one probe per
// hour instead of burning subrequests every 2 minutes under a long window.
const OPENALEX_COOLDOWN_MS = 60_000
const OPENALEX_COOLDOWN_MAX_MS = 3_600_000
const OPENALEX_COOLDOWN_KEY = 'cooldown:openalex'

let openalexRateLimitedUntil = 0

/**
 * Is the OpenAlex cooldown window currently active? Checks the local mirror
 * first (fast path), then the shared DO store. EXPORTED FOR TESTS.
 */
export async function isOpenalexRateLimitedShared(
  env: Env | undefined,
  now: number = Date.now(),
): Promise<boolean> {
  if (openalexRateLimitedUntil > now) return true
  const untilMs = await getSharedCooldown(env, OPENALEX_COOLDOWN_KEY, now)
  if (untilMs > now) {
    openalexRateLimitedUntil = Math.max(openalexRateLimitedUntil, untilMs)
    return true
  }
  return false
}

/** Mirror the current OpenAlex cooldown deadline into shared DO storage. */
export async function mirrorOpenalexCooldown(env: Env | undefined): Promise<void> {
  await setSharedCooldown(env, OPENALEX_COOLDOWN_KEY, openalexRateLimitedUntil)
}

/**
 * Record an OpenAlex 429 — arms a cooldown. Honours Retry-After when present
 * (clamped to OPENALEX_COOLDOWN_MAX_MS = 1h); otherwise the 60s fallback.
 * EXPORTED FOR TESTS.
 */
export function recordOpenalexRateLimit(
  res?: { headers?: { get?: (key: string) => string | null } },
  now: number = Date.now(),
): void {
  const retryAfterSec = Number(res?.headers?.get?.('retry-after'))
  const cooldownMs =
    Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.min(Math.max(retryAfterSec * 1000, 1000), OPENALEX_COOLDOWN_MAX_MS)
      : OPENALEX_COOLDOWN_MS
  openalexRateLimitedUntil = Math.max(openalexRateLimitedUntil, now + cooldownMs)
}

/** Reset the local OpenAlex cooldown state (test hook). */
export function resetOpenalexRateState(): void {
  openalexRateLimitedUntil = 0
}

/**
 * Minimal shape of the OpenAlex /works response we consume. OpenAlex returns
 * many more fields; only the ones used for URL selection and result mapping
 * are typed.
 */
export interface OpenAlexWork {
  display_name?: string
  publication_date?: string
  publication_year?: number
  doi?: string | null
  primary_location?: { landing_page_url?: string | null; source?: { display_name?: string } | null } | null
  best_oa_location?: { landing_page_url?: string | null } | null
  /**
   * Every location OpenAlex knows for the work (publisher page, OA copies,
   * repository mirrors — including arxiv.org/abs/<id> when the paper has an
   * arxiv preprint). Added 2026-08-13: without it, arxiv-gold queries were
   * landing on doi.org because primary/best_oa were publisher links even
   * when an arxiv copy existed in `locations` (live-verified: Deep Residual
   * Learning's locations carry http://arxiv.org/abs/1512.03385 while primary
   * is the IEEE doi).
   */
  locations?: Array<{ landing_page_url?: string | null } | null> | null
  ids?: { openalex?: string; doi?: string; paperswithcode?: string; semantic_scholar?: string } | null
  authorships?: Array<{ author?: { display_name?: string } | null } | null> | null
}

export interface OpenAlexSearchOptions {
  maxResults?: number
  timeoutMs?: number
  env?: Env
  mailto?: string
  signal?: AbortSignal
}

/**
 * Academic landing domains in priority order. Used by `openalexSearch` to pick
 * the most useful URL per work: a readable paper page on an academic site beats
 * a bare DOI redirect, and the same order doubles as a gold-domain preference
 * list (every one of these is a label-suffix match target in eval gold sets —
 * arxiv.org is gold in 29/29 academic queries, openreview.net/acm.org/
 * semanticscholar.org/paperswithcode.com in en-acad-08..17, etc.).
 */
export const ACADEMIC_PREFERRED_DOMAINS = [
  'arxiv.org',
  'openreview.net',
  'aclanthology.org',
  'jmlr.org',
  'nature.com',
  'ieeexplore.ieee.org',
  'acm.org',
  'semanticscholar.org',
  'paperswithcode.com',
  'doi.org',
]

/**
 * Collect a work's candidate URLs (primary → best-oa → locations → doi → pwc → s2).
 * `locations` (added 2026-08-13) carries every copy OpenAlex knows — including
 * arxiv.org preprints that primary/best_oa skip — so arxiv-gold queries stop
 * collapsing to doi.org when an arxiv copy exists.
 */
export function workUrlCandidates(work: OpenAlexWork): string[] {
  const out: string[] = []
  const push = (u?: string | null) => {
    if (!u) return
    const norm = u.trim().replace(/^http:\/\//, 'https://')
    if (!/^https?:\/\//i.test(norm)) return
    let host: string
    try {
      host = new URL(norm).hostname
    } catch {
      return
    }
    // Never surface api.openalex.org itself as a result URL.
    if (host === 'api.openalex.org' || host.endsWith('.openalex.org')) return
    if (!out.includes(norm)) out.push(norm)
  }
  push(work.primary_location?.landing_page_url)
  push(work.best_oa_location?.landing_page_url)
  for (const loc of work.locations ?? []) {
    push(loc?.landing_page_url)
  }
  push(work.doi)
  push(work.ids?.paperswithcode)
  push(work.ids?.semantic_scholar)
  return out
}

/**
 * Pick the best URL for a work. When `preferredDomains` is given (ordered
 * list), candidates are ranked by preferred-domain priority — a best-oa arxiv
 * copy beats a primary doi.org landing for an arxiv-gold query, regardless of
 * which field the URL came from. Ties keep candidate order (primary before
 * best-oa before doi). Without preferences, the primary landing page wins.
 * Matching is label-suffix aware (exact or `endsWith('.' + gold)`), the same
 * rule the eval matcher uses, so `ieeexplore.ieee.org` matches gold `ieee.org`
 * and `api.semanticscholar.org` matches `semanticscholar.org`.
 */
export function pickWorkUrl(work: OpenAlexWork, preferredDomains?: readonly string[]): string | null {
  const cands = workUrlCandidates(work)
  if (cands.length === 0) return null
  if (preferredDomains && preferredDomains.length > 0) {
    const rankOf = (c: string): number => {
      const d = extractDomain(c)
      const idx = preferredDomains.findIndex((g) => d === g || d.endsWith(`.${g}`))
      return idx === -1 ? preferredDomains.length : idx
    }
    return [...cands].sort((a, b) => rankOf(a) - rankOf(b))[0] ?? cands[0]
  }
  return cands[0]
}

/** Map a raw OpenAlex work to a SearchResult (null when no usable URL/title). */
export function openAlexWorkToResult(work: OpenAlexWork, query: string): SearchResult | null {
  const url = pickWorkUrl(work, ACADEMIC_PREFERRED_DOMAINS)
  const title = (work.display_name ?? '').trim()
  if (!url || !title) return null

  const authors = (work.authorships ?? [])
    .slice(0, 3)
    .map((a) => a?.author?.display_name ?? '')
    .filter(Boolean)
    .join(', ')
  const venue = work.primary_location?.source?.display_name ?? ''
  const year = work.publication_year ? String(work.publication_year) : ''
  const meta = [authors, venue, year].filter(Boolean).join(' · ')
  const snippet = meta || 'Academic paper'

  return {
    title,
    url,
    content: snippet,
    // Same academic authority boost pattern as arxivSearch (computeScore +
    // 0.12) so scholarly hits compete with bing/github in the pool.
    score: Math.min(computeScore(title, snippet, query) + 0.12, 0.99),
    domain: extractDomain(url),
    published_date: work.publication_date || undefined,
    author: authors || undefined,
  }
}

/**
 * Transient failure from the OpenAlex /works endpoint — the ONLY error class
 * worth retrying (docs/16_FAILFAST_BACKEND_RETRY_ANALYSIS.md §3.4). Covers
 * 5xx and network errors (fetch throw). Deliberately NOT wrapped: 4xx
 * (permanent refusal), 429 (shared-pool quota window — a 150ms retry lands in
 * the same window), and the rate limiter's circuit-open / capacity-race
 * throws (retrying a closed circuit just hammers it — docs/16 rule 4).
 */
class TransientOpenalexError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null) {
    super(message)
    this.status = status
    this.name = 'TransientOpenalexError'
  }
}

/**
 * Search OpenAlex for academic works. Keyless and ToS-safe (official REST
 * API). Returns [] on any failure so the fanout pool degrades gracefully.
 */
export async function openalexSearch(query: string, opts: OpenAlexSearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = backendTimeoutMs('openalex', 6000), env, mailto, signal } = opts
  const results: SearchResult[] = []

  // 2026-08-13 (S76): OpenAlex 429 pacing guard — skip the network chain
  // entirely while a recorded window is active. Live-verified: when the
  // anonymous pool is exhausted the Retry-After can be hours, and every
  // hammering call just re-429s and burns a subrequest.
  if (await isOpenalexRateLimitedShared(env)) {
    logger.warn('OpenAlex search skipped (429 cooldown window):', {
      resumeAt: new Date(openalexRateLimitedUntil).toISOString(),
      query,
    })
    return results
  }

  try {
    const params = new URLSearchParams({
      search: query,
      'per-page': String(Math.min(maxResults, 25)),
      select: 'display_name,publication_date,publication_year,doi,primary_location,best_oa_location,locations,ids,authorships',
    })
    if (mailto) params.set('mailto', mailto)
    const url = `${OPENALEX_BASE}?${params.toString()}`
    // docs/16 §3.4: 5xx/network gets ONE retry via the shared withRetry
    // decorator. Budget: splitRetryBudget(4500, 2, 150, 800) = 2175 → worst
    // 2×2175+150 = 4500 = the openalex fanout ceiling exactly, so the
    // per-backend timer never fires mid-chain. Circuit-open throws are
    // excluded from retryable.
    const perAttemptMs = splitRetryBudget(Math.min(timeoutMs, 4500), 2, 150, 800)
    const response = await withRetry(
      async () => {
        let res: Response
        try {
          res = await fetchWithTimeout(env, url, { headers: { Accept: 'application/json' }, signal }, perAttemptMs)
        } catch (err) {
          // Circuit open / capacity race → fail fast (never retry a closed
          // circuit); network timeout / blip → transient, retry once.
          if (isCircuitOpenError(err)) throw err
          throw new TransientOpenalexError(`OpenAlex fetch failed: ${toError(err)}`, null)
        }
        if (res.ok) return res
        // 4xx → permanent refusal; 429 → quota window — fail fast (a 150ms
        // retry would land in the same window and burn a subrequest) and arm
        // the cooldown so later calls skip the chain entirely.
        if (res.status === 429) {
          recordOpenalexRateLimit(res)
          await mirrorOpenalexCooldown(env)
          return res
        }
        if (res.status >= 400 && res.status < 500) return res
        // 5xx → server-side transient failure — retry once.
        res.body?.cancel().catch(() => {})
        throw new TransientOpenalexError(`OpenAlex HTTP ${res.status}`, res.status)
      },
      {
        maxRetries: 1,
        delaysMs: [150],
        jitter: false,
        retryable: (err) => err instanceof TransientOpenalexError && !isCircuitOpenError(err),
      },
    ).catch((err) => {
      logger.warn('OpenAlex search failed:', { error: toError(err) })
      return null
    })

    if (!response?.ok) {
      if (response) logger.warn(`OpenAlex search failed: HTTP ${response.status}`, { query })
      return results
    }

    const json = (await response.json()) as { results?: OpenAlexWork[] }
    for (const work of json.results ?? []) {
      if (results.length >= maxResults) break
      const r = openAlexWorkToResult(work, query)
      if (r) results.push(r)
    }
  } catch (err) {
    logger.warn('OpenAlex search failed:', { error: err instanceof Error ? err.message : String(err) })
  }

  return results
}
