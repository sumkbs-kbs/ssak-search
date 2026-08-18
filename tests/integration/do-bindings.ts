/**
 * Shared Durable Object test-runtime configuration (P2 ④ 복구, 2026-08-13).
 *
 * Both vitest configs (vitest.config.ts, vitest.integration.config.ts) load
 * wrangler.jsonc, which binds every DO via script_name="ssak-do-worker" (the
 * separate DO host worker deployed from wrangler.do.jsonc — Cloudflare Pages
 * cannot create DOs itself). The vitest-pool-workers runtime cannot load that
 * cross-worker topology:
 *
 *   1. script_name bindings fail at startup unless the ssak-do-worker service
 *      is defined (ERR_RUNTIME_FAILURE "no such service is defined").
 *   2. Registering the real do-worker as an auxiliary module worker fails
 *      with ERR_MODULE_PARSE — miniflare's module locator parses with acorn
 *      (JS only) and src/do-worker/index.ts is TypeScript.
 *
 * Resolution: override EVERY script_name designator with a self-referencing
 * designator ({ className }, no scriptName). The pool resolves self
 * designators from the MAIN worker's exports, and src/index.tsx still
 * re-exports all 11 DO classes (inert in production Pages, but the test
 * runtime uses them directly). Keep this list in sync with wrangler.jsonc /
 * wrangler.do.jsonc.
 */
export const DO_BINDINGS = {
  RATE_LIMITER: 'RateLimiterDO',
  THREAD_DO: 'ThreadDO',
  PAGES_DO: 'PagesDO',
  LIBRARY_DO: 'LibraryDO',
  USER_PROFILE_DO: 'UserProfileDO',
  SPACE_DO: 'SpaceDO',
  API_KEY_DO: 'ApiKeyDO',
  CRAWLER_DO: 'CrawlerDO',
  CLICK_LOG_DO: 'ClickLogDO',
  EXPERIMENT_DO: 'ExperimentDO',
  CANARY_DO: 'CanaryOrchestratorDO',
} as const

/** Class names for the SQLite-backed DO migration declaration. */
export const DO_CLASS_NAMES = Object.values(DO_BINDINGS)

/** Miniflare fragment shared by both vitest configs. */
export const DO_MINIFLARE_FRAGMENT = {
  durableObjects: { ...DO_BINDINGS },
  // The DO classes are SQLite-backed (wrangler.do.jsonc uses
  // new_sqlite_classes) — workerd needs the migration declared in the SELF
  // worker to materialize the env.* namespace bindings.
  migrations: [{ tag: 'v1', new_sqlite_classes: DO_CLASS_NAMES }],
} as const
