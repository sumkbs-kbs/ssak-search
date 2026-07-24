/**
 * Tavily-compatible Search Engine API - Type Definitions
 */

// ============================================================
// Queue Message Types
// ============================================================

export type IndexQueueMessage =
  | { type: 'INDEX_URL'; payload: { url: string; title: string; html: string; options?: Record<string, unknown> } }
  | { type: 'REINDEX_URL'; payload: { url: string; force?: boolean } }
  | { type: 'DELETE_URL'; payload: { url: string } }
  | { type: 'REFRESH_SCHEDULE'; payload: { urls: string[] } }
  | { type: 'BULK_INDEX'; payload: { urls: Array<{ url: string; title: string; html: string }> } }
  | { type: 'SEED_FROM_BRAVE'; payload: { query: string; urls: string[] } }
  | { type: 'UPDATE_DOMAIN_REPUTATION'; payload: { domains: Array<{ domain: string; success: boolean; quality: number }> } }

// ============================================================
// Search Types
// ============================================================

export type SearchDepth = 'basic' | 'advanced'
export type Topic = 'general' | 'news' | 'finance'

/**
 * Focus Mode — Perplexity 스타일 검색 영역 전문화
 * - all: 모든 백엔드 (기본값)
 * - academic: Wikipedia + arXiv + 학술 소스 우선
 * - news: 최신 뉴스에 집중
 * - writing: 긴 컨텍스트 + 최소 필터 (글쓰기/아이디어 발굴)
 * - video: YouTube + 비디오 트랜스크립트
 * - social: Reddit + HackerNews + 커뮤니티
 * - finance: 주식/재무 데이터 집중
 * - math: 계산 + 수학 (WolframAlpha 유사)
 */
export type FocusMode = 'all' | 'academic' | 'news' | 'writing' | 'video' | 'social' | 'finance' | 'math'

export type TimeRange = 'day' | 'week' | 'month' | 'year' | 'any'
export type SortBy = 'relevance' | 'date'

export interface SearchRequest {
  /** The search query */
  query: string
  /** Search depth: 'basic' for fast, 'advanced' for deeper analysis */
  search_depth?: SearchDepth
  /** Topic category */
  topic?: Topic
  /** Number of results to return (1-20, default 10) */
  max_results?: number
  /** Include an AI-generated answer in the response */
  include_answer?: boolean
  /** Include the full extracted content of each result */
  include_raw_content?: boolean
  /** Include a list of query suggestions */
  include_domains?: string[]
  /** Exclude these domains from results */
  exclude_domains?: string[]
  /** Time range filter */
  time_range?: TimeRange
  /** Sort results by */
  sort_by?: SortBy
  /** Return chunks instead of full content (advanced only) */
  chunks_per_source?: number
  /** Max number of tokens to include per result content */
  max_tokens?: number
  /** Page number for pagination (1-based, default 1) */
  page?: number
  /** Country code for localized results (ISO 3166-1 alpha-2, e.g. 'US', 'KR', 'CN') */
  country?: string
  /** Search language (BCP 47, e.g. 'en', 'ko', 'zh-CN', 'ja') */
  language?: string
  /** Location string for geo-targeted results (e.g. 'New York, United States') */
  location?: string
  /** Focus mode: specialize search for a specific domain (default 'all') */
  focus?: FocusMode
  /** User ID for personalized ranking (domain boosting, Phase 3.2b) */
  user_id?: string
  /** Space ID for workspace context injection (Phase 3.3b) */
  space_id?: string
}

export interface SearchResultContent {
  /** Cleaned markdown content */
  text?: string
  /** Raw HTML content */
  raw_html?: string
}

export interface SearchResult {
  /** Result title */
  title: string
  /** Result URL */
  url: string
  /** Content snippet / summary */
  content: string
  /** Score 0-1 (higher = more relevant) */
  score: number
  /** Full extracted content (when include_raw_content=true) */
  raw_content?: string
  /** Published date if available (ISO 8601) */
  published_date?: string
  /** Author if available */
  author?: string
  /** Source domain */
  domain: string
  /** Images found on the page */
  images?: string[]
  /** Structured stock/financial data (when available from Naver Finance) */
  stock_data?: StockData
  /** Rich snippet (rating, price, FAQ, etc.) */
  rich_snippet?: RichSnippet
}

/** Rich snippet / structured metadata */
export interface RichSnippet {
  type: 'rating' | 'price' | 'faq' | 'article' | 'breadcrumb'
  /** For 'rating': star rating 1-5 */
  rating?: number
  /** For 'rating': number of reviews */
  review_count?: number
  /** For 'price': formatted price string */
  price?: string
  /** For 'article': author name */
  author?: string
  /** For 'article': reading time in minutes */
  reading_time_min?: number
}

/** Structured stock/financial data for search results */
export interface StockData {
  /** Stock name (e.g. "한화에어로스페이스") */
  name: string
  /** Ticker symbol (e.g. "012450") */
  ticker: string
  /** Exchange (e.g. "KOSPI", "KOSDAQ") */
  exchange: string
  /** Current price (raw number, e.g. 943000) */
  price: number
  /** Currency (e.g. "KRW") */
  currency: string
  /** Change amount (positive = up, negative = down) */
  change: number
  /** Change percentage (e.g. 1.51 for +1.51%) */
  change_percent: number
  /** Change direction */
  direction: 'up' | 'down' | 'flat'
  /** Trading volume (number of shares) */
  volume?: number
  /** Market capitalization */
  marketCap?: number
  /** Today's high price */
  high_price?: number
  /** Today's low price */
  low_price?: number
  /** Today's open price */
  open_price?: number
  /** Previous close price */
  prev_close?: number
  /** Market status (open/closed) */
  market_status?: 'open' | 'closed'
}

export interface SearchAnswerSource {
  /** Index into the results array (0-based) */
  index: number
  /** Source URL (if available) */
  url?: string
  /** Source title (if available) */
  title?: string
  /** Snippet from the source (if available) */
  snippet?: string
}

export interface SearchAnswer {
  /** The synthesized answer text */
  text: string
  /** Confidence 0-1 */
  confidence: number
  /** Result indices that contributed to the answer.
   *  - `number[]`: backward-compatible index-only (legacy)
   *  - `SearchAnswerSource[]`: rich citations with URL/title/snippet (Pro mode)
   *  Consumers should handle both forms. */
  sources: number[] | SearchAnswerSource[]
}

export interface SearchResponse {
  /** The original query */
  query: string
  /** AI-generated answer (when include_answer=true) */
  answer?: SearchAnswer
  /** List of search results */
  results: SearchResult[]
  /** Query response time in ms */
  response_time_ms: number
  /** Which backend produced these results */
  backend: string
  /** Whether the request fell back to a secondary backend */
  fallback_used: boolean
  /** Suggested related queries */
  related_queries?: string[]
  /** Whether this response was served from cache */
  cached?: boolean
  /** Current page number (1-based) */
  page?: number
  /** Total results found (before pagination) */
  total_results?: number
  /** Total number of pages (ceil(total_results / max_results)) */
  total_pages?: number
  /** Number of results requested per page */
  page_size?: number
  /** Image results (when available) */
  images?: ImageResult[]
  /** Knowledge panel / entity data */
  knowledge_graph?: KnowledgeGraph
  /** Estimated number of subrequests made (for quota monitoring) */
  subrequest_estimate?: number
  /**
   * True when the orchestrator ran to completion but produced zero usable
   * results (every backend failed and all fallbacks exhausted). Sent so
   * agents/clients can distinguish a genuine "no results" from a transient
   * server error or empty body. Mirrors the Tavily convention.
   */
  no_results?: boolean
}

/** Image search result */
export interface ImageResult {
  url: string
  title: string
  source: string
  width?: number
  height?: number
  thumbnail?: string
  /** Content description/snippet */
  content?: string
  /** Relevance score 0-1 */
  score?: number
  /** Source domain */
  domain?: string
}

/** Knowledge graph / entity panel */
export interface KnowledgeGraph {
  title: string
  description: string
  url?: string
  image?: string
  type?: string // person | organization | place | concept | technology | product
  facts?: Record<string, string> // e.g. { "Founded": "1969", "CEO": "John Doe" }
  /** Related entities / topics for navigation */
  related_entities?: Array<{ name: string; type?: string; url?: string }>
  /** Source of the knowledge panel data */
  source?: 'wikipedia' | 'wikidata' | 'search_results' | 'hybrid'
}

// ============================================================
// Extract Types
// ============================================================

export interface ExtractRequest {
  /** Single URL or multiple URLs */
  urls: string | string[]
  /** Include images extracted from the page */
  include_images?: boolean
  /** Max tokens to extract per URL */
  max_tokens?: number
}

export interface ExtractedContent {
  /** The URL that was extracted */
  url: string
  /** Page title */
  title?: string
  /** Extracted markdown content */
  raw_content: string
  /** Extracted images (when include_images=true) */
  images?: string[]
  /** Rich snippet data extracted from the page (rating, price, article, etc.) */
  rich_snippet?: RichSnippet
  /** Whether extraction succeeded */
  success: boolean
  /** Error message if extraction failed */
  error?: string
}

export interface ExtractResponse {
  /** Extraction results (one per URL) */
  results: ExtractedContent[]
  /** Response time in ms */
  response_time_ms: number
  /** Failed URLs */
  failed_results: ExtractedContent[]
}

// ============================================================
// Health Types
// ============================================================

export interface HealthResponse {
  status: 'ok' | 'degraded'
  version: string
  backends: Record<string, 'operational' | 'degraded' | 'down' | 'unknown' | 'disabled'>
  features?: Record<string, boolean>
  notes?: string[]
  uptime_hint: string
  auth_required: boolean
}

// ============================================================
// Error Types
// ============================================================

export interface ErrorResponse {
  detail: string
  code: string
  query?: string
}

// ============================================================
// Conversational Thread Types (Phase 1.2)
// ============================================================

export interface ThreadMessage {
  role: 'user' | 'assistant'
  content: string
  sources?: Array<{ title: string; url: string }>
  timestamp: number
}

export interface ThreadData {
  id: string
  messages: ThreadMessage[]
  created_at: number
  last_activity: number
  message_count: number
}

export interface ChatRequest {
  query: string
  thread_id?: string
  depth?: 'quick' | 'deep'
  max_sources?: number
  focus?: FocusMode
  file_ids?: string[]
}

export interface ChatResponse {
  thread_id: string
  answer: string
  sources: Array<{ title: string; url: string }>
  message_count: number
  response_time_ms: number
}

// ============================================================
// Page Types (Phase 2.1)
// ============================================================

export interface PageSource {
  title: string
  url: string
}

export interface PageData {
  id: string
  title: string
  query: string
  answer: string
  sources: PageSource[]
  sub_queries: string[]
  depth: 'quick' | 'deep'
  quality_estimate?: string
  response_time_ms?: number
  created_at: number
  updated_at: number
}

export interface CreatePageRequest {
  title: string
  query: string
  answer: string
  sources: PageSource[]
  sub_queries?: string[]
  depth?: 'quick' | 'deep'
  quality_estimate?: string
  response_time_ms?: number
}

export interface UpdatePageRequest {
  title?: string
  answer?: string
  sources?: PageSource[]
  sub_queries?: string[]
  quality_estimate?: string
}

// ============================================================
// File Upload Types (Phase 2.2)
// ============================================================

export interface UploadResponse {
  file_id: string
  filename: string
  content_type: string
  file_size: number
  summary?: string
  key_points?: string[]
  uploaded_at: number
}

export interface AnalyzeRequest {
  file_id: string
  question?: string
}

export interface AnalyzeResponse {
  file_id: string
  filename: string
  answer: string
  key_points: string[]
  word_count: number
}

// ============================================================
// Library / Collection Types (Phase 2.3)
// ============================================================

export interface LibraryItem {
  id: string
  collection_id: string
  query: string
  answer?: string
  sources?: Array<{ title: string; url: string }>
  tags?: string[]
  depth?: string
  created_at: number
}

export interface LibraryCollection {
  id: string
  name: string
  description?: string
  item_count: number
  created_at: number
  updated_at: number
}

export interface CreateCollectionRequest {
  name: string
  description?: string
}

export interface UpdateCollectionRequest {
  name?: string
  description?: string
}

export interface CreateItemRequest {
  collection_id: string
  query: string
  answer?: string
  sources?: Array<{ title: string; url: string }>
  tags?: string[]
  depth?: string
}

// ============================================================
// User Profile Types (Phase 3.2)
// ============================================================

export interface UserPreferences {
  language?: string
  focus_mode?: FocusMode
  theme?: 'light' | 'dark' | 'system'
  max_sources?: number
  exclude_domains?: string[]
}

export interface UserProfile {
  user_id: string
  preferences: UserPreferences
  recently_visited_domains: DomainVisit[]
  created_at: number
  updated_at: number
}

export interface DomainVisit {
  domain: string
  count: number
  last_visited: number
}

// ============================================================
// Bindings
// ============================================================

export interface AppBindings {
  // Optional API keys (stored as Cloudflare secrets)
  JINA_API_KEY?: string
  SEARCH_API_KEY?: string
  // Multi-tenant config (JSON array of TenantConfig, stored as secret)
  TENANTS_CONFIG?: string
  // Workers AI binding (optional)
  AI?: Ai
  // Durable Object for rate limiting
  RATE_LIMITER?: DurableObjectNamespace
  // Cache TTL configuration (seconds)
  CACHE_TTL_GENERAL?: string
  CACHE_TTL_NEWS?: string
  // Health canary check (parser regression detection)
  HEALTH_CANARY_ENABLED?: string
  // KV namespace for persistent response caching (optional, secondary to Cloudflare Cache API)
  CACHE_KV?: KVNamespace
  // Workers Analytics Engine for metrics persistence
  ANALYTICS?: AnalyticsEngineDataset
  // Vectorize index for dense vector search (Phase 2)
  VECTORIZE_INDEX?: VectorizeIndex
  // D1 database for metadata, indexing schedule, URL importance scores
  SEARCH_INDEX_DB?: D1Database
  // Queue for async indexing
  INDEX_QUEUE?: Queue<IndexQueueMessage>
  // Custom embedding endpoint (optional)
  EMBEDDING_ENDPOINT?: string
  EMBEDDING_API_KEY?: string
  // Self-hosted SearXNG instance URL (optional backend)
  SEARXNG_URL?: string
  // SearXNG API key (if required by instance)
  SEARXNG_API_KEY?: string
  // Ollama local LLM base URL (default: http://localhost:11434)
  // Set OLLAMA_BASE_URL to use a remote Ollama instance or custom port
  OLLAMA_BASE_URL?: string
  // OpenRouter API key for free LLM models (DeepSeek R1, Qwen3, Llama 4).
  // Get a free key at https://openrouter.ai/keys
  // Key benefit: external API calls don't consume Workers CPU time, so answer
  // generation works even on the free Cloudflare plan (unlike Workers AI).
  OPENROUTER_API_KEY?: string
  // Cohere Rerank API key for Cross-Encoder Reranker (Phase 1.2)
  COHERE_API_KEY?: string
  // Optional external LLM API keys for answer generation
  OPENAI_API_KEY?: string
  ANTHROPIC_API_KEY?: string
  // Opt-in flag for auto-promoting complex queries to the agentic Pro pipeline.
  // Default is OFF — Pro mode is opt-in via explicit search_depth=advanced to
  // avoid burning Workers AI / subrequest quota on the free tier. Set to "1"
  // or "true" to restore the legacy auto-promote behavior.
  ENABLE_AUTO_PRO?: string
  // Durable Object binding for conversation threads (Phase 1.2)
  THREAD_DO?: DurableObjectNamespace
  // Durable Object binding for saved pages (Phase 2.1)
  PAGES_DO?: DurableObjectNamespace
  // R2 bucket for file uploads (Phase 2.2)
  UPLOAD_BUCKET?: R2Bucket
  // Durable Object binding for library/collections (Phase 2.3)
  LIBRARY_DO?: DurableObjectNamespace
  // Durable Object binding for user profiles (Phase 3.2)
  USER_PROFILE_DO?: DurableObjectNamespace
  // Durable Object binding for spaces/projects (Phase 3.3)
  SPACE_DO?: DurableObjectNamespace
  // Durable Object for API Key management (Phase 1.2)
  API_KEY_DO?: DurableObjectNamespace
  // Durable Object for web crawling (Phase 2.1)
  CRAWLER_DO?: DurableObjectNamespace
  // Brave Search API key (Phase 0.1 — official API, ToS-safe, 50 req/s)
  BRAVE_API_KEY?: string
  // Free image search API keys (Phase 3.4b)
  FLICKR_API_KEY?: string
  UNSPLASH_ACCESS_KEY?: string
  // Cloudflare account ID for Analytics Engine SQL API
  ACCOUNT_ID?: string
  // Cloudflare API token with Account Analytics Read permissions
  ANALYTICS_API_TOKEN?: string
  // Analytics Engine dataset name (default: SEARCH_API_METRICS)
  ANALYTICS_DATASET?: string
  // Sentry DSN for error tracking and APM (Phase 0.5)
  SENTRY_DSN?: string
  // Environment name (production, staging, development)
  ENVIRONMENT?: string
  // Slack webhook URL for alerts (health check failures, eval regressions)
  SLACK_WEBHOOK?: string
}

// ============================================================
// Spaces / Projects (Phase 3.3)
// ============================================================

export interface SpaceFile {
  /** Original filename */
  name: string
  /** Uploaded file key in R2 */
  file_key: string
  /** MIME type */
  mime_type: string
  /** File size in bytes */
  size: number
  /** Upload timestamp */
  uploaded_at: number
}

export interface SpaceData {
  id: string
  user_id: string
  name: string
  description: string
  /** System instructions for AI context */
  instructions: string
  /** Focus mode override for searches in this space */
  focus_mode?: string
  /** Files uploaded to this space */
  files: SpaceFile[]
  created_at: number
  updated_at: number
}

export interface CreateSpaceRequest {
  name: string
  description?: string
  instructions?: string
  focus_mode?: string
}

export interface UpdateSpaceRequest {
  name?: string
  description?: string
  instructions?: string
  focus_mode?: string
}

// ============================================================
// Crawler Types (Phase 2.1)
// ============================================================

export interface CrawlRequest {
  /** Seed URLs to start crawling from */
  urls: string[]
  /** Maximum crawl depth (default 2) */
  max_depth?: number
  /** Maximum pages to crawl per domain (default 100) */
  max_pages_per_domain?: number
  /** Politeness delay between requests to same domain in ms (default 2000) */
  politeness_delay_ms?: number
  /** Whether to follow external links (default false — same-domain only) */
  follow_external_links?: boolean
  /** Whether to respect robots.txt (default true) */
  respect_robots_txt?: boolean
  /** Callback/notification URL when crawl completes */
  webhook_url?: string
  /** Crawl job label for identification */
  label?: string
}

export interface CrawlUrl {
  url: string
  depth: number
  source_url?: string
  priority: number
  added_at: number
}

export interface CrawlDomainState {
  domain: string
  last_crawled_at: number
  pages_crawled: number
  allowed: boolean
  robots_cached_at: number
  robots_disallows: string[]
  crawl_delay_ms: number
}

export interface CrawlStats {
  total_seeds: number
  total_urls_discovered: number
  urls_crawled: number
  urls_failed: number
  urls_skipped: number
  urls_queued: number
  domains_encountered: number
  chunks_indexed: number
  start_time: number
  last_activity: number
  estimated_completion: number
  status: 'idle' | 'running' | 'paused' | 'completed' | 'error'
}

export interface CrawlerConfig {
  max_depth: number
  max_pages_per_domain: number
  politeness_delay_ms: number
  follow_external_links: boolean
  respect_robots_txt: boolean
  max_concurrent_requests: number
  request_timeout_ms: number
  webhook_url?: string
  label?: string
}

export const DEFAULT_CRAWLER_CONFIG: CrawlerConfig = {
  max_depth: 2,
  max_pages_per_domain: 100,
  politeness_delay_ms: 2000,
  follow_external_links: false,
  respect_robots_txt: true,
  max_concurrent_requests: 3,
  request_timeout_ms: 15000,
}

export interface CrawlStatusResponse {
  crawl_id: string
  label?: string
  stats: CrawlStats
  config: CrawlerConfig
  seeds: string[]
  recent_urls: string[]
  domain_breakdown: Array<{ domain: string; crawled: number; failed: number; last_crawled: string }>
}

export interface CrawlStartResponse {
  crawl_id: string
  message: string
  seeds_added: number
}

export type Env = AppBindings
