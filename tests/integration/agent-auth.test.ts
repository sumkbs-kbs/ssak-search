/**
 * Integration tests — /api/agent auth + rate-limit middleware.
 *
 * The agent routes drive bing/naver/DDG scraping from the deployment's egress
 * IPs; before the middleware they were fully unauthenticated, which is an IP-ban
 * lever for anyone who finds the endpoint. These tests pin the guard:
 * 401 without a key, 200 with the test key, and the agent-shaped error payload.
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

describe('/api/agent auth guard', () => {
  it('rejects missing API key with 401 and an agent-shaped error payload', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `10.7.0.${(Math.random() * 250) | 1}` },
      body: JSON.stringify({ query: 'test' }),
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; agent_hint: string; retryable: boolean } }
    expect(body.error.code).toBe('UNAUTHORIZED')
    expect(body.error.agent_hint).toBeTruthy()
    expect(body.error.retryable).toBe(false)
  })

  it('accepts a valid API key and reaches the search handler', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-key',
        'X-Forwarded-For': `10.8.0.${(Math.random() * 250) | 1}`,
      },
      body: JSON.stringify({ query: '' }), // invalid on purpose — 400 from the handler proves we got past auth
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('MISSING_QUERY')
  })

  it('guards the SSE stream endpoint too', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/stream-search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    })
    expect(res.status).toBe(401)
  })

  it('guards the extract endpoint too', async () => {
    const res = await worker.fetch(`${BASE}/api/agent/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://example.com' }),
    })
    expect(res.status).toBe(401)
  })
})
