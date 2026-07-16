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
      // Primary: Bing mobile web scraping (no API key, no registration)
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
    },
    notes: [
      'All search backends are free and require no API keys',
      'Bing mobile scraping is the primary backend for all queries',
      'Specialized sources (Wikipedia, GitHub, HN, Reddit) add depth based on query type',
      'Korean/CJK queries automatically use correct regional market (mkt=ko-KR)',
    ],
    uptime_hint: 'edge-deployed',
    auth_required: !!c.env.SEARCH_API_KEY,
  }
  return c.json(response)
})

export { healthRoute }
