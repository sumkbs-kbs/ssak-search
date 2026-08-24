/**
 * NewsHubDO — 뉴스 RSS 허브 주기 수집 Durable Object (P2-2, 2026-08-18).
 *
 * P1-7 파일럿(scripts/probe-news-rss-hub.ts)은 아웃렛 직접 RSS 수집이 gold
 * 회수를 보장함을 실측했다(파일럿 5개 아웃렛 100%). 파일럿의 수집은 프로세스
 * 내부 메모리 캐시라 프로덕션의 per-isolate 경계에서 공유되지 않는다. P2-2는
 * 이 수집을 **DO alarm 기반 주기 수집**으로 승격한다:
 *
 *   - 이 DO 가 15분마다 alarm 을 받아 아웃렛 21개 피드를 병렬 수집하고
 *     결과(약 1,000건 기사, ~240KB)를 CACHE_KV 에 쓴다 (KV 값 상한 25MB —
 *     DO storage 값 상한 128KB 를 초과하므로 KV 를 저장소로 사용).
 *   - Pages 검색 경로(all.ts news-hub 백엔드)는 KV 를 직접 읽으므로 검색
 *     요청마다 DO 라운드트립 없이 ~ms 로 기사 풀에 접근한다.
 *   - 외부 cron(ssak-probe-scheduler, wrangler.cron.jsonc)이 매 15분
 *     POST /api/news-hub/refresh 를 호출해도 같은 경로를 태운다 (이중
 *     스케줄링이지만 DO 가 60초 min-interval 로 중복 수집을 버린다).
 *
 * 제약:
 *   - CACHE_KV 미바인딩이면 수집은 되지만 저장이 안 되어 검색 경로는 빈 풀.
 *   - refresh 실패 시에도 alarm 체인을 유지해 다음 주기에 재시도한다.
 *   - DO 는 RATE_LIMITER 바인딩이 없으므로 fetchWithTimeout 은 DO 내부
 *     in-memory 회로로 동작 (Pages 검색 경로와 분리 — feed 수집이 검색
 *     회로를 오염시키지 않는다).
 */
import { DurableObject } from 'cloudflare:workers'
import { logger, toError } from './logger'
import { NEWS_HUB_OUTLETS, fetchNewsHub, type NewsHubArticle } from './news-rss-hub'
import type { Env } from '../types'

/** alarm 주기 — 15분 (외부 cron 과 동일). */
export const HUB_REFRESH_INTERVAL_MS = 15 * 60 * 1000
/** 중복 수집 방지 최소 간격 — 짧은 연타/이중 스케줄러에서 feed 를 보호. */
const HUB_MIN_REFRESH_GAP_MS = 60 * 1000
const KV_ARTICLES_KEY = 'news-hub-articles'
const KV_META_KEY = 'news-hub-meta'
/** KV TTL — alarm 주기보다 여유 있게 (20분). */
const KV_TTL_S = 20 * 60

export interface NewsHubSummary {
  ok: boolean
  fetchedAt?: number
  articleCount?: number
  outletCount?: number
  perOutlet?: Record<string, number>
  latencyMs?: number
  error?: string
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export class NewsHubDO extends DurableObject<Env> {
  /** 동시 refresh 요청 coalescing — 중복 수집 방지. */
  private refreshing: Promise<NewsHubSummary> | null = null

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'POST' && url.pathname.endsWith('/refresh')) {
      return json(await this.refresh())
    }
    if (req.method === 'GET' && url.pathname.endsWith('/articles')) {
      const articles = await this.loadArticles()
      if (!articles) return json({ ok: false, detail: 'no cached articles — run POST /refresh first' }, 404)
      return json({ ok: true, articles })
    }
    if (req.method === 'GET' && url.pathname.endsWith('/status')) {
      const meta = await this.loadMeta()
      return json({ ok: true, meta })
    }
    return json({ ok: false, detail: 'not found' }, 404)
  }

  /** DO alarm — 주기 수집의 1차 스케줄러. */
  async alarm(): Promise<void> {
    logger.info('[news-hub-do] alarm tick — periodic refresh', {})
    const summary = await this.refresh()
    logger.info('[news-hub-do] alarm refresh done', {
      ok: summary.ok,
      articles: summary.articleCount ?? 0,
      outlets: summary.outletCount ?? 0,
    })
  }

  /**
   * 수집 실행 — 동시 호출 coalescing + 60초 min-interval 스로틀.
   * 성공/실패 모두 다음 alarm 을 재장전해 주기 체인을 유지한다.
   */
  async refresh(): Promise<NewsHubSummary> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh()
    try {
      return await this.refreshing
    } finally {
      this.refreshing = null
    }
  }

  private async doRefresh(): Promise<NewsHubSummary> {
    const last = await this.ctx.storage.get<number>('lastRefreshedAt')
    if (last && Date.now() - last < HUB_MIN_REFRESH_GAP_MS) {
      const meta = await this.loadMeta()
      return { ok: true, ...(meta ?? {}), latencyMs: 0, error: 'throttled (min interval 60s)' }
    }

    const start = Date.now()
    try {
      const articles = await fetchNewsHub(this.env, { forceFresh: true })
      const perOutlet: Record<string, number> = {}
      for (const a of articles) perOutlet[a.domain] = (perOutlet[a.domain] ?? 0) + 1

      if (this.env.CACHE_KV) {
        await this.env.CACHE_KV.put(KV_ARTICLES_KEY, JSON.stringify(articles), { expirationTtl: KV_TTL_S })
        const meta = {
          fetchedAt: Date.now(),
          articleCount: articles.length,
          outletCount: Object.keys(perOutlet).length,
          perOutlet,
        }
        await this.env.CACHE_KV.put(KV_META_KEY, JSON.stringify(meta), { expirationTtl: KV_TTL_S })
      } else {
        logger.warn('[news-hub-do] CACHE_KV binding missing — articles not persisted', {})
      }

      await this.ctx.storage.put('lastRefreshedAt', Date.now())
      await this.ctx.storage.setAlarm(Date.now() + HUB_REFRESH_INTERVAL_MS).catch(() => {})

      logger.info('[news-hub-do] refresh complete', {
        articles: articles.length,
        outlets: Object.keys(perOutlet).length,
        latency_ms: Date.now() - start,
      })
      return {
        ok: true,
        fetchedAt: Date.now(),
        articleCount: articles.length,
        outletCount: Object.keys(perOutlet).length,
        perOutlet,
        latencyMs: Date.now() - start,
      }
    } catch (err) {
      logger.error('[news-hub-do] refresh failed', { error: toError(err), latency_ms: Date.now() - start })
      await this.ctx.storage.setAlarm(Date.now() + HUB_REFRESH_INTERVAL_MS).catch(() => {})
      return { ok: false, error: toError(err), latencyMs: Date.now() - start }
    }
  }

  private async loadArticles(): Promise<NewsHubArticle[] | null> {
    if (!this.env.CACHE_KV) return null
    try {
      const raw = await this.env.CACHE_KV.get<NewsHubArticle[]>(KV_ARTICLES_KEY, 'json')
      return raw && raw.length > 0 ? raw : null
    } catch (err) {
      logger.warn('[news-hub-do] KV read failed', { error: toError(err) })
      return null
    }
  }

  private async loadMeta(): Promise<Record<string, unknown> | null> {
    if (!this.env.CACHE_KV) return null
    try {
      return (await this.env.CACHE_KV.get<Record<string, unknown>>(KV_META_KEY, 'json')) ?? null
    } catch {
      return null
    }
  }
}

/** 단일 'global' 인스턴스 스텁 — 허브는 전역 하나로 충분하다. */
export function getNewsHubStub(env: Env): DurableObjectStub {
  if (!env.NEWS_HUB_DO) {
    throw new Error('NEWS_HUB_DO binding missing')
  }
  return env.NEWS_HUB_DO.get(env.NEWS_HUB_DO.idFromName('global'))
}

export const NEWS_HUB_OUTLET_COUNT = NEWS_HUB_OUTLETS.length
