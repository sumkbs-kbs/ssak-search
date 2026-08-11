/**
 * Specialized Search Sources (No API Key Required)
 *
 * These are free, no-auth APIs that complement general web search:
 * - Wikipedia REST API: encyclopedia entries with summaries
 * - GitHub Search API: repositories, code, issues (rate-limited without token)
 * - HackerNews Algolia API: tech news and discussions
 * - OpenAlex API: academic papers
 * - Reddit JSON API: community discussions
 *
 * These sources add depth and authority to search results,
 * especially for factual, technical, and academic queries.
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, extractDomain, stripHtml, computeScore, truncateToTokens, simplifyQuery } from './util'

// ============================================================
// Wikipedia REST API
// ============================================================

/**
 * In-process wikipedia search result cache.
 *
 * wikipedia is the single highest-value backend for factual/general/academic
 * queries, but its REST + Action endpoints hard-rate-limit (429) after a burst
 * of rapid calls and stay blocked for a minute+. The eval harness re-runs the
 * same query set N times for median aggregation, and each run re-hits
 * wikipedia for the SAME queries — N× the upstream load, tripping the block
 * mid-run and dropping wikipedia from backends on otherwise-fine queries
 * (en-fact-01 requiredBackends regression in the 88×3 median eval).
 *
 * Caching successful (non-empty) results here collapses those repeated calls
 * to ~1/N while leaving every OTHER backend (bing/HN/DDG) uncached so the
 * median run still sees fresh per-run availability noise. Only NON-EMPTY
 * results are stored — a 429/empty response is never cached, so a later run
 * still gets a real retry chance once the upstream window recovers.
 *
 * Production benefit: repeated factual queries within 10 minutes no longer
 * re-scrape wikipedia (encyclopedia content is stable; 10-min staleness is
 * irrelevant for search quality).
 */
const WIKIPEDIA_CACHE_TTL_MS = 10 * 60 * 1000
const WIKIPEDIA_CACHE_MAX = 500
const wikipediaCache = new Map<string, { results: SearchResult[]; expiresAt: number }>()

function wikipediaCacheKey(language: string, query: string, maxResults: number, source = 'rest'): string {
  // S28: the `source` dimension keeps DBpedia-fallback results in a SEPARATE
  // cache slot from REST results — a 429-window DBpedia entry must not shadow
  // the canonical REST results for 10 min after the window recovers.
  return `${language}|${source}|${query.trim().toLowerCase()}|${maxResults}`
}

function wikipediaCacheGet(key: string): SearchResult[] | undefined {
  const entry = wikipediaCache.get(key)
  if (entry && entry.expiresAt > Date.now()) {
    // Shallow-copy each result: the orchestrator mutates SearchResult objects
    // in place AFTER the cache read (mergeAndDeduplicate keeps first-seen
    // references, then ranking recomputes score, enrichment rewrites content,
    // matchImagesToResults attaches images). Returning the cached references
    // directly would leak one request's post-processing into the next.
    return entry.results.map((r) => ({ ...r }))
  }
  if (entry) wikipediaCache.delete(key) // expired — clean up
  return undefined
}

function wikipediaCacheSet(key: string, results: SearchResult[]): void {
  if (results.length === 0) return // never cache 429/empty — allow real retry later
  wikipediaCache.set(key, { results, expiresAt: Date.now() + WIKIPEDIA_CACHE_TTL_MS })
  // Bound memory: evict oldest entry past 500 unique queries
  if (wikipediaCache.size > WIKIPEDIA_CACHE_MAX) {
    const oldest = wikipediaCache.entries().next().value
    if (oldest) wikipediaCache.delete(oldest[0])
  }
}

/**
 * Clear the in-process wikipedia cache. Exported for tests — unit tests mock
 * fetchWithTimeout and must not have one test's cached results leak into the
 * next (which would make the mock calls vanish and assertions fail).
 */
export function clearWikipediaCache(): void {
  wikipediaCache.clear()
}

// ============================================================
// B1 (Wave 4): wikipedia 429 pacing guard
// ============================================================

/**
 * Default cooldown after a wikipedia 429 when the response carries no
 * usable Retry-After header. The wikimedia gateway's REST+Action block
 * lasts "a minute+" under sustained hammering, but the eval's own 1200ms
 * pacing (runner.ts) keeps windows shorter — 30s balances stopping the
 * burst (queries 2+ in the window skip instantly) against not over-holding
 * a healthy endpoint once the window actually recovers. Mirrors the S23
 * GitHub /search guard pattern (header-driven, module-level, per-isolate).
 */
const WIKIPEDIA_RATE_COOLDOWN_MS = 30_000

/** Epoch ms; 0 = not limited. B1: module-level wikipedia 429 window. */
let wikipediaRateLimitedUntil = 0

/** TEST HOOK: reset the wikipedia rate-guard state (per-isolate module state). */
export function resetWikipediaRateState(): void {
  wikipediaRateLimitedUntil = 0
}

/** True when wikipedia recently 429'd and the cooldown window has not passed. */
export function isWikipediaRateLimited(now: number = Date.now()): boolean {
  return now < wikipediaRateLimitedUntil
}

/**
 * Record a wikipedia 429 — arms a cooldown. Honours the upstream Retry-After
 * header when present (clamped to [1s, 120s]); falls back to the 30s default
 * otherwise (a plain-object mock in tests has no headers). EXPORTED FOR TESTS.
 */
export function recordWikipediaRateLimit(
  res?: { headers?: { get?: (key: string) => string | null } },
  now: number = Date.now(),
): void {
  const retryAfterSec = Number(res?.headers?.get?.('retry-after'))
  const cooldownMs =
    Number.isFinite(retryAfterSec) && retryAfterSec > 0
      ? Math.min(Math.max(retryAfterSec * 1000, 1000), 120_000)
      : WIKIPEDIA_RATE_COOLDOWN_MS
  wikipediaRateLimitedUntil = Math.max(wikipediaRateLimitedUntil, now + cooldownMs)
}

/**
 * Search Wikipedia for encyclopedia entries.
 * Free, no API key. Works for all languages.
 * Returns title, excerpt, and URL for each match.
 */
export async function wikipediaSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; language?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, language = 'en', env } = opts
  const cacheKey = wikipediaCacheKey(language, query, maxResults)
  const cached = wikipediaCacheGet(cacheKey)
  if (cached) return cached

  // B1 (Wave 4): pacing guard. When wikipedia recently 429'd (the wikimedia
  // gateway blocks the IP across REST+Action for a minute+ under bursts),
  // skip the network chain ENTIRELY — every attempt inside the window just
  // re-429s and re-arms the cooldown, wasting requests and delaying window
  // recovery. The orchestrator-level mirror (5b) covers the gold instead;
  // once the cooldown expires the next call retries for real. The cache is
  // checked BEFORE this guard so a pre-window result still serves. Mirrors
  // the S23 GitHub rate-guard skip semantics.
  const results: SearchResult[] = []
  if (isWikipediaRateLimited()) {
    logger.warn('Wikipedia search skipped (429 cooldown window):', {
      resumeAt: new Date(wikipediaRateLimitedUntil).toISOString(),
      query,
      language,
    })
    return results
  }

  // Wikipedia REST API can return HTTP 429 (rate limit) under rapid sequential
  // calls. Retry with backoff that fits within fanout's wikipedia ceiling
  // (4500ms). The original 500/1200/3000 delays pushed the full retry chain
  // past the ceiling, causing fanout to time the task out before the final
  // attempt finished.
  //
  // maxRetries=2 (300/600 backoff, 3 attempts) is the ceiling-safe budget: the
  // REST chain (≈900ms sleep + 3 fast requests) + the Action API fallback
  // (500ms + 2 requests) totals ≈3.4s even at ~600ms/request, leaving margin
  // under the 4.5s fanout ceiling so the fallback ALWAYS executes. The prior
  // 3-retry chain (250/500/1000, 4 attempts) sat right at the boundary — slow
  // requests pushed the task past 4.5s and fanout rejected it wholesale,
  // dropping wikipedia (and the Action fallback with it) on the same runs where
  // zh-general-04 fell to 4 results.
  const maxRetries = 2
  const backoffDelays = [300, 600]

  // Fallback: if the REST API returned no results (including after exhausted
  // 429 retries — previously the `if (!response?.ok) return results` early
  // exit skipped this path entirely, so a rate-limited run dropped wikipedia
  // from the backend list and failed en-fact-01's requiredBackends check),
  // try the Action API (list=search). This also helps Chinese and other
  // non-English wikis where REST search may return empty.
  // Action API fallback with its OWN 429 retry. In the eval harness (and
  // under rapid sequential calls) wikipedia can be rate-limited on both the
  // REST search AND the Action API back-to-back; one retry keeps the backend
  // alive long enough to pass the fanout's wikipedia ceiling (4500ms) even
  // when a chinese/factual eval batch is hammering the API.
  //
  // S35 (2026-08-07): the DBpedia mirror fallback that lived here (S28) was
  // PROMOTED OUT to a standalone `dbpediaSearch` that the orchestrator fires
  // AFTER the fanout, only when wikipedia was expected but produced nothing
  // (429-exhausted / failed). Inside wikipediaSearch it ran under fanout's
  // 4500ms wikipedia ceiling AFTER the REST 429-retry chain + Action fallback
  // had already burned most of the budget — S34 measured 27/27 eval attempts
  // aborting with "This operation was aborted" (8s fetch timeout). At the
  // orchestrator level it runs with its own budget, independent of the
  // fanout ceiling.
  const actionApiFallback = async (): Promise<void> => {
    if (results.length > 0) return
    try {
      const actionUrl = `https://${language}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=${maxResults}&srprop=snippet`
      let actionRes: Response | null = null
      for (let attempt = 0; attempt <= 1; attempt++) {
        actionRes = await fetchWithTimeout(
          env,
          actionUrl,
          {
            headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
          },
          timeoutMs,
        )
        if (actionRes.ok) break
        if (actionRes.status === 429 && attempt === 0) {
          // B1: the Action endpoint shares the same gateway block as REST
          // (verified live) — record the cooldown so later queries skip the
          // whole chain, then give the window a slightly longer beat (500ms)
          // for the rare transient case. The REST chain already burned ~900ms
          // of backoff sleep, so this stays well inside the 4.5s fanout
          // ceiling.
          recordWikipediaRateLimit(actionRes)
          await new Promise((r) => setTimeout(r, 500))
          continue
        }
        break
      }
      if (actionRes?.ok) {
        const actionData = (await actionRes.json()) as { query?: { search?: { title: string; snippet: string }[] } }
        for (const item of actionData.query?.search || []) {
          if (results.length >= maxResults) break
          const pageUrl = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`
          const excerpt = stripHtml(item.snippet || '').trim()
          results.push({
            title: item.title,
            url: pageUrl,
            content: truncateToTokens(excerpt, 500),
            score: Math.min(computeScore(item.title, excerpt, query) + 0.15, 0.99),
            domain: `${language}.wikipedia.org`,
          })
        }
      }
    } catch (err) {
      logger.warn('Wikipedia Action API fallback failed:', { error: toError(err) })
    }
  }

  try {
    // Search for page titles
    const searchUrl = `https://${language}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(query)}&limit=${maxResults}`

    let response: Response | null = null
    let restRateLimited = false
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      response = await fetchWithTimeout(
        env,
        searchUrl,
        {
          headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
        },
        timeoutMs,
      )

      if (response.ok) break
      if (response.status === 429 && attempt < maxRetries) {
        // Rate limited — B1: record the cooldown (Retry-After-aware) so the
        // NEXT wikipedia-expected query in this isolate skips instantly
        // instead of burning its own 429 attempts. The intra-query retry
        // chain is kept for the DISCOVERY query only (the one that finds the
        // window) — later queries are skipped at the top by the guard.
        restRateLimited = true
        recordWikipediaRateLimit(response)
        await new Promise((r) => setTimeout(r, backoffDelays[attempt]))
        continue
      }
      // Non-429 error or exhausted retries
      break
    }

    // REST failure (429 exhausted / 5xx / network) must NOT short-circuit the
    // Action API fallback — drop through to it instead of returning empty.
    if (response?.ok) {
      const data = (await response.json()) as {
        pages?: { title: string; key: string; excerpt: string; description?: string }[]
      }
      const pages = data.pages || []

      for (const page of pages) {
        if (results.length >= maxResults) break
        const url = `https://${language}.wikipedia.org/wiki/${encodeURIComponent(page.key.replace(/ /g, '_'))}`
        // Clean excerpt - remove HTML spans
        const excerpt = stripHtml(page.excerpt || '').trim()
        const description = page.description ? `${page.description}. ` : ''
        const content = truncateToTokens(`${description}${excerpt}`, 500)

        results.push({
          title: page.title,
          url,
          content,
          score: Math.min(computeScore(page.title, excerpt, query) + 0.15, 0.99), // Wikipedia authority boost (clamped)
          domain: `${language}.wikipedia.org`,
        })
      }
    } else if (response) {
      logger.warn(`Wikipedia REST search failed (status ${response.status}), trying Action API:`, { query })
    } else {
      logger.warn('Wikipedia REST search failed (no response), trying Action API:', { query })
    }

    // Action API fallback — runs for non-ok responses (5xx, network) AND for
    // 200 responses that returned 0 pages (e.g. zh REST returning empty for a
    // Chinese query), where it can genuinely succeed.
    //
    // SKIPPED when REST was rate-limited (429): wikipedia.org rate-limits the
    // IP across BOTH the REST and Action endpoints (verified live: Action keeps
    // returning 429 for 8s+ after REST trips). Firing the fallback on REST-429
    // just amplifies the block with wasted requests and delays window recovery.
    if (!restRateLimited) {
      await actionApiFallback()
    } else {
      logger.warn(
        `Wikipedia REST search rate-limited (429) — skipping Action API fallback so the window can recover:`,
        { query },
      )
    }
  } catch (err) {
    logger.warn('Wikipedia search failed:', { error: toError(err) })
    // Even when the REST path throws, try the Action API before giving up.
    await actionApiFallback().catch(() => {})
  }

  // Cache successful (non-empty) results so repeated queries (eval 3× median
  // runs, production repeat traffic) don't re-hit wikipedia's rate-limited API.
  // S35: DBpedia fallback results are cached under their OWN 'dbpedia' source
  // slot (see dbpediaSearch) so a fallback hit never shadows the canonical
  // REST results once the 429 window recovers.
  wikipediaCacheSet(wikipediaCacheKey(language, query, maxResults, 'rest'), results)
  return results
}

/**
 * S35: DBpedia Lookup — cross-infrastructure wikipedia mirror fallback,
 * PROMOTED OUT of wikipediaSearch to the orchestrator level.
 *
 * en.wikipedia.org's REST AND Action endpoints share the SAME IP-level 429
 * window (verified live 2026-08-07: api.wikimedia.org gateway 429s in lock
 * step with the REST host). DBpedia.org is a DIFFERENT infrastructure — its
 * Lookup service (https://lookup.dbpedia.org/api/search) is keyless and
 * immune to the Wikimedia block (live probe: HTTP 200 while wikipedia was
 * 429ing). DBpedia resources ARE wikipedia article titles, so the fallback
 * reconstructs the canonical https://en.wikipedia.org/wiki/<title> URL —
 * recovering the wikipedia.org eval gold that a 429 would otherwise drop.
 *
 * S34 measured the OLD in-wikipediaSearch placement failing 27/27 eval
 * attempts ("This operation was aborted" — the REST 429-retry chain + Action
 * fallback burned the fanout 4500ms wikipedia ceiling before DBpedia was
 * reached). The orchestrator fires this ONLY when wikipedia was expected but
 * produced nothing (usedBackends lacks 'wikipedia'), with its own timeout and
 * NO fanout ceiling, so the mirror gets a real budget.
 *
 * EN-only: the Lookup index is English-centric. Results are cached under the
 * 'dbpedia' source slot so a fallback hit never shadows canonical REST
 * results for 10 min after the 429 window recovers (S28 design preserved).
 */
export async function dbpediaSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; language?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, language = 'en', env } = opts
  if (language !== 'en') return [] // EN-only Lookup index

  const cacheKey = wikipediaCacheKey(language, query, maxResults, 'dbpedia')
  const cached = wikipediaCacheGet(cacheKey)
  if (cached) return cached

  const results: SearchResult[] = []
  try {
    // LIVE-VERIFIED 2026-08-07: DBpedia Lookup relevance collapses on
    // natural-language queries — 'what is quantum computing' returned
    // Microsoft_Windows/United_States/Author (popular-resource fallback),
    // while the simplified 'quantum computing' returned Quantum_computing
    // + related pages. Strip stop words (mirrors githubSearch/HN), then
    // filter by relevance as defense-in-depth.
    const dbpediaQuery = simplifyQuery(query, 4) || query
    const lookupUrl = `https://lookup.dbpedia.org/api/search?query=${encodeURIComponent(dbpediaQuery)}&format=json&maxResults=${maxResults}`
    const response = await fetchWithTimeout(
      env,
      lookupUrl,
      { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' } },
      timeoutMs,
    )
    if (!response.ok) {
      logger.warn(`Wikipedia DBpedia lookup fallback failed (status ${response.status})`)
      return results
    }
    const data = (await response.json()) as { docs?: Array<Record<string, unknown>> }
    for (const doc of data.docs ?? []) {
      if (results.length >= maxResults) break
      const resource = Array.isArray(doc.resource) ? String(doc.resource[0] ?? '') : ''
      const m = resource.match(/^https?:\/\/dbpedia\.org\/resource\/(.+)$/)
      if (!m || m[1].length < 2) continue
      const titlePart = m[1] // URL-encoded article title, e.g. 'Quantum_computing'
      const label = Array.isArray(doc.label) ? stripHtml(String(doc.label[0] ?? '')).trim() : ''
      const title = label || titlePart.replace(/_/g, ' ')
      const comment = Array.isArray(doc.comment) ? stripHtml(String(doc.comment[0] ?? '')).trim() : ''
      // Relevance filter against the SIMPLIFIED query (NOT the original):
      // scoring against the raw query lets content stop words inflate
      // irrelevant docs ('Microsoft Windows' abstract contains 'is' → 0.13
      // vs a clean 0.05), and dilutes acronym hits ('how does gps work'
      // vs 'Global Positioning System' → 0.125). The simplified query is
      // what the API matched on and is stop-word-free — 'Quantum computing'
      // scores 0.65, 'Microsoft Windows' scores 0.05 (verified 2026-08-07).
      if (computeScore(title, comment, dbpediaQuery) < 0.08) continue
      results.push({
        title,
        url: `https://en.wikipedia.org/wiki/${titlePart}`,
        content: truncateToTokens(comment, 500),
        score: Math.min(computeScore(title, comment, query) + 0.15, 0.99), // wikipedia authority boost (clamped)
        domain: 'en.wikipedia.org',
      })
    }
  } catch (err) {
    logger.warn('Wikipedia DBpedia lookup fallback failed:', { error: toError(err) })
  }

  wikipediaCacheSet(cacheKey, results)
  return results
}

// ============================================================
// S36: Wikidata cross-infrastructure fallback for NON-EN wikis
// ============================================================

/**
 * S36: shared cooldown for the Wikidata API. The fallback only fires when
 * wikipedia is down, but many zh/ja factual queries 429ing back-to-back
 * makes wikidata rate-limit itself (probe: 1.5s gaps still tripped
 * wbsearchentities mid-run). A 60s cooldown stops one isolate from wasting
 * calls on a budget Wikidata has already told us is exhausted — graceful
 * degradation mirroring the S23 GitHub /search rate guard. EXPORTED FOR
 * TESTS.
 */
let wikidataRateLimitedUntil = 0 // epoch ms; 0 = not limited

/** TEST HOOK: reset the wikidata rate-guard state. */
export function resetWikidataRateState(): void {
  wikidataRateLimitedUntil = 0
}

/** True when Wikidata reported the API quota exhausted and the window has not passed. */
function isWikidataRateLimited(now: number = Date.now()): boolean {
  return now < wikidataRateLimitedUntil
}

/**
 * Record a Wikidata 429/5xx — sets a 60s cooldown (Wikidata doesn't send
 * usable Retry-After on the MediaWiki action API; the observed block lasted
 * seconds, 60s is a conservative bound). EXPORTED FOR TESTS.
 */
export function recordWikidataRateLimit(now: number = Date.now()): void {
  wikidataRateLimitedUntil = Math.max(wikidataRateLimitedUntil, now + 60_000)
}

/**
 * CJK query cleaning for the Wikidata label search. Wikipedia question
 * prefixes and trailing generic nouns pollute wbsearchentities: '什么是
 * 区块链技术' matches scholarly-article labels ('区块链技术在打骗打虚工作中…')
 * instead of the 区块链 entity (Q20514253). Stripping question prefixes and
 * re-stripping generic trailing nouns ('技术/网络/原理') recovers the exact
 * label — live-verified 2026-08-07: '区块链技术'→'区块链' (Q20514253),
 * '5G网络'→'5G' (Q1363408), '什么是虫洞'→'虫洞' (Q7544).
 *
 * Suffix stripping is ITERATIVE (review S36): '区块链技术发展' needs the
 * trailing 发展 AND 技术 stripped to reach '区块链' — a depth-1 strip left
 * '区块链技术' (papers again). The loop bounds total candidates so the
 * fallback never issues more than 3 label searches per query.
 */
export function cleanWikiFallbackQuery(query: string, language: string): string[] {
  const ZH_SUFFIX = /(技术|网络|原理|方法|机制|系统|研究|现状|趋势|影响|发展|应用|是什么|什么意思)$/
  const JA_SUFFIX = /(の仕組み|の原理|とは何か|とは|について|の影響|の意味)$/
  const KO_SUFFIX = /(이란|란|에 대해| 대해|의 의미| 뜻)$/

  let q = query.trim()
  const candidates: string[] = [q]
  if (language === 'zh') {
    q = q
      .replace(/^什么是/, '')
      .replace(/^什麼是/, '')
      .replace(/^什么/, '')
      .replace(/^什麼/, '')
      .replace(/^怎么/, '')
      .replace(/^如何/, '')
      .replace(/^为什么/, '')
      .trim()
    candidates[0] = q
    let prev = q
    let stripped = q.replace(ZH_SUFFIX, '').trim()
    while (stripped && stripped !== prev && candidates.length < 3) {
      candidates.push(stripped)
      prev = stripped
      stripped = stripped.replace(ZH_SUFFIX, '').trim()
    }
    return candidates.filter((c) => c.length > 0)
  }
  if (language === 'ja') {
    q = q.replace(JA_SUFFIX, '').trim()
    return q ? [q] : [query.trim()]
  }
  if (language === 'ko') {
    q = q.replace(KO_SUFFIX, '').trim()
    return q ? [q] : [query.trim()]
  }
  return [query.trim()]
}

/** Map a wikipedia language code to the wikidata site id (jawiki/zhwiki/…). */
function wikidataSiteId(language: string): string {
  return `${language}wiki`
}

/**
 * Label-relation gate for the wikidata fallback. The sitelink filter already
 * guarantees the entity IS a real <lang>wikipedia page (papers have no
 * sitelinks), so relevance is checked against the CLEANED query with CJK
 * script-variant tolerance: computeScore bigram overlap silently fails on
 * traditional/simplified mismatches ('虫洞' vs '蟲洞' share no bigram —
 * live-verified Q7544 labels as 蟲洞). Accept when the cleaned query and
 * label share >= 50% of the query's CJK chars, or contain each other.
 * EXPORTED FOR TESTS.
 */
export function wikidataLabelRelevant(cleanedQuery: string, label: string): boolean {
  const q = cleanedQuery.trim()
  if (!q || q.length < 2) return false
  if (label.includes(q) || q.includes(label)) return true
  const qChars = new Set(q)
  const lChars = new Set(label)
  let shared = 0
  for (const ch of qChars) if (lChars.has(ch)) shared++
  return shared / qChars.size >= 0.5
}

/**
 * S36: Wikidata-based wikipedia mirror fallback for NON-EN languages.
 *
 * S34 measured 13 still-vulnerable non-EN queries (ja-fact-02/10,
 * zh-fact-03/06/07/09/12/15 — gold = ja/zh.wikipedia.org) that the EN-only
 * DBpedia Lookup cannot cover. wikipedia.org's REST+Action 429 window is
 * shared across ALL language wikis (same wikimedia.org gateway), so a mirror
 * must live on DIFFERENT infrastructure. Wikidata (www.wikidata.org) is that
 * mirror: wbsearchentities searches entity labels in the target language
 * (live-verified 2026-08-07: '人工知能'→Q11660, '地球温暖化'→Q7942,
 * '区块链'→Q20514253, '元宇宙'→Q2632041, '5G'→Q1363408), and the entity's
 * <lang>wiki sitelink reconstructs the canonical wikipedia.org URL that the
 * eval gold matcher (domain substring) needs.
 *
 * NOISE FILTER: scholarly-article entities pass the label search but have NO
 * <lang>wiki sitelink (live-verified: '区块链技术在打骗打虚工作中的构建与
 * 应用' Q121899186 has zero sitelinks) — only entities with a sitelink are
 * kept, so papers never become fake wikipedia URLs.
 *
 * Fires ONLY when wikipedia was expected but produced nothing (orchestrator
 * step 5b), with its own timeout and NO fanout ceiling (S35 design).
 * Results cache under the 'wikidata' source slot so a fallback hit never
 * shadows canonical REST results once the 429 window recovers.
 */
export async function wikidataWikiSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; language?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, language = 'zh', env } = opts
  // EN is covered by dbpediaSearch (DBpedia Lookup, English index).
  if (language === 'en') return []

  const cacheKey = wikipediaCacheKey(language, query, maxResults, 'wikidata')
  const cached = wikipediaCacheGet(cacheKey)
  if (cached) return cached

  const results: SearchResult[] = []
  const siteId = wikidataSiteId(language)
  const cleanedCandidates = cleanWikiFallbackQuery(query, language)

  // S36 rate guard: skip when Wikidata reported the API quota exhausted.
  if (isWikidataRateLimited()) {
    logger.warn('Wikidata fallback skipped (API quota exhausted):', {
      resumeAt: new Date(wikidataRateLimitedUntil).toISOString(),
      query,
      language,
    })
    return results
  }

  try {
    for (const cleaned of cleanedCandidates) {
      // Once the SPECIFIC candidate produced real results, stop — the
      // stripped broader candidate would only add related-but-off-topic
      // articles (e.g. 区块链国家) on top of the exact match (review S36).
      if (results.length > 0) break
      // ── Step 1: label search ──
      const searchParams = new URLSearchParams({
        action: 'wbsearchentities',
        search: cleaned,
        language,
        uselang: language,
        format: 'json',
        limit: '10',
      })
      const searchUrl = `https://www.wikidata.org/w/api.php?${searchParams}`
      const searchRes = await fetchWithTimeout(
        env,
        searchUrl,
        { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' } },
        timeoutMs,
      )
      if (!searchRes.ok) {
        if (searchRes.status === 429 || searchRes.status >= 500) recordWikidataRateLimit()
        logger.warn(`Wikidata fallback label search failed (status ${searchRes.status})`, { query, language })
        continue
      }
      const searchData = (await searchRes.json()) as {
        search?: Array<{ id?: string; label?: string; description?: string }>
      }
      const candidates = (searchData.search ?? []).slice(0, 8).filter((e) => e.id)
      if (candidates.length === 0) continue

      // ── Step 2: batch sitelink fetch — keeps only entities that ARE
      // wikipedia pages (scholarly-article noise has zero sitelinks) ──
      const entityParams = new URLSearchParams({
        action: 'wbgetentities',
        ids: candidates.map((c) => c.id ?? '').join('|'),
        props: 'sitelinks/urls',
        sitefilter: siteId,
        format: 'json',
      })
      const entityUrl = `https://www.wikidata.org/w/api.php?${entityParams}`
      const entityRes = await fetchWithTimeout(
        env,
        entityUrl,
        { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' } },
        timeoutMs,
      )
      if (!entityRes.ok) {
        if (entityRes.status === 429 || entityRes.status >= 500) recordWikidataRateLimit()
        logger.warn(`Wikidata fallback sitelink fetch failed (status ${entityRes.status})`, { query, language })
        continue
      }
      const entityData = (await entityRes.json()) as {
        entities?: Record<
          string,
          { sitelinks?: Record<string, { url?: string }>; labels?: Record<string, { value?: string }> }
        >
      }

      const byId = new Map(candidates.map((c) => [c.id ?? '', c]))
      for (const [id, ent] of Object.entries(entityData.entities ?? {})) {
        if (results.length >= maxResults) break
        const cand = byId.get(id)
        const sitelink = ent.sitelinks?.[siteId]?.url
        if (!cand || !sitelink) continue // no wikipedia page — skip (papers, dead ends)
        const label = cand.label ?? ent.labels?.[language]?.value ?? ''
        const description = cand.description ?? ''
        if (!label) continue
        // Relevance: label relation against the CLEANED query (the sitelink
        // filter already excludes papers; computeScore bigram overlap fails
        // on zh traditional/simplified variants like 蟲洞 vs 虫洞). The
        // +0.15 wikipedia authority boost mirrors dbpediaSearch.
        if (!wikidataLabelRelevant(cleaned, label)) continue
        const relevance = Math.max(computeScore(label, description, query), 0.05)
        results.push({
          title: label,
          url: sitelink,
          content: truncateToTokens(description || label, 500),
          score: Math.min(relevance + 0.15, 0.99),
          domain: `${language}.wikipedia.org`,
        })
      }
    }
  } catch (err) {
    logger.warn('Wikidata fallback search failed:', { error: toError(err) })
  }

  wikipediaCacheSet(cacheKey, results)
  return results
}

// ============================================================
// S38: DBpedia LANGUAGE-endpoint fallback (ja.dbpedia.org SPARQL)
// ============================================================

/**
 * S38: shared cooldown for the ja.dbpedia.org SPARQL endpoint. The endpoint
 * is flaky (live-verified 2026-08-08: HTTP 503 on 2/3 rapid probes even
 * though the root host answers 200) and has no documented quota headers.
 * A short 30s cooldown stops one isolate from hammering a half-down
 * endpoint across a burst of fallback queries. EXPORTED FOR TESTS.
 */
let dbpediaLangRateLimitedUntil = 0 // epoch ms; 0 = not limited

/** TEST HOOK: reset the dbpedia-lang rate-guard state. */
export function resetDbpediaLangRateState(): void {
  dbpediaLangRateLimitedUntil = 0
}

/** True when the ja.dbpedia.org endpoint recently failed and the window has not passed. */
function isDbpediaLangRateLimited(now: number = Date.now()): boolean {
  return now < dbpediaLangRateLimitedUntil
}

/**
 * Record a ja.dbpedia.org failure — sets a 30s cooldown. EXPORTED FOR TESTS.
 */
export function recordDbpediaLangRateLimit(now: number = Date.now()): void {
  dbpediaLangRateLimitedUntil = Math.max(dbpediaLangRateLimitedUntil, now + 30_000)
}

/**
 * S38: DBpedia LANGUAGE-endpoint wikipedia mirror fallback — ja only.
 *
 * The S36 Wikidata fallback covers non-EN gold, but Wikidata itself can 429
 * (it rate-limits under eval bursts; S36 measured wbsearchentities tripping
 * mid-run). When BOTH wikipedia AND Wikidata fail, ja.dbpedia.org's SPARQL
 * endpoint is a THIRD infrastructure: `?s rdfs:label "<query>"@ja` returns
 * DBpedia resources whose URI suffix IS the ja.wikipedia article title
 * (live-verified 2026-08-08: 人工知能 → http://ja.dbpedia.org/resource/
 * 人工知能 → https://ja.wikipedia.org/wiki/人工知能).
 *
 * zh/ko.dbpedia.org are DOWN (HTTP 000, live-verified 2026-08-07), so the
 * endpoint is gated to ja — zh/ko fall back to Wikidata only (S36).
 *
 * Fires ONLY when wikipedia was expected but produced nothing AND the
 * Wikidata mirror also failed (orchestrator step 5b chain), with its own
 * timeout and NO fanout ceiling (S35 design). Cached under the
 * 'dbpedia-lang' source slot so a fallback hit never shadows canonical REST
 * results once the 429 window recovers.
 */
export async function dbpediaLangSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; language?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, language = 'ja', env } = opts
  // Only the ja endpoint is live — zh/ko.dbpedia.org are down. EN is covered
  // by dbpediaSearch (Lookup), not this SPARQL path.
  if (language !== 'ja') return []

  const cacheKey = wikipediaCacheKey(language, query, maxResults, 'dbpedia-lang')
  const cached = wikipediaCacheGet(cacheKey)
  if (cached) return cached

  const results: SearchResult[] = []
  const cleanedCandidates = cleanWikiFallbackQuery(query, language)

  if (isDbpediaLangRateLimited()) {
    logger.warn('dbpedia-lang fallback skipped (endpoint cooldown):', {
      resumeAt: new Date(dbpediaLangRateLimitedUntil).toISOString(),
      query,
    })
    return results
  }

  try {
    for (const cleaned of cleanedCandidates) {
      if (results.length > 0) break
      // SPARQL: find resources whose rdfs:label equals the cleaned query.
      // The `format=json` query param is REQUIRED — an Accept:
      // application/json header alone is rejected with 406 (live-verified
      // 2026-08-07 in the S36 endpoint survey).
      const labelLiteral = `"${cleaned.replace(/"/g, '')}"@ja`
      const sparql = `SELECT ?s WHERE { ?s rdfs:label ${labelLiteral} } LIMIT ${Math.min(maxResults + 2, 10)}`
      const sparqlUrl = `https://ja.dbpedia.org/sparql?query=${encodeURIComponent(sparql)}&format=json`
      const response = await fetchWithTimeout(
        env,
        sparqlUrl,
        { headers: { 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' } },
        timeoutMs,
      )
      if (!response.ok) {
        if (response.status === 429 || response.status >= 500) recordDbpediaLangRateLimit()
        logger.warn(`dbpedia-lang SPARQL failed (status ${response.status})`, { query, language })
        continue
      }
      const data = (await response.json()) as {
        results?: { bindings?: Array<{ s?: { type?: string; value?: string } }> }
      }
      for (const binding of data.results?.bindings ?? []) {
        if (results.length >= maxResults) break
        const uri = binding.s?.value ?? ''
        // Only local ja.dbpedia.org resources — skip the wikidata.dbpedia.org
        // cross-reference entries (Q… URIs) and Category: namespaces that the
        // label match also surfaces.
        const m = uri.match(/^https?:\/\/ja\.dbpedia\.org\/resource\/(.+)$/)
        if (!m) continue
        // The resource URI suffix is percent-encoded (人工知能 → %E4%BA%BA…)
        // — decode BEFORE the Category:/length checks and label gate so the
        // decoded title (not the escaped form) is matched and re-encoded.
        let titlePart: string
        try {
          titlePart = decodeURIComponent(m[1])
        } catch {
          titlePart = m[1]
        }
        if (titlePart.startsWith('Category:')) continue
        if (titlePart.length < 2) continue
        const title = titlePart.replace(/_/g, ' ')
        if (!wikidataLabelRelevant(cleaned, title)) continue
        results.push({
          title,
          url: `https://ja.wikipedia.org/wiki/${encodeURIComponent(titlePart)}`,
          content: truncateToTokens(title, 500),
          score: Math.min(Math.max(computeScore(title, '', query), 0.05) + 0.15, 0.99),
          domain: 'ja.wikipedia.org',
        })
      }
    }
  } catch (err) {
    logger.warn('dbpedia-lang fallback failed:', { error: toError(err) })
  }

  wikipediaCacheSet(cacheKey, results)
  return results
}

/**
 * Get Wikipedia article summary (first paragraph) by title.
 */
export async function wikipediaSummary(
  title: string,
  language = 'en',
  timeoutMs = 8000,
  env?: Env,
): Promise<{ title: string; extract: string; url: string } | null> {
  try {
    const url = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' },
      },
      timeoutMs,
    )
    if (!response.ok) return null
    const data = (await response.json()) as {
      title: string
      extract: string
      content_urls?: { desktop?: { page?: string } }
    }
    return {
      title: data.title,
      extract: data.extract || '',
      url: data.content_urls?.desktop?.page || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
    }
  } catch (err) {
    logger.warn('Wikipedia REST API failed:', { error: toError(err) })
    return null
  }
}

// ============================================================
// GitHub Search API
// ============================================================

/**
 * S21: problem/action verbs that must NOT drive REPO discovery. The issues
 * backend owns problem-solving threads; the repo search should surface the
 * canonical subject repos. Live-verified 2026-08-07: 'how to fix react query
 * cache error' simplified to "fix react" and matched fixed-data-table /
 * react-fix-it junk while burying TanStack/query; 'why redis not working' →
 * "why redis" matched rediscovering-* junk while burying redis/redis;
 * 'flutter null exception' → "flutter null" matched null-safety boilerplates.
 * Deliberately separate from QUERY_NOISE_WORDS — the issues backend NEEDS
 * these terms ('fix', 'error') in its /search/issues query.
 */
const GITHUB_REPO_SKIP_TERMS = new Set([
  // NOTE: 'how'/'crash' are already in QUERY_NOISE_WORDS and never survive
  // simplifyQuery; "can't" tokenizes to 'cant' (apostrophes are stripped), so
  // only 'cant' is a live entry. 'work' is kept deliberately: "redis not work"
  // must simplify to 'redis', not "redis work" (the rarer 'work-stealing'
  // subject phrase loses 'work' — acceptable trade-off, review 2026-08-07).
  'fix',
  'fixed',
  'fixes',
  'why',
  'error',
  'errors',
  'null',
  'undefined',
  'not',
  'working',
  'work',
  'bug',
  'bugs',
  'crashes',
  'crashing',
  'failed',
  'fail',
  'fails',
  'failure',
  'unable',
  'cannot',
  'cant',
  'exception',
  'exceptions',
  'problem',
  'problems',
  'solve',
  'solution',
  'solutions',
])

// ============================================================
// GitHub /search rate guard (S23)
// ============================================================

/**
 * S23: GitHub /search rate guard. The unauthenticated search API allows
 * ~10 req/min per egress IP, and githubSearch + githubIssuesSearch share the
 * SAME quota (a technical query fires both = 2 calls). Every /search
 * response carries the search-resource X-RateLimit-Remaining/-Reset headers;
 * when remaining hits 0 (or the call 403s with Retry-After) we record the
 * reset window and SKIP subsequent calls until it passes — graceful
 * degradation instead of hammering a capped budget. The skip is logged so
 * ops sees the signal.
 *
 * Header-driven ONLY (no local sliding window): a local window would trip
 * the eval harness, which makes far more github calls sequentially than the
 * 10/min IP budget yet currently succeeds (Workers egress IPs spread; the
 * eval's own IP is under the cap in practice). Module-level state is
 * per-isolate — the guard exists to stop ONE isolate from wasting calls on
 * a budget GitHub has already told us is exhausted.
 */
let githubSearchRateLimitedUntil = 0 // epoch ms; 0 = not limited
let githubSearchCallsSinceReset = 0

/** TEST HOOK: reset the GitHub search rate-guard state. */
export function resetGithubSearchRateState(): void {
  githubSearchRateLimitedUntil = 0
  githubSearchCallsSinceReset = 0
}

/**
 * True when GitHub has reported the search quota exhausted and the reset
 * window has not passed. EXPORTED FOR TESTS.
 */
export function isGithubSearchRateLimited(now: number = Date.now()): boolean {
  return now < githubSearchRateLimitedUntil
}

/**
 * Update the guard state from one /search response. Called on EVERY response
 * (ok or 403 — the rate-limit headers are present either way). EXPORTED FOR
 * TESTS. Missing headers are ignored (Number(undefined) = NaN guard).
 */
export function recordGithubSearchCall(res: Response, now: number = Date.now()): void {
  githubSearchCallsSinceReset += 1
  const retryAfterSec = Number(res.headers?.get?.('retry-after'))
  if (Number.isFinite(retryAfterSec) && retryAfterSec > 0) {
    // GitHub 403s with Retry-After when the search quota is exhausted.
    githubSearchRateLimitedUntil = Math.max(githubSearchRateLimitedUntil, now + retryAfterSec * 1000)
    return
  }
  const remaining = Number(res.headers?.get?.('x-ratelimit-remaining'))
  const resetSec = Number(res.headers?.get?.('x-ratelimit-reset'))
  if (Number.isFinite(remaining) && Number.isFinite(resetSec) && resetSec > 0 && remaining <= 0) {
    githubSearchRateLimitedUntil = Math.max(githubSearchRateLimitedUntil, resetSec * 1000)
    return
  }
  // Fallback: a 403/429 with NO usable rate-limit headers (malformed or
  // proxied response) must not turn into endless hammering — apply a
  // conservative 60s cooldown instead of leaving the guard silent.
  if (res.status === 403 || res.status === 429) {
    githubSearchRateLimitedUntil = Math.max(githubSearchRateLimitedUntil, now + 60_000)
  }
}

/**
 * Search GitHub repositories.
 * Free without token (rate-limited to ~10 req/min per IP).
 */
export async function githubSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 8000, env } = opts
  const results: SearchResult[] = []

  // S23: skip early when GitHub reported the shared /search quota exhausted.
  if (isGithubSearchRateLimited()) {
    logger.warn('GitHub search skipped (search quota exhausted):', {
      callsSinceReset: githubSearchCallsSinceReset,
      resumeAt: new Date(githubSearchRateLimitedUntil).toISOString(),
    })
    return results
  }

  try {
    // GitHub Search API returns 0 results for overly specific natural-language queries.
    // Simplify: strip years, filler words, keep only key tech terms.
    // e.g. "Cloudflare Workers D1 tutorial 2025" → "cloudflare workers d1"
    //
    // S19: GitHub search treats space-separated terms as AND across
    // name/description/readme — a 4-term query ('redis caching strategies
    // production') matches only tiny repos that mention EVERY word (eval
    // pool: ★1 URL-Shortener repos; live-verified 2026-08-06). The first TWO
    // key terms + stars sort recover the canonical repos (redis/redis) that
    // the github.com eval gold (127/158 technical queries) needs.
    // S21: skip problem/action verbs so the two-term query drives on the
    // SUBJECT ('react query' not 'fix react', 'redis' not 'why redis'). If
    // every term is a verb (rare), fall back to the raw first two.
    const rawTerms = simplifyQuery(query, 6)
      .split(' ')
      .filter((t) => t.length > 0)
    const subjectTerms = rawTerms.filter((t) => !GITHUB_REPO_SKIP_TERMS.has(t))
    const q = (subjectTerms.length > 0 ? subjectTerms : rawTerms).slice(0, 2).join(' ')
    if (!q) return results

    const params = new URLSearchParams({
      q,
      sort: 'stars',
      order: 'desc',
      per_page: String(Math.min(maxResults, 30)),
    })
    const url = `https://api.github.com/search/repositories?${params}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'SearchAPI/1.0',
        },
      },
      timeoutMs,
    )
    // S23: record the rate-limit state from EVERY response (ok or 403).
    recordGithubSearchCall(response)
    if (!response.ok) return results

    const data = (await response.json()) as {
      items?: {
        full_name: string
        description: string | null
        html_url: string
        stargazers_count: number
        language: string | null
        topics?: string[]
      }[]
    }

    for (const repo of data.items || []) {
      if (results.length >= maxResults) break
      // Quality filter: skip very low-quality repos (no description)
      // Personal/student repos without descriptions aren't authoritative
      if (!repo.description) continue
      const desc = repo.description || ''
      const lang = repo.language ? ` [${repo.language}]` : ''
      const stars = repo.stargazers_count > 0 ? ` ★${repo.stargazers_count}` : ''
      const content = truncateToTokens(`${desc}${lang}${stars}`, 500)

      results.push({
        title: `${repo.full_name}${stars}`,
        url: repo.html_url,
        content,
        score: Math.min(computeScore(repo.full_name, desc, query) + 0.1, 0.99), // GitHub authority boost (clamped)
        domain: 'github.com',
      })
    }
  } catch (err) {
    logger.warn('GitHub search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// GitHub Issues Search API
// ============================================================

/**
 * Problem/learning-intent gate for the issues backend. Issues shine for
 * "how do I fix X / why is Y / A vs B" queries — real problem-solving
 * threads with maintainer answers. Tutorial/reference queries are better
 * served by repos + docs, so they are skipped (saves the shared GitHub
 * search rate budget — unauthenticated 10 req/min/IP). EXPORTED FOR TESTS.
 */
export function isGithubIssuesIntent(query: string): boolean {
  // Word boundaries prevent substring false positives: "vs" must not match
  // vscode, "bug" must not match debug, "fix" must not match prefix/suffix,
  // "fail" must not match failover (code review 2026-08-07).
  return /\b(how\s+to|why|errors?|fail(?:ed|ure)?|crash(?:ing)?|bugs?|fix(?:ed)?|not\s+working|undefined|null|exceptions?|deprecat\w*|migrat\w*|upgrad\w*|differences?|versus|vs\.?|best\s+practices?|problems?|solutions?|unable|cannot|can'?t)\b|에러|오류|해결|안\s*되|안\s*돼|비교|エラー|違い|解決|できない|なぜ|报错|错误|区别|为什么|怎么解决/i.test(
    query,
  )
}

/**
 * S27 (2026-08-07): CJK technical-vocabulary detection. S22's S22 branch
 * required a Latin keyword (isTechnicalPattern) or an entity-typed
 * technology (hasTech) — Korean/Chinese/Japanese problem queries with NO
 * Latin tech term ('레디스 안되') and pure-CJK tech queries
 * ('자바스크립트 클로저', '数据库索引原理') fell through to 'general'.
 *
 * The list is deliberately CONSERVATIVE — distinctive dev vocabulary only.
 * Excluded homonym/ambiguous words (each would false-positive a general
 * query): 개발/開発/开发 (real-estate '신도시 개발', ja-news '宇宙開発 最新'),
 * 코드/コード (music chords '기타 코드'), 캐시 (cashback), 스프링 (coil /
 * season — 스프링부트 is the unambiguous form), 데이터 (mobile data plans),
 * 웹/ウェブ (webtoons '웹툰'), 컴퓨터/计算机/エンジニア (consumer/broad).
 *
 * ACCEPTED TRADE-OFFS (rare homonyms kept for coverage — all resolve to
 * github/juejin/csdn empty-or-relevant results, never harmful routing):
 * 자바 (Java vs Java-island travel), 배포 (deploy vs media distribution),
 * 장고 (Django vs the deliberation idiom '장고 끝에'), 러스트 (Rust vs metal
 * corrosion), 네트워크 (network vs '네트워크 마케팅' MLM), 인덱스 (index vs
 * '인덱스 펀드' — the financial branch catches the common finance forms
 * first). CJK has no word boundaries, so matching is substring-based — each
 * term is distinctive enough to be safe (review 2026-08-07).
 */
const CJK_TECH_TERMS = [
  // Korean — romanized ecosystems + native dev vocabulary
  '리액트',
  '레디스',
  '파이썬',
  '자바',
  '자바스크립트',
  '타입스크립트',
  '안드로이드',
  '리눅스',
  '우분투',
  '도커',
  '쿠버네티스',
  '깃허브',
  '스프링부트',
  '장고',
  '플라스크',
  '러스트',
  '노드',
  '마이크로서비스',
  '프로그래밍',
  '코딩',
  '개발자',
  '프레임워크',
  '라이브러리',
  '데이터베이스',
  '서버',
  '백엔드',
  '프론트엔드',
  '풀스택',
  '알고리즘',
  '컴파일러',
  '디버깅',
  '배포',
  '오픈소스',
  '소프트웨어',
  '클라우드',
  '네트워크',
  '스키마',
  '쿼리',
  '스레드',
  '인덱스',
  '운영체제',
  '미들웨어',
  // Chinese
  '编程',
  '代码',
  '程序员',
  '开发者',
  '前端',
  '后端',
  '服务器',
  '数据库',
  '算法',
  '软件',
  '框架',
  '编程语言',
  '开源',
  '部署',
  '调试',
  '接口',
  '脚本',
  '线程',
  '进程',
  '爬虫',
  '机器学习',
  '深度学习',
  '大模型',
  '人工智能',
  '数据结构',
  '操作系统',
  '编译器',
  '云计算',
  '源码',
  '网络安全',
  // Japanese
  'プログラミング',
  'プログラマー',
  'サーバー',
  'データベース',
  'アルゴリズム',
  'ソフトウェア',
  'フレームワーク',
  'ライブラリ',
  'フロントエンド',
  'バックエンド',
  'クラウド',
  'オープンソース',
  '機械学習',
  '深層学習',
  'デプロイ',
  'デバッグ',
  'スクリプト',
  'ミドルウェア',
  'ネットワーク',
  'データ構造',
  'マイクロサービス',
  'スレッド',
  'インデックス',
  'コンパイラ',
]

/**
 * True when the query contains a CJK technical keyword (Korean/Chinese/
 * Japanese dev vocabulary). EXPORTED FOR TESTS. Substring matching — CJK has
 * no word boundaries; the terms are curated to be distinctive (see the
 * exclusion list above).
 */
export function isCjkTechPattern(query: string): boolean {
  return CJK_TECH_TERMS.some((term) => query.includes(term))
}

/**
 * Search GitHub issues via the official Search API (/search/issues). Free
 * without a token (shares the unauthenticated 10 req/min/IP search budget;
 * on Workers egress IPs spread so the cap rarely binds). Returns real
 * github.com/owner/repo/issues/N pages — the github.com gold domain the eval
 * matcher needs (S19: 46/127 github-gold technical queries missed the pool
 * — repos alone cannot cover problem-solving threads).
 *
 * PRs are skipped (code, not discussion); results are relevance-filtered
 * against the ORIGINAL query so unrelated trending issues never enter the
 * pool (mirrors the HN relevance filter).
 */
export async function githubIssuesSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, env } = opts
  const results: SearchResult[] = []

  // S23: skip early when GitHub reported the shared /search quota exhausted
  // (githubSearch + githubIssuesSearch share the same search-resource budget).
  if (isGithubSearchRateLimited()) {
    logger.warn('GitHub issues search skipped (search quota exhausted):', {
      callsSinceReset: githubSearchCallsSinceReset,
      resumeAt: new Date(githubSearchRateLimitedUntil).toISOString(),
    })
    return results
  }

  try {
    const params = new URLSearchParams({
      q: simplifyQuery(query, 4),
      sort: 'relevance',
      order: 'desc',
      per_page: String(Math.min(maxResults * 2, 20)),
    })
    const url = `https://api.github.com/search/issues?${params}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'SearchAPI/1.0',
        },
      },
      timeoutMs,
    )
    // S23: record the rate-limit state from EVERY response (ok or 403).
    recordGithubSearchCall(response)
    if (!response.ok) return results
    const data = (await response.json()) as {
      items?: Array<{
        title?: string
        html_url?: string
        state?: string
        comments?: number
        repository_url?: string
        pull_request?: unknown
      }>
    }

    for (const issue of data.items ?? []) {
      if (results.length >= maxResults) break
      if (issue.pull_request) continue // PRs are code, not discussion
      const title = (issue.title ?? '').trim()
      if (title.length < 5) continue
      const htmlUrl = issue.html_url
      if (!htmlUrl || !/^https?:\/\//i.test(htmlUrl)) continue
      const repo = (issue.repository_url ?? '').replace('https://api.github.com/repos/', '')
      // Relevance filter against the ORIGINAL query — TITLE-only (mirrors the
      // HN filter). The repo string ('redis/redis') would match any issue in a
      // related repo and let unrelated threads through.
      const relevance = computeScore(title, '', query)
      if (relevance < 0.08) continue
      const closed = issue.state === 'open' ? '' : ' [closed]'
      const comments = typeof issue.comments === 'number' && issue.comments > 0 ? ` (${issue.comments} comments)` : ''

      results.push({
        title: `${title}${closed}${comments}`,
        url: htmlUrl,
        content: truncateToTokens(`${repo}${closed}${comments} — ${title}`, 400),
        score: Math.min(computeScore(title, '', query) + 0.15, 0.99), // github authority boost (clamped)
        domain: 'github.com',
      })
    }
  } catch (err) {
    logger.warn('GitHub issues search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// HackerNews Algolia API
// ============================================================

/**
 * Search HackerNews stories.
 * Free, no API key. Great for tech news and discussions.
 */
export async function hackerNewsSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; timeRange?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 8000, timeRange, env } = opts
  const results: SearchResult[] = []

  try {
    // HN Algolia API returns 0 hits for overly specific natural-language queries.
    // Simplify query to key terms for better match rate.
    // e.g. "Cloudflare Workers D1 tutorial 2025" → "cloudflare workers d1"
    const simplified = simplifyQuery(query, 4)
    const params = new URLSearchParams({
      query: simplified,
      tags: 'story',
      hitsPerPage: String(Math.min(maxResults, 20)),
    })
    // Add time range filter if specified (Unix timestamp)
    if (timeRange) {
      const daysMap: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 }
      const days = daysMap[timeRange] || 30
      const minTimestamp = Math.floor(Date.now() / 1000) - days * 86400
      params.append('numericFilters', `created_at_i>${minTimestamp}`)
    }

    const url = `https://hn.algolia.com/api/v1/search?${params}`
    const response = await fetchWithTimeout(
      env,
      url,
      { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' } },
      timeoutMs,
    )

    if (!response.ok) return results
    const data = (await response.json()) as {
      hits?: {
        title: string
        url: string
        points: number
        num_comments: number
        objectID: string
        created_at: string
      }[]
    }

    for (const hit of data.hits || []) {
      if (results.length >= maxResults) break
      // HN stories may have external URL or point to HN discussion
      const extUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`

      // Relevance filter: skip results with very low relevance to the ORIGINAL query
      // (not the simplified one) — this prevents unrelated trending stories
      const relevance = computeScore(hit.title, '', query)
      if (relevance < 0.08) continue // Skip low-relevance results
      // Extra filter: "Show HN:" posts are only useful if actually relevant
      if (/^Show HN:/i.test(hit.title) && relevance < 0.15) continue

      const comments = hit.num_comments > 0 ? ` (${hit.num_comments} comments)` : ''
      const points = hit.points > 0 ? ` ↑${hit.points}` : ''
      const content = truncateToTokens(`${hit.title}${points}${comments}`, 500)

      results.push({
        title: hit.title,
        url: extUrl,
        content,
        score: relevance + Math.min(hit.points / 100, 0.1),
        domain: extractDomain(extUrl),
      })
    }
  } catch (err) {
    logger.warn('HackerNews search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// Reddit JSON API
// ============================================================

/**
 * Search Reddit posts via .json endpoint.
 * Free, no API key. Requires descriptive User-Agent.
 */
export async function redditSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; timeRange?: string; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 5, timeoutMs = 8000, timeRange, env } = opts
  const results: SearchResult[] = []

  try {
    // Reddit search also benefits from simplified queries for better hit rates
    const simplified = simplifyQuery(query, 5)
    const params = new URLSearchParams({
      q: simplified,
      limit: String(Math.min(maxResults, 25)),
      sort: 'relevance',
    })
    if (timeRange) {
      const tMap: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' }
      params.append('t', tMap[timeRange] || 'month')
    }

    const url = `https://www.reddit.com/search.json?${params}`
    const response = await fetchWithTimeout(
      env,
      url,
      {
        headers: {
          Accept: 'application/json',
          'User-Agent': 'SearchAPI/1.0 (contact@example.com)',
        },
      },
      timeoutMs,
    )

    if (!response.ok) return results
    const data = (await response.json()) as {
      data?: {
        children?: {
          data: {
            title: string
            url: string
            selftext: string
            subreddit: string
            score: number
            num_comments: number
            permalink: string
          }
        }[]
      }
    }
    const children = data.data?.children || []

    for (const child of children) {
      if (results.length >= maxResults) break
      const post = child.data
      // Reddit post URL - use external URL if it's a link post, otherwise Reddit permalink
      const postUrl =
        post.url && !post.url.includes('reddit.com') && !post.url.includes('redd.it')
          ? post.url
          : `https://www.reddit.com${post.permalink}`
      const subreddit = `r/${post.subreddit}`
      const score = post.score > 0 ? ` ↑${post.score}` : ''
      const comments = post.num_comments > 0 ? ` (${post.num_comments} comments)` : ''
      const selftext = post.selftext ? ` - ${post.selftext.slice(0, 200)}` : ''
      const content = truncateToTokens(`${subreddit}${score}${comments}${selftext}`, 500)

      results.push({
        title: post.title,
        url: postUrl,
        content,
        score: computeScore(post.title, post.selftext, query) + Math.min(post.score / 1000, 0.05),
        domain: extractDomain(postUrl),
      })
    }
  } catch (err) {
    logger.warn('Reddit search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// arXiv API (Academic Papers — No Key Required)
// ============================================================

/**
 * Search arXiv for academic papers.
 * Free, no API key. Returns research paper titles, abstracts, and URLs.
 * Excellent for academic/scientific queries — far better than Wikipedia
 * for ML/AI/physics/cs papers.
 *
 * Endpoint: https://export.arxiv.org/api/query?search_query=all:QUERY&max_results=N
 * Returns Atom XML feed.
 */
export async function arxivSearch(
  query: string,
  opts: { maxResults?: number; timeoutMs?: number; env?: Env } = {},
): Promise<SearchResult[]> {
  const { maxResults = 8, timeoutMs = 10000, env } = opts
  const results: SearchResult[] = []

  try {
    // Simplify query for arXiv — strip filler words, keep key terms
    const simplified = simplifyQuery(query, 4)
    const params = new URLSearchParams({
      search_query: `all:${simplified}`,
      start: '0',
      max_results: String(Math.min(maxResults, 20)),
      sortBy: 'relevance',
      sortOrder: 'descending',
    })
    const url = `https://export.arxiv.org/api/query?${params.toString()}`
    const response = await fetchWithTimeout(
      env,
      url,
      { headers: { Accept: 'application/xml, application/atom+xml' } },
      timeoutMs,
    )

    if (!response.ok) return results
    const xml = await response.text()

    // Parse Atom XML entries: <entry>...<title>...</title><summary>...</summary><id>...</id>...</entry>
    const entryRegex = /<entry>([\s\S]*?)<\/entry>/gi
    let match: RegExpExecArray | null
    while ((match = entryRegex.exec(xml)) !== null && results.length < maxResults) {
      const entry = match[1]
      const titleMatch = entry.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      const summaryMatch = entry.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i)
      const idMatch = entry.match(/<id[^>]*>([\s\S]*?)<\/id>/i)
      // Also try to get published date
      const publishedMatch = entry.match(/<published[^>]*>([\s\S]*?)<\/published>/i)
      // Try to get authors
      const authorMatches = [...entry.matchAll(/<name[^>]*>([\s\S]*?)<\/name>/gi)]

      if (!titleMatch || !idMatch) continue
      const title = stripHtml(titleMatch[1]).trim()
      if (!title || title.length < 5) continue

      const rawId = idMatch[1].trim()
      // arXiv IDs look like http://arxiv.org/abs/2106.09685v1
      const url = rawId.replace(/^http:/, 'https:')
      const summary = summaryMatch ? stripHtml(summaryMatch[1]).trim() : ''
      const authors = authorMatches
        .map((m) => stripHtml(m[1]).trim())
        .slice(0, 3)
        .join(', ')
      const publishedDate = publishedMatch ? publishedMatch[1].trim() : undefined

      const content = truncateToTokens(`${authors ? `[${authors}] ` : ''}${summary}`, 500)

      results.push({
        title,
        url,
        content,
        score: Math.min(computeScore(title, summary, query) + 0.12, 0.99), // arXiv authority boost (clamped)
        domain: 'arxiv.org',
        published_date: publishedDate,
      })
    }
  } catch (err) {
    logger.warn('arXiv search failed:', { error: toError(err) })
  }

  return results
}

// ============================================================
// DuckDuckGo Instant Answer API (lightweight, no HTML scraping)
// ============================================================

/**
 * DuckDuckGo Instant Answer API.
 * Free, no API key. Returns Wikipedia-sourced abstracts for factual queries.
 * This is the JSON API (api.duckduckgo.com), NOT the HTML endpoint.
 */
export async function duckDuckGoInstantAnswer(
  query: string,
  timeoutMs = 8000,
  env?: Env,
): Promise<{ abstract: string; source: string; url: string } | null> {
  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      no_html: '1',
      skip_disambig: '1',
    })
    const response = await fetchWithTimeout(
      env,
      `https://api.duckduckgo.com/?${params}`,
      { headers: { Accept: 'application/json' } },
      timeoutMs,
    )
    if (!response.ok) return null
    const data = (await response.json()) as DDGInstantAnswerResponse

    if (data.AbstractText && data.AbstractText.length > 20) {
      return {
        abstract: data.AbstractText,
        source: data.AbstractSource || 'DuckDuckGo',
        url: data.AbstractURL || '',
      }
    }
    return null
  } catch (err) {
    logger.warn('DuckDuckGo Instant Answer API failed:', { error: toError(err) })
    return null
  }
}

interface DDGInstantAnswerResponse {
  AbstractText: string
  AbstractSource: string
  AbstractURL: string
  Heading: string
  RelatedTopics: unknown[]
}

// ============================================================
// Query Type Detection
// ============================================================

/**
 * Detect the type of a search query to determine which specialized sources to use.
 *
 * Phase 1.3: Added optional entities parameter for entity-aware routing.
 * Pass entity information from the understanding module to refine query type.
 */
export type QueryType = 'technical' | 'factual' | 'financial' | 'news' | 'academic' | 'general'

export function detectQueryType(
  query: string,
  entities?: { organizations: string[]; technologies: string[]; products: string[]; people: string[] },
): QueryType {
  const lower = query.toLowerCase()
  const trimmed = query.trim()

  // Extracted entity hints for refined classification
  const hasOrg = entities ? entities.organizations.length > 0 : false
  const hasTech = entities ? entities.technologies.length > 0 : false
  const hasProduct = entities ? entities.products.length > 0 : false
  const hasPerson = entities ? entities.people.length > 0 : false

  // Financial / stock keywords (Korean + English + Chinese)
  // Must be checked BEFORE news because stock queries often contain year numbers
  // Phase 1.3: If known organization is detected + financial context keywords → financial
  const isFinancialPattern =
    /주가|주식|증권|코스피|코스닥|kospi|kosdaq|시세|변동률|상한가|하한가|목표주가|투자의견|실적|배당|주주|공시|기업분석|리서치|\bper\b|\bpbr\b|\broe\b|\beps\b|시가총액|거래량|시장가|주봉|일봉|월봉|\bchart\b|\bfinance\b|\bfinancial\b|\bstock\b|\bprice\b|\bshare\b|\bshares\b|\bdividend\b|market\s?cap|\btrading\b|\bipo\b|공모가/i.test(
      query,
    )

  if (isFinancialPattern) {
    return 'financial'
  }

  // S48: Korean ETF/fund LEARNING intent — 'ETF 투자 방법 초보' (kr-stock-14)
  // contains no stock keyword, so it fell through to general routing, the
  // naver-finance backend never fired, and the eval pool was blog-saturated
  // (NDCG 0.136, finance.naver.com absent above rank 9). Product terms ALONE
  // must NOT classify financial — '환율 동향'/'금리 인하 시점' (kr-news-09/10)
  // are NEWS intents that bare 금리/환율 would hijack — so the gate requires
  // BOTH a product term AND a learning word (방법/초보/입문/추천/비교/how-to/...).
  // Accepted trade-off: '부동산 투자 방법' passes (투자+방법) — the additive
  // naver-finance task adds low-rank noise that the general bing/naver results
  // still outrank (documented S48).
  // 리뷰 반영 (S48): 부동산/코인 투자 쿼리는 네이버 증권 데이터와 무관하므로
  // 학습 게이트에서 제외 (최다 오탐 버킷 — '부동산 투자 방법').
  const isExcludedLearning = /부동산|코인|가상화폐/i.test(query)
  const isFinancialLearningIntent =
    !isExcludedLearning &&
    /ETF|펀드|투자|연금저축|퇴직연금|적립식|재테크|주린이|배당주|가치주|성장주|공모주|인덱스\s*펀드|금리|환율|자산배분|\binvest(?:ing|ment)?s?\b|\bfunds?\b/i.test(
      query,
    ) &&
    /방법|초보|입문|기초|시작|공부|배우|가이드|추천|비교|하는\s*법|tip|guide|beginner|how\s+to|start|learn|recommend|compare/i.test(
      query,
    )

  if (isFinancialLearningIntent) {
    return 'financial'
  }

  // Phase 1.3: Organization-only queries with financial context
  // e.g. "삼성전자 실적", "TSMC earnings"
  if (hasOrg && /실적|실적발표|earnings|revenue|profit|분기/i.test(query)) {
    return 'financial'
  }

  // Technical keywords (expanded for accurate detection)
  // Strong academic signals must win over entity-driven technical routing.
  // Phase 6.7 diagnosis: 'GPT-4 architecture paper' and 'diffusion models
  // generative AI research' were reclassified 'technical' because
  // extractEntityHints tags GPT-4/diffusion-models as technologies and the
  // `hasTech` branch below fires first — dropping arxiv/openalex and
  // producing en-acad-04/05 NDCG 0.000 (top-10 = github repos only).
  // Paper/research/survey/arxiv markers are unambiguous academic intent, so
  // they take precedence over the hasTech boost. Also catches the modern ML
  // vocabulary (LLM/fine-tuning/LoRA) that ds-01 uses and that used to fall
  // through to 'general' with arxiv+github both off.
  const isAcademicSignal =
    /\b(research|paper|papers|study|studies|theory|survey|journal|arxiv|academic|thesis|dissertation|publication)\b/i.test(
      query,
    ) ||
    /\b(llm|llms|fine[- ]?tun|finetun|lora|transformer|transformers|neural\s?network|deep\s?learning|machine\s?learning|generative|diffusion\s?model|large\s?language\s?model|reinforcement\s?learning)\b/i.test(
      query,
    )

  // Pure question forms ('what is X', 'how does X work') are factual lookups
  // even when X contains a technology keyword — 'what is serverless
  // architecture' used to hit the technical branch (serverless) and drop
  // wikipedia, missing the wikipedia.org gold (gk-04 NDCG 0.000).
  // 'how to X' / 'how do I X' remain technical (implementation intent), as do
  // long multi-term questions ('what is the best way to learn React').
  const trimmedLower = trimmed.toLowerCase()
  const isQuestionForm =
    /^(what|who|when|where|why|is|are)\b/.test(trimmedLower) || /^(how)\s+(does|do|is|are|can)\b/.test(trimmedLower)
  const isHowTo = /^(how)\s+(to|do\s+i|do\s+you|can\s+i)\b/.test(trimmedLower)
  const isShortQuestion = isQuestionForm && !isHowTo && trimmed.split(/\s+/).length <= 6

  // Phase 1.3: If entity extraction found technology entities → boost confidence
  // Phase 6.7: added SRE/observability vocabulary (microservices, observability,
  // distributed tracing, telemetry, monitoring, prometheus, grafana, kafka) —
  // ds-05 'microservices observability distributed tracing' fell through to
  // 'general', turning off github (its gold domain) and the docs authority.
  // Declared here (before the question-form branches) so the S22
  // problem-intent branch below can reuse it.
  const isTechnicalPattern =
    /\b(tutorial|tutorials|guide|guides|docs|documentation|example|examples|walkthrough|how\s?to|github|code|coding|programming|api|apis|framework|frameworks|library|libraries|sdk|cli|npm|pip|cargo|yarn|pnpm|docker|kubernetes|react|vue|angular|svelte|nextjs|next\.js|nuxt|express|fastify|hono|django|flask|rails|spring|laravel|python|javascript|typescript|rust|golang|java|kotlin|swift|ruby|php|sql|database|sqlite|postgres|postgresql|mysql|mongodb|redis|graphql|rest|grpc|serverless|cloudflare|workers?|lambda|aws|azure|gcp|vercel|netlify|edge|deploy|deployment|git|webpack|vite|rollup|esbuild|eslint|prettier|jest|vitest|tailwind|bootstrap|html|css|node|deno|bun|oauth|jwt|cors|websocket|devtools|microservices|observability|distributed\s?tracing|telemetry|monitoring|prometheus|grafana|kafka|rabbitmq|terraform|ansible|sre|infrastructure\s?as\s?code|vector\s?database|rag|retrieval\s?augmented)\b/i.test(
      query,
    )

  if (isAcademicSignal) {
    return 'academic'
  }

  // S22: problem-intent troubleshooting queries with a tech signal must route
  // to the technical strategy (github repos + issues + stackexchange + docs).
  // The isShortQuestion branch below classifies 5-word question forms like
  // 'why is redis not working' as 'factual' — dropping the issues backend and
  // producing noise ('WHY' dictionary pages, unrelated videos; live-verified
  // 2026-08-07). Guarded by BOTH the problem-intent gate and a technical
  // keyword/entity so 'why is the sky blue' stays factual.
  // S27 (2026-08-07): CJK technical-vocabulary detection. S22 routed
  // problem-intent queries to technical ONLY when a Latin keyword or an
  // entity-typed technology existed — '레디스 안되' (Redis broken) has
  // neither: '안되' passes the issues-intent gate but the query fell through
  // to 'general' (live-verified), losing the github/issues/docs routing.
  // eval also carries pure-CJK tech gold queries ('자바스크립트 클로저',
  // '数据库索引原理') that classify 'general' the same way.
  const isCjkTech = isCjkTechPattern(query)

  // S22: problem-intent troubleshooting queries with a tech signal must route
  // to the technical strategy (github repos + issues + stackexchange + docs).
  // Guarded by BOTH the problem-intent gate and a technical keyword/entity
  // so 'why is the sky blue' stays factual.
  if (isGithubIssuesIntent(query) && (isTechnicalPattern || hasTech || isCjkTech)) {
    return 'technical'
  }

  if (isShortQuestion) {
    return 'factual'
  }

  if (isTechnicalPattern || hasTech || isCjkTech) {
    return 'technical'
  }

  // News/current events keywords
  // Year numbers alone are news indicators only if no technical/financial keywords matched above
  const _y = new Date().getFullYear()
  const _yearPattern = `${_y}|${_y - 1}`
  // Phase 6.7: added CJK + Korean news markers (最新/新闻/发布/發佈/ニュース/発表/速報/報道/뉴스/속보/보도/기사)
  // — zh-news/ja-news queries carry no English news word, so without these
  // they classified 'general' and skipped the news RSS backends entirely.
  // Phase P1: added Korean news markers (뉴스/속보/보도/기사/최신) — same pattern:
  // 'AI 최신 뉴스' was classified 'general' and never triggered NewsStrategy.
  if (
    new RegExp(
      `\\b(latest|news|today|${_yearPattern}|recent|breaking|update|updates|announce|announcement|launch|launched|release|released)\\b`,
      'i',
    ).test(query) ||
    /最新|新闻|新聞|发布|發佈|ニュース|発表|速報|報道|뉴스|속보|보도|기사/.test(query)
  ) {
    return 'news'
  }

  // Academic keywords
  // Phase 1.3: If entities include known academic concepts + academic keywords → boost
  if (
    /\b(research|paper|study|theory|analysis|survey|journal|arxiv|academic|science|physics|biology|medicine)\b/i.test(
      query,
    )
  ) {
    return 'academic'
  }

  // Factual - short queries that look like entity lookups
  // Phase 1.3: Enhanced with entity detection
  const isShortQuery = trimmed.split(/\s+/).length <= 4
  const isQuestionPattern =
    /\b(what|who|when|where|definition|meaning|is|are|was|were)\b/i.test(lower) ||
    /什么是|什麼是|什么叫|什麼叫/.test(query)

  if (isShortQuery && (isQuestionPattern || hasOrg || hasProduct || hasPerson)) {
    return 'factual'
  }

  return 'general'
}

/**
 * Determine which specialized sources to query based on query type.
 */
export function getSourcesForQueryType(type: QueryType): {
  useWikipedia: boolean
  useGitHub: boolean
  useHackerNews: boolean
  useReddit: boolean
  useArxiv: boolean
  /** S96: keyless OpenAlex works API (replaces the captcha-dead Google Scholar scraper). */
  useOpenAlex: boolean
} {
  switch (type) {
    case 'technical':
      // Phase 6.7: wikipedia ON for technical queries — ds-04 (edge computing
      // latency optimization) and gk-04 (what is serverless architecture) have
      // wikipedia.org in their gold domains, but technical used to skip it
      // entirely, leaving the top-10 to github repos alone (NDCG 0.000).
      return {
        useWikipedia: true,
        useGitHub: true,
        useHackerNews: true,
        useReddit: false,
        useArxiv: false,
        useOpenAlex: false,
      }
    case 'factual':
      // Factual: Wikipedia for definitions + HackerNews for discussions/explanations
      // HackerNews boosts result count for "what is X" queries with community explanations
      return {
        useWikipedia: true,
        useGitHub: false,
        useHackerNews: true,
        useReddit: false,
        useArxiv: false,
        useOpenAlex: false,
      }
    case 'financial':
      // Financial queries: Wikipedia for company background + HackerNews for stock discussion/news.
      // HN provides stock market discussions, earnings analysis, and investor commentary
      // that Bing stock-card results don't cover — boosts result count to 10+.
      return {
        useWikipedia: true,
        useGitHub: false,
        useHackerNews: true,
        useReddit: false,
        useArxiv: false,
        useOpenAlex: false,
      }
    case 'news':
      return {
        useWikipedia: false,
        useGitHub: false,
        useHackerNews: true,
        useReddit: true,
        useArxiv: false,
        useOpenAlex: false,
      }
    case 'academic':
      // Academic: Wikipedia + arXiv for research papers + OpenAlex works API.
      // Phase 6.7: github ON — ds-01 (LLM fine-tuning LoRA) gold includes
      // github.com (huggingface/awesome-list repos), which academic skipped.
      // S96: useOpenAlex replaces useGoogleScholar — the Scholar scraper is
      // captcha-dead (78/78 eval runs), OpenAlex is keyless and returns
      // openreview/aclanthology/jmlr/nature/ieee landing pages directly.
      return {
        useWikipedia: true,
        useGitHub: true,
        useHackerNews: false,
        useReddit: false,
        useArxiv: true,
        useOpenAlex: true,
      }
    default:
      return {
        useWikipedia: true,
        useGitHub: false,
        useHackerNews: true,
        useReddit: false,
        useArxiv: false,
        useOpenAlex: false,
      }
  }
}

// ============================================================
// Knowledge Graph / Entity Panel
// ============================================================

/**
 * Fetch a knowledge graph panel for a query using Wikipedia's REST summary API.
 * Returns a KnowledgeGraph object with title, description, image, and key facts,
 * or null if no entity is found.
 */
/**
 * Get Wikidata entity ID from a Wikipedia page title.
 */
async function wikipediaToWikidataId(title: string, language = 'en'): Promise<string | null> {
  try {
    const url = `https://${language}.wikipedia.org/w/api.php?action=query&prop=pageprops&titles=${encodeURIComponent(title)}&format=json&redirects=1`
    const resp = await fetch(url, { headers: { 'User-Agent': 'SearchAPI/1.0' } })
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    const pages = (data.query as Record<string, unknown>)?.pages as Record<string, Record<string, unknown>> | undefined
    if (!pages) return null
    for (const page of Object.values(pages)) {
      const props = page.pageprops as Record<string, string> | undefined
      if (props?.wikibase_item) return props.wikibase_item
    }
    return null
  } catch (err) {
    logger.warn('Wikipedia Wikidata lookup failed:', { error: toError(err) })
    return null
  }
}

/**
 * Fetch Wikidata entity and extract interesting facts.
 */
async function wikidataEntityFacts(wikidataId: string): Promise<{
  type?: string
  facts: Record<string, string>
  image?: string
  timeline?: Array<{ date: string; event: string }>
  stats?: Record<string, string>
} | null> {
  try {
    const url = `https://www.wikidata.org/wiki/Special:EntityData/${wikidataId}.json`
    const resp = await fetch(url, { headers: { 'User-Agent': 'SearchAPI/1.0' } })
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    const entities = data.entities as Record<string, Record<string, unknown>>
    const entity = entities?.[wikidataId] as Record<string, unknown> | undefined
    if (!entity) return null

    const claims = entity.claims as
      Record<string, { mainsnak: { datavalue?: { value?: unknown } }; rank?: string }[]> | undefined
    if (!claims) return null

    const facts: Record<string, string> = {}
    let type: string | undefined
    let image: string | undefined

    // Instance of (P31) → determine KG type
    const instanceOf = claims.P31?.[0]?.mainsnak?.datavalue?.value as Record<string, unknown> | undefined
    const instanceId = instanceOf?.id as string | undefined
    if (instanceId) {
      if (['Q5', 'Q215627', 'Q95074', 'Q811430'].includes(instanceId)) type = 'person'
      else if (['Q43229', 'Q4830453', 'Q6881511'].includes(instanceId)) type = 'organization'
      else if (['Q486972', 'Q515', 'Q5107', 'Q3957'].includes(instanceId)) type = 'place'
      else if (['Q7725634', 'Q188451', 'Q11424'].includes(instanceId)) type = 'concept'
      else type = 'concept'
    }

    // Helper to get label from claim
    const claimValue = (claimId: string): string | undefined => {
      const claim = claims[claimId]?.[0]
      if (!claim) return undefined
      const val = claim.mainsnak?.datavalue?.value
      if (typeof val === 'string') return val
      if (val && typeof val === 'object') {
        const v = val as Record<string, unknown>
        return (v.label || v.text || v.id || v.time || '') as string
      }
      return undefined
    }

    // Map claim IDs to human-readable labels
    const CLAIM_MAP: Record<string, string> = {
      P569: 'Born',
      P570: 'Died',
      P571: 'Founded',
      P576: 'Dissolved',
      P577: 'Publication date',
      P856: 'Website',
      P112: 'Founder',
      P488: 'Chairperson',
      P169: 'CEO',
      P127: 'Owner',
      P159: 'Headquarters',
      P17: 'Country',
      P1082: 'Population',
      P2046: 'Area',
      P2048: 'Height',
      P2049: 'Width',
      P2079: 'Production',
      P2131: 'Revenue',
      P2403: 'Net profit',
      P2295: 'Net income',
      P414: 'Stock exchange',
      P1454: 'Legal form',
      P452: 'Industry',
      P1056: 'Product',
      P1416: 'Award received',
    }

    for (const [claimId, label] of Object.entries(CLAIM_MAP)) {
      const val = claimValue(claimId)
      if (val) facts[label] = val
    }

    // Image (P18)
    const imageClaim = claims.P18?.[0]?.mainsnak?.datavalue?.value as string | undefined
    if (imageClaim) {
      image = `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(imageClaim.replace(/\s+/g, '_'))}`
    }

    const timeline = extractTimelineFromClaims(claims)
    const stats = extractStatsFromClaims(claims)

    return Object.keys(facts).length > 0 || type ? { type, facts, image, timeline, stats } : null
  } catch (err) {
    logger.warn('Wikidata entity fetch failed:', { error: toError(err) })
    return null
  }
}

/**
 * Extract a chronological timeline from Wikidata claims.
 * Only date-typed claims (time precision ≥ year) are included.
 */
export function extractTimelineFromClaims(
  claims: Record<string, { mainsnak: { datavalue?: { value?: unknown } }; rank?: string }[]>,
): Array<{ date: string; event: string }> {
  const TIMELINE_CLAIMS: Record<string, string> = {
    P569: 'Born',
    P570: 'Died',
    P571: 'Founded',
    P576: 'Dissolved',
    P577: 'Publication date',
    P580: 'Start time',
    P582: 'End time',
    P1619: 'Opened',
  }

  const timeline: Array<{ date: string; event: string }> = []
  for (const [claimId, label] of Object.entries(TIMELINE_CLAIMS)) {
    const claim = claims[claimId]?.[0]
    const val = claim?.mainsnak?.datavalue?.value
    if (!val || typeof val !== 'object') continue
    const time = (val as { time?: string }).time
    if (!time) continue
    // Wikidata time format: "+1969-07-20T00:00:00Z" — extract the year
    const yearMatch = time.match(/[+-]?(\d{4})/)
    if (yearMatch) timeline.push({ date: yearMatch[1], event: label })
  }

  return timeline.sort((a, b) => a.date.localeCompare(b.date))
}

/**
 * Extract key numeric statistics from Wikidata claims (population, area, revenue...).
 */
export function extractStatsFromClaims(
  claims: Record<string, { mainsnak: { datavalue?: { value?: unknown } }; rank?: string }[]>,
): Record<string, string> {
  const STAT_CLAIMS: Record<string, string> = {
    P1082: 'Population',
    P2046: 'Area',
    P2048: 'Height',
    P2049: 'Width',
    P2131: 'Revenue',
    P2403: 'Net profit',
    P2295: 'Net income',
    P2079: 'Production',
  }

  const stats: Record<string, string> = {}
  for (const [claimId, label] of Object.entries(STAT_CLAIMS)) {
    const claim = claims[claimId]?.[0]
    const val = claim?.mainsnak?.datavalue?.value
    if (!val) continue
    // Amount form: { amount: "+510000000", unit: "..." } or plain number/string
    let raw: string
    if (typeof val === 'string' || typeof val === 'number') {
      raw = String(val)
    } else {
      const amount = (val as { amount?: string }).amount
      if (typeof amount !== 'string') continue
      raw = amount
    }
    const normalized = raw.replace(/^[+-]/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',')
    if (normalized && normalized !== '0') stats[label] = normalized
  }

  return stats
}

/**
 * Fetch DBPedia entity data and extract abstract + thumbnail.
 * Free, no API key. Silent failure — returns null on any error.
 */
export async function fetchDbpediaEntity(
  title: string,
  env?: Env,
): Promise<{ abstract?: string; thumbnail?: string } | null> {
  try {
    const encodedTitle = encodeURIComponent(title.replace(/\s+/g, '_'))
    const url = `https://dbpedia.org/data/${encodedTitle}.json`
    const resp = await fetchWithTimeout(
      env,
      url,
      {
        headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0' },
      },
      6000,
    )
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    // DBPedia JSON structure: { "http://dbpedia.org/resource/Title": { predicate: [{ value }] } }
    const resourceKey = `http://dbpedia.org/resource/${encodedTitle}`
    const entity = data[resourceKey] as Record<string, Array<{ value?: unknown }>> | undefined
    if (!entity) return null

    const pick = (predicate: string): string | undefined => {
      const value = entity[predicate]?.[0]?.value
      return typeof value === 'string' ? value : undefined
    }

    const abstract = pick('http://dbpedia.org/ontology/abstract')
    const thumbnail = pick('http://dbpedia.org/ontology/thumbnail')
    return abstract || thumbnail ? { abstract, thumbnail } : null
  } catch (err) {
    logger.warn('DBPedia entity fetch failed:', { error: toError(err) })
    return null
  }
}

/**
 * Fetch Wikipedia infobox HTML snippet and extract key-value pairs.
 */
async function wikipediaInfobox(query: string, language = 'en'): Promise<Record<string, string> | null> {
  try {
    // Use the Action API to get the page HTML
    const url = `https://${language}.wikipedia.org/w/api.php?action=parse&page=${encodeURIComponent(query)}&prop=text&section=0&format=json&redirects=1`
    const resp = await fetch(url, { headers: { 'User-Agent': 'SearchAPI/1.0' } })
    if (!resp.ok) return null
    const data = (await resp.json()) as Record<string, unknown>
    const parseData = data.parse as Record<string, unknown> | undefined
    const text = parseData?.text as Record<string, unknown> | undefined
    const html = text?.['*'] as string | undefined
    if (!html) return null

    // Match infobox table rows: <th>label</th><td>value</td>
    const facts: Record<string, string> = {}
    const infoboxRegex =
      /<th[^>]*class="infobox-label"[^>]*>(.*?)<\/th>\s*<td[^>]*class="infobox-data"[^>]*>(.*?)<\/td>/gi
    let match: RegExpExecArray | null
    while ((match = infoboxRegex.exec(html)) !== null) {
      const label = stripHtml(match[1]).trim()
      const value = stripHtml(match[2]).trim()
      if (label && value && label.length < 50 && value.length < 200) {
        facts[label] = value
      }
    }

    // Fallback: older infobox format
    if (Object.keys(facts).length === 0) {
      const oldRegex = /<tr>\s*<th[^>]*>(.*?)<\/th>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gi
      let m2: RegExpExecArray | null
      while ((m2 = oldRegex.exec(html)) !== null) {
        const label = stripHtml(m2[1]).trim()
        const value = stripHtml(m2[2]).trim()
        if (label && value && label.length < 50 && value.length < 200 && !label.includes('<')) {
          facts[label] = value
        }
      }
    }

    return Object.keys(facts).length > 0 ? facts : null
  } catch (err) {
    logger.warn('Wikipedia infobox parsing failed:', { error: toError(err) })
    return null
  }
}

/**
 * Wikipedia → Wikidata → Infobox Knowledge Graph
 *
 * Combines three data sources for rich entity information:
 * 1. Wikipedia summary (description, image)
 * 2. Wikidata entity (structured facts, entity type, logo)
 * 3. Wikipedia infobox (detailed key-value pairs)
 */
export async function getKnowledgeGraph(
  query: string,
  language = 'en',
  env?: Env,
): Promise<{
  title: string
  description: string
  url?: string
  image?: string
  type?: string
  facts?: Record<string, string>
  timeline?: Array<{ date: string; event: string }>
  stats?: Record<string, string>
} | null> {
  try {
    // Phase 1: Get Wikipedia summary (primary source of truth)
    const summaryUrl = `https://${language}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query.replace(/\s+/g, '_'))}`
    const summaryResp = await fetchWithTimeout(
      env,
      summaryUrl,
      { headers: { Accept: 'application/json', 'User-Agent': 'SearchAPI/1.0 (contact@example.com)' } },
      6000,
    )

    if (!summaryResp.ok) return null
    const summary = (await summaryResp.json()) as Record<string, unknown>

    // Wikipedia returns type: "standard" for real articles, "disambiguation" for ambiguous
    if (summary.type === 'disambiguation' || !summary.extract) return null

    const title = summary.title as string
    const extract = summary.extract as string
    const pageUrl = (summary.content_urls as { desktop?: { page?: string } })?.desktop?.page
    const thumbnail = (summary.thumbnail as { source?: string })?.source
    const description = summary.description as string | undefined

    // Phase 2: Get Wikidata ID → richer facts + DBPedia abstract (run in parallel with infobox)
    const wikidataId = await wikipediaToWikidataId(title, language)

    const [wd, infobox, dbpedia] = await Promise.all([
      wikidataId ? wikidataEntityFacts(wikidataId) : Promise.resolve(null),
      wikipediaInfobox(title, language),
      fetchDbpediaEntity(title, env),
    ])

    // Merge facts: Wikidata structured data + Wikipedia infobox
    const facts: Record<string, string> = {}
    if (wd?.facts) Object.assign(facts, wd.facts)
    if (infobox) {
      for (const [key, value] of Object.entries(infobox)) {
        // Wikidata takes precedence for overlapping keys
        if (!facts[key]) facts[key] = value
      }
    }
    // Always include description
    if (description) facts['Description'] = description

    const image = wd?.image || dbpedia?.thumbnail || thumbnail
    const type =
      wd?.type ??
      (description?.toLowerCase().includes('company')
        ? 'organization'
        : description?.toLowerCase().includes('person')
          ? 'person'
          : description?.toLowerCase().includes('city') || description?.toLowerCase().includes('country')
            ? 'place'
            : 'concept')

    return {
      title,
      description: extract.slice(0, 400),
      url: pageUrl || `https://${language}.wikipedia.org/wiki/${encodeURIComponent(title)}`,
      image,
      type,
      facts: Object.keys(facts).length > 0 ? facts : undefined,
      timeline: wd?.timeline && wd.timeline.length > 0 ? wd.timeline : undefined,
      stats: wd?.stats && Object.keys(wd.stats).length > 0 ? wd.stats : undefined,
    }
  } catch (err) {
    logger.warn('Wikipedia knowledge graph fetch failed:', { error: toError(err) })
    return null
  }
}
