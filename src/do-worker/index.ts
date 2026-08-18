/**
 * DO host worker — Cloudflare Pages cannot create Durable Objects within a
 * Pages project (verified 2026-08-10 P2: official docs "You cannot create and
 * deploy a Durable Object within a Pages project"; wrangler 3.x/4.x all
 * require a script_name for Pages DO bindings, and pointing script_name at the
 * Pages auto-generated worker fails with an "environment" error). The only
 * supported path is a SEPARATE Workers deployment that owns the DO classes,
 * bound from Pages via script_name.
 *
 * This entrypoint is deployed with:
 *   npx wrangler deploy --config wrangler.do.jsonc
 *
 * The Pages worker (wrangler.jsonc) then declares durable_objects.bindings
 * with script_name = "ssak-do-worker" so env.RATE_LIMITER / THREAD_DO / …
 * resolve to THIS worker's Durable Objects (cross-isolate coordination via
 * DO storage + alarms instead of the per-isolate in-memory fallback).
 *
 * NOTE: the Pages worker bundle (src/index.tsx) ALSO re-exports these classes
 * for local dev (`wrangler pages dev` resolves DOs from the entrypoint via
 * wrangler.dev.jsonc's exports map — no script_name there). Production Pages
 * cannot register them, so that copy is inert; the deployed classes live here.
 */
import { RateLimiterDO } from '../lib/rate-limiter-do'
import { ThreadDO } from '../lib/thread-do'
import { PagesDO } from '../lib/pages-do'
import { LibraryDO } from '../lib/library-do'
import { UserProfileDO } from '../lib/user-profile-do'
import { SpaceDO } from '../lib/space-do'
import { ApiKeyDO } from '../lib/api-key-do'
import { CrawlerDO } from '../lib/crawler-do'
import { ClickLogDO } from '../lib/ltr/click-logger'
import { ExperimentDO } from '../lib/experiments/ab-test'
import { CanaryOrchestratorDO } from '../lib/canary/canary-orchestrator'
import { AuditLogDO } from '../lib/durable/audit-log-do'
import { TenancyDO } from '../lib/durable/tenancy-layer'
import { NewsHubDO } from '../lib/news-hub-do'

// Durable Object classes — discovered by wrangler from this entrypoint.
// Migrations (wrangler.do.jsonc → migrations[].new_sqlite_classes) register
// them with SQLite-backed storage, matching wrangler.dev.jsonc's storage:sqlite.
export { RateLimiterDO }
export { ThreadDO }
export { PagesDO }
export { LibraryDO }
export { UserProfileDO }
export { SpaceDO }
export { ApiKeyDO }
export { CrawlerDO }
export { ClickLogDO }
export { ExperimentDO }
export { CanaryOrchestratorDO }
export { AuditLogDO }
export { TenancyDO }
export { NewsHubDO }

/**
 * Minimal fetch handler — wrangler deploy requires a default export. This
 * worker is NOT routable by design (no routes/workers_dev traffic); it exists
 * solely to host the Durable Object classes that Pages binds via script_name.
 */
export default {
  async fetch(): Promise<Response> {
    return new Response(
      JSON.stringify({ ok: true, service: 'ssak-do-worker', note: 'DO host worker — not directly routable' }),
      {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      },
    )
  },
}
