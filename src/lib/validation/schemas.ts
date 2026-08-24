/**
 * Zod schemas for external (untrusted) API inputs — the defensive validation
 * gate required by the execution principles ("모든 외부 입력은 zod 스키마로 검증").
 *
 * Every public POST route parses its JSON body through these schemas BEFORE any
 * business logic runs. The schemas preserve the legacy manual-validation
 * semantics exactly (numeric clamping, enum fallback, error-code mapping) while
 * adding strict type rejection for malformed input that the old code silently
 * coerced or let through.
 *
 * Error-code mapping mirrors the historical route contracts (missing_query,
 * query_too_long, too_many_domains, missing_urls, invalid_urls) so existing
 * clients keep working — only the validation SOURCE moves here.
 */

import { z } from 'zod'
import type { ErrorCode, FocusMode, SearchDepth, SortBy, TimeRange, Topic } from '../../types'

// ============================================================
// Shared constants & enum arrays — single source of truth for routes
// ============================================================

export const TOPICS = ['general', 'news', 'finance'] as const
export const FOCUS_MODES = ['all', 'academic', 'news', 'writing', 'video', 'social', 'finance', 'math'] as const
export const TIME_RANGES = ['day', 'week', 'month', 'year', 'any'] as const
export const SORT_BYS = ['relevance', 'date'] as const
export const SEARCH_DEPTHS = ['basic', 'advanced', 'auto'] as const

export const MAX_QUERY_LENGTH = 2000
export const MAX_DOMAIN_FILTERS = 20
export const MAX_RESULTS = 20
export const MAX_PAGE = 10
export const MAX_TOKENS = 8000
export const MAX_USER_ID_LENGTH = 200
export const MAX_EXTRACT_URLS = 20
export const MAX_URL_LENGTH = 2048
export const MAX_EXTRACT_TOKENS = 16000

// ============================================================
// SearchRequestSchema — POST /api/search body
// ============================================================

const SearchRequestSchema = z.object({
  // .trim() keeps the legacy whitespace-only rejection while normalizing the
  // stored value (normalizeQuery() downstream trims anyway).
  query: z.string().trim().min(1, 'Query is required').max(MAX_QUERY_LENGTH, 'Query too long'),
  // 'auto' is a documented value (defaults to basic unless ENABLE_AUTO_PRO).
  search_depth: z.enum(SEARCH_DEPTHS).optional(),
  // Unknown topic → 'general' (legacy fallback, not a 400).
  topic: z
    .string()
    .optional()
    .transform((v): Topic => (v && (TOPICS as readonly string[]).includes(v) ? (v as Topic) : 'general')),
  // Clamp instead of reject — legacy route clamped out-of-range values.
  max_results: z
    .number()
    .optional()
    .default(10)
    .transform((v) => Math.min(Math.max(v, 1), MAX_RESULTS)),
  include_answer: z.boolean().optional().default(false),
  include_raw_content: z.boolean().optional().default(false),
  // Truthy coercion: boolean true / string "true" (form-serialized clients).
  // String "false" correctly coerces to false (fixes the legacy Boolean("false") bug).
  include_fact_check: z
    .union([z.boolean(), z.string()])
    .optional()
    .default(false)
    .transform((v) => v === true || v === 'true'),
  include_domains: z.array(z.string()).max(MAX_DOMAIN_FILTERS).optional(),
  exclude_domains: z.array(z.string()).max(MAX_DOMAIN_FILTERS).optional(),
  // Unknown time_range → undefined (legacy fallback).
  time_range: z
    .string()
    .optional()
    .transform((v): TimeRange | undefined =>
      v && (TIME_RANGES as readonly string[]).includes(v) ? (v as TimeRange) : undefined,
    ),
  // Preserve the blend default: unknown sort_by → undefined (ranking.ts then
  // applies the relevance+freshness blend instead of pure relevance).
  sort_by: z
    .string()
    .optional()
    .transform((v): SortBy | undefined => (v === 'date' ? 'date' : v === 'relevance' ? 'relevance' : undefined)),
  max_tokens: z
    .number()
    .optional()
    .default(4000)
    .transform((v) => Math.min(v, MAX_TOKENS)),
  // Clamp into [1, 10] without rounding — mirrors the legacy route exactly.
  page: z
    .number()
    .optional()
    .default(1)
    .transform((v) => Math.min(Math.max(v, 1), MAX_PAGE)),
  country: z.string().optional(),
  language: z.string().optional(),
  location: z.string().optional(),
  // Unknown focus → 'all' (legacy fallback).
  focus: z
    .string()
    .optional()
    .transform((v): FocusMode => (v && (FOCUS_MODES as readonly string[]).includes(v) ? (v as FocusMode) : 'all')),
  user_id: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : v.slice(0, MAX_USER_ID_LENGTH))),
  space_id: z.string().optional(),
})

/** Typed output of parseSearchRequest — the safe, validated SearchRequest fields. */
export type ParsedSearchRequest = {
  query: string
  search_depth?: SearchDepth | 'auto'
  topic: Topic
  max_results: number
  include_answer: boolean
  include_raw_content: boolean
  include_fact_check: boolean
  include_domains?: string[]
  exclude_domains?: string[]
  time_range?: TimeRange
  sort_by?: SortBy
  max_tokens: number
  page: number
  country?: string
  language?: string
  location?: string
  focus: FocusMode
  user_id?: string
  space_id?: string
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; code: ErrorCode; detail: string }

/**
 * Parse + validate a POST /api/search body.
 *
 * Error codes are mapped back to the historical route contract so clients that
 * switch on `code` keep working unchanged:
 *   - missing/empty/non-string query   → missing_query
 *   - query > 2000 chars               → query_too_long
 *   - domain filters > 20 entries      → too_many_domains
 *   - any other malformed field        → validation_error
 */
export function parseSearchRequest(input: unknown): ParseResult<ParsedSearchRequest> {
  const parsed = SearchRequestSchema.safeParse(input)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const path = issue.path.join('.')
      if (path === 'query') {
        // Legacy contract: ANY bad query (missing, empty, whitespace, non-string)
        // is missing_query; only the length cap is query_too_long.
        if (issue.code === 'too_big') {
          return { ok: false, code: 'query_too_long', detail: `Query too long (max ${MAX_QUERY_LENGTH} chars)` }
        }
        return { ok: false, code: 'missing_query', detail: 'Query is required' }
      }
      if (path === 'include_domains' || path === 'exclude_domains') {
        return { ok: false, code: 'too_many_domains', detail: `${path} max ${MAX_DOMAIN_FILTERS} entries` }
      }
    }
    return { ok: false, code: 'validation_error', detail: 'Invalid request body' }
  }
  return { ok: true, data: parsed.data }
}

// ============================================================
// ExtractRequestSchema — POST /api/extract body
// ============================================================

const ExtractRequestSchema = z.object({
  urls: z.union([z.string(), z.array(z.string())]),
  include_images: z.boolean().optional().default(false),
  max_tokens: z
    .number()
    .optional()
    .default(8000)
    .transform((v) => Math.min(v, MAX_EXTRACT_TOKENS)),
})

/**
 * Validate a single URL string (length/emptiness). Returns the trimmed value
 * on success. Used by the GET route's comma-separated parsing too, so both
 * endpoints enforce identical URL rules.
 */
export function validateUrl(raw: string): { ok: true; value: string } | { ok: false; detail: string } {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return { ok: false, detail: 'URL is empty' }
  if (trimmed.length > MAX_URL_LENGTH) {
    return { ok: false, detail: `URL too long (max ${MAX_URL_LENGTH} chars)` }
  }
  return { ok: true, value: trimmed }
}

export type ParsedExtractRequest = {
  urls: string[]
  include_images: boolean
  max_tokens: number
}

/**
 * Parse + validate a POST /api/extract body.
 *
 * Error-code mapping mirrors the legacy route:
 *   - missing / null / empty-string / empty-array urls → missing_urls
 *   - too many URLs, oversized URL, non-string entries → invalid_urls
 */
export function parseExtractRequest(input: unknown): ParseResult<ParsedExtractRequest> {
  const parsed = ExtractRequestSchema.safeParse(input)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue && issue.path.join('.') === 'urls') {
      const rawUrls = (input as { urls?: unknown } | null)?.urls
      if (rawUrls === undefined || rawUrls === null || rawUrls === '') {
        return { ok: false, code: 'missing_urls', detail: 'urls is required (string or array of strings)' }
      }
      return { ok: false, code: 'invalid_urls', detail: 'Invalid urls' }
    }
    return { ok: false, code: 'validation_error', detail: 'Invalid request body' }
  }

  const { urls, include_images, max_tokens } = parsed.data
  // Legacy contract: a falsy/empty STRING urls field is missing_urls, while an
  // empty entry inside an array is invalid_urls ('URL is empty').
  if (typeof urls === 'string' && urls.trim() === '') {
    return { ok: false, code: 'missing_urls', detail: 'urls is required (string or array of strings)' }
  }
  const list = typeof urls === 'string' ? [urls] : urls
  if (list.length === 0) {
    return { ok: false, code: 'missing_urls', detail: 'urls is required (string or array of strings)' }
  }
  if (list.length > MAX_EXTRACT_URLS) {
    return { ok: false, code: 'invalid_urls', detail: `Too many URLs (max ${MAX_EXTRACT_URLS})` }
  }
  const validated: string[] = []
  for (const raw of list) {
    const checked = validateUrl(raw)
    if (!checked.ok) return { ok: false, code: 'invalid_urls', detail: checked.detail }
    validated.push(checked.value)
  }
  return { ok: true, data: { urls: validated, include_images, max_tokens } }
}
