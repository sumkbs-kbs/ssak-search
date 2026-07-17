/**
 * Tavily-compatible Search Engine API - Type Definitions
 */

// ============================================================
// Search Types
// ============================================================

export type SearchDepth = 'basic' | 'advanced'
export type Topic = 'general' | 'news' | 'finance'
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
}

export interface SearchAnswer {
  /** The synthesized answer text */
  text: string
  /** Confidence 0-1 */
  confidence: number
  /** Result indices that contributed to the answer */
  sources: number[]
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
  /** Image results (when available) */
  images?: ImageResult[]
  /** Knowledge panel / entity data */
  knowledge_graph?: KnowledgeGraph
}

/** Image search result */
export interface ImageResult {
  url: string
  title: string
  source: string
  width?: number
  height?: number
  thumbnail?: string
}

/** Knowledge graph / entity panel */
export interface KnowledgeGraph {
  title: string
  description: string
  url?: string
  image?: string
  type?: string // person | organization | place | concept
  facts?: Record<string, string> // e.g. { "Founded": "1969", "CEO": "John Doe" }
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
// Bindings
// ============================================================

export interface AppBindings {
  // Optional API keys (stored as Cloudflare secrets)
  JINA_API_KEY?: string
  SEARCH_API_KEY?: string
  // Workers AI binding (optional)
  AI?: Ai
}
