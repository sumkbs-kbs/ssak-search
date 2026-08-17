/**
 * API Route: /api/news-hub — 뉴스 RSS 허브 수집/상태 (P2-2, 2026-08-18)
 *
 * POST /api/news-hub/refresh  — NewsHubDO 에 수집 지시 (외부 cron
 *   ssak-probe-scheduler 가 매 15분 호출; DO alarm 이 1차 스케줄러이므로 이
 *   엔드포인트는 이중 스케줄링 보강 + 수동 트리거. DO 가 60초 min-interval
 *   로 중복 수집을 버린다. idempotent — feed 수집 후 KV 저장).
 * GET  /api/news-hub/status   — 저장된 기사 수/수집 시각 (운영 검증용).
 *
 * 인증: /api/health?depth=full 과 동일하게 열려 있다 (cron 워커가 시크릿 없이
 * 호출). 상태를 바꾸지 않는 idempotent 수집이며 DO 의 min-interval 스로틀 +
 * in-flight coalescing 이 남용을 제한한다.
 */
import { Hono, type Context } from 'hono'
import { logger, toError } from '../lib/logger'
import { cors } from 'hono/cors'
import type { AppBindings, ErrorResponse } from '../types'
import { getNewsHubStub } from '../lib/news-hub-do'

const newsHubRoute = new Hono<{ Bindings: AppBindings }>()

newsHubRoute.use('/*', cors({ origin: '*' }))

function checkBinding(c: Context<{ Bindings: AppBindings }>): boolean {
  return !!c.env.NEWS_HUB_DO
}

// ============================================================
// POST /api/news-hub/refresh
// ============================================================
newsHubRoute.post('/refresh', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      {
        detail: 'News hub requires NEWS_HUB_DO Durable Object binding (script_name: ssak-do-worker, class: NewsHubDO).',
        code: 'binding_missing',
      },
      501,
    )
  }
  const start = Date.now()
  try {
    const stub = getNewsHubStub(c.env)
    const res = await stub.fetch('http://news-hub-do/refresh', { method: 'POST' })
    const body = (await res.json()) as Record<string, unknown>
    logger.info('[news-hub-route] refresh', {
      ok: body.ok,
      articles: body.articleCount ?? 0,
      outlets: body.outletCount ?? 0,
      latency_ms: Date.now() - start,
    })
    return res.ok ? c.json(body) : c.json(body, 502)
  } catch (err) {
    logger.error('[news-hub-route] refresh failed', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'News hub refresh failed', code: 'refresh_failed' }, 502)
  }
})

// ============================================================
// GET /api/news-hub/status
// ============================================================
newsHubRoute.get('/status', async (c) => {
  if (!checkBinding(c)) {
    return c.json<ErrorResponse>(
      {
        detail: 'News hub requires NEWS_HUB_DO Durable Object binding (script_name: ssak-do-worker, class: NewsHubDO).',
        code: 'binding_missing',
      },
      501,
    )
  }
  try {
    const stub = getNewsHubStub(c.env)
    const res = await stub.fetch('http://news-hub-do/status')
    const body = (await res.json()) as Record<string, unknown>
    return res.ok ? c.json(body) : c.json(body, 502)
  } catch (err) {
    logger.error('[news-hub-route] status failed', { error: toError(err) })
    return c.json<ErrorResponse>({ detail: 'News hub status failed', code: 'status_failed' }, 502)
  }
})

export { newsHubRoute }
