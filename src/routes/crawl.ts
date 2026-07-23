/**
 * API Route: /api/crawl — Web Crawler API
 *
 * POST   /api/crawl            — Start a new crawl with seed URLs
 * GET    /api/crawl/:id        — Get crawl status
 * POST   /api/crawl/:id/stop   — Pause an active crawl
 * DELETE /api/crawl/:id        — Reset crawl state
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse, CrawlRequest, CrawlStartResponse, CrawlStatusResponse } from '../types'
import { getCrawlerStub, generateCrawlId } from '../lib/crawler-do'

const crawlRoute = new Hono<{ Bindings: AppBindings }>()

crawlRoute.use('/*', cors({ origin: '*' }))

// Binding check helper
function checkBinding(c: any): boolean {
  return !!c.env.CRAWLER_DO
}

// ============================================================
// POST /api/crawl — Start a new crawl
// ============================================================
crawlRoute.post('/', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      {
        detail: 'Crawler requires CRAWLER_DO Durable Object binding. Configure via Cloudflare Dashboard → Pages → search-engine-api → Settings → Functions → Durable Objects → Add binding (name: CRAWLER_DO, class: CrawlerDO).',
        code: 'binding_missing',
      },
      501,
    )
  }

  let body: Partial<CrawlRequest>
  try {
    body = await c.req.json()
  } catch (err) {
    logger.warn('[Crawl] Invalid JSON body:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.urls || !Array.isArray(body.urls) || body.urls.length === 0) {
    return c.json<ErrorResponse>({ detail: 'urls is required (array of seed URLs)', code: 'missing_urls' }, 400)
  }

  if (body.urls.length > 50) {
    return c.json<ErrorResponse>({ detail: 'Maximum 50 seed URLs per request', code: 'too_many_urls' }, 400)
  }

  const crawlId = generateCrawlId()

  try {
    const stub = getCrawlerStub(c.env, crawlId)

    // Add seed URLs with config
    const config = {
      max_depth: body.max_depth ?? 2,
      max_pages_per_domain: body.max_pages_per_domain ?? 100,
      politeness_delay_ms: body.politeness_delay_ms ?? 2000,
      follow_external_links: body.follow_external_links ?? false,
      respect_robots_txt: body.respect_robots_txt ?? true,
      request_timeout_ms: 15000,
      max_concurrent_requests: 3,
      webhook_url: body.webhook_url,
      label: body.label,
    }

    const result = await stub.seed(body.urls, config)
    await stub.start()

    const response: CrawlStartResponse = {
      crawl_id: crawlId,
      message: `Crawl started with ${result.added} seed URLs${result.failed > 0 ? ` (${result.failed} failed validation)` : ''}`,
      seeds_added: result.added,
    }

    return c.json(response, 201)
  } catch (err) {
    logger.error('Start crawl error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Failed to start crawl', code: 'crawl_error' },
      500,
    )
  }
})

// ============================================================
// GET /api/crawl/:id — Get crawl status
// ============================================================
crawlRoute.get('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Crawler requires CRAWLER_DO binding', code: 'binding_missing' },
      501,
    )
  }

  const { id } = c.req.param()

  try {
    const stub = getCrawlerStub(c.env, id)
    const status = await stub.getStatus()

    const response: CrawlStatusResponse = {
      crawl_id: id,
      label: status.config.label,
      stats: status.stats,
      config: status.config,
      seeds: status.seeds,
      recent_urls: status.recent_urls,
      domain_breakdown: [],
    }

    return c.json(response)
  } catch (err) {
    logger.error('Get crawl status error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to get crawl status', code: 'status_error' },
      500,
    )
  }
})

// ============================================================
// POST /api/crawl/:id/stop — Pause an active crawl
// ============================================================
crawlRoute.post('/:id/stop', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Crawler requires CRAWLER_DO binding', code: 'binding_missing' },
      501,
    )
  }

  const { id } = c.req.param()

  try {
    const stub = getCrawlerStub(c.env, id)
    await stub.pause()

    return c.json({ success: true, message: 'Crawl paused', crawl_id: id })
  } catch (err) {
    logger.error('Stop crawl error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to stop crawl', code: 'stop_error' },
      500,
    )
  }
})

// ============================================================
// DELETE /api/crawl/:id — Reset crawl state
// ============================================================
crawlRoute.delete('/:id', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      { detail: 'Crawler requires CRAWLER_DO binding', code: 'binding_missing' },
      501,
    )
  }

  const { id } = c.req.param()

  try {
    const stub = getCrawlerStub(c.env, id)
    await stub.reset()

    return c.json({ success: true, message: 'Crawl state reset', crawl_id: id })
  } catch (err) {
    logger.error('Reset crawl error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: 'Failed to reset crawl', code: 'reset_error' },
      500,
    )
  }
})

export { crawlRoute }
