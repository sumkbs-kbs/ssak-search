/**
 * Scheduled worker handler (S104-③) — deep health probe on a cron trigger.
 *
 * Cloudflare Workers/Pages invoke `scheduled(event, env, ctx)` on every cron
 * tick (wrangler.jsonc → `triggers.crons`). This is the SINGLE controlled
 * consumer of the quota-burning deep probe: it runs the live backend probes
 * + D1 corpus stats + Slack alerts on a fixed cadence, while the default
 * /api/health stays light (zero subrequests) for every external caller.
 *
 * Design:
 *   - Never throws — a probe failure must not surface as a worker error.
 *   - Reuses runDeepHealthProbe (same code path as `?depth=full`).
 *   - Logs a structured summary (status, down backends, latency, cron id).
 *   - No-op safe: without cron triggers configured, this handler never runs.
 */
import type { AppBindings } from './types'
import { logger, toError } from './lib/logger'
import { logDeepProbeComplete, runDeepHealthProbe } from './routes/health'

export interface ScheduledEvent {
  /** Cron expression string that triggered this run (Workers provides it). */
  cron?: string
}

export async function scheduled(
  event: ScheduledEvent,
  env: AppBindings,
  ctx: { waitUntil(p: Promise<unknown>): void },
): Promise<void> {
  const start = Date.now()
  try {
    const data = await runDeepHealthProbe(env, ctx)

    // S104-③-③: same structured line the ?depth=full route emits — the field
    // shape (down_backends/status/latency_ms/rate_limiter_mode/hosts_tracked)
    // lives in ONE place (buildDeepProbeSummary) so verify-do-binding.sh can
    // parse either source interchangeably.
    logDeepProbeComplete('scheduled', data, Date.now() - start, { cron: event.cron })
  } catch (err) {
    // The scheduled tick must never crash the isolate — surface and move on.
    logger.error('[scheduled] deep health probe failed', { error: toError(err), latency_ms: Date.now() - start })
  }
}
