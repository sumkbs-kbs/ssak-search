// ============================================================
// Request Types
// ============================================================

export type SearchDepth = 'basic' | 'advanced'
export type Topic = 'general' | 'news' | 'finance'
export type TimeRange = 'day' | 'week' | 'month' | 'year'
export type SortBy = 'relevance' | 'date'

export interface SearchRequest {
  query: string
  search_depth?: SearchDepth
  topic?: Topic
  max_results?: number
  include_answer?: boolean
  include_raw_content?: boolean
  include_domains?: string[]
  exclude_domains?: string[]
  time_range?: TimeRange
  sort_by?: SortBy
  max_tokens?: number
  page?: number
}

export interface ExtractRequest {
  urls: string | string[]
  include_images?: boolean
  max_tokens?: number
}

// ============================================================
// Response Types
// ============================================================

export interface SearchResult {
  title: string
  url: string
  content: string
  score: number
  raw_content?: string
  published_date?: string
  domain: string
}

export interface SearchAnswer {
  text: string
  confidence: number
  sources: number[]
}

export interface SearchResponse {
  query: string
  answer?: SearchAnswer
  results: SearchResult[]
  response_time_ms: number
  backend: string
  fallback_used: boolean
  related_queries?: string[]
  cached?: boolean
  page?: number
  total_results?: number
  total_pages?: number
  page_size?: number
  subrequest_estimate?: number
}

export interface ExtractedContent {
  url: string
  title?: string
  raw_content: string
  images?: string[]
  success: boolean
  error?: string
}

export interface ExtractResponse {
  results: ExtractedContent[]
  response_time_ms: number
  failed_results: ExtractedContent[]
}

export interface ErrorResponse {
  detail: string
  code: string
  query?: string
}

// ============================================================
// SSE Stream Types
// ============================================================

export interface StreamEventResults {
  query: string
  results: SearchResult[]
  backend: string
  related_queries?: string[]
}

export interface StreamEventToken {
  text: string
}

export interface StreamEventAnswerDone {
  confidence: number
  sources: number[]
}

export interface StreamEventDone {
  response_time_ms: number
}

export interface StreamEventError {
  detail: string
}

export type StreamEvent =
  | { event: 'results'; data: StreamEventResults }
  | { event: 'token'; data: StreamEventToken }
  | { event: 'answer_done'; data: StreamEventAnswerDone }
  | { event: 'done'; data: StreamEventDone }
  | { event: 'error'; data: StreamEventError }

// ============================================================
// Client Options
// ============================================================

export interface ClientOptions {
  /** Base URL of the Answer Engine API (default: http://localhost:8788) */
  baseUrl?: string
  /** API key for authenticated requests */
  apiKey?: string
  /** Request timeout in milliseconds (default: 30000) */
  timeout?: number
}

export const DEFAULT_BASE_URL = 'http://localhost:8788'
export const DEFAULT_TIMEOUT = 30_000
