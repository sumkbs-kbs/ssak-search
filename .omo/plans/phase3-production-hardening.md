# Phase 3: Production Hardening — Work Plan

## TL;DR (For humans)

**What you'll get:** 6 sequential production-hardening upgrades: (1) multi-tenant API key system with per-tenant rate limits, (2) official TypeScript + Python SDK packages, (3) SSE streaming UX for real-time answer delivery, (4) automated evaluation harness for search quality regression detection, (5) auto-routing between Fast and Pro search pipelines based on query complexity, (6) per-request cost tracking with usage API endpoint.

**Why this approach:** Sequential delivery lets each feature stabilize before the next depends on it. Each task is self-contained with its own verification gates.

**What it will NOT do:** No UI redesigns. No infrastructure-as-code deployment scripts. No LangChain/LlamaIndex integration (scoped to raw SDK wrappers). No billing system.

**Effort:** XL
**Risk:** Medium — SDK packaging and eval harness are novel additions; multi-tenancy touches auth which is security-sensitive
**Decisions to sanity-check:** Tenant config format (JSON secret vs per-key env vars); SDK monorepo structure (separate repo vs packages/ dir); eval harness scoring methodology

---

> TL;DR (machine): 6 sequential Phase 3 hardening tasks: multi-tenancy → SDK → streaming UX → eval harness → auto routing → cost tracking.

## Scope
### Must have
- Multi-tenant API key validation with per-tenant rate limits (JSON-based tenant registry)
- TypeScript SDK (npm package) + Python SDK (PyPI package) wrappers
- SSE streaming endpoint for real-time answer delivery
- Automated eval harness (BLEU/ROUGE-based) with regression comparison
- Auto Pro/Fast routing via query complexity classifier
- Per-request cost tracking with `/api/usage` endpoint
- All tasks: typecheck + build + test gates

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No billing/payment integration
- No UI redesign or dashboard features beyond existing `/` and `/docs`
- No LangChain/LlamaIndex integration (raw HTTP SDK only)
- No multi-region deployment config
- No breaking changes to existing `/api/search` response shape

## Verification strategy
- Test decision: tests-after per task + TDD for auth changes
- Evidence: `npm run typecheck` (0 errors), `npm test` (112+ pass), build passes
- QA: curl against dev server for HTTP endpoints

## Todos

### Wave 1: Multi-tenancy
- [ ] 1. Add `TENANTS_CONFIG` secret support to `src/lib/auth.ts`
  What to do: Parse JSON from `TENANTS_CONFIG` env var (`[{ "id": "tenant-1", "name": "Acme", "apiKey": "sk-...", "rateLimitPerMinute": 60, "plan": "pro" }]`). Fall back to `SEARCH_API_KEY` as default tenant for backward compatibility. Replace `validateApiKey()` to check against all tenant keys, return `{ valid, tenantId, tenant }`.
  Must NOT do: No database dependency — tenants live in a JSON secret. No admin panel.
  References: `src/lib/auth.ts:36-61`, `src/types.ts:248-272`
  Acceptance criteria: `npm run typecheck` passes, existing auth tests pass with both old and new config formats.
  QA: `curl -H "Authorization: Bearer <tenant-key>"` returns 200, bad key returns 401.
  Commit: N | `feat(auth): multi-tenant API key validation`

- [ ] 2. Add per-tenant rate limiting to `src/lib/auth.ts`
  What to do: `checkClientRateLimit()` accepts optional `tenantId` and applies per-tenant rate limit (from tenant config) instead of global 30/min. Maintain per-tenant + per-IP rate limit buckets. Eviction logic respects tenant isolation.
  Must NOT do: No Durable Object dependency for rate limit state (keep per-isolate best-effort).
  References: `src/lib/auth.ts:67-97`
  Acceptance criteria: `npm run typecheck` passes, rate limit tests cover per-tenant + per-IP.
  QA: Send 31 requests with same tenant key → 429 on #31. Different tenant → separate counter.
  Commit: N | `feat(auth): per-tenant rate limiting`

- [ ] 3. Add tenant context to audit logging + response headers
  What to do: Pass `tenantId` through middleware chain. Add `X-Tenant-Id` response header. Include tenant info in audit log entries (`audit.ts` already accepts `context` object). Add `X-Tenant-Plan` header.
  Must NOT do: No tenant info in search response body (backward compatible).
  References: `src/routes/search.ts:33-75`, `src/lib/audit.ts`
  Acceptance criteria: Response includes `X-Tenant-Id` header. Audit entries include tenant context.
  QA: `curl -v -H "Authorization: Bearer <key>"` → inspect response headers.
  Commit: N | `feat(auth): tenant context in audit logs and response headers`

- [ ] 4. Wire TENANTS_CONFIG into wrangler.jsonc docs + AppBindings
  What to do: Add `TENANTS_CONFIG?: string` to `AppBindings` in types.ts. Update wrangler.jsonc comments/docs for the new secret. Update README.md with tenant setup instructions.
  Must NOT do: No hard dependency — SEARCH_API_KEY still works standalone.
  References: `src/types.ts:248-272`, `wrangler.jsonc`
  Acceptance criteria: Types include TENANTS_CONFIG. No typecheck errors.
  Commit: N | `feat(auth): TENANTS_CONFIG binding and docs`

### Wave 2: SDK Packaging → planned after Wave 1 complete

### Wave 3: Streaming UX → planned after Wave 2

### Wave 4: Eval Harness → planned after Wave 3

### Wave 5: Auto routing → planned after Wave 4

### Wave 6: Cost tracking → planned after Wave 5

## Final verification wave
- [ ] F1. Full typecheck pass (0 errors)
- [ ] F2. Full unit test pass (112+)
- [ ] F3. Integration test pass (20/22 pre-existing)
- [ ] F4. Manual curl QA of multi-tenant auth

## Commit strategy
One commit per todo, squash at wave boundary if requested.

## Success criteria
- Multi-tenant auth: multiple API keys, each with per-tenant rate limits, tenant context in audit/headers
- Backward compatible: existing `SEARCH_API_KEY` still works as default tenant
- All typecheck + unit tests pass
