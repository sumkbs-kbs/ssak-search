/**
 * S104-③-fix (2026-08-11): cron scheduler for the deep health probe.
 *
 * Cloudflare Pages does NOT support cron triggers (Pages compatibility matrix:
 * Cron Triggers — Workers ✅ / Pages ❌), and `wrangler pages deploy` rejects
 * `triggers` in a Pages config — so the S104-③ `triggers.crons` in
 * wrangler.jsonc both blocked deploys AND could never fire on Pages.
 *
 * This thin Workers script is the Cloudflare-recommended pattern: a Workers
 * deployment owns the cron trigger and invokes the Pages deployment's opt-in
 * `/api/health?depth=full` probe every 15 minutes. That route runs the SHARED
 * deep probe (live backend fetches + D1 corpus stats + Slack alerts) and emits
 * the `[health] deep health probe complete` structured log —
 * scripts/verify-do-binding.sh check [6] parses `down_backends` from it.
 *
 * The scheduler itself burns ~1 subrequest per tick (one fetch) — the
 * quota-burning probe logic stays in ONE place (runDeepHealthProbe in
 * src/routes/health.ts). Never throws: a failed trigger must not surface as a
 * worker error. `PROBE_URL` default matches the production Pages domain.
 */
import { logger, toError } from './lib/logger'

export interface CronProbeEnv {
  /** Base URL of the Pages worker, e.g. https://search-engine-api.pages.dev */
  PROBE_URL?: string
}

export async function scheduled(
  event: { cron?: string },
  env: CronProbeEnv,
  _ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> {
  const base = (env.PROBE_URL ?? 'https://search-engine-api.pages.dev').replace(/\/+$/, '')
  const start = Date.now()
  try {
    const res = await fetch(`${base}/api/health?depth=full`, {
      headers: { 'User-Agent': 'ssak-cron-probe/1.0' },
    })
    const latencyMs = Date.now() - start

    let probeStatus = 'unknown'
    let downBackends: string | null = null
    if (res.ok) {
      try {
        const body = (await res.json()) as {
          status?: string
          backends?: Record<string, { status?: string }>
        }
        probeStatus = body.status ?? 'unknown'
        downBackends =
          Object.entries(body.backends ?? {})
            .filter(([, b]) => b?.status === 'down')
            .map(([name]) => name)
            .join(',') || 'none'
      } catch {
        probeStatus = 'unparseable'
      }
    }

    logger.info('[cron-probe] deep health probe triggered', {
      http_status: res.status,
      probe_status: probeStatus,
      down_backends: downBackends ?? 'unknown',
      latency_ms: latencyMs,
      cron: event.cron ?? 'unknown',
      probe_url: base,
    })

    // P2-2 (2026-08-18): 뉴스 RSS 허브 주기 수집 — 같은 15분 틱에서
    // POST /api/news-hub/refresh 를 호출한다 (DO alarm 이 1차 스케줄러,
    // 이 호출은 보강 + 로그 신호). idempotent — DO 의 60초 min-interval
    // 스로틀이 중복 수집을 버린다. 실패해도 health probe 는 이미 성공했으므로
    // 이 틱을 실패로 만들지 않는다.
    try {
      const hubStart = Date.now()
      const hubRes = await fetch(`${base}/api/news-hub/refresh`, {
        method: 'POST',
        headers: { 'User-Agent': 'ssak-cron-probe/1.0' },
      })
      let hubBody: { ok?: boolean; articleCount?: number; outletCount?: number; error?: string } | null = null
      try {
        hubBody = (await hubRes.json()) as { ok?: boolean; articleCount?: number; outletCount?: number; error?: string }
      } catch {
        hubBody = null
      }
      logger.info('[cron-probe] news hub refresh triggered', {
        http_status: hubRes.status,
        ok: hubBody?.ok ?? false,
        articles: hubBody?.articleCount ?? 0,
        outlets: hubBody?.outletCount ?? 0,
        hub_error: hubBody?.error ?? null,
        latency_ms: Date.now() - hubStart,
      })
    } catch (err) {
      logger.error('[cron-probe] news hub refresh failed', { error: toError(err) })
    }
  } catch (err) {
    logger.error('[cron-probe] trigger failed', { error: toError(err), latency_ms: Date.now() - start })
  }
}

// Workers entrypoint: a bare named `scheduled` export is NOT registered as a
// handler (deploy fails with code 10021 "No event handlers were registered") —
// the default export must carry the handlers, same shape as src/index.tsx.
export default {
  scheduled,
}
