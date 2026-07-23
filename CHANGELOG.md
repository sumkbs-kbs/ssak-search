# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

### Fixed

### Changed

## [3.0.0] — 2026-07-22

### Phase 1: Core Stabilization & Security

#### Added
- Vitest test infrastructure with `tests/unit/` (23 files, 524 tests)
  - `cacheKey` regression tests (P0-1: page isolation, NFC normalization)
  - SSRF guard tests (`assertSafeFetchUrl`, `isPublicHostname`)
  - auth rate-limit + getClientIp tests
  - extractor SSRF rejection tests (P0-2)
  - snapshots for Wikipedia, HackerNews, GitHub, Naver, Bing, DuckDuckGo parsers
- `npm test` and `npm run typecheck` scripts; `@cloudflare/workers-types` for 0 false positives
- `vitest.config.ts` + `vitest.integration.config.ts` dual-project test configuration
- `e2e/` integration tests — `executeSearch.test.ts`, `parsers.test.ts`, `orchestrator.test.ts`, `api.test.ts`
- LICENSE (MIT), SECURITY.md (private disclosure + threat model), CONTRIBUTING.md (PR checklist)
- `package.json` metadata: `license`, `author`, `repository`, `engines.node>=20`, `description`
- Container for response: 64KB body cap on `/api/search` and `/api/extract` (P0-4)
- Domain-filter cap (`include_domains`/`exclude_domains` ≤20) enforced in `/api/search` POST (P0-4)
- Per-URL length cap (2048) and per-request URL count cap (20) for `/api/extract` (P0-4)
- `metricsRoute` Hono app mounted at `/api/metrics` for proper Prometheus path (P0-3)
- `/api` root endpoint listing all available API endpoints
- Structured audit logging (`src/lib/audit.ts`) — security events with `audit: 'true'` flag
- Logger module (`src/lib/logger.ts`) — structured JSON logging with context enrichment
- Rich snippets extraction (`src/lib/rich-snippets.ts`) — schema.org/JSON-LD/Microdata parsing
- Input size enforcement middleware — body 64KB, domain arrays 20, extract URLs 20, page 1-10

#### Fixed
- **P0-1 (critical)**: `cacheKey()` now includes `page` — pagination cache isolation
- **P0-2 (critical)**: `assertSafeFetchUrl()` SSRF guard — private IPs, metadata endpoints, credentials-in-URL
- **P0-3 (critical)**: `/api/metrics` routing — dedicated metricsRoute at `/api/metrics`
- **P1-1**: TypeScript strict `PromiseSettledResult.value` narrowing in orchestrator
- **P1-2**: `fetchWithTimeout` circuit breaker bypass — both paths throw 503
- **P1-4**: Adaptive threshold floor at `min(10, max_results)` — spam tier-3 gating
- **P1-5**: `sort_by=date` score blend — date-weight + relevance score combined
- **P1-6**: Korean NFC/NFD normalization + ZWSP/NBSP/BOM stripping in cacheKey

#### Security
- SECURITY.md with threat model and private disclosure path
- All input-validation routes enforce explicit size caps (P0-4)
- Audit logging for auth failures, SSRF attempts, rate limit overages
- CSP compliance — HSTS, X-Content-Type-Options, X-Frame-Options, X-XSS-Protection headers

### Phase 2: Advanced Features & New Backends

#### Agentic Search Engine (`src/lib/agentic/`)
- **Planner** (`planner.ts`): LLM-based query decomposition into sub-query plans with JSON schema
- **Executor** (`executor.ts`): Sequential step runner with context passing between steps
- **Search Tools** (`search-tools.ts`): Agentic primitives — `searchWeb()`, `fetchUrl()`, `compute()`, `filterEvidence()`, `rerankResults()`, `assemblePrompt()`
- **Synthesizer** (`synthesizer.ts`): Constrained generation with pre-embedded citation markers
- **Classifier** (`classifier.ts`): Query complexity classifier for Pro/Fast auto-routing
- **Quality Gate** (`quality-gate.ts`): Evidence quality evaluation with fail-fast re-query
- **Index** (`index.ts`): Main pipeline orchestrator with Pro (deep research) / Fast (simple) routing

#### New Search Backends
- **Free Image Search** (`free-image-search.ts`): Multi-source image search (Flickr, Unsplash, Bing)
- **Google Scholar** (`google-scholar.ts`): Academic paper search via Google Scholar scraping
- **SearXNG** (`searxng-search.ts`): Self-hosted SearXNG integration with configurable URL
- **Yahoo Finance** (`yahoo-finance-search.ts`): Real-time stock data, financial news, chart data
- **YouTube Search** (`youtube-search.ts`): Video search and transcript extraction
- **Product Search** (`product-search.ts`): E-commerce price comparison and product discovery

#### Index Pipeline (`src/lib/index/`)
- **Chunker** (`chunker.ts`): Semantic HTML-to-chunks segmentation (heading-aware)
- **Embedding** (`embedding.ts`): Custom embedding API integration with configurable endpoint
- **Scheduler** (`scheduler.ts`): ML-driven refresh scheduler for URL importance × update frequency
- **Pipeline** (`pipeline.ts`): Incremental indexing pipeline with Queues + Workers + Vectorize
- **Types** (`types.ts`): Index schema — documents, chunks, embeddings metadata
- D1 database schema (`schema.sql`) — index metadata, URL importance, refresh schedule

#### Durable Objects (Stateful Storage)
- **ThreadDO** (`thread-do.ts`): Conversational thread persistence with message history
- **PagesDO** (`pages-do.ts`): Research report/pages storage with versioning
- **LibraryDO** (`library-do.ts`): Search collections, bookmarks, saved queries
- **UserProfileDO** (`user-profile-do.ts`): User profiles, domain visit history, preferences
- **SpaceDO** (`space-do.ts`): Workspace/collaboration spaces with member management
- **RateLimiterDO** (`rate-limiter-do.ts`): Cross-isolate rate limiting and circuit breaker

#### New API Routes
- **Chat** (`/api/chat`): Multi-turn conversational search with thread management
- **Council** (`/api/council`): Multi-model comparison (OpenAI, Anthropic, Workers AI)
- **Images** (`/api/images`): Image search with multi-source aggregation
- **News** (`/api/news`): News search with trending endpoint (`/api/news/trending`)
- **Research** (`/api/research`): Multi-step deep research with configurable depth
- **Spaces** (`/api/spaces`): Collaborative workspace management
- **Pages** (`/api/pages`): Research report CRUD operations
- **Library** (`/api/library`): Saved searches and collections management
- **Profile** (`/api/profile`): User profile and preferences
- **Suggest** (`/api/suggest`): Search autocomplete suggestions (DDG → Bing fallback)
- **Usage** (`/api/usage`): Per-user API usage tracking and quotas
- **Upload** (`/api/upload`): File upload to R2 storage
- **Video** (`/api/video`): YouTube search and transcript retrieval
- **Products** (`/api/products`): E-commerce product search and price comparison
- **Canary** (`/api/canary`): Parser regression detection with real search queries
- **OpenAI Compatible** (`/api/openai`): `/v1/chat/completions` with function calling support
- **Analytics Proxy** (`/api/analytics-proxy`): Grafana Simple JSON datasource for Workers Analytics Engine

#### Frontend Pages
- **Chat UI** (`src/pages/chat.ts`): Full conversational search interface with SSE streaming
- **Dashboard** (`src/pages/dashboard.ts`): API usage dashboard with real-time metrics
- **Docs** (`src/pages/docs.ts`): Interactive API documentation with Scalar
- **Status** (`src/pages/status.ts`): Service status and backend health visualization
- **Page View** (`src/pages/page-view.ts`): Research report viewer with citation display

### Phase 3: Production Hardening & Operations

#### Monitoring & Observability
- **Metrics module** (`src/lib/metrics.ts`): Comprehensive Prometheus metrics — requests, errors, latency, cache hit rate, circuit breaker state, persistence gauge
- **Workers Analytics Engine** integration: Cross-isolate persistent metrics via `ANALYTICS` binding
- **Grafana Dashboard** (`grafana/dashboard.json`): 25-panel dashboard with backend status, latency heatmaps, SLO tracking, cache performance
- **Grafana Alert Rules** (`grafana/alerts.yml`): 14 Prometheus alerting rules for SLO breaches
- **Grafana Scrape Config** (`grafana/prometheus.yml`): Prometheus scraping configuration
- **Datadog Dashboard** (`datadog/dashboard.json`): Datadog dashboard with 12 widgets — backend latency, error rates, cache hit rate, circuit breaker status
- **Datadog Monitors**: SSRF attempts, auth failures, rate limit overage alerts
- **Logpush Integration** (`scripts/create-logpush-datadog.sh`): Cloudflare Logpush → Datadog
- **Analytics Engine Proxy** (`src/routes/analytics-proxy.ts`): Grafana Simple JSON datasource proxy
- **SLO.md**: Service Level Objectives — 99.9% availability, p50 < 3s, p99 < 15s, cache hit > 60%
- **AUDIT.md**: Audit log configuration — Logpush setup, Datadog/Splunk integration, Live Tail filters
- **MONITORING_GUIDE.md**: Complete monitoring setup guide with Grafana/Datadog integration steps

#### Rate Limiting & Circuit Breaker
- **RateLimiterDO**: Durable Object-based cross-isolate rate limiting (30 req/min per IP)
- In-memory fallback when DO binding not available (per-isolate best-effort)
- Per-host circuit breaker with automatic recovery
- X-RateLimit-* headers in all responses

#### Security Hardening
- CSP headers on all UI pages
- HSTS (Strict-Transport-Security) header
- X-Content-Type-Options, X-Frame-Options, X-XSS-Protection headers
- CORS configuration for `/api/*` endpoints
- API key authentication with Bearer token and X-API-Key header support

### Phase 4: SDK & Packages

#### TypeScript SDK (`packages/answer-sdk-ts/`)
- `HermesAnswerClient` — typed streaming and non-streaming chat client
- SSE streaming support with `streamChat()`
- Full TypeScript types for request/response schemas
- Bun-compatible package configuration

#### Python SDK (`packages/answer-sdk-py/`)
- `AnswerClient` — async HTTP client for chat and search
- SSE streaming with `sse-starlette` parser
- Type-annotated dataclasses for request/response
- Poetry/pyproject.toml package management

#### Hermes Search SDK (`packages/hermes-search/`)
- `HermesSearch` — full-featured Tavily-compatible client
  - `search()` / `search_async()` — typed dataclass search
  - `search_dict()` / `search_async_dict()` — Tavily-compatible raw dict interface
  - `extract()` — URL content extraction
  - `chat_async()` — multi-turn conversation
  - `health()` / `health_async()` — backend health check
  - `stream_search_async()` — SSE streaming search
- `HermesAgentTools` — OpenAI function-calling tool definitions for agent integration
- Comprehensive README with Tavily compatibility table
- Focus modes: general, news, academic, image, video, social, shopping, financial

### Phase 5: Documentation

#### Comprehensive Documentation Set
- **README.md**: Complete project documentation — architecture, API reference, deployment guide, Korean search optimization, production setup
- **ANALYSIS_REPORT.md**: 83-item commercial gap analysis with ICE-scored roadmap
- **COMPLETENESS_ANALYSIS_V2.md**: Perplexity-level completeness analysis with phased redesign plan
- **STRATEGIC_CHECKLIST.md**: Strategic plan to surpass Perplexity — phased execution checklist
- **DEPLOYMENT_CHECKLIST.md**: 11-section production deployment checklist (pre-flight → deploy → post-flight → incident response)
- **HERMES_INTEGRATION.md**: 3-method Hermes Agent integration guide (Tavily HTTP, OpenAI Compatible, Python SDK)
- **MONITORING_GUIDE.md**: Grafana and Datadog monitoring setup guide
- **AUDIT.md**: Audit log configuration with Logpush, Datadog/Splunk/Grafana integration
- **SLO.md**: Service Level Objectives with alerting rules and dashboard panels
- **CONTRIBUTING.md**: PR checklist, code style guide, development workflow
- **SECURITY.md**: Threat model, vulnerability disclosure, security best practices
- **OpenAPI Spec** (`openapi.yaml`): Full OpenAPI 3.0 specification covering all API endpoints
- **CHANGELOG.md**: Complete version history following Keep a Changelog format

### Phase 6: Additional Features

#### UX & Frontend
- PWA support with `manifest.json` — installable web app
- Service worker registration for offline capability
- Responsive CSS with Tailwind CDN + custom utility classes
- SSE streaming UI for real-time search results
- Interactive API documentation with Scalar UI
- Status page with backend health visualization

#### Council (Multi-Model Comparison)
- `/api/council` — compare responses from OpenAI, Anthropic, and Workers AI side-by-side
- Model-specific prompt engineering for each provider
- Structured response comparison with latency tracking

#### YouTube Transcript
- `/api/video` — YouTube search + transcript extraction
- Transcript caching for repeated queries
- Multi-language transcript support

### Phase 7: Deployment & Operations

#### CI/CD Pipeline
- `.github/workflows/ci.yml` — typecheck + test + build on PR/push
- `.github/workflows/deploy.yml` — Pages deployment with CI artifact reuse
- `.github/workflows/monitor.yml` — 15-min health check with Slack alerts
- `.github/dependabot.yml` — automated dependency updates

#### Infrastructure
- `wrangler.jsonc` — complete Cloudflare configuration with all DO bindings
- `ecosystem.config.cjs` — PM2 process management for local development
- `vite.config.ts` — optimized build configuration with code splitting
- `tsconfig.json` — strict TypeScript configuration

#### Testing
- 84 → 524 unit tests across 23 test files
- Integration tests for parsers, orchestrator, executeSearch
- K6 load test script (`tests/k6/load-test.js`)
- Snapshot-based parser regression testing
- Coverage reports with `@vitest/coverage-v8`

### Known Limitations (v3.0.0)
- `RATE_LIMITER` DO binding optional — in-memory fallback without Dashboard binding
- Analytics Engine binding optional — metrics reset on isolate cold start without `ANALYTICS` binding
- HTML scraping depends on Bing/Naver/DDG DOM stability — parsers regress silently
- Per-isolate rate limiting without DO — cross-isolate accuracy requires DO binding
- `/api/health` unauthenticated by design
- Subrequest quota: ~27/request → ~2 concurrent users on free plan
- Python/TS SDKs not yet published to PyPI/npm

## [2.0.0] — 2026-07-18

### Added (prior baseline, documented retroactively)
- Naver mobile search backend (Korean PRIMARY, no API key)
- Bing mobile + image + news search with mkt=zh-CN for CJK queries
- DuckDuckGo HTML/Lite fallback with 202 anti-bot fail-fast
- Wikipedia / GitHub / HackerNews / Reddit / arXiv specialized sources
- Jina AI Reader content extraction (optional, works without key)
- Cloudflare HTMLRewriter-based fallback extractor
- Optional Workers AI answer generation with inline citations
- Knowledge Graph (Wikipedia REST summary) for factual/general queries
- Image search vertical via Bing `iusc m=` JSON parsing
- Per-host circuit breaker (`src/lib/rate-limiter.ts`)
- Optional API key auth + per-IP rate limit (`src/lib/auth.ts`)
- 30-second cached `/api/health` to prevent self-DoS
- Adaptive 3-tier minimum quality threshold (0.10 → 0.05 → 0.01)
- CJK bigram matching + cross-language penalty
- Unicode property escapes in dedup normalization

### Known limitations (carried into 2.x)
- Per-isolate rate limiting — high-traffic deployments should add KV or DO.
- HTML scraping depends on Bing/Naver DOM staying stable — parsers regress
  silently. (Mitigations in this release: unit tests, health probes.)
- `/api/health` is unauthenticated by design; gate behind an edge firewall
  if you need to hide operational metadata.
