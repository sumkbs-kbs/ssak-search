/**
 * TDD RED — council.ts / openai.ts 라우트의 fetch 기반 LLM 호출부 429 재시도 통일.
 *
 * council.ts의 invokeOpenAI/invokeClaude(외부 OpenAI/Anthropic 게이트웨이)와
 * openai.ts의 callInternalApi(내부 /api/search·/api/research 호출)에
 * httpErrorFromResponse + withRetry(isRateLimitError / rateLimitDelaysMs /
 * getRetryAfterMs)가 연결되어야 한다. Retry-After 힌트는 고정 백오프를
 * 재정의하고, 429 소진 시 status/retryAfterMs를 실은 오류가 라우트까지
 * 전달되어야 한다.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Hono } from 'hono'

const fetchMock = vi.fn()

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  fetchMock.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

import { councilRoute, invokeOpenAI, invokeClaude } from '../../src/routes/council'
import { openaiRoute, callInternalApi } from '../../src/routes/openai'
import { retryAfterMsFromError } from '../../src/lib/resilience/retry'

const stubExecutionCtx = {
  waitUntil: (p: Promise<unknown>) => p.catch(() => {}),
  passThroughOnException: () => {},
  cf: {},
  props: {},
}

function okOpenAI(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function okClaude(content: string): Response {
  return new Response(JSON.stringify({ content: [{ text: content }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('council invokeOpenAI — withRetry 429 통일', () => {
  it('429 응답의 Retry-After(0s)가 고정 백오프를 재정의하고 즉시 재시도해 회복한다', async () => {
    // rateLimitDelaysMs [2000, 4000] 지터 최소 1000ms — Retry-After 0s가 아니라면
    // 100ms 시점에 재시도될 수 없다. 서버 지시 대기(0)가 권위를 가진다.
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(okOpenAI('council answer'))
    const promise = invokeOpenAI('질문', 'sk-test', 'gpt4o-mini', undefined)
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise
    expect(result).toBe('council answer')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('429 소진 시 status+retryAfterMs를 실은 오류를 던진다 (라우트가 available:false 처리)', async () => {
    // mockImplementation: 매 호출 새 Response — 재시도에서 본문 재사용 방지.
    fetchMock.mockImplementation(() => new Response('quota', { status: 429, headers: { 'retry-after': '2' } }))
    const promise = invokeOpenAI('질문', 'sk-test', 'gpt4o-mini', undefined)
    // rejection을 즉시 catch — fake timers 진행 중 unhandled 방지.
    const rejection = promise.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(3000)
    const err = await rejection
    expect(err).toMatchObject({
      status: 429,
      retryAfterMs: 2000,
      message: expect.stringContaining('429'),
    })
    expect(fetchMock).toHaveBeenCalledTimes(2) // initial + 1 rate-limit retry
  })

  it('비-429(500)는 fail-fast — 재시도 없이 즉시 실패 (1회 호출)', async () => {
    fetchMock.mockResolvedValueOnce(new Response('boom', { status: 500 }))
    const promise = invokeOpenAI('질문', 'sk-test', 'gpt4o-mini', undefined)
    const rejection = promise.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(100)
    const err = await rejection
    expect((err as Error).message).toMatch(/OpenAI API error \(500\)/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('council invokeClaude — withRetry 429 통일', () => {
  it('429 Retry-After(0s) 후 재시도로 회복한다', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(okClaude('claude answer'))
    const promise = invokeClaude('질문', 'sk-anthropic', undefined)
    await vi.advanceTimersByTimeAsync(100)
    const result = await promise
    expect(result).toBe('claude answer')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('429 소진 시 status+retryAfterMs 오류 — retryAfterMsFromError가 힌트를 소비', async () => {
    fetchMock.mockImplementation(() => new Response('quota', { status: 429, headers: { 'retry-after': '3' } }))
    const promise = invokeClaude('질문', 'sk-anthropic', undefined)
    const rejection = promise.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(4000)
    const err = await rejection
    expect((err as { status: number }).status).toBe(429)
    expect(retryAfterMsFromError(err)).toBe(3000)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('council 라우트 e2e — 429 재시도 후 available:true', () => {
  it('POST /api/council: openai-gpt4o-mini가 429 후 재시도로 회복하면 결과 반환', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(okOpenAI('e2e council answer'))
    const app = new Hono()
    app.route('/api/council', councilRoute)
    const req = new Request('http://localhost/api/council', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ query: '테스트', models: ['openai-gpt4o-mini'] }),
    })
    const resPromise = app.fetch(req, { OPENAI_API_KEY: 'sk-test', SEARCH_API_KEY: 'test-key' }, stubExecutionCtx)
    await vi.advanceTimersByTimeAsync(100)
    const res = await resPromise
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      results: Array<{ model: string; available: boolean; response: string; error?: string }>
    }
    expect(body.results[0]).toMatchObject({
      model: 'openai-gpt4o-mini',
      available: true,
      response: 'e2e council answer',
    })
    expect(body.results[0].error).toBeUndefined()
  })

  it('POST /api/council: 429 소진 시 available:false + 오류 메시지 (라우트가 오류를 소화)', async () => {
    fetchMock.mockResolvedValue(new Response('quota', { status: 429, headers: { 'retry-after': '0' } }))
    const app = new Hono()
    app.route('/api/council', councilRoute)
    const req = new Request('http://localhost/api/council', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({ query: '테스트', models: ['openai-gpt4o-mini'] }),
    })
    const resPromise = app.fetch(req, { OPENAI_API_KEY: 'sk-test', SEARCH_API_KEY: 'test-key' }, stubExecutionCtx)
    await vi.advanceTimersByTimeAsync(100)
    const res = await resPromise
    expect(res.status).toBe(200) // council은 모델 단위 실패를 200 본문으로 소화
    const body = (await res.json()) as { results: Array<{ available: boolean; error: string }> }
    expect(body.results[0].available).toBe(false)
    expect(body.results[0].error).toContain('429')
  })
})

describe('openai callInternalApi — withRetry 429 통일', () => {
  it('429 Retry-After(0s) 후 재시도로 회복해 JSON을 반환한다', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ results: [{ title: 'T', url: 'https://x.com', content: 'c' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
    const promise = callInternalApi('http://localhost', '/api/search', {}, { query: 'q' }, 'search')
    await vi.advanceTimersByTimeAsync(100)
    const data = await promise
    expect(data).toEqual({ results: [{ title: 'T', url: 'https://x.com', content: 'c' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('429 소진 시 status:429를 실은 오류를 던진다 (라우트 429 패스스루용)', async () => {
    fetchMock.mockImplementation(
      () =>
        new Response(JSON.stringify({ detail: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'retry-after': '1' },
        }),
    )
    const promise = callInternalApi('http://localhost', '/api/search', {}, { query: 'q' }, 'search')
    const rejection = promise.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(2000)
    const err = await rejection
    expect((err as { status: number }).status).toBe(429)
    expect(retryAfterMsFromError(err)).toBe(1000)
    expect((err as Error).message).toContain('Rate limit exceeded')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('비-429(500)는 fail-fast — 1회 호출', async () => {
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ detail: 'boom' }), { status: 500 }))
    const promise = callInternalApi('http://localhost', '/api/search', {}, { query: 'q' }, 'search')
    const rejection = promise.catch((e: unknown) => e)
    await vi.advanceTimersByTimeAsync(100)
    const err = await rejection
    expect((err as Error).message).toMatch(/boom|Search failed/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('openai 라우트 e2e — 내부 search 429 재시도', () => {
  it('POST /v1/chat/completions: 내부 search 429 후 재시도로 회복하면 200 + 내용', async () => {
    fetchMock
      .mockResolvedValueOnce(new Response('rate limited', { status: 429, headers: { 'retry-after': '0' } }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            results: [{ title: '출처1', url: 'https://x.com', content: '내용' }],
            answer: { text: 'e2e search answer' },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      )
    const app = new Hono()
    app.route('/v1', openaiRoute)
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({
        model: 'search-engine',
        messages: [{ role: 'user', content: '테스트 질문' }],
      }),
    })
    const resPromise = app.fetch(req, {}, stubExecutionCtx)
    await vi.advanceTimersByTimeAsync(100)
    const res = await resPromise
    expect(res.status).toBe(200)
    const body = (await res.json()) as { choices: Array<{ message: { content: string } }> }
    expect(body.choices[0].message.content).toContain('e2e search answer')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('POST /v1/chat/completions: 내부 search 429 소진 시 429를 클라이언트에 패스스루 (502가 아님)', async () => {
    fetchMock.mockImplementation(
      () =>
        new Response(JSON.stringify({ detail: 'Rate limit exceeded' }), {
          status: 429,
          headers: { 'retry-after': '0' },
        }),
    )
    const app = new Hono()
    app.route('/v1', openaiRoute)
    const req = new Request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
      body: JSON.stringify({
        model: 'search-engine',
        messages: [{ role: 'user', content: '테스트 질문' }],
      }),
    })
    const resPromise = app.fetch(req, {}, stubExecutionCtx)
    await vi.advanceTimersByTimeAsync(100)
    const res = await resPromise
    expect(res.status).toBe(429)
    const body = (await res.json()) as { error: { type: string; message: string } }
    expect(body.error.type).toBe('search_error')
    expect(body.error.message).toContain('Rate limit exceeded')
  })
})
