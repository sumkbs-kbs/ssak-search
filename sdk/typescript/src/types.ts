/**
 * SDK types — aligned with openapi.yaml component schemas.
 * The spec-consistency test (tests/unit/sdk-spec-consistency.test.ts) verifies
 * that the parameter surface in spec.ts matches openapi.yaml exactly.
 */

// ── Search ─────────────────────────────────────────────────────────────────

/** POST /api/search body — SearchRequest schema. */
export interface SearchRequest {
  query: string
  search_depth?: 'basic' | 'advanced'
  topic?: 'general' | 'news' | 'finance'
  max_results?: number
  include_answer?: boolean
  include_raw_content?: boolean
  include_fact_check?: boolean
  include_domains?: string[]
  exclude_domains?: string[]
  time_range?: 'day' | 'week' | 'month' | 'year'
  sort_by?: 'relevance' | 'date'
  page?: number
  focus?: 'all' | 'academic' | 'news' | 'writing' | 'video' | 'social' | 'finance' | 'math'
  country?: string
  language?: string
  location?: string
  user_id?: string
  max_tokens?: number
}

/** GET /api/search query parameters — includes spec aliases (q, limit, answer). */
export interface SearchGetParams {
  query?: string
  /** Alias for query. */
  q?: string
  max_results?: number
  /** Alias for max_results. */
  limit?: number
  search_depth?: 'basic' | 'advanced'
  topic?: 'general' | 'news' | 'finance'
  include_answer?: boolean
  /** Alias for include_answer. */
  answer?: boolean
  include_raw_content?: boolean
  include_fact_check?: boolean
  time_range?: 'day' | 'week' | 'month' | 'year'
  sort_by?: 'relevance' | 'date'
  page?: number
  focus?: 'all' | 'academic' | 'news' | 'writing' | 'video' | 'social' | 'finance' | 'math'
  include_domains?: string[]
  exclude_domains?: string[]
  country?: string
  language?: string
  location?: string
}

export interface SearchAnswer {
  answer?: string
  query?: string
  response_time_ms?: number
}

export interface ImageResult {
  url?: string
  title?: string
  source?: string
}

export interface SearchResult {
  title: string
  url: string
  content: string
  score?: number
  raw_content?: string | null
  published_date?: string | null
  author?: string | null
  domain: string
  images?: string[]
  stock_data?: Record<string, unknown> | null
}

export interface SearchResponse {
  query?: string
  answer?: SearchAnswer
  results?: SearchResult[]
  response_time_ms?: number
  backend?: string
  fallback_used?: boolean
  related_queries?: string[]
  cached?: boolean
  page?: number
  page_size?: number
  total_results?: number
  total_pages?: number
  images?: ImageResult[]
  knowledge_graph?: Record<string, unknown>
  subrequest_estimate?: number
}

// ── Extract ────────────────────────────────────────────────────────────────

/** POST /api/extract body — ExtractRequest schema. */
export interface ExtractRequest {
  urls: string | string[]
  include_images?: boolean
  max_tokens?: number
}

/** GET /api/extract query parameters. */
export interface ExtractGetParams {
  urls: string[]
  include_images?: boolean
}

export interface ExtractedContent {
  url: string
  title?: string
  raw_content?: string
  images?: string[]
  rich_snippet?: Record<string, unknown>
  success?: boolean
  error?: string
}

export interface ExtractResponse {
  results?: ExtractedContent[]
  failed_results?: ExtractedContent[]
  response_time_ms?: number
}

// ── Health ─────────────────────────────────────────────────────────────────

export interface HealthBackend {
  status?: string
  latency_ms?: number
  circuit?: Record<string, unknown>
}

export interface HealthResponse {
  status: 'ok' | 'degraded' | 'partial_outage'
  version?: string
  timestamp?: string
  backends?: Record<string, HealthBackend>
  features?: Record<string, boolean>
  auth_required?: boolean
  index?: Record<string, unknown>
  rate_limiter?: {
    mode?: 'durable_object' | 'in_memory_fallback'
    source?: 'local' | 'durable'
    hosts_tracked?: number
  }
  cached?: boolean
}

// ── Errors ─────────────────────────────────────────────────────────────────

/** ErrorResponse schema. */
export interface ErrorResponse {
  detail: string
  code?: string
}
