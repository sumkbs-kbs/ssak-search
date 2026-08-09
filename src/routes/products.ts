/**
 * Product Search API — Product Hunt + G2 (Phase 3.4c)
 *
 * Endpoints:
 *   POST /api/products/search  — Search Product Hunt and G2
 *   GET  /api/products         — List available product sources
 */
import { Hono } from 'hono'
import { logger, toError } from '../lib/logger'
import { z } from 'zod'
import type { AppBindings, ErrorResponse } from '../types'
import { searchProducts } from '../lib/product-search'

// ============================================================
// Schema
// ============================================================

const ProductSearchRequest = z.object({
  query: z.string().min(1).max(500),
  max_results: z.number().int().min(1).max(20).default(10),
})

// ============================================================
// Route
// ============================================================

const products = new Hono<{ Bindings: AppBindings }>()

/**
 * GET / — List available product sources
 */
products.get('/', (c) => {
  return c.json({
    success: true,
    sources: [
      {
        id: 'producthunt',
        name: 'Product Hunt',
        description: 'Search Product Hunt for new products and tools',
        endpoints: {
          search: 'POST /api/products/search',
        },
      },
      {
        id: 'g2',
        name: 'G2',
        description: 'Search G2 for software reviews and ratings',
        endpoints: {
          search: 'POST /api/products/search',
        },
      },
    ],
  })
})

/**
 * POST /search — Search Product Hunt and G2
 */
products.post('/search', async (c) => {
  try {
    const body = ProductSearchRequest.parse(await c.req.json())
    const { query, max_results } = body

    const results = await searchProducts(query, max_results, c.env)

    return c.json({ success: true, query, results })
  } catch (err) {
    if (err instanceof z.ZodError) {
      return c.json<ErrorResponse>({ detail: 'Validation error', code: 'validation_error' }, 400)
    }
    logger.error('Product search error:', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'Product search failed', code: 'internal_error' }, 500)
  }
})

export { products as productsRoute }
