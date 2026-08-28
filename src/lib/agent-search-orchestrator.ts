import { normalizeUrl } from './util'
import { naverSearch } from './naver-search'
import { bingSearch } from './bing-search'
import { duckDuckGoSearch, isDuckDuckGoCoolingDown } from './duckduckgo'
import { wikipediaBackboneSearch } from './wikipedia-backbone'
import type { Env } from '../types'

export interface AgentSearchHit {
  title: string
  url: string
  snippet: string
  score: number
  source: string
  authority_boost?: boolean
}

export interface AgentSearchResult {
  query: string
  took_ms: number
  hits: AgentSearchHit[]
  aborted_backends: string[]
  signal_confidence: 'HIGH' | 'MEDIUM' | 'LOW'
  decomposed_subqueries?: string[]
  /** Present when this response came from the micro cache */
  cached?: boolean
  /** Age of the cached copy in ms (freshness signal for agents) */
  cache_age_ms?: number
}

export interface AgentSearchOptions {
  maxResults?: number
  timeoutMs?: number
  topic?: 'general' | 'code' | 'news' | 'finance'
  decomposeSubqueries?: boolean
  env?: Env
}

/**
 * Per-batch callback fired the moment a provider's results land — lets callers
 * (e.g. the SSE stream route) emit hits in arrival order instead of waiting
 * for the whole race to settle. Returning a Promise is awaited inside that
 * provider's task only, so slow consumers delay their own batch, not others.
 */
export type AgentHitsListener = (hits: AgentSearchHit[], source: string) => void | Promise<void>

// Zero-overlap lexical scores (computeScore floor ~0.05) are harvested
// navigation chrome — author cards, index pages. Below this the hit is noise
// for an agent deciding what to read next. The main pipeline's adaptive
// threshold bottoms out at 0.01–0.08; the fast path holds a slightly higher
// bar because it serves a tight top-k.
const FAST_PATH_NOISE_FLOOR = 0.1

// ============================================================
// Micro cache — agent loops re-issue near-identical queries within seconds.
// 60s TTL is short enough for news, long enough to absorb loop chatter and
// spare the scraping backends. Empty results are NOT cached: a scraper
// hiccup should not freeze "no results" for a minute.
// ============================================================
const FAST_PATH_CACHE_TTL_MS = 60_000
const FAST_PATH_CACHE_MAX_ENTRIES = 200

interface FastPathCacheEntry {
  result: AgentSearchResult
  cachedAt: number
}
const FAST_PATH_CACHE = new Map<string, FastPathCacheEntry>()

/** Test hook — isolate the micro cache between tests. */
export function resetFastPathCache(): void {
  FAST_PATH_CACHE.clear()
}

function fastPathCacheKey(query: string, maxResults: number, topic: string, decompose: boolean): string {
  return `${query}|${maxResults}|${topic}|${decompose ? 1 : 0}`
}

function getFromFastPathCache(key: string): { result: AgentSearchResult; ageMs: number } | undefined {
  const entry = FAST_PATH_CACHE.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.cachedAt > FAST_PATH_CACHE_TTL_MS) {
    FAST_PATH_CACHE.delete(key)
    return undefined
  }
  return { result: entry.result, ageMs: Date.now() - entry.cachedAt }
}

function setInFastPathCache(key: string, result: AgentSearchResult): void {
  if (result.hits.length === 0) return
  FAST_PATH_CACHE.set(key, { result, cachedAt: Date.now() })
  if (FAST_PATH_CACHE.size > FAST_PATH_CACHE_MAX_ENTRIES) {
    const oldest = FAST_PATH_CACHE.keys().next().value
    if (oldest !== undefined) FAST_PATH_CACHE.delete(oldest)
  }
}

// First-party documentation and code hosts only. Aggregator blogs (medium.com,
// dev.to) were deliberately removed: scraped copies of official docs get the
// same +0.1 boost as the source of truth and outrank it on snippet match.
const CODE_AUTHORITY_DOMAINS = [
  'github.com',
  'stackoverflow.com',
  'developer.mozilla.org',
  'learn.microsoft.com',
  'npmjs.com',
  'pypi.org',
  'pkg.go.dev',
  'crates.io',
  'go.dev',
  'nodejs.org',
  'docs.python.org',
  'docs.oracle.com',
  'rust-lang.org',
  'kubernetes.io',
  'nextjs.org',
  'react.dev',
  'vuejs.org',
]

function isCodeAuthorityUrl(url: string): boolean {
  // Hostname suffix match on a parsed URL — the previous url.includes(d)
  // substring check matched path segments ("evil.com/github.com") and any
  // host containing the constant ("mydocs.example.com" for 'docs.').
  try {
    const host = new URL(url).hostname.toLowerCase()
    return CODE_AUTHORITY_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))
  } catch {
    return false
  }
}

export function generateSubqueries(query: string, topic: string): string[] {
  const subqueries = [query]
  // Match the sub-query language to the query language — appending Korean
  // suffixes to an English news query produced off-language sub-searches.
  const isKorean = /[\uac00-\ud7af]/.test(query)
  if (topic === 'code') {
    if (!/github|docs?/i.test(query)) subqueries.push(`${query} official documentation`)
    if (!/error|solution|fix/i.test(query)) subqueries.push(`${query} example solution`)
  } else if (topic === 'news') {
    subqueries.push(isKorean ? `${query} 속보 뉴스` : `${query} latest news`)
  } else if (topic === 'finance') {
    subqueries.push(isKorean ? `${query} 실적 주가 공시` : `${query} earnings stock price`)
  }
  return subqueries.slice(0, 3)
}

// Single-flight: concurrent identical queries collapse into one fan-out.
// Agent loops fan out subagents that fire duplicate queries in the same
// instant — without this, each duplicate races the micro cache (stores only
// on completion) and pays full backend latency, doubling scraping pressure
// and arming anti-bot. Mirrors orchestrator.ts's INFLIGHT_SEARCHES.
const INFLIGHT_SEARCHES = new Map<string, Promise<AgentSearchResult>>()

/** Test hook — isolate the single-flight map between tests. */
export function resetFastPathInflight(): void {
  INFLIGHT_SEARCHES.clear()
}

async function replayHits(hits: AgentSearchHit[], onHits: AgentHitsListener): Promise<void> {
  const bySource = new Map<string, AgentSearchHit[]>()
  for (const h of hits) {
    const list = bySource.get(h.source) ?? []
    list.push(h)
    bySource.set(h.source, list)
  }
  for (const [source, batch] of bySource) {
    await onHits(batch, source)
  }
}

export async function executeFastAgentSearch(
  query: string,
  maxResults = 5,
  timeoutMs = 2500,
  env?: Env,
  topic: 'general' | 'code' | 'news' | 'finance' = 'general',
  decomposeSubqueries = false,
  onHits?: AgentHitsListener,
): Promise<AgentSearchResult> {
  const start = performance.now()
  const isKorean = /[\uac00-\ud7af\u1100-\u11ff]/.test(query)

  // Micro cache — replay stored hits (grouped per source so stream listeners
  // see the same batch shape as a live run) with an honest age stamp.
  const cacheKey = fastPathCacheKey(query, maxResults, topic, decomposeSubqueries)
  const cached = getFromFastPathCache(cacheKey)
  if (cached) {
    if (onHits) await replayHits(cached.result.hits, onHits)
    return { ...cached.result, cached: true, cache_age_ms: cached.ageMs }
  }

  // Single-flight: join an identical in-flight query instead of racing it.
  // The joiner replays the settled hits through its own onHits listener and
  // reports its own wall time (the leader's took_ms is not the joiner's).
  const inflight = INFLIGHT_SEARCHES.get(cacheKey)
  if (inflight) {
    const result = await inflight
    if (onHits) await replayHits(result.hits, onHits)
    return { ...result, took_ms: Math.round(performance.now() - start) }
  }

  const execution = (async (): Promise<AgentSearchResult> => {
    const hits: AgentSearchHit[] = []
    const seenUrls = new Set<string>()
    const abortedBackends: string[] = []

    const queriesToRun = decomposeSubqueries ? generateSubqueries(query, topic) : [query]

    const tasks: Array<() => Promise<void>> = []

    for (const q of queriesToRun) {
      // Korean: naver first-class + bing ko-KR. Non-Korean: bing en-US + DDG —
      // naver returns noise for English queries and bing-only left the fast path
      // with a single point of scraping failure.
      const providers = isKorean
        ? [
            {
              name: 'naver_mobile',
              fn: () => naverSearch(q, { maxResults, timeoutMs, env }),
            },
            {
              name: 'bing_mobile',
              fn: () => bingSearch(q, { maxResults, timeoutMs, region: 'ko-KR', env }),
            },
          ]
        : [
            {
              name: 'bing_mobile',
              fn: () => bingSearch(q, { maxResults, timeoutMs, region: 'en-US', env }),
            },
            {
              name: 'duckduckgo',
              fn: () => duckDuckGoSearch(q, { maxResults, timeoutMs, region: 'wt-wt', env }),
            },
          ]

      for (const { name, fn } of providers) {
        tasks.push(async () => {
          try {
            const rawResults = await fn()
            if (rawResults.length === 0 && name === 'duckduckgo' && isDuckDuckGoCoolingDown()) {
              // Empty DDG during the 202 cooldown is a provider outage, not a
              // "no results" — report it so agents don't trust bing-only output
              // as full coverage.
              if (!abortedBackends.includes('duckduckgo(antibot-cooldown)')) {
                abortedBackends.push('duckduckgo(antibot-cooldown)')
              }
            }
            const batch: AgentSearchHit[] = []
            for (let i = 0; i < rawResults.length; i++) {
              const item = rawResults[i]
              const norm = normalizeUrl(item.url)
              if (seenUrls.has(norm)) continue
              seenUrls.add(norm)

              // Backends without a lexical score get a rank-decayed prior
              // (first hit 0.80, −0.05 per rank, floor 0.50). The previous flat
              // 0.85 seed made almost every batch read as HIGH confidence.
              const fallback = Math.max(0.5, 0.8 - i * 0.05)
              let score = typeof item.score === 'number' && item.score > 0 ? item.score : fallback

              // Code Authority Boosting
              let authorityBoost = false
              if (topic === 'code' && isCodeAuthorityUrl(item.url)) {
                score = Math.min(score + 0.1, 1.0)
                authorityBoost = true
              }

              if (score < FAST_PATH_NOISE_FLOOR) continue

              batch.push({
                title: item.title,
                url: item.url,
                snippet: item.content || '',
                score,
                source: name,
                authority_boost: authorityBoost,
              })
            }
            if (batch.length > 0) {
              hits.push(...batch)
              await onHits?.(batch, name)
            }
          } catch (_err) {
            if (!abortedBackends.includes(name)) {
              abortedBackends.push(name)
            }
          }
        })
      }
    }

    await Promise.allSettled(tasks.map((t) => t()))

    // Knowledge backbone: when every provider came back empty (scrapers
    // blocked/cooling-down, or genuinely nothing), Wikipedia's official keyless
    // API keeps the agent unblocked instead of returning a bare LOW. This only
    // fires on the empty path, so p50 is untouched.
    if (hits.length === 0) {
      try {
        const wikiResults = await wikipediaBackboneSearch(query, {
          maxResults,
          language: isKorean ? 'ko' : 'en',
          env,
        })
        const batch: AgentSearchHit[] = []
        for (const item of wikiResults) {
          if (typeof item.score !== 'number' || item.score < FAST_PATH_NOISE_FLOOR) continue
          batch.push({
            title: item.title,
            url: item.url,
            snippet: item.content || '',
            score: item.score,
            source: 'wikipedia',
          })
        }
        if (batch.length > 0) {
          hits.push(...batch)
          await onHits?.(batch, 'wikipedia')
        }
      } catch (_err) {
        if (!abortedBackends.includes('wikipedia')) {
          abortedBackends.push('wikipedia')
        }
      }
    }

    hits.sort((a, b) => b.score - a.score)
    const finalHits = hits.slice(0, maxResults)

    // Confidence is derived from scored evidence only: HIGH needs at least two
    // hits at ≥0.75, MEDIUM means usable results, LOW means nothing arrived.
    const strongHits = finalHits.filter((h) => h.score >= 0.75).length
    const signalConfidence: AgentSearchResult['signal_confidence'] =
      finalHits.length === 0 ? 'LOW' : strongHits >= 2 ? 'HIGH' : 'MEDIUM'

    const result: AgentSearchResult = {
      query,
      took_ms: Math.round(performance.now() - start),
      hits: finalHits,
      aborted_backends: abortedBackends,
      signal_confidence: signalConfidence,
      decomposed_subqueries: decomposeSubqueries ? queriesToRun : undefined,
    }
    setInFastPathCache(cacheKey, result)
    return result
  })()

  INFLIGHT_SEARCHES.set(cacheKey, execution)
  // finally (not only-then): the slot must clear on rejection too, or a
  // single throw would wedge this query for the isolate's lifetime.
  return execution.finally(() => {
    INFLIGHT_SEARCHES.delete(cacheKey)
  })
}
