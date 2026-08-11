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
 */

import type { Env, SearchResult } from '../types'

import { logger } from './logger'
import { computeScore, extractDomain, fetchWithTimeout } from './util'

const OPENALEX_BASE = 'https://api.openalex.org/works'

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

/** Collect a work's candidate URLs (primary → best-oa → doi → pwc → s2). */
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
 * Search OpenAlex for academic works. Keyless and ToS-safe (official REST
 * API). Returns [] on any failure so the fanout pool degrades gracefully.
 */
export async function openalexSearch(query: string, opts: OpenAlexSearchOptions = {}): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 6000, env, mailto, signal } = opts
  const results: SearchResult[] = []

  try {
    const params = new URLSearchParams({
      search: query,
      'per-page': String(Math.min(maxResults, 25)),
      select: 'display_name,publication_date,publication_year,doi,primary_location,best_oa_location,ids,authorships',
    })
    if (mailto) params.set('mailto', mailto)
    const url = `${OPENALEX_BASE}?${params.toString()}`
    const response = await fetchWithTimeout(env, url, { headers: { Accept: 'application/json' }, signal }, timeoutMs)

    if (!response.ok) {
      logger.warn(`OpenAlex search failed: HTTP ${response.status}`, { query })
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
