# Security Policy

## Supported Versions

Only the latest release line (`2.x`) receives security updates. Older
versions are not supported.

## Reporting a Vulnerability

**Please DO NOT file public GitHub issues for security vulnerabilities.**

Instead, email **sumkbs@gmail.com** with:

1. A precise description of the issue and its impact
2. Reproduction steps or proof-of-concept
3. Affected versions (or the `main` branch commit SHA)
4. Your suggested fix if you have one

You should receive an acknowledgment within **5 business days**. We will
work with you to validate the issue, coordinate a fix, and credit you in
the release notes (if desired) when the patch is published.

## Threat Model (high-level)

- **Server-runtime**: Cloudflare Workers (Pages). The worker runs as a
  stateless proxy that scrapes public search-engine results. No persistent
  storage is used; client IP-rate-limit state lives in isolate memory only.
- **User-supplied inputs**:
  - `query` strings up to 2,000 chars — input to upstream scrapers and the
    optional Workers AI model.
  - `urls` arrays on `/api/extract` up to 20 entries — fetched server-side.
    SSRF guard (`assertSafeFetchUrl`) rejects private/loopback/metadata IPs,
    non-http(s) schemes, and credentials-in-URL.
  - `include_domains` / `exclude_domains` arrays capped at 20 entries each.
- **Authentication**: Bearer / `X-API-Key`, **fail-closed by default** —
  without `SEARCH_API_KEY`/`TENANTS_CONFIG`/`API_KEY_DO` configured (and
  without explicit `AUTH_OPEN_MODE=1` for local development), protected
  routes answer 401. Constant-time comparison prevents trivial timing
  attacks. A single central policy table (`API_AUTH_GATED_PREFIXES` in
  `src/index.tsx`) gates every backend-driving or data-bearing route
  (search/extract/agent/research/chat/suggest/video/products/news-hub/
  spaces/pages/library/profile/canary/monitor/queue/upload); only
  `/api/health` and `/api/metrics` stay open for monitoring. CORS
  preflights (OPTIONS) pass through — they carry no credentials by design.
- **Result safety (phishing / SEO poisoning)**: every result URL passes
  `src/lib/security/phishing-guard.ts` — hostnames claiming a finance brand
  they don't own (typosquatting, `.ph.com`-style shared-suffix squatting,
  title-corroborated impersonation) are blocked from result pools at all
  three layers (main pipeline filter, agent fast path, deep research);
  softer signals (punycode hosts, URL shorteners, login paths on
  suspicious hosts) stay visible with `security_warning` attached. The
  extractor additionally flags redirect chains that land on a different
  registrable domain (cloaking signal).
- **Out-of-scope**:
  - DNS rebinding defenses (we do not perform DNS resolution; Cloudflare's
    fetch already blocks private egress in production).
  - Cross-isolate rate limiting (per-isolate memory only — for high-traffic
    deployments, move to Cloudflare KV or a Durable Object counter).

## Best-effort Commitments

- Dependency audit (`npm audit`) runs before every release; we will publish
  an advisory within **7 days** of being notified of a high-severity
  vulnerability in a direct dependency.
- Security-relevant code paths (`src/lib/auth.ts`, `src/lib/util.ts` SSRF
  guard, `src/middleware/api-auth.ts`, `src/lib/security/phishing-guard.ts`,
  `src/lib/extractor.ts` input validation) are covered by unit and workerd
  integration tests in `tests/` (auth gate pinned by
  `tests/integration/agent-auth.test.ts`, phishing screen by
  `tests/unit/phishing-guard.test.ts`). Regressions to these paths gate the
  release.

## Known Limitations

- Per-isolate rate limit (`src/lib/auth.ts`) does not provide exact
  cross-request enforcement. A determined attacker on Workers' free plan can
  exceed the published 30 req/min/IP by pinning to different isolates.
  Mitigation: place this service behind Cloudflare's own "Rate Limiting
  Rules" or migrate to a Durable Object counter for high-traffic
  deployments.
- The `/api/health` endpoint is intentionally unauthenticated so monitoring
  probes can reach it without credentials. It exposes backend hostnames and
  aggregate circuit-breaker state. If this leaks operational data you'd
  rather hide, gate it behind your edge firewall or add an `Authorization`
  check.
