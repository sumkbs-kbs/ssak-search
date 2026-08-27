import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { AppBindings } from '../types'
import { AgentToolInputSchema, extractWithStealthEscalation, handleExtractionError } from '../lib/agent-extractor'
import { executeFastAgentSearch } from '../lib/agent-search-orchestrator'

export const agentApi = new Hono<{ Bindings: AppBindings }>()

/**
 * 1. 초고속 에이전트 검색 엔드포인트
 */
agentApi.post('/search', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  if (!body || typeof body.query !== 'string' || !body.query.trim()) {
    return c.json(
      {
        error: {
          code: 'MISSING_QUERY',
          detail: 'Query parameter is required.',
          agent_hint: 'Provide a valid non-empty search query string.',
          retryable: false,
          suggested_action: 'RETRY_WITH_BACKOFF',
        },
      },
      400,
    )
  }

  const query = body.query.trim()
  const maxResults = Math.min(Math.max(Number(body.max_results) || 5, 1), 10)
  const topic = body.topic === 'code' || body.topic === 'news' || body.topic === 'finance' ? body.topic : 'general'
  const decomposeSubqueries = Boolean(body.decompose_subqueries)

  // 조기 반환 검색 실행
  const result = await executeFastAgentSearch(query, maxResults, 0.82, 2500, c.env, topic, decomposeSubqueries)

  return c.json({ ...result, cached: false })
})

/**
 * 2. 실시간 SSE 스트리밍 에이전트 검색 엔드포인트 (TTFT < 300ms)
 */
agentApi.post('/stream-search', async (c) => {
  const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null
  const query = String(body?.query ?? '').trim()
  if (!query) {
    return c.json({ error: 'Query parameter is required' }, 400)
  }

  const maxResults = Math.min(Math.max(Number(body?.max_results) || 5, 1), 10)
  const topic = body?.topic === 'code' || body?.topic === 'news' || body?.topic === 'finance' ? body.topic : 'general'
  const decomposeSubqueries = Boolean(body?.decompose_subqueries)

  return streamSSE(c, async (stream) => {
    await stream.writeSSE({
      event: 'start',
      data: JSON.stringify({ query, timestamp: new Date().toISOString() }),
    })

    const result = await executeFastAgentSearch(query, maxResults, 0.82, 2500, c.env, topic, decomposeSubqueries)

    for (const hit of result.hits) {
      await stream.writeSSE({
        event: 'hit',
        data: JSON.stringify(hit),
      })
    }

    await stream.writeSSE({
      event: 'complete',
      data: JSON.stringify({
        took_ms: result.took_ms,
        confidence: result.signal_confidence,
        total_hits: result.hits.length,
      }),
    })
  })
})

/**
 * 3. 4단계 스텔스 에스컬레이션 기반 고밀도 마크다운/JSON 추출 엔드포인트
 */
agentApi.post('/extract', async (c) => {
  const body = await c.req.json().catch(() => null)
  const parseResult = AgentToolInputSchema.safeParse(body)

  if (!parseResult.success) {
    return c.json(
      {
        error: {
          code: 'VALIDATION_ERROR',
          detail: parseResult.error.message,
          agent_hint: 'Verify the input URL format and schema constraints.',
          retryable: false,
          suggested_action: 'RETRY_WITH_BACKOFF',
        },
      },
      400,
    )
  }

  const { url, max_token_budget, extract_depth, section_target } = parseResult.data

  try {
    const result = await extractWithStealthEscalation(url, {
      maxTokens: max_token_budget,
      sectionTarget: section_target,
      extractDepth: extract_depth,
      env: c.env,
    })

    return c.json(result, result.success ? 200 : 200)
  } catch (err: unknown) {
    const errObj = err instanceof Error ? err.message : String(err)
    return c.json(handleExtractionError(url, 500, errObj || 'Unknown network error'), 200)
  }
})
