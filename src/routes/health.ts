/**
 * API Route: /api/health
 * Health check and service status
 */

import { Hono } from 'hono'
import { cors } from 'hono/cors'
import type { AppBindings, HealthResponse } from '../types'

const healthRoute = new Hono<{ Bindings: AppBindings }>()

healthRoute.use('/*', cors({ origin: '*' }))

healthRoute.get('/', (c) => {
  const response: HealthResponse = {
    status: 'ok',
    version: '1.0.0',
    backends: {
      // Primary for Korean queries: Naver mobile web scraping (no API key)
      naver: 'operational',
      // Secondary: Bing mobile web scraping (no API key, no registration)
      bing: 'operational',
      // Specialized free sources (no API key required)
      wikipedia: 'operational',
      github: 'operational',
      hackernews: 'operational',
      reddit: 'operational',
      // Emergency fallback (anti-bot blocked but kept for resilience)
      duckduckgo_fallback: 'degraded',
      // Optional: Workers AI for answer generation
      workers_ai: c.env.AI ? 'operational' : 'disabled',
    },
    features: {
      search: true,
      extract: true,
      answer: !!c.env.AI,
      news: true,
      multilingual: true,
      korean_optimized: true,
    },
    notes: [
      'All search backends are free and require no API keys',
      'Naver mobile scraping is the PRIMARY backend for Korean queries (stock cards, news, blogs)',
      'Bing mobile scraping is the secondary backend for all queries',
      'Specialized sources (Wikipedia, GitHub, HN, Reddit) add depth based on query type',
      'Financial/stock queries are detected and routed to Naver for real-time price data',
    ],
    uptime_hint: 'edge-deployed',
    auth_required: !!c.env.SEARCH_API_KEY,
  }
  return c.json(response)
})

export { healthRoute }
