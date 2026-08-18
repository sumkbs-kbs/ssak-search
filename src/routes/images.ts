/**
 * API Route: /api/images
 * Dedicated image search endpoint (like Brave Image Search / SerpAPI image search)
 *
 * GET /api/images?query=...&max_results=10&size=medium&color=any&type=any
 * POST /api/images
 * Body: { query, max_results, size, color, type, safe_search }
 * Returns: { query, images: ImageResult[], response_time_ms, total_results }
 */

import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ImageResult, ErrorResponse } from '../types'

import { searchAllFreeImageSources } from '../lib/free-image-search'
import { validateApiKeyWithTenant, checkClientRateLimit, getClientIp } from '../lib/auth'
import { auditAuthFailure, audit } from '../lib/audit'
import { setMetricsEnv, recordSearchSubrequests } from '../lib/metrics'
import { getCached, setCached } from '../lib/cache'

// ============================================================
// Types
// ============================================================

export type ImageSize = 'small' | 'medium' | 'large' | 'wallpaper' | 'any'
export type ImageColor = 'color' | 'monochrome' | 'any'
export type ImageType = 'photo' | 'clipart' | 'animated' | 'transparent' | 'any'
export type ImageSafeSearch = 'strict' | 'moderate' | 'off'

export interface ImageSearchRequest {
  query: string
  max_results?: number
  size?: ImageSize
  color?: ImageColor
  type?: ImageType
  safe_search?: ImageSafeSearch
  /** Generate AI-powered visual answer describing image results (Phase 3.1) */
  include_visual_answer?: boolean
}

export interface ImageSearchResponse {
  query: string
  images: ImageResult[]
  response_time_ms: number
  total_results: number
  /** AI-generated visual answer describing image results (Phase 3.1) */
  visual_answer?: string
}

/**
 * Execute image search with optional filters.
 * Filters are applied via Bing's URL parameters (qft filter string).
 */
async function executeImageSearch(
  query: string,
  opts: {
    maxResults?: number
    size?: ImageSize
    color?: ImageColor
    type?: ImageType
    env?: AppBindings
  } = {},
): Promise<ImageResult[]> {
  const { maxResults = 10, size = 'any', color = 'any', type = 'any', env } = opts

  // Use combined free image search (Bing + Flickr + Unsplash if keys configured)
  let results = await searchAllFreeImageSources(query, { maxResults, env, size, color, type })

  // Post-filter by size (in case some sources return dimensions).
  // 'small' needs no post-filter — sources already return their default
  // (small/medium) thumbnails; only 'large' is enforced here.
  if (size === 'large') {
    results = results.filter((r) => (r.width ?? 0) > 1200 || (r.height ?? 0) > 1200)
  }

  return results.slice(0, maxResults)
}

// ============================================================
// Visual Answer Generation (Phase 3.1)
// ============================================================

/**
 * Generate an AI-powered visual answer that describes and contextualizes
 * image search results. Uses image titles + source context to produce
 * a coherent narrative about the visual content found.
 */
async function generateVisualAnswer(query: string, images: ImageResult[], ai: Ai): Promise<string | undefined> {
  if (!ai || images.length === 0) return undefined

  // Take top images for context
  const topImages = images.slice(0, 8)
  const imageContext = topImages
    .map((img, i) => `[Image ${i + 1}] Title: ${img.title}\n    Source: ${img.source}\n    URL: ${img.url}`)
    .join('\n')

  const prompt = `You are a visual search analyst. Based on the image search results for the query "${query}", provide a concise visual summary (2-3 paragraphs) that:

1. Describes what types of images were found
2. Groups related images by theme or subject
3. Highlights the most relevant visual content for the user's query
4. Suggests what visual information these images collectively convey

Do NOT describe individual images in a list. Instead, synthesize across images to give a coherent visual answer.

IMAGE SEARCH RESULTS:
${imageContext}

VISUAL ANSWER (2-3 paragraphs):`

  try {
    const result = await ai.run('@cf/meta/llama-3.1-8b-instruct', {
      messages: [
        {
          role: 'system',
          content: 'You are a visual search analyst that produces brief, insightful visual summaries.',
        },
        { role: 'user', content: prompt },
      ],
      max_tokens: 500,
      temperature: 0.3,
    })

    const text =
      typeof result === 'object' && result !== null
        ? ('response' in result ? (result as { response: string }).response : null) || JSON.stringify(result)
        : String(result)

    if (text && text.trim().length > 20) return text.trim()
  } catch (err) {
    logger.warn('Visual answer generation failed:', { error: toError(err) })
  }

  return undefined
}

const imagesRoute = new Hono<{ Bindings: AppBindings; Variables: { tenantId: string; tenantPlan: string } }>()

// CORS
imagesRoute.use(
  '/*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
    maxAge: 86400,
  }),
)

// Auth + rate limit middleware
imagesRoute.use('/*', async (c, next) => {
  const clientIp = getClientIp(c.req.raw.headers)

  // Body size guard
  const contentLength = parseInt(c.req.raw.headers.get('Content-Length') ?? '0', 10)
  if (contentLength > 64 * 1024) {
    audit({
      eventType: 'invalid_input',
      severity: 'low',
      outcome: 'blocked',
      resource: c.req.path,
      actor: clientIp,
      context: { contentLength },
    })
    return c.json<ErrorResponse>({ detail: 'Request body too large (max 64KB)', code: 'payload_too_large' }, 413)
  }

  // Multi-tenant API key validation
  const authResult = validateApiKeyWithTenant(c.req.raw.headers, c.env.TENANTS_CONFIG, c.env.SEARCH_API_KEY, c.env)
  if (!authResult.valid) {
    auditAuthFailure({
      reason: authResult.reason || 'Invalid or missing API key',
      clientIp,
      resource: c.req.path,
      attempt: 'none',
    })
    return c.json<ErrorResponse>({ detail: authResult.reason || 'Unauthorized', code: 'unauthorized' }, 401)
  }

  // Per-client rate limiting
  const rateLimit = checkClientRateLimit(clientIp, {
    tenantId: authResult.tenant?.id,
    tenantsConfig: c.env.TENANTS_CONFIG,
    env: c.env,
  })
  if (!rateLimit.allowed) {
    return c.json<ErrorResponse>({ detail: 'Rate limit exceeded. Try again later.', code: 'rate_limited' }, 429, {
      'X-RateLimit-Remaining': '0',
      'Retry-After': '60',
    })
  }

  c.header('X-Tenant-Id', authResult.tenant?.id ?? '__default__')
  if (authResult.tenant?.config.plan) c.header('X-Tenant-Plan', authResult.tenant.config.plan)
  c.header('X-RateLimit-Remaining', rateLimit.remaining.toString())
  c.set('tenantId', authResult.tenant?.id ?? '__default__')
  c.set('tenantPlan', authResult.tenant?.config.plan ?? 'pro')

  await next()
})

// POST /api/images — primary image search endpoint
imagesRoute.post('/', async (c) => {
  setMetricsEnv(c.env)
  let body: Partial<ImageSearchRequest>
  try {
    body = await c.req.json()
  } catch (_err) {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.query || typeof body.query !== 'string' || body.query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query is required', code: 'missing_query' }, 400)
  }

  if (body.query.length > 2000) {
    return c.json<ErrorResponse>({ detail: 'Query too long (max 2000 chars)', code: 'query_too_long' }, 400)
  }

  const maxResults = Math.min(Math.max(body.max_results ?? 10, 1), 50)
  const size = body.size ?? 'any'
  const color = body.color ?? 'any'
  const type = body.type ?? 'any'
  const includeVisualAnswer = body.include_visual_answer === true

  const startTime = Date.now()
  try {
    // Check cache (general images change slowly unless it's news)
    const key = `img:${body.query.trim()}:${maxResults}:${size}:${color}:${type}:${includeVisualAnswer}`
    const cached = await getCached<ImageSearchResponse>(key)
    if (cached) {
      return c.json<ImageSearchResponse>(cached)
    }

    const images = await executeImageSearch(body.query.trim(), {
      maxResults,
      size,
      color,
      type,
      env: c.env,
    })

    // Generate visual answer if requested
    let visualAnswer: string | undefined
    if (includeVisualAnswer && c.env.AI) {
      visualAnswer = await generateVisualAnswer(body.query.trim(), images, c.env.AI)
    }

    const result: ImageSearchResponse = {
      query: body.query.trim(),
      images,
      response_time_ms: Date.now() - startTime,
      total_results: images.length,
      visual_answer: visualAnswer,
    }

    // Cache (5 min TTL for images)
    if (images.length > 0) {
      c.executionCtx.waitUntil(setCached(key, result, 'image', c.env))
    }

    recordSearchSubrequests(1)
    return c.json<ImageSearchResponse>(result)
  } catch (err) {
    logger.error('Image search error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Image search failed', code: 'image_search_error' },
      500,
    )
  }
})

// GET /api/images — simplified GET interface
imagesRoute.get('/', async (c) => {
  setMetricsEnv(c.env)
  const query = c.req.query('query') || c.req.query('q')
  if (!query || query.trim().length === 0) {
    return c.json<ErrorResponse>({ detail: 'Query parameter "query" or "q" is required', code: 'missing_query' }, 400)
  }

  const maxResults = Math.min(Math.max(parseInt(c.req.query('max_results') || '10', 10) || 10, 1), 50)
  const size = (c.req.query('size') as ImageSize) || 'any'
  const color = (c.req.query('color') as ImageColor) || 'any'
  const type = (c.req.query('type') as ImageType) || 'any'

  const startTime = Date.now()
  try {
    const images = await executeImageSearch(query.trim(), { maxResults, size, color, type, env: c.env })

    const result: ImageSearchResponse = {
      query: query.trim(),
      images,
      response_time_ms: Date.now() - startTime,
      total_results: images.length,
    }

    recordSearchSubrequests(1)
    return c.json<ImageSearchResponse>(result)
  } catch (err) {
    logger.error('Image search error:', { error: toError(err) })
    return c.json<ErrorResponse>(
      { detail: err instanceof Error ? err.message : 'Image search failed', code: 'image_search_error' },
      500,
    )
  }
})

export { imagesRoute }
