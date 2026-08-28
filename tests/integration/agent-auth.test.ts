/**
 * Integration tests — central API auth gate (API_AUTH_GATED_PREFIXES).
 *
 * The gate covers every backend-driving or data-bearing route that used to
 * leak unauthenticated (research ran a 4.5s/15-source pipeline for anyone).
 * These tests pin the gate: 401 without a key on every gated prefix, and the
 * handler actually reached with one (invalid bodies 400 before any backend
 * is driven — no live network from these tests).
 *
 * Run: npx vitest run --config vitest.integration.config.ts
 */

import { exports } from 'cloudflare:workers'
import { describe, it, expect } from 'vitest'

interface WorkerModule {
  fetch: (url: string, init?: RequestInit) => Promise<Response>
}
const worker = (exports as unknown as { default: WorkerModule }).default

const BASE = 'https://ssak-search.pages.dev'

// Unique client IP per request: the global securityMiddleware rate-limits by
// IP (~17 rapid requests → pre-auth 429). Sharing one IP across the probe
// loops trips that limiter and masks the 401s these tests assert on.
const uniqueIp = () => `10.${(Math.random() * 250) | 1}.${(Math.random() * 250) | 1}.${(Math.random() * 250) | 1}`

const GATED_POST_ROUTES = [
  '/api/agent/search',
  '/api/agent/deep-research',
  '/api/research',
  '/api/chat',
  '/api/suggest',
  '/api/video',
  '/api/products',
  '/api/news-hub',
  '/api/queue',
]

const GATED_GET_ROUTES = ['/api/spaces', '/api/pages', '/api/library', '/api/profile', '/api/canary', '/api/monitor']

describe('central API auth gate', () => {
  it('rejects missing API key with 401 and an agent-shaped error payload', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ query: 'test' }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; agent_hint: string; retryable: boolean } }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.agent_hint).toBeTruthy()
    expect(body.error.retryable).toBe(false)
  })

  it('blocks every gated POST route without a key', async () => {
    for (const path of GATED_POST_ROUTES) {
      const res = await worker.fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
        body: JSON.stringify({}),
      })
      expect(res.status, `${path} should be 401`).toBe(401)
    }
  })

  it('blocks every gated GET route without a key', async () => {
    for (const path of GATED_GET_ROUTES) {
      const res = await worker.fetch(`${BASE}${path}`, { headers: { 'X-Forwarded-For': uniqueIp() } })
      expect(res.status, `${path} should be 401`).toBe(401)
    }
  })

  it('accepts a valid API key and reaches the search handler', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-key',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({ query: '' }), // invalid on purpose — 400 from the handler proves we got past auth
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_QUERY')
  })

  it('reaches the research handler with a key (validation 400, no backend driven)', async () => {
    const res = await worker.fetch(`${BASE}/api/research`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-key',
        'X-Forwarded-For': uniqueIp(),
      },
      body: JSON.stringify({}), // validation rejects before any fan-out
    })
    expect(res.status).toBe(400)
  })

  it('guards the SSE stream endpoint too', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/stream-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ query: 'test' }),
    })
    expect(res.status).toBe(401)
  })

  it('guards the extract endpoint too', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': uniqueIp() },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(401)
  })
})
