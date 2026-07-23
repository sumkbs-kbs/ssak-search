/**
 * CrawlerDO — Web Crawler Durable Object
 *
 * Manages a URL frontier for crawling, respecting robots.txt and politeness.
 * Feeds extracted content into the INDEX_QUEUE for async indexing.
 *
 * Architecture:
 *   POST /api/crawl (seed URLs)
 *     → CrawlerDO.start()
 *       → For each batch:
 *         1. Pop from frontier (sorted by priority)
 *         2. Check robots.txt cache (per domain)
 *         3. Apply politeness delay
 *         4. Fetch & extract content
 *         5. Discover child links
 *         6. Filter + enqueue new URLs
 *         7. Push extracted content to INDEX_QUEUE
 *         8. Set alarm for next batch
 *     → INDEX_QUEUE consumer (pipeline.ts)
 *       → chunk → embed → Vectorize upsert → D1 metadata
 */

import { DurableObject } from 'cloudflare:workers'
import { logger, toError } from './logger'
import type { Env, CrawlUrl, CrawlDomainState, CrawlStats, CrawlerConfig, IndexQueueMessage } from '../types'
import { normalizeUrl, assertSafeFetchUrl } from './util'
import { DEFAULT_CRAWLER_CONFIG } from '../types'

// ============================================================
// Crawler Storage Schema
// ============================================================

interface CrawlerStorage {
  frontier: CrawlUrl[]
  visited: string[]  // Serialized set
  domainStates: Record<string, CrawlDomainState>
  seeds: string[]
  config: CrawlerConfig
  stats: CrawlStats
  active: boolean
  version: number
}

// ============================================================
// Robots.txt Parser (minimal)
// ============================================================

interface RobotsRules {
  disallows: string[]
  crawlDelay: number
  sitemaps: string[]
}

function parseRobotsTxt(body: string, userAgent = '*'): RobotsRules {
  const disallows: string[] = []
  const sitemaps: string[] = []
  let crawlDelay = 0
  let currentAgent = ''
  const lines = body.split('\n')

  for (const raw of lines) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const colonIdx = line.indexOf(':')
    if (colonIdx === -1) continue

    const field = line.slice(0, colonIdx).trim().toLowerCase()
    const value = line.slice(colonIdx + 1).trim()

    if (field === 'user-agent') {
      currentAgent = value
    } else if (currentAgent === userAgent || currentAgent === '*') {
      if (field === 'disallow') {
        if (value) disallows.push(value)
      } else if (field === 'crawl-delay') {
        const delay = parseInt(value, 10)
        if (!isNaN(delay) && delay > 0) crawlDelay = delay * 1000
      } else if (field === 'sitemap') {
        sitemaps.push(value)
      }
    }
  }

  return { disallows, crawlDelay, sitemaps }
}

// ============================================================
// Link Discovery
// ============================================================

interface DiscoveredLink {
  url: string
  text: string
}

/**
 * Extract links from HTML content.
 * Returns absolute URLs that appear to be regular web pages.
 */
function discoverLinks(html: string, baseUrl: string): DiscoveredLink[] {
  const links: DiscoveredLink[] = []
  const seen = new Set<string>()

  // Match <a href="...">text</a>
  const anchorRegex = /<a\s+(?:[^>]*?\s+)?href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))(?:\s+(?:[^>]*?\s+)?rel\s*=\s*(?:"nofollow"|'nofollow'))?[^>]*>([\s\S]*?)<\/a>/gi
  let match: RegExpExecArray | null

  while ((match = anchorRegex.exec(html)) !== null) {
    const href = match[1] || match[2] || match[3]
    if (!href) continue

    try {
      const absoluteUrl = new URL(href, baseUrl).href

      // Skip non-http(s) links
      if (!absoluteUrl.startsWith('http://') && !absoluteUrl.startsWith('https://')) continue

      // Skip anchors, javascript, mailto
      const normalized = normalizeUrl(absoluteUrl)
      if (seen.has(normalized)) continue
      seen.add(normalized)

      // Skip non-HTML extensions (images, pdfs, etc.)
      const skipExtensions = /\.(pdf|zip|tar|gz|rar|exe|dmg|iso|img|png|jpg|jpeg|gif|svg|webp|ico|css|js|json|xml|doc|docx|xls|xlsx|ppt|pptx|mp3|mp4|avi|mov|wmv|flv)$/i
      if (skipExtensions.test(normalized)) continue

      links.push({ url: normalized, text: match[4]?.replace(/<[^>]+>/g, '').trim() || '' })
    } catch (err) {
      logger.warn('[CrawlerDO] Invalid URL in link discovery:', { error: toError(err) })
    }
  }

  return links
}

// ============================================================
// Crawler Durable Object
// ============================================================

export class CrawlerDO extends DurableObject<Env> {
  private frontier: CrawlUrl[] = []
  private visited = new Set<string>()
  private domainStates = new Map<string, CrawlDomainState>()
  private seeds: string[] = []
  private config: CrawlerConfig = { ...DEFAULT_CRAWLER_CONFIG }
  private stats: CrawlStats = this.emptyStats()
  private active = false
  private version = 1

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<CrawlerStorage>('crawler')
      if (stored) {
        this.frontier = stored.frontier ?? []
        this.visited = new Set(stored.visited ?? [])
        this.domainStates = new Map(Object.entries(stored.domainStates ?? {}))
        this.seeds = stored.seeds ?? []
        this.config = stored.config ?? { ...DEFAULT_CRAWLER_CONFIG }
        this.stats = stored.stats ?? this.emptyStats()
        this.active = stored.active ?? false
        this.version = stored.version ?? 1
      }
    })
  }

  // ============================================================
  // Persistence
  // ============================================================

  private async persist(): Promise<void> {
    await this.ctx.storage.put<CrawlerStorage>('crawler', {
      frontier: this.frontier,
      visited: Array.from(this.visited),
      domainStates: Object.fromEntries(this.domainStates),
      seeds: this.seeds,
      config: this.config,
      stats: this.stats,
      active: this.active,
      version: this.version,
    })
  }

  // ============================================================
  // RPC — Public Methods
  // ============================================================

  /**
   * Seed the crawler with initial URLs.
   * Validates URLs before adding them to the frontier.
   */
  async seed(urls: string[], options: Partial<CrawlerConfig> = {}): Promise<{ added: number; failed: number }> {
    // Merge config
    this.config = { ...this.config, ...options }
    this.seeds = urls

    let added = 0
    let failed = 0

    for (const rawUrl of urls) {
      try {
        const url = normalizeUrl(rawUrl.trim())
        await assertSafeFetchUrl(url)

        if (this.visited.has(url)) continue
        this.visited.add(url)

        this.frontier.push({
          url,
          depth: 0,
          priority: 100,  // High priority for seeds
          added_at: Date.now(),
        })
        added++
      } catch (err) {
        logger.warn(`[CrawlerDO] Failed to add seed URL:`, { error: toError(err) })
        failed++
      }
    }

    // Sort frontier by priority (descending), then by added_at (ascending)
    this.sortFrontier()
    this.stats.total_urls_discovered = this.frontier.length + this.visited.size
    this.stats.total_seeds = this.seeds.length

    await this.persist()
    return { added, failed }
  }

  /**
   * Start (or resume) crawling.
   * Sets an immediate alarm to begin processing.
   */
  async start(): Promise<void> {
    if (this.active) return

    this.active = true
    this.stats.status = 'running'
    this.stats.start_time = this.stats.start_time || Date.now()
    this.stats.last_activity = Date.now()

    await this.persist()

    // Set alarm for immediate processing
    await this.ctx.storage.setAlarm(Date.now())
  }

  /**
   * Pause crawling. Alarm will still fire but processor checks `active`.
   */
  async pause(): Promise<void> {
    this.active = false
    this.stats.status = 'paused'
    this.stats.last_activity = Date.now()

    // Cancel pending alarm
    await this.ctx.storage.deleteAlarm()
    await this.persist()
  }

  /**
   * Stop crawling and reset all state.
   */
  async reset(): Promise<void> {
    this.frontier = []
    this.visited = new Set()
    this.domainStates = new Map()
    this.seeds = []
    this.stats = this.emptyStats()
    this.active = false
    this.version++

    await this.ctx.storage.deleteAll()
    await this.ctx.storage.deleteAlarm()
  }

  /**
   * Phase 2.3: Seed from Brave Search API results.
   * Uses Brave Search API to discover high-quality seed URLs for a query.
   * Validates domains against blacklist before adding to frontier.
   * Brave API key is read from env.BRAVE_API_KEY.
   */
  async seedFromBrave(query: string, maxResults = 10): Promise<{ added: number; failed: number; query: string }> {
    const apiKey = this.env.BRAVE_API_KEY
    if (!apiKey) {
      logger.warn('[CrawlerDO] seedFromBrave: No BRAVE_API_KEY configured')
      return { added: 0, failed: 0, query }
    }

    try {
      // 1. Call Brave Web Search API
      const url = new URL('https://api.search.brave.com/res/v1/web/search')
      url.searchParams.set('q', query)
      url.searchParams.set('count', String(Math.min(maxResults * 2, 20)))
      url.searchParams.set('source', 'web')

      const response = await fetch(url.toString(), {
        headers: {
          'Accept': 'application/json',
          'X-Subscription-Token': apiKey,
        },
        signal: AbortSignal.timeout(10000),
      })

      if (!response.ok) {
        logger.warn(`[CrawlerDO] Brave API error: ${response.status}`)
        return { added: 0, failed: 0, query }
      }

      const data = await response.json() as {
        web?: { results: Array<{ url: string; title: string; description?: string }> }
      }

      if (!data.web?.results?.length) {
        return { added: 0, failed: 0, query }
      }

      // 2. Check domain blacklist and add valid URLs to seeds
      const braveUrls = data.web.results.map(r => r.url).filter(Boolean)
      const blacklisted = await this.checkDomainBlacklist(braveUrls)
      const validUrls = braveUrls.filter(u => !blacklisted.has(new URL(u).hostname))

      // 3. Add as seeds with metadata
      const result = await this.seed(validUrls.slice(0, maxResults))

      // 4. Push SEED_FROM_BRAVE to INDEX_QUEUE for tracking
      if (this.env.INDEX_QUEUE && validUrls.length > 0) {
        await this.env.INDEX_QUEUE.send({
          type: 'SEED_FROM_BRAVE',
          payload: { query, urls: validUrls.slice(0, maxResults) },
        })
      }

      logger.info(`[CrawlerDO] Brave-seeded ${result.added} URLs for query: "${query}"`)
      return { added: result.added, failed: result.failed, query }
    } catch (err) {
      logger.error('[CrawlerDO] Brave seed failed:', { error: toError(err) })
      return { added: 0, failed: 0, query }
    }
  }

  /**
   * Phase 2.3: Check URLs against the domain blacklist in D1.
   * Returns a Set of blacklisted domains.
   */
  private async checkDomainBlacklist(urls: string[]): Promise<Set<string>> {
    const blacklisted = new Set<string>()
    if (!this.env.SEARCH_INDEX_DB || urls.length === 0) return blacklisted

    try {
      const domains = urls.map(u => new URL(u).hostname.replace(/^www\./, ''))
      const uniqueDomains = [...new Set(domains)]

      for (const domain of uniqueDomains) {
        const row = await this.env.SEARCH_INDEX_DB.prepare(
          `SELECT domain FROM domain_blacklist
           WHERE domain = ?
             AND (expires_at IS NULL OR expires_at > ?)
           LIMIT 1`
        ).bind(domain, Date.now()).first()

        if (row) {
          blacklisted.add(domain)
          logger.info(`[CrawlerDO] Skipping blacklisted domain: ${domain}`)
        }
      }
    } catch (err) {
      logger.warn('[CrawlerDO] Blacklist check failed:', { error: toError(err) })
    }

    return blacklisted
  }

  /**
   * Phase 2.3: Seed from popular domains with high domain reputation.
   * Queries D1 domain_reputation table for high-authority uncrawled domains.
   */
  async seedFromReputation(minAuthority = 0.7, maxResults = 20): Promise<{ added: number }> {
    if (!this.env.SEARCH_INDEX_DB) return { added: 0 }

    try {
      const rows = await this.env.SEARCH_INDEX_DB.prepare(
        `SELECT domain FROM domain_reputation
         WHERE authority >= ?
           AND crawability >= 0.5
         ORDER BY (authority + freshness + content_quality) DESC
         LIMIT ?`
      ).bind(minAuthority, maxResults).all<{ domain: string }>()

      if (!rows.results?.length) return { added: 0 }

      // For each domain, try to find an sitemap or root URL
      let added = 0
      for (const row of rows.results) {
        const url = `https://${row.domain}/`
        try {
          await assertSafeFetchUrl(url)
          if (this.visited.has(url)) continue
          this.visited.add(url)
          this.frontier.push({
            url,
            depth: 0,
            priority: 50,
            added_at: Date.now(),
          })
          added++
        } catch (err) {
          logger.warn('[CrawlerDO] seedFromReputation: skip URL:', { error: toError(err) })
        }
      }

      this.sortFrontier()
      await this.persist()
      logger.info(`[CrawlerDO] Seeded ${added} URLs from reputation-based domains`)
      return { added }
    } catch (err) {
      logger.error('[CrawlerDO] Reputation seed failed:', { error: toError(err) })
      return { added: 0 }
    }
  }

  /**
   * Get current crawl status (v2.3 enhanced).
   */
  async getStatus(): Promise<{
    stats: CrawlStats
    config: CrawlerConfig
    seeds: string[]
    frontier_size: number
    visited_count: number
    domain_count: number
    recent_urls: string[]
  }> {
    return {
      stats: this.stats,
      config: this.config,
      seeds: this.seeds,
      frontier_size: this.frontier.length,
      visited_count: this.visited.size,
      domain_count: this.domainStates.size,
      recent_urls: this.frontier.slice(0, 10).map(u => u.url),
    }
  }

  // ============================================================
  // Alarm Handler (crawl loop)
  // ============================================================

  /**
   * Alarm handler — processes the next batch of crawl jobs.
   * Re-schedules itself if more work remains.
   */
  async alarm(): Promise<void> {
    if (!this.active || this.frontier.length === 0) {
      this.active = false
      this.stats.status = this.frontier.length === 0 ? 'completed' : 'paused'
      this.stats.last_activity = Date.now()
      await this.persist()

      // Fire webhook if configured
      if (this.config.webhook_url && this.stats.status === 'completed') {
        this.fireWebhook().catch(err =>
          logger.error('[CrawlerDO] Webhook failed:', { error: toError(err) })
        )
      }
      return
    }

    const batchSize = this.config.max_concurrent_requests
    const batch: CrawlUrl[] = []

    // Pop next batch from frontier (skipping URLs whose domain is in cooldown)
    const remaining: CrawlUrl[] = []
    for (const url of this.frontier) {
      if (batch.length >= batchSize) {
        remaining.push(url)
        continue
      }

      const domain = new URL(url.url).hostname
      const domainState = this.domainStates.get(domain)

      // Check politeness delay
      if (domainState) {
        const elapsed = Date.now() - domainState.last_crawled_at
        const effectiveDelay = Math.max(domainState.crawl_delay_ms, this.config.politeness_delay_ms)
        if (elapsed < effectiveDelay) {
          // Not enough time — push back but with incremental priority boost
          remaining.push({ ...url, priority: url.priority + 1 })
          continue
        }
      }

      // Check domain page limit
      if (domainState && domainState.pages_crawled >= this.config.max_pages_per_domain) {
        this.stats.urls_skipped++
        continue  // Skip this URL entirely
      }

      batch.push(url)
    }

    this.frontier = remaining

    // Process batch in parallel
    await Promise.allSettled(
      batch.map(url => this.crawlUrl(url))
    )

    // Sort remaining frontier
    this.sortFrontier()

    this.stats.last_activity = Date.now()
    this.stats.urls_queued = this.frontier.length

    // Update estimated completion
    const processed = this.stats.urls_crawled + this.stats.urls_failed + this.stats.urls_skipped
    if (processed > 0) {
      const elapsed = this.stats.last_activity - this.stats.start_time
      const rate = processed / (elapsed || 1)
      this.stats.estimated_completion = rate > 0 ? Date.now() + (this.frontier.length / rate) : 0
    }

    await this.persist()

    // Schedule next alarm
    if (this.active && this.frontier.length > 0) {
      // Wait at least 1 second before next batch
      await this.ctx.storage.setAlarm(Date.now() + 1000)
    } else {
      this.active = false
      this.stats.status = this.frontier.length === 0 ? 'completed' : 'paused'
      await this.persist()

      if (this.config.webhook_url && this.stats.status === 'completed') {
        this.fireWebhook().catch(err =>
          logger.error('[CrawlerDO] Webhook failed:', { error: toError(err) })
        )
      }
    }
  }

  // ============================================================
  // Core Crawling Logic
  // ============================================================

  private async crawlUrl(crawlUrl: CrawlUrl): Promise<void> {
    const { url, depth } = crawlUrl
    const domain = new URL(url).hostname

    try {
      logger.info(`[CrawlerDO] Crawling [${depth}/${this.config.max_depth}]: ${url}`)

      // 1. Check robots.txt (cached per domain)
      if (this.config.respect_robots_txt) {
        const domainAllowed = await this.checkRobotsTxt(domain)
        if (!domainAllowed) {
          logger.info(`[CrawlerDO] Domain blocked by robots.txt: ${domain}`)
          this.stats.urls_skipped++
          this.updateDomainState(domain, false)
          return
        }
        // Also check if this specific URL path is disallowed
        const domainState = this.domainStates.get(domain)
        if (domainState && domainState.robots_disallows.length > 0) {
          const urlPath = new URL(url).pathname
          const pathBlocked = domainState.robots_disallows.some(pattern =>
            pattern === '/' ? true : urlPath.startsWith(pattern)
          )
          if (pathBlocked) {
            logger.info(`[CrawlerDO] Path blocked by robots.txt: ${url}`)
            this.stats.urls_skipped++
            this.updateDomainState(domain, false)
            return
          }
        }
      }

      // 2. Fetch the page
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; SearchEngineCrawler/1.0; +https://webapp.pages.dev)',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
        },
        redirect: 'follow',
        signal: AbortSignal.timeout(this.config.request_timeout_ms),
      })

      if (!response.ok) {
        // Don't retry 4xx errors
        if (response.status >= 400 && response.status < 500) {
          this.stats.urls_failed++
          this.updateDomainState(domain, true)
          return
        }
        throw new Error(`HTTP ${response.status}`)
      }

      const contentType = response.headers.get('content-type') || ''
      const isHtml = contentType.includes('text/html')

      if (!isHtml) {
        this.stats.urls_skipped++
        this.updateDomainState(domain, true)
        return
      }

      const html = await response.text()
      if (html.length < 100) {
        this.stats.urls_skipped++  // Too short
        this.updateDomainState(domain, true)
        return
      }

      // 3. Extract title
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
      const title = titleMatch ? titleMatch[1].replace(/<[^>]+>/g, '').trim() : domain

      // 4. Extract clean content directly from HTML (no double fetch)
      let extractedContent = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, ' ')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, ' ')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, ' ')
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 16000)

      if (extractedContent.length < 50) {
        this.stats.urls_skipped++
        this.updateDomainState(domain, true)
        return
      }

      // 5. Discover links (if within depth limit)
      if (depth < this.config.max_depth) {
        const links = discoverLinks(html, url)
        let newUrlsAdded = 0

        for (const link of links) {
          const linkDomain = new URL(link.url).hostname

          // Respect same-domain scope
          if (!this.config.follow_external_links && linkDomain !== domain) continue

          // Skip if already visited or queued
          if (this.visited.has(link.url)) continue
          if (this.frontier.some(u => u.url === link.url)) continue

          // Validate URL
          try {
            await assertSafeFetchUrl(link.url)
          } catch (err) {
            logger.warn(`[CrawlerDO] Unsafe URL skipped: ${link.url} — ${err instanceof Error ? err.message : err}`)
            continue
          }

          this.visited.add(link.url)
          this.frontier.push({
            url: link.url,
            depth: depth + 1,
            source_url: url,
            priority: Math.max(1, 10 - depth),  // Lower depth = higher priority
            added_at: Date.now(),
          })
          newUrlsAdded++
        }

        logger.info(`[CrawlerDO] Discovered ${links.length} links, added ${newUrlsAdded} new`)
      }

      // 6. Push to indexing queue
      if (this.env.INDEX_QUEUE) {
        const queueMsg: IndexQueueMessage = {
          type: 'INDEX_URL',
          payload: {
            url,
            title,
            html: extractedContent,
            options: {
              language: 'en',
              source_url: url,
              crawled_at: new Date().toISOString(),
            },
          },
        }
        await this.env.INDEX_QUEUE.send(queueMsg)
        this.stats.chunks_indexed++

        logger.info(`[CrawlerDO] Queued for indexing: ${url}`)
      }

      // 7. Mark as visited (prevents re-crawling via other paths)
      this.visited.add(url)

      // 8. Update state
      this.stats.urls_crawled++
      this.updateDomainState(domain, true)

      logger.info(`[CrawlerDO] Completed: ${url} (${extractedContent.length} chars)`)

    } catch (error) {
      logger.error(`[CrawlerDO] Failed: ${url}:`, { error: toError(error) })
      this.stats.urls_failed++
      this.updateDomainState(domain, true)
    }
  }

  // ============================================================
  // Robots.txt Handling
  // ============================================================

  private async checkRobotsTxt(domain: string): Promise<boolean> {
    let domainState = this.domainStates.get(domain)

    // Check cache freshness (1 hour)
    if (domainState && domainState.robots_cached_at > Date.now() - 3600000) {
      return domainState.allowed
    }

    try {
      const robotsUrl = `https://${domain}/robots.txt`
      const response = await fetch(robotsUrl, {
        signal: AbortSignal.timeout(5000),
        headers: { 'User-Agent': 'SearchEngineCrawler/1.0' },
      })

      if (response.ok) {
        const body = await response.text()
        const rules = parseRobotsTxt(body)

        // Update domain state
        domainState = {
          domain,
          last_crawled_at: domainState?.last_crawled_at ?? 0,
          pages_crawled: domainState?.pages_crawled ?? 0,
          allowed: true,
          robots_cached_at: Date.now(),
          robots_disallows: rules.disallows,
          crawl_delay_ms: rules.crawlDelay,
        }
        this.domainStates.set(domain, domainState)

        return true
      }
    } catch (err) {
      logger.warn(`[CrawlerDO] Could not fetch robots.txt for ${domain}, assuming allowed:`, { error: toError(err) })
    }

    // Ensure domain state exists
    if (!this.domainStates.has(domain)) {
      this.domainStates.set(domain, {
        domain,
        last_crawled_at: 0,
        pages_crawled: 0,
        allowed: true,
        robots_cached_at: 0,
        robots_disallows: [],
        crawl_delay_ms: 0,
      })
    }

    return true
  }

  // ============================================================
  // State Helpers
  // ============================================================

  private updateDomainState(domain: string, crawled: boolean): void {
    const existing = this.domainStates.get(domain)
    this.domainStates.set(domain, {
      domain,
      last_crawled_at: Date.now(),
      pages_crawled: (existing?.pages_crawled ?? 0) + (crawled ? 1 : 0),
      allowed: existing?.allowed ?? true,
      robots_cached_at: existing?.robots_cached_at ?? 0,
      robots_disallows: existing?.robots_disallows ?? [],
      crawl_delay_ms: existing?.crawl_delay_ms ?? 0,
    })
    this.stats.domains_encountered = this.domainStates.size
  }

  private sortFrontier(): void {
    this.frontier.sort((a, b) => {
      if (b.priority !== a.priority) return b.priority - a.priority
      return a.added_at - b.added_at
    })
  }

  private emptyStats(): CrawlStats {
    return {
      total_seeds: 0,
      total_urls_discovered: 0,
      urls_crawled: 0,
      urls_failed: 0,
      urls_skipped: 0,
      urls_queued: 0,
      domains_encountered: 0,
      chunks_indexed: 0,
      start_time: 0,
      last_activity: 0,
      estimated_completion: 0,
      status: 'idle',
    }
  }

  private async fireWebhook(): Promise<void> {
    if (!this.config.webhook_url) return

    try {
      await fetch(this.config.webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          event: 'crawl_completed',
          stats: this.stats,
          config: this.config,
          seeds: this.seeds,
        }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (err) {
      logger.error('[CrawlerDO] Webhook delivery failed:', { error: toError(err) })
    }
  }
}

// ============================================================
// Client-Side RPC Stubs
// ============================================================

export interface CrawlerRPC {
  seed(urls: string[], options?: Partial<CrawlerConfig>): Promise<{ added: number; failed: number }>
  start(): Promise<void>
  pause(): Promise<void>
  reset(): Promise<void>
  getStatus(): Promise<{
    stats: CrawlStats
    config: CrawlerConfig
    seeds: string[]
    frontier_size: number
    visited_count: number
    domain_count: number
    recent_urls: string[]
  }>
}

/**
 * Get a CrawlerDO stub for the given crawl ID.
 * Uses ID-based routing: each crawl gets its own DO instance.
 */
export function getCrawlerStub(env: Env, crawlId: string): CrawlerRPC {
  const id = env.CRAWLER_DO!.idFromName(`crawl-${crawlId}`)
  return env.CRAWLER_DO!.get(id) as unknown as CrawlerRPC
}

/**
 * Generate a unique crawl ID.
 */
export function generateCrawlId(): string {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 8)
  return `cr_${ts}${rand}`
}
