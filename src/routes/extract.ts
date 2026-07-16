/**
 * API Route: /api/extract
 * Extract clean content from URLs (Tavily-compatible)
 *
 * POST /api/extract
 * Body: ExtractRequest (JSON)
 * Returns: ExtractResponse
 *
 * GET /api/extract?urls=url1,url2
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppBindings, ExtractRequest, ExtractResponse, ErrorResponse } from '../types'
import { extractContent } from '../lib/extractor'

const extractRoute = new Hono<{ Bindings: AppBindings }>()

extractRoute.use('/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// POST /api/extract
extractRoute.post('/', async (c) => {
  let body: Partial<ExtractRequest>
  try {
    body = await c.req.json()
  } catch {
    return c.json<ErrorResponse>({ detail: 'Invalid JSON body', code: 'invalid_body' }, 400)
  }

  if (!body.urls || (Array.isArray(body.urls) && body.urls.length === 0)) {
    return c.json<ErrorResponse>({ detail: 'urls is required (string or array of strings)', code: 'missing_urls' }, 400)
  }

  const urls = body.urls
  const includeImages = body.include_images ?? false
  const maxTokens = Math.min(body.max_tokens ?? 8000, 16000)

  try {
    const results = await extractContent(urls, {
      jinaApiKey: c.env.JINA_API_KEY,
      includeImages,
      maxTokens,
    })

    const response: ExtractResponse = {
      results: results.filter((r) => r.success),
      failed_results: results.filter((r) => !r.success),
      response_time_ms: 0, // Set by caller if needed
    }

    return c.json<ExtractResponse>(response)
  } catch (err) {
    console.error('Extract error:', err)
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Extraction failed',
        code: 'extract_error',
      },
      500,
    )
  }
})

// GET /api/extract?urls=url1,url2
extractRoute.get('/', async (c) => {
  const urlsParam = c.req.query('urls') || c.req.query('url')
  if (!urlsParam) {
    return c.json<ErrorResponse>({ detail: 'urls parameter is required (comma-separated)', code: 'missing_urls' }, 400)
  }

  const urls = urlsParam.split(',').map((u) => u.trim()).filter(Boolean)
  if (urls.length === 0) {
    return c.json<ErrorResponse>({ detail: 'At least one URL is required', code: 'missing_urls' }, 400)
  }

  const includeImages = c.req.query('include_images') === 'true'

  try {
    const results = await extractContent(urls, {
      jinaApiKey: c.env.JINA_API_KEY,
      includeImages,
    })

    const response: ExtractResponse = {
      results: results.filter((r) => r.success),
      failed_results: results.filter((r) => !r.success),
      response_time_ms: 0,
    }

    return c.json<ExtractResponse>(response)
  } catch (err) {
    console.error('Extract error:', err)
    return c.json<ErrorResponse>(
      {
        detail: err instanceof Error ? err.message : 'Extraction failed',
        code: 'extract_error',
      },
      500,
    )
  }
})

export { extractRoute }
