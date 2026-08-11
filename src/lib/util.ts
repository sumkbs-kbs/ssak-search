/**
 * Shared utility functions for the search engine
 */

import type { Env } from '../types'

import { logger, toError } from './logger'

// ============================================================
// Subrequest budget — guards the Cloudflare 50-subrequest/request cap
// ============================================================

/**
 * Cloudflare Workers/Pages hard limit on outbound subrequests per request.
 * We start shedding non-essential work at SUBREQUEST_SOFT_LIMIT so the
 * orchestrator still has headroom to finish and serialize a response.
 */
export const SUBREQUEST_HARD_LIMIT = 50
export const SUBREQUEST_SOFT_LIMIT = 40

/**
 * Per-request subrequest tracker. fetchWithTimeout() increments the tracker
 * on every outbound backend fetch; fan-out callers can poll budgetExhausted()
 * to skip remaining backends once the soft limit is hit.
 *
 * Implementation note: we do NOT monkey-patch globalThis.fetch. On Cloudflare
 * Workers the `fetch` binding is effectively read-only per request — a patch
 * silently no-ops, so the counter stays at 0 (this was the original bug).
 * Instead fetchWithTimeout is the single choke point all 30+ backend fetches
 * pass through, so we count there.
 *
 * The tracker is wired into a module-global slot via installSubrequestTracker()
 * for the duration of a request. Workers isolates are per-request, so the slot
 * cannot leak across requests.
 */
export class SubrequestTracker {
  count = 0
  readonly softLimit: number
  readonly hardLimit: number

  constructor(softLimit = SUBREQUEST_SOFT_LIMIT, hardLimit = SUBREQUEST_HARD_LIMIT) {
    this.softLimit = softLimit
    this.hardLimit = hardLimit
  }

  /** True once we've passed the soft limit — fan-out should stop adding work. */
  budgetExhausted(): boolean {
    return this.count >= this.softLimit
  }

  /** True at the Cloudflare hard limit — the next fetch will likely throw. */
  budgetCritical(): boolean {
    return this.count >= this.hardLimit - 2
  }

  /** Increment the counter and enforce the hard limit by throwing. */
  tick(): void {
    this.count++
    if (this.count > this.hardLimit) {
      throw new Error(
        `Subrequest budget exhausted (${this.count}/${this.hardLimit}) — request would exceed Cloudflare limit`,
      )
    }
  }
}

/**
 * Module-global slot for the active request's tracker. Workers isolates are
 * single-request, so this is per-request in practice. Cleared on uninstall.
 */
let _activeTracker: SubrequestTracker | null = null

/**
 * Register a subrequest tracker as active for the current request. Returns an
 * uninstall function that MUST be called (via c.executionCtx.waitUntil or a
 * finally block) to clear the slot before the isolate is reused.
 */
export function installSubrequestTracker(tracker: SubrequestTracker): () => void {
  _activeTracker = tracker
  return () => {
    if (_activeTracker === tracker) _activeTracker = null
  }
}

/**
 * Internal hook called by fetchWithTimeout on every outbound fetch. If a
 * tracker is active for the current request, it increments the count and
 * enforces the hard limit. No-op when no tracker is installed (library reuse,
 * tests, non-request contexts).
 */
function tickSubrequestTracker(): void {
  const tracker = _activeTracker
  if (tracker) tracker.tick()
}

// ============================================================
// Domain Authority Map
// ============================================================

/** Domain authority scores (0.0-0.15) for known high-quality sources */
const DOMAIN_AUTHORITY: Record<string, number> = {
  'wikipedia.org': 0.12,
  'en.wikipedia.org': 0.12,
  'ko.wikipedia.org': 0.12,
  'zh.wikipedia.org': 0.12,
  'github.com': 0.1,
  'stackoverflow.com': 0.1,
  'arxiv.org': 0.1,
  'developer.mozilla.org': 0.09,
  'reddit.com': 0.05,
  'news.ycombinator.com': 0.06,
  'naver.com': 0.06,
  'm.stock.naver.com': 0.08,
  'daum.net': 0.04,
  'namu.wiki': 0.05,
  'investing.com': 0.07,
  'bloomberg.com': 0.1,
  'reuters.com': 0.1,
  'nytimes.com': 0.09,
  'bbc.com': 0.08,
}

/** Get domain authority boost for a URL */
export function getDomainAuthority(url: string): number {
  const domain = extractDomain(url)
  for (const [known, score] of Object.entries(DOMAIN_AUTHORITY)) {
    if (domain === known || domain.endsWith(`.${known}`)) {
      return score
    }
  }
  return 0
}

/** Extract the registered domain from a URL string */
export function extractDomain(url: string): string {
  try {
    const u = new URL(url)
    return u.hostname.replace(/^www\./, '')
  } catch (err) {
    logger.warn('URL parsing failed:', { error: toError(err) })
    return ''
  }
}

/** Normalize a URL (add https:// if missing). Rejects non-http(s) schemes. */
export function normalizeUrl(url: string): string {
  const trimmed = url.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^\/\//.test(trimmed)) return `https:${trimmed}`
  // Reject anything that looks like another scheme (file://, javascript:, data:, etc.)
  // by prefixing with https:// — only allow bare host/path forms.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new Error(`Unsupported URL scheme: ${trimmed}`)
  }
  return `https://${trimmed}`
}

/**
 * Check whether a URL points at a private / loopback / link-local / reserved
 * address that must not be fetched server-side (SSRF protection).
 *
 * Returns true if the URL is SAFE to fetch (public hostname), false otherwise.
 * Hostnames are matched as strings — this is best-effort and does NOT resolve
 * DNS, so an attacker who controls DNS for "evil.com" → 127.0.0.1 can still
 * probe us. Cloudflare's fetch already blocks most private egress by default,
 * but this is the application-layer gate.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '') // strip IPv6 brackets

  // IPv4 in decimal/hex/octet forms (parse defensively)
  const ipv4Match = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (ipv4Match) {
    const octets = ipv4Match.slice(1).map((o) => parseInt(o, 10))
    if (octets.some((n) => n > 255)) return false // malformed
    const [a, b] = octets
    if (a === 0) return false // 0.0.0.0/8
    if (a === 10) return false // 10.0.0.0/8
    if (a === 127) return false // 127.0.0.0/8
    if (a === 169 && b === 254) return false // 169.254.0.0/16 link-local + AWS/GCP metadata
    if (a === 172 && b >= 16 && b <= 31) return false // 172.16.0.0/12
    if (a === 192 && b === 168) return false // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return false // 100.64.0.0/10 CGNAT
    if (a >= 224) return false // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved
    return true
  }

  // IPv6 — block all reserved ranges
  if (host.includes(':')) {
    // ::1 loopback, fc00::/7 unique-local, fe80::/10 link-local, :: unspecified
    if (host === '::' || host === '::1') return false
    if (/^fc/.test(host) || /^fd/.test(host)) return false // ULA
    if (/^fe[89ab]/i.test(host)) return false // link-local
    if (/^ff/i.test(host)) return false // multicast
    // IPv4-mapped IPv6 — Cloudflare's URL parser may emit decimal "::ffff:127.0.0.1"
    // OR hex "::ffff:7f00:1" form. Strip the prefix and recurse on the mapped IPv4.
    const v4mapped = host.match(/^::ffff:((?:\d{1,3}\.){3}\d{1,3})$/i)
    if (v4mapped) return isPublicHostname(v4mapped[1])
    const v4hex = host.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i)
    if (v4hex) {
      const hi = parseInt(v4hex[1], 16)
      const lo = parseInt(v4hex[2], 16)
      const a = (hi >> 8) & 0xff
      const b = hi & 0xff
      const c = (lo >> 8) & 0xff
      const d = lo & 0xff
      return isPublicHostname(`${a}.${b}.${c}.${d}`)
    }
    return true
  }

  // Hostnames that look like internal infrastructure
  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal' || // GCP metadata
    host === 'metadata.aws.internal' ||
    host.endsWith('.internal') ||
    host.endsWith('.local')
  ) {
    return false
  }

  return true
}

// DNS-over-HTTPS resolution cache (short TTL to prevent stale DNS rebinding)
// Key: hostname, Value: { ips: string[], expires: number }
const dnsCache = new Map<string, { ips: string[]; expires: number }>()
const DNS_CACHE_TTL_MS = 30_000 // 30 seconds — short to limit rebinding window

/**
 * Resolve a hostname via DNS-over-HTTPS and validate all resolved IPs are public.
 * Uses Cloudflare's 1.1.1.1 DoH endpoint (https://1.1.1.1/dns-query).
 *
 * FAIL-OPEN on network/DNS errors (Cloudflare Workers already blocks private egress).
 * FAIL-CLOSED only if resolution succeeds AND any resolved IP is private/internal.
 */
async function resolveAndValidateHostname(hostname: string): Promise<void> {
  const now = Date.now()
  const cached = dnsCache.get(hostname)
  if (cached && cached.expires > now) {
    // Re-validate cached IPs (defense in depth)
    for (const ip of cached.ips) {
      if (!isPublicHostname(ip)) {
        throw new Error(`Cached DNS resolution for ${hostname} includes private IP: ${ip}`)
      }
    }
    return
  }

  try {
    // Use Cloudflare DoH (GET with accept: application/dns-json)
    // Query both A (IPv4) and AAAA (IPv6) records
    const [aResp, aaaaResp] = await Promise.allSettled([
      fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=A`, {
        headers: { accept: 'application/dns-json' },
        cf: { cacheTtl: 0 }, // bypass Cloudflare cache for DoH
      }),
      fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=AAAA`, {
        headers: { accept: 'application/dns-json' },
        cf: { cacheTtl: 0 },
      }),
    ])

    const allIps: string[] = []
    // Cloudflare DoH returns a JSON `Status` field (RFC 1035 RCODE). 3 === NXDOMAIN.
    let definitiveNxdomain = true
    for (const resp of [aResp, aaaaResp]) {
      if (resp.status !== 'fulfilled' || !resp.value.ok) {
        // Network/HTTP failure on any leg means we cannot authoritatively prove non-existence → must fail-open.
        definitiveNxdomain = false
        continue
      }

      const data = (await resp.value.json()) as { Answer?: { data: string; type: number }[]; Status?: number }
      // A DNS NXDOMAIN is signaled by RCODE 3 in "Status", independent of the presence/absence of an "Answer" section.
      definitiveNxdomain = definitiveNxdomain && typeof data.Status === 'number' && data.Status === 3

      if (data.Answer) {
        for (const ans of data.Answer) {
          // Answer type 1 = A (IPv4), 28 = AAAA (IPv6)
          if ((ans.type === 1 || ans.type === 28) && ans.data) allIps.push(ans.data)
        }
      }
    }

    // Hard block: every DNS leg must have *authoritatively* returned NXDOMAIN. This is the only safe fail-closed path — an empty body without a clear RCODE 3 (e.g., NOERROR/NODATA transient blip) stays fail-open per existing policy.
    if (allIps.length === 0 && definitiveNxdomain) {
      throw new Error(`SSRF: domain ${hostname} definitively NXDOMAIN — blocked (fail-closed)`)
    } else if (allIps.length === 0) {
      logger.warn(`[SSRF] DNS resolution returned no A/AAAA records for ${hostname} — allowing (transient, fail-open)`)
      return // transient/non-committal empty response → fail-open. Cloudflare Workers fetch blocks private egress regardless.
    }

    // Validate every resolved IP — THIS IS THE SECURITY GATE
    for (const ip of allIps) {
      if (!isPublicHostname(ip)) {
        throw new Error(`DNS resolution for ${hostname} returned private/internal IP: ${ip}`)
      }
    }

    // Cache successful resolution
    dnsCache.set(hostname, { ips: allIps, expires: now + DNS_CACHE_TTL_MS })

    // Evict stale entries periodically
    if (dnsCache.size > 500) {
      for (const [key, val] of dnsCache) {
        if (val.expires <= now) dnsCache.delete(key)
      }
    }
  } catch (err) {
    if (err instanceof Error && err.message.includes('private')) throw err // genuine private-IP exposure via DNS → always surface as hard SSRF rejection.
    if (err instanceof Error && /definitively NXDOMAIN/.test(err.message)) throw err // authoritative non-existence → fail CLOSED. Surfacing this prevents DNS-rebinding bypass where a forged "phantom" hostname silently resolves then pivots to private space mid-request.
    logger.warn(`[SSRF] DNS resolution failed for ${hostname}, failing open: ${toError(err)}`) // transient/network-only failure (timeout, DoH unreachable) → fail-open; Cloudflare Workers fetch egress is itself sandboxed per-worker.
  }
}

/**
 * Validate that a URL is safe to fetch server-side.
 * Rejects non-http(s) schemes, private/tracking IPs, and malformed URLs.
 * Throws on rejection — caller should treat as extract failure.
 *
 * Now includes DNS-over-HTTPS resolution + IP validation to prevent DNS rebinding attacks.
 */
export async function assertSafeFetchUrl(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch (_err) {
    throw new Error(`Invalid URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported scheme: ${parsed.protocol}`)
  }
  if (parsed.username || parsed.password) {
    // Reject credentials-in-URL — they're a smuggler vector for internal services.
    throw new Error('Credentials in URL are not allowed')
  }
  // First check hostname string (fast path for IP literals and known internal hostnames)
  if (!isPublicHostname(parsed.hostname)) {
    throw new Error(`Blocked hostname (SSRF guard): ${parsed.hostname}`)
  }
  // Then resolve via DoH and validate resolved IPs (prevents DNS rebinding)
  await resolveAndValidateHostname(parsed.hostname)
}

/** Check if a URL matches any of the domain filters (include/exclude) */
export function domainMatches(url: string, domains: string[]): boolean {
  const host = extractDomain(url).toLowerCase()
  return domains.some((d) => {
    const domain = d.toLowerCase().replace(/^www\./, '')
    return host === domain || host.endsWith(`.${domain}`)
  })
}

/** Strip HTML tags and decode entities, returning plain text */
export function stripHtml(html: string): string {
  // Remove script/style blocks entirely
  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<header[\s\S]*?<\/header>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
  // Replace block tags with newlines for better readability
  cleaned = cleaned.replace(/<(?:p|div|br|li|h[1-6]|tr|section|article)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
  // Decode common HTML entities
  cleaned = decodeEntities(cleaned)
  // Collapse whitespace
  cleaned = cleaned
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return cleaned
}

/** Decode common HTML entities */
export function decodeEntities(text: string): string {
  const entities: Record<string, string> = {
    '&amp;': '&',
    '&lt;': '<',
    '&gt;': '>',
    '&quot;': '"',
    '&#39;': "'",
    '&apos;': "'",
    '&nbsp;': ' ',
    '&mdash;': '—',
    '&ndash;': '–',
    '&hellip;': '…',
    '&laquo;': '«',
    '&raquo;': '»',
    '&copy;': '©',
    '&reg;': '®',
    '&trade;': '™',
  }
  return text
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => entities[m.toLowerCase()] ?? m)
}

/** Truncate text to maxTokens approximate (1 token ≈ 4 chars) */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4
  if (text.length <= maxChars) return text
  const truncated = text.slice(0, maxChars)
  // Try to cut at a sentence/word boundary
  const lastSentence = Math.max(truncated.lastIndexOf('. '), truncated.lastIndexOf('! '), truncated.lastIndexOf('? '))
  if (lastSentence > maxChars * 0.5) {
    return truncated.slice(0, lastSentence + 1) + '…'
  }
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > maxChars * 0.5 ? truncated.slice(0, lastSpace) : truncated) + '…'
}

/**
 * Split text into sentences, preserving CJK/Korean sentence boundaries.
 * (Moved from answer.ts so fact-check.ts can reuse it without creating a
 * circular runtime import between answer.ts and fact-check.ts.)
 */
export function splitIntoSentences(text: string): string[] {
  // \uE000 (Private Use Area) is the abbreviation-protection placeholder —
  // intentionally NOT a control character so no-control-regex stays quiet.
  const protected_ = text.replace(/(\b(?:Mr|Mrs|Dr|Prof|Inc|Ltd|Corp|vs|etc|e\.g|i\.e|U\.S|U\.K)\.)/g, '$1\uE000')
  const sentences = protected_
    .split(/(?<=[.!?。！？])\s*(?=[A-Z\u00C0-\u017F\uAC00-\uD7A3\u4E00-\u9FFF])/)
    .flatMap((s) => s.split(/(?<=[。！？])/))
    .map((s) => s.replace(/\uE000/g, '.').trim())
    .filter((s) => s.length > 0)
  return sentences
}

/**
 * Jaccard similarity over whitespace-separated tokens.
 * (Moved from answer.ts so fact-check.ts can reuse it without creating a
 * circular runtime import between answer.ts and fact-check.ts.)
 */
export function similarity(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\s+/))
  const setB = new Set(b.toLowerCase().split(/\s+/))
  let intersection = 0
  for (const word of setA) {
    if (setB.has(word)) intersection++
  }
  const union = setA.size + setB.size - intersection
  return union > 0 ? intersection / union : 0
}

/** Check if a string contains CJK characters (Chinese/Japanese/Korean) */
function hasCJK(text: string): boolean {
  // \u4E00-\u9FFF: CJK Unified Ideographs (Chinese/Japanese Kanji)
  // \uAC00-\uD7A3: Hangul Syllables (Korean)
  return /[\u4E00-\u9FFF\uAC00-\uD7A3]/.test(text)
}

/** Extract CJK/Korean bigrams (2-char substrings) for fuzzy matching */
function cjkBigrams(text: string): string[] {
  // Extract CJK ideographs and Hangul syllables, then form bigrams
  const cjkOnly = text.replace(/[^\u4E00-\u9FFF\uAC00-\uD7A3]/g, '')
  const bigrams: string[] = []
  for (let i = 0; i < cjkOnly.length - 1; i++) {
    bigrams.push(cjkOnly.slice(i, i + 2))
  }
  return bigrams
}

/** Compute a relevance score based on query term overlap + phrase matching + freshness + authority */
export function computeScore(
  title: string,
  content: string,
  query: string,
  publishedDate?: string,
  url?: string,
): number {
  // Tokenize the query preserving symbol-bearing terms. Naively stripping all
  // non-alphanumerics mangles financial/tech queries: "S&P 500" → "sp 500"
  // (drops the &, and "S" alone is a stopword-sized fragment), "C++" → "c",
  // ".NET" → "net". We keep an ampersand and strip only leading/trailing
  // punctuation so "s&p", "c++", "c#" survive as matchable terms.
  const queryTerms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}&+#]/gu, ''))
    .filter((t) => t.length > 1)

  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()

  // --- Freshness boost: recent content gets up to +0.05, decaying over 365 days ---
  let freshnessBoost = 0
  if (publishedDate) {
    try {
      const pubDate = new Date(publishedDate)
      if (!isNaN(pubDate.getTime())) {
        const daysOld = (Date.now() - pubDate.getTime()) / (1000 * 60 * 60 * 24)
        if (daysOld < 365) {
          freshnessBoost = 0.05 * Math.exp(-daysOld / 90)
        }
      }
    } catch (_err) {
      // Invalid date — no boost
    }
  }

  // --- Domain authority boost ---
  const authorityBoost = url ? getDomainAuthority(url) : 0

  // --- CJK (Chinese/Japanese) special handling ---
  // CJK text has no spaces, so whitespace-splitting produces one huge "word" that
  // won't match anything. Use bigram matching instead for CJK queries.
  const queryIsCJK = hasCJK(query)
  if (queryIsCJK) {
    const queryBigrams = cjkBigrams(query)
    if (queryBigrams.length > 0) {
      // Check bigram overlap with title and content
      let titleBigramHits = 0
      let contentBigramHits = 0
      for (const bg of queryBigrams) {
        if (titleLower.includes(bg)) titleBigramHits++
        if (contentLower.includes(bg)) contentBigramHits++
      }
      const titleScoreCJK = (titleBigramHits / queryBigrams.length) * 0.6
      const contentScoreCJK = Math.min(contentBigramHits / queryBigrams.length, 1) * 0.3
      const baseScoreCJK = 0.05

      // Cross-language penalty: if the query is CJK but the result title/content
      // contains NO CJK characters at all, the result is likely in a different language
      // and probably irrelevant (e.g. English "AARP Games" for a Chinese query).
      // Penalize heavily so these don't pass the minimum score threshold.
      let crossLangPenalty = 0
      const titleIsCJK = hasCJK(title)
      const contentIsCJK = hasCJK(content)
      if (!titleIsCJK && !contentIsCJK) {
        crossLangPenalty = 0.15 // Heavy penalty — drops score below 0.10 threshold
      } else if (!titleIsCJK) {
        crossLangPenalty = 0.05 // Title is non-CJK but content has some — mild penalty
      }

      // Phrase bonus: if cleaned CJK query appears verbatim in title
      let phraseBonusCJK = 0
      const cleanedCJK = query.replace(/^[什么是什麼是什么叫什麼叫]+/, '').trim()
      if (cleanedCJK.length > 1 && titleLower.includes(cleanedCJK)) {
        phraseBonusCJK = 0.12
      }

      const rawScore =
        titleScoreCJK +
        contentScoreCJK +
        baseScoreCJK +
        phraseBonusCJK -
        crossLangPenalty +
        freshnessBoost +
        authorityBoost
      return Math.min(Math.max(Math.round(rawScore * 100) / 100, 0), 0.99)
    }
    // If CJK bigrams couldn't be formed (e.g. single char query), fall through
    if (queryTerms.length === 0) return 0.5
  }

  if (queryTerms.length === 0) return 0.5

  let titleHits = 0
  let contentHits = 0
  for (const term of queryTerms) {
    if (titleLower.includes(term)) titleHits++
    if (contentLower.includes(term)) contentHits++
  }
  // Title matches are weighted 2x (0.6 vs 0.3), normalized
  const titleScore = (titleHits / queryTerms.length) * 0.6
  const contentScore = Math.min(contentHits / queryTerms.length, 1) * 0.3
  // Base score: lowered from 0.1 to 0.05 so that results with zero query-term
  // overlap don't automatically pass the Tier 1 threshold (0.10).
  const baseScore = 0.05

  // Phrase matching bonus: if the full query (or a significant substring) appears
  // verbatim in the title, give extra weight. This disambiguates e.g.
  // "transformer architecture paper" from electrical transformer pages.
  let phraseBonus = 0
  const queryLower = query.toLowerCase().trim()
  if (queryLower.length > 3) {
    if (titleLower.includes(queryLower)) {
      phraseBonus = 0.12 // Exact full-query match in title → strong signal
    } else {
      // Try progressively shorter substrings (2+ consecutive terms)
      const terms = queryLower.split(/\s+/).filter((t) => t.length > 1)
      for (let len = terms.length - 1; len >= 2; len--) {
        for (let start = 0; start <= terms.length - len; start++) {
          const sub = terms.slice(start, start + len).join(' ')
          if (titleLower.includes(sub)) {
            phraseBonus = Math.max(phraseBonus, 0.04 * len)
            break
          }
        }
        if (phraseBonus > 0) break
      }
    }
  }

  return Math.min(
    Math.round((titleScore + contentScore + baseScore + phraseBonus + freshnessBoost + authorityBoost) * 100) / 100,
    0.99,
  )
}

// ============================================================
// Query Simplification for API-based specialized sources
// ============================================================

/**
 * Words/tokens that are generic and should be stripped when building
 * a simplified query for GitHub / HackerNews / Reddit search APIs.
 * These APIs match on keywords, not natural language — removing filler
 * dramatically increases hit rate (e.g. "Cloudflare Workers D1 tutorial 2025"
 * → "cloudflare workers d1" which actually returns results).
 */
const QUERY_NOISE_WORDS = new Set([
  // English filler / intent words
  'tutorial',
  'tutorials',
  'guide',
  'guides',
  'how',
  'to',
  'for',
  'with',
  'best',
  'top',
  'latest',
  'new',
  'newest',
  'recent',
  'updated',
  'modern',
  'simple',
  'easy',
  'beginner',
  'advanced',
  'complete',
  'comprehensive',
  'introduction',
  'intro',
  'overview',
  'explained',
  'examples',
  'example',
  'vs',
  'versus',
  'alternative',
  'alternatives',
  'comparison',
  'compare',
  'what',
  'is',
  'are',
  'was',
  'were',
  'the',
  'a',
  'an',
  'of',
  'in',
  'on',
  'about',
  'into',
  'from',
  'using',
  'use',
  'learn',
  'learning',
  'documentation',
  'docs',
  'reference',
  'cheatsheet',
  'cheat',
  'sheet',
  'deep',
  'dive',
  'deepdive',
  'crash',
  'course',
  'step',
  'by',
  'stepbystep',
  // Korean filler words (already in STOP_WORDS but duplicated here for clarity)
  '튜토리얼',
  '가이드',
  '설명',
  '정리',
  '최신',
  '쉽게',
  '간단한',
  '완벽',
  '소개',
  '개요',
  '예시',
  '예제',
  '비교',
  '대안',
  '사용법',
  '방법',
  '하는',
  '하는법',
  '알아보기',
  '정리해',
  '모음',
  '추천',
  // Academic filler words — strip for API-based searches
  'paper',
  'papers',
  'article',
  'articles',
  'survey',
  'surveys',
  'architecture',
  'model',
  'models',
  'method',
  'methods',
  'approach',
  'network',
  'networks',
  'algorithm',
  'algorithms',
  'system',
  'systems',
  'based',
  'novel',
  'new',
  'proposed',
  'towards',
  'toward',
])

/**
 * Simplify a natural-language query into a compact keyword string suitable
 * for API-based search backends (GitHub, HackerNews, Reddit).
 *
 * Strategy:
 *   1. Strip year-only tokens (2024, 2025, 2026) — they kill API match rates
 *   2. Remove generic noise words (tutorial, guide, best, latest, ...)
 *   3. Remove single-char tokens and pure punctuation
 *   4. Keep proper nouns, tech terms, entity names
 *   5. Limit to 5 most significant terms (APIs prefer shorter queries)
 *
 * Examples:
 *   "Cloudflare Workers D1 tutorial 2025" → "cloudflare workers d1"
 *   "React state management best practices" → "react state management"
 *   "Hono TypeScript framework" → "hono typescript framework"
 *   "Apple stock price" → "apple stock price"
 */
export function simplifyQuery(query: string, maxTerms = 5): string {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[^\p{L}\p{N}]/gu, '').trim())
    .filter((t) => t.length > 1)
    // Remove year-only tokens
    .filter((t) => !/^(19|20)\d{2}$/.test(t))
    // Remove noise words
    .filter((t) => !QUERY_NOISE_WORDS.has(t))

  // Deduplicate while preserving order
  const seen = new Set<string>()
  const unique: string[] = []
  for (const t of tokens) {
    if (!seen.has(t)) {
      seen.add(t)
      unique.push(t)
    }
  }

  // If simplification removed everything, fall back to original query
  // (minus years) so we don't send an empty string to the API
  if (unique.length === 0) {
    return (
      query
        .toLowerCase()
        .split(/\s+/)
        .filter((t) => t.length > 1 && !/^(19|20)\d{2}$/.test(t))
        .join(' ')
        .trim() || query.trim()
    )
  }

  return unique.slice(0, maxTerms).join(' ')
}

/** Parse a date string and return ISO 8601 if valid */
export function parseDate(dateStr: string | undefined): string | undefined {
  if (!dateStr) return undefined
  try {
    const d = new Date(dateStr)
    if (isNaN(d.getTime())) return undefined
    return d.toISOString()
  } catch (err) {
    logger.warn('Date parsing failed:', { error: toError(err) })
    return undefined
  }
}

/** Convert a TimeRange to number of days */
export function timeRangeToDays(range: string | undefined): number | undefined {
  switch (range) {
    case 'day':
      return 1
    case 'week':
      return 7
    case 'month':
      return 30
    case 'year':
      return 365
    default:
      return undefined
  }
}

/** Fetch with timeout */
export async function fetchWithTimeout(
  env: Env | undefined,
  url: string,
  init: RequestInit = {},
  timeoutMs = 15000,
): Promise<Response> {
  // Count this fetch against the active request's subrequest budget (if any).
  // This is the single choke point for all backend fetches, which is why we
  // count here rather than monkey-patching globalThis.fetch (which is a no-op
  // on Cloudflare Workers).
  tickSubrequestTracker()

  // Route through the rate limiter / circuit breaker for all backend fetches.
  // This ensures per-host concurrency limits and automatic circuit tripping
  // on consecutive failures, preventing IP bans.
  const { rateLimitedFetch, canRequest } = await import('./rate-limiter')

  // If the circuit is open OR concurrency is saturated for this host, do NOT
  // fall back to a direct fetch — that would defeat the circuit breaker and
  // could trip an IP ban from the upstream. Surface a 503 upstream error
  // instead so callers can treat it as a backend failure.
  if (!(await canRequest(env ?? {}, url))) {
    throw new Error(`Upstream unavailable (circuit open or at capacity): ${url}`)
  }

  const limited = await rateLimitedFetch(env ?? {}, url, init, timeoutMs)
  if (limited !== null) return limited

  // Defensive: rateLimitedFetch returning null after canRequest passed is
  // unexpected (race with another concurrent acquire). Bail with a 503 rather
  // than silently bypassing the breaker.
  throw new Error(`Rate limiter rejected (capacity race): ${url}`)
}

/**
 * SSRF-safe fetch for USER-SUPPLIED URLs: re-validates every redirect hop.
 *
 * Cloudflare Workers' `fetch` follows redirects internally (up to 20 hops)
 * WITHOUT re-running our SSRF guard on the Location targets — a classic
 * redirect-pivot / DNS-rebinding vector: hop 0 passes `assertSafeFetchUrl`
 * but hop 1 can point at 127.0.0.1 or an internal host. This wrapper sets
 * `redirect: 'manual'` and runs the full guard (scheme + hostname string
 * check + DoH IP validation) on EVERY hop before following.
 *
 * Only for user-controlled URLs (extract/crawl). Trusted backend fetches
 * (bing/wikipedia/...) should keep using plain fetchWithTimeout — per-hop DoH
 * re-validation there would add latency without security value.
 *
 * `validate` is injectable for hermetic unit tests (default: real guard).
 */
export async function safeFetchWithRedirects(
  env: Env | undefined,
  url: string,
  init: RequestInit = {},
  opts: {
    timeoutMs?: number
    maxRedirects?: number
    validate?: (u: string) => Promise<void>
    /** Injectable fetcher — defaults to the rate-limited fetchWithTimeout. */
    fetcher?: (u: string, requestInit: RequestInit) => Promise<Response>
  } = {},
): Promise<Response> {
  const timeoutMs = opts.timeoutMs ?? 15_000
  const maxRedirects = opts.maxRedirects ?? 5
  const validate = opts.validate ?? assertSafeFetchUrl
  const fetcher =
    opts.fetcher ?? ((u: string, requestInit: RequestInit) => fetchWithTimeout(env, u, requestInit, timeoutMs))

  let currentUrl = url
  for (let hops = 0; ; hops++) {
    // Guard this hop BEFORE fetching — hop 0 included (cheap when the DoH
    // 30s cache is warm, and callers may not have pre-validated).
    await validate(currentUrl)

    const response = await fetcher(currentUrl, { ...init, redirect: 'manual' })

    // Non-redirect: return as-is (fetchWithTimeout already surfaces upstream
    // circuit-open as a thrown error, consistent with every other caller).
    if (response.status < 300 || response.status >= 400) return response

    const location = response.headers.get('location')
    if (!location) return response // 3xx without a Location — nothing to follow

    if (hops >= maxRedirects) {
      throw new Error(`SSRF redirect limit exceeded (${maxRedirects} hops): ${url}`)
    }

    currentUrl = new URL(location, currentUrl).toString()
  }
}

/** Generate enhanced related queries from the original query and results */
export function generateRelatedQueries(query: string, resultTitles: string[]): string[] {
  const related = new Set<string>()
  const baseQuery = query.trim()
  const isKorean = /[\uAC00-\uD7A3]/.test(baseQuery)

  // Detect query subtypes for specialized templates
  const isFinancial =
    /주가|주식|증권|코스피|코스닥|kospi|kosdaq|stock|price|finance|dividend|\bper\b|\bpbr\b|시세|목표주가|투자의견|실적|배당/i.test(
      baseQuery,
    )
  const isHowTo = /^(?:how|하는|사용|설치|방법)/i.test(baseQuery)
  const isWhatIs = /^(?:what|what is|what are|who|who is|whose|which)/i.test(baseQuery)
  // NOTE: \b is ASCII-word-only, so the Korean comparison suffixes are
  // matched with a trailing $ (end-of-query) instead — '아이폰 vs 갤럭시 차이'
  // ends in 차이, and the \b alternative only works for the ASCII vs token.
  const isComparison = /\b(?:vs|versus)\b|(?:대비|비교|차이)$/i.test(baseQuery)

  const isQuestion = /[?？]$|^(?:why|when|where|how|does|can|should|would|could)/i.test(baseQuery)
  const isTech =
    /\b(?:api|sdk|framework|library|language|compiler|runtime|protocol|standard|typescript|rust|python|javascript|react|node|docker|kubernetes)\b/i.test(
      baseQuery,
    )
  const isNewsQuery = /^(?:news|latest|breaking|update|headlines)|(?:news|update)$/i.test(baseQuery)

  const currentYear = new Date().getFullYear().toString()

  // Build context-aware templates based on query type
  const templates: string[] = []

  if (isKorean) {
    if (isFinancial) {
      templates.push(
        `${baseQuery} 전망`,
        `${baseQuery} 분석`,
        `${baseQuery} 실적`,
        `${baseQuery} 목표주가`,
        `${baseQuery} 배당`,
        `${baseQuery} 차트`,
        `${baseQuery} 투자`,
      )
    } else if (isHowTo) {
      templates.push(
        `${baseQuery} 단계별`,
        `${baseQuery} 예제`,
        `${baseQuery} 팁`,
        `${baseQuery} ${currentYear}`,
        `${baseQuery} 문제해결`,
      )
    } else if (isComparison) {
      templates.push(`${baseQuery} 장단점`, `${baseQuery} 대안`, `${baseQuery} 리뷰`, `${baseQuery} 추천`)
    } else {
      templates.push(
        `${baseQuery} 정리`,
        `${baseQuery} 설명`,
        `${baseQuery} 최신`,
        `${baseQuery} 가이드`,
        `${baseQuery} ${currentYear}`,
        `무엇인가 ${baseQuery}`,
      )
    }
  } else {
    if (isFinancial) {
      templates.push(
        `${baseQuery} forecast`,
        `${baseQuery} analysis`,
        `${baseQuery} earnings`,
        `${baseQuery} price target`,
        `${baseQuery} dividend`,
        `${baseQuery} stock chart`,
      )
    } else if (isHowTo) {
      templates.push(
        `${baseQuery} step by step`,
        `${baseQuery} examples`,
        `${baseQuery} best practices`,
        `${baseQuery} troubleshooting`,
        `${baseQuery} ${currentYear}`,
      )
    } else if (isWhatIs) {
      templates.push(
        `${baseQuery} definition`,
        `${baseQuery} explained`,
        `${baseQuery} examples`,
        `${baseQuery} history`,
        `types of ${baseQuery.replace(/^(?:what|who|which)\s+(?:is|are|was|were)?\s*/i, '')}`,
      )
    } else if (isComparison) {
      templates.push(
        `${baseQuery} comparison`,
        `${baseQuery} pros and cons`,
        `${baseQuery} alternatives`,
        `${baseQuery} review`,
      )
    } else if (isTech && !isNewsQuery) {
      templates.push(
        `${baseQuery} documentation`,
        `${baseQuery} tutorial`,
        `${baseQuery} getting started`,
        `${baseQuery} api reference`,
        `${baseQuery} vs`,
        `${baseQuery} best practices`,
      )
    } else if (isNewsQuery || isQuestion) {
      templates.push(
        `${baseQuery} update`,
        `${baseQuery} latest news`,
        `${baseQuery} analysis`,
        `${baseQuery} timeline`,
        `impact of ${baseQuery}`,
      )
    } else {
      // Default templates with question-based alternatives
      templates.push(
        `${baseQuery} guide`,
        `${baseQuery} explained`,
        `what is ${baseQuery}`,
        `best ${baseQuery}`,
        `${baseQuery} examples`,
        `${baseQuery} ${currentYear}`,
        `${baseQuery} vs`,
        `how does ${baseQuery} work`,
      )
    }
  }

  for (const t of templates) {
    if (t.toLowerCase() !== baseQuery.toLowerCase()) related.add(t)
  }

  // Extract keywords from top result titles — enhanced with bigram detection
  const topWords = new Map<string, number>()
  const topBigrams = new Map<string, number>()
  for (const title of resultTitles.slice(0, 5)) {
    const words = title
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 1 && !isStopWord(w))
      .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((w) => w.length > 0)
    for (let i = 0; i < words.length; i++) {
      topWords.set(words[i], (topWords.get(words[i]) ?? 0) + 1)
      // Bigrams
      if (i < words.length - 1) {
        const bigram = `${words[i]} ${words[i + 1]}`
        topBigrams.set(bigram, (topBigrams.get(bigram) ?? 0) + 1)
      }
    }
  }

  // Add keyword-based expansions (from frequent terms in titles)
  const topKeywords = [...topWords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([w]) => w)

  for (const kw of topKeywords) {
    if (!baseQuery.toLowerCase().includes(kw) && related.size < 10) {
      related.add(`${baseQuery} ${kw}`)
    }
  }

  // Add bigram-based suggestions (more specific than single words)
  const topBigramList = [...topBigrams.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([b]) => b)

  for (const bg of topBigramList) {
    if (!baseQuery.toLowerCase().includes(bg) && related.size < 10) {
      related.add(`${baseQuery} ${bg}`)
    }
  }

  return [...related].slice(0, 8)
}

const STOP_WORDS = new Set([
  // English stop words
  'about',
  'above',
  'after',
  'again',
  'against',
  'between',
  'both',
  'during',
  'having',
  'their',
  'there',
  'these',
  'those',
  'where',
  'which',
  'while',
  'with',
  'your',
  'what',
  'when',
  'where',
  'this',
  'that',
  'from',
  'into',
  'should',
  'would',
  'could',
  'might',
  'will',
  'been',
  'were',
  'they',
  'them',
  'more',
  'most',
  'some',
  'such',
  'only',
  'very',
  'than',
  'then',
  'also',
  'just',
  'like',
  'make',
  'made',
  'many',
  'much',
  'must',
  'need',
  'even',
  'ever',
  'every',
  // Korean stop words — particles, common verbs, filler words
  '그리고',
  '그래서',
  '그러나',
  '그런',
  '그렇게',
  '그것',
  '그게',
  '그',
  '이런',
  '이것',
  '이게',
  '이',
  '저런',
  '저것',
  '저게',
  '하는',
  '한다',
  '했다',
  '할',
  '한',
  '하다',
  '되는',
  '된다',
  '됐다',
  '있는',
  '있다',
  '없는',
  '없다',
  '없는',
  '이런',
  '저런',
  '그런',
  '어떤',
  '무엇',
  '누가',
  '언제',
  '어디',
  '에서',
  '에게',
  '에게서',
  '한테',
  '한테서',
  '으로',
  '로',
  '로서',
  '와',
  '과',
  '하고',
  '며',
  '며는',
  '이고',
  '이며',
  '거나',
  '든지',
  '는',
  '은',
  '가',
  '이',
  '을',
  '를',
  '의',
  '에',
  '도',
  '만',
  '까지',
  '부터',
  '조차',
  '마저',
  '든지',
  '이나',
  '나',
  '든',
  '인',
  '일',
  '매우',
  '정말',
  '진짜',
  '너무',
  '좀',
  '조금',
  '다시',
  '또',
  '또한',
  '더',
  '더욱',
  '특히',
  '바로',
  '미리',
  '이미',
  '아직',
  '벌써',
])

function isStopWord(word: string): boolean {
  return STOP_WORDS.has(word.toLowerCase())
}

/**
 * Map ISO 3166-1 alpha-2 country code to a Bing mkt (market) BCP 47 tag.
 * Falls back to the language derived from country, or en-US as default.
 */
export function countryToBingMkt(country: string): string {
  const map: Record<string, string> = {
    KR: 'ko-KR',
    CN: 'zh-CN',
    TW: 'zh-TW',
    HK: 'zh-HK',
    JP: 'ja-JP',
    FR: 'fr-FR',
    DE: 'de-DE',
    IT: 'it-IT',
    ES: 'es-ES',
    PT: 'pt-PT',
    BR: 'pt-BR',
    RU: 'ru-RU',
    NL: 'nl-NL',
    PL: 'pl-PL',
    SE: 'sv-SE',
    NO: 'nb-NO',
    DK: 'da-DK',
    FI: 'fi-FI',
    TR: 'tr-TR',
    AR: 'es-AR',
    MX: 'es-MX',
    IN: 'en-IN',
    GB: 'en-GB',
    AU: 'en-AU',
    CA: 'en-CA',
    US: 'en-US',
  }
  return map[country.toUpperCase()] || `${countryToLanguageTag(country)}-${country.toUpperCase()}`
}

/**
 * Map ISO 3166-1 alpha-2 country code to a BCP 47 language tag (language part only).
 * Uses the most common/official language for each country.
 */
export function countryToLanguageTag(country: string): string {
  const map: Record<string, string> = {
    KR: 'ko',
    CN: 'zh',
    TW: 'zh',
    HK: 'zh',
    JP: 'ja',
    FR: 'fr',
    DE: 'de',
    IT: 'it',
    ES: 'es',
    PT: 'pt',
    BR: 'pt',
    RU: 'ru',
    NL: 'nl',
    PL: 'pl',
    SE: 'sv',
    NO: 'nb',
    DK: 'da',
    FI: 'fi',
    TR: 'tr',
    AR: 'es',
    MX: 'es',
    GB: 'en',
    US: 'en',
    AU: 'en',
    CA: 'en',
    IN: 'hi',
    SG: 'en',
    MY: 'ms',
    TH: 'th',
    VN: 'vi',
    ID: 'id',
    PH: 'tl',
    SA: 'ar',
    AE: 'ar',
    IL: 'he',
    GR: 'el',
    CZ: 'cs',
    HU: 'hu',
    RO: 'ro',
    UA: 'uk',
    AT: 'de',
    CH: 'de',
    BE: 'nl',
  }
  return map[country.toUpperCase()] || 'en'
}

// ============================================================
// Query normalization — defends against double-encoded queries
// ============================================================

/**
 * Detect ANY residual percent-encoding in the post-Hono query string.
 *
 * We can't require "2+ consecutive %XX pairs" (the obvious pattern) because
 * triple-encoded input leaves shapes like "%25EC%2582%25BC" where each hex
 * pair is separated by literal hex chars (E, C) rather than another %XX.
 * A single `%` followed by two hex digits is enough signal that decoding
 * wasn't complete. Loop-termination is handled by progress detection in
 * normalizeQuery, not by this regex.
 */
const RESIDUAL_PERCENT_ENCODING = /%[0-9A-Fa-f]{2}/

/**
 * Safely decode a percent-encoded string. Returns the original on any failure
 * (invalid sequences, malformed UTF-8) so callers never crash on bad input.
 */
function tryDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Normalize a search query received from an HTTP request.
 *
 * Hono auto-decodes query params ONCE. When a client (notably Python agents
 * using urllib.parse.quote()) double-encodes a Korean query, the single decode
 * leaves residual "%ED%95%9C" literal strings. Those literals fail the Hangul
 * regex in isKoreanQuery(), silently routing the query to English backends and
 * returning either unrelated English results or an empty body.
 *
 * This helper:
 *   1. trims whitespace
 *   2. if residual percent-encoding is detected, attempts extra safe decodes
 *      until the input stabilizes (no more %XX) or a guard is hit
 *   3. collapses internal whitespace
 *
 * Idempotent — already-decoded Korean text passes through unchanged because
 * the regex doesn't match Hangul syllables.
 */
export function normalizeQuery(raw: string): string {
  if (!raw) return ''
  let q = raw.trim()
  // Defensive loop: a triple-encoded value needs at most 2 extra decodes after
  // Hono's single pass; allow up to 4 iterations as a safety margin.
  let guard = 0
  while (RESIDUAL_PERCENT_ENCODING.test(q) && guard < 4) {
    const decoded = tryDecodeURIComponent(q)
    if (decoded === q) break // no progress — stop to avoid infinite loop
    q = decoded.trim()
    guard++
  }
  return q.replace(/\s+/g, ' ').trim()
}

// ============================================================
// Relative time parsing — Korean + English → ISO timestamp
// ============================================================

/**
 * Parse a relative-time string ("2시간 전", "3 days ago", "어제") into an ISO
 * timestamp relative to `now` (defaults to Date.now()). Returns null when the
 * input doesn't look like a recognized relative time — callers should keep the
 * field empty rather than guess.
 *
 * Supported patterns (Korean + English):
 *   - 방금 전 / just now / now
 *   - N초 전 / N seconds ago
 *   - N분 전 / N minutes ago / N min ago
 *   - N시간 전 / N hours ago / N hr ago
 *   - N일 전 / N days ago
 *   - N주일 전 / N주 전 / N weeks ago
 *   - N개월 전 / N달 전 / N months ago
 *   - N년 전 / N years ago
 *   - 어제 / yesterday
 *
 * This is the foundation for `sort_by=date` actually working — Naver mobile
 * search results expose dates only as Korean relative time inside the
 * `<span class="time">` element. Without parsing it, the date-sort blend in
 * ranking.ts:sortResults silently no-ops for the dominant Korean backend.
 */
export function parseRelativeTime(input: string | undefined | null, now: number = Date.now()): string | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  if (!s) return null

  // 방금 전 / just now. (No \b — it's ASCII-only and won't match Hangul.)
  if (/^(방금\s*전|just now|now)/i.test(s)) return new Date(now).toISOString()
  // 어제 / yesterday → 24h ago. (No leading \b — ASCII-only, misses Hangul.)
  if (/^어제(?!\S)/.test(s) || /^yesterday\b/i.test(s)) {
    return new Date(now - 24 * 60 * 60 * 1000).toISOString()
  }

  // Korean relative: "<number><unit> 전"
  // Units: 초(초), 분, 시간, 일, 주(일)/주, 개월/달, 년/해
  const kr = s.match(/^(\d+)\s*(초|분|시간|시|일|주일|주|개월|달|년|해)\s*전$/)
  if (kr) {
    const n = parseInt(kr[1], 10)
    const unit = kr[2]
    const ms = koreanUnitToMs(unit, n)
    if (ms !== null) return new Date(now - ms).toISOString()
  }

  // English relative: "<number> <unit> ago"
  const en = s.match(
    /^(\d+)\s*(second|seconds|sec|s|minute|minutes|min|m|hour|hours|hr|h|day|days|d|week|weeks|w|month|months|mo|year|years|y)\s*ago$/,
  )
  if (en) {
    const n = parseInt(en[1], 10)
    const unit = en[2]
    const ms = englishUnitToMs(unit, n)
    if (ms !== null) return new Date(now - ms).toISOString()
  }

  return null
}

function koreanUnitToMs(unit: string, n: number): number | null {
  const SEC = 1000
  const MIN = 60 * SEC
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  switch (unit) {
    case '초':
      return n * SEC
    case '분':
      return n * MIN
    case '시간':
    case '시':
      return n * HOUR
    case '일':
      return n * DAY
    case '주일':
    case '주':
      return n * 7 * DAY
    case '개월':
    case '달':
      return n * 30 * DAY
    case '년':
    case '해':
      return n * 365 * DAY
    default:
      return null
  }
}

function englishUnitToMs(unit: string, n: number): number | null {
  const SEC = 1000
  const MIN = 60 * SEC
  const HOUR = 60 * MIN
  const DAY = 24 * HOUR
  switch (unit) {
    case 'second':
    case 'seconds':
    case 'sec':
    case 's':
      return n * SEC
    case 'minute':
    case 'minutes':
    case 'min':
    case 'm':
      return n * MIN
    case 'hour':
    case 'hours':
    case 'hr':
    case 'h':
      return n * HOUR
    case 'day':
    case 'days':
    case 'd':
      return n * DAY
    case 'week':
    case 'weeks':
    case 'w':
      return n * 7 * DAY
    case 'month':
    case 'months':
    case 'mo':
      return n * 30 * DAY
    case 'year':
    case 'years':
    case 'y':
      return n * 365 * DAY
    default:
      return null
  }
}

/**
 * Try to coerce an arbitrary date-ish string (absolute or relative) into an
 * ISO timestamp. Accepts:
 *   - Already-ISO: "2026-07-25T..." → passthrough
 *   - YYYY.MM.DD / YYYY-MM-DD / YYYY/MM/DD
 *   - Korean/English relative time (delegates to parseRelativeTime)
 * Returns null on anything unrecognizable so callers can leave the field empty.
 */
export function parseFlexibleDate(input: string | undefined | null, now: number = Date.now()): string | null {
  if (!input) return null
  const s = input.trim()
  if (!s) return null

  // Already ISO 8601
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) {
    const d = new Date(s)
    return isNaN(d.getTime()) ? null : d.toISOString()
  }

  // YYYY.MM.DD / YYYY-MM-DD / YYYY/MM/DD (optionally with time). Spaces
  // after the separators are tolerated — Bing renders "2026. 7. 24. —" and
  // the datePrefix in bing-search.ts matches that form, so this must too
  // (verified 2026-08-07: sort_by=date was silently no-op'ing for those).
  const abs = s.match(/^(\d{4})[.\-/]\s*(\d{1,2})[.\-/]\s*(\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/)
  if (abs) {
    const [, y, mo, d, h, mi] = abs
    const date = new Date(Number(y), Number(mo) - 1, Number(d), h ? Number(h) : 0, mi ? Number(mi) : 0)
    return isNaN(date.getTime()) ? null : date.toISOString()
  }

  // English month names — "Jul 24, 2026" / "July 24, 2026" (Bing web
  // results prefix snippets with "Mon D, YYYY ·"). parseFlexibleDate
  // previously returned null for these, so bing's datePrefix match never
  // produced a published_date and date-sort silently no-op'ed (2026-08-07).
  const MONTHS: Record<string, number> = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  }
  const en = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})/)
  if (en) {
    const mo = MONTHS[en[1].toLowerCase().slice(0, 3)]
    if (mo !== undefined) {
      const date = new Date(Number(en[3]), mo, Number(en[2]))
      return isNaN(date.getTime()) ? null : date.toISOString()
    }
  }

  // Relative time fallback
  return parseRelativeTime(s, now)
}
