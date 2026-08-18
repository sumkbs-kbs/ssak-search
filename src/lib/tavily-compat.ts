/**
 * Tavily API compatibility layer (P1-5, 2026-08-18).
 *
 * ## Why this exists
 *
 * This project's headline promise is "Tavily-compatible search engine API", so
 * a client written against Tavily's SDK should work by changing only the base
 * URL. An audit of the live `/api/search` response found four contract breaks
 * that made a genuine drop-in swap impossible:
 *
 *   | Tavily field        | Before                          | After |
 *   |---------------------|---------------------------------|-------|
 *   | `answer`            | object `{text, confidence, …}`  | string |
 *   | `response_time`     | missing (only `response_time_ms`) | seconds (float) |
 *   | `images`            | missing even when requested     | populated |
 *   | `results[].raw_content` | `undefined` instead of `null` | `null` |
 *
 * ## Design constraint: no breaking change
 *
 * `answer.text` is consumed internally in 9 places (dashboard.tsx,
 * routes/openai.ts, routes/search.ts SSE, lib/answer.ts). Flipping the wire
 * type to a bare string would break all of them plus every existing client.
 *
 * So this layer is ADDITIVE and opt-in:
 *
 *   - Default (`/api/search`) keeps the rich native shape, and merely fills in
 *     the genuinely-missing pieces (`response_time`, `raw_content: null`), which
 *     no existing consumer can regress on.
 *   - Strict Tavily mode flattens `answer` to a string. It is selected by an
 *     explicit `api_compat: "tavily"` body field, the `X-API-Compat: tavily`
 *     header, or by POSTing to the dedicated `/api/tavily/search` alias.
 *
 * That way native clients keep their structured answer + citations, and Tavily
 * SDK users get a byte-compatible response.
 *
 * @see tests/unit/tavily-compat.test.ts
 */

import type { SearchResponse, SearchResult, ImageResult } from '../types'

/** Result entry exactly as Tavily serializes it. */
export interface TavilyResult {
  title: string
  url: string
  content: string
  score: number
  /** Tavily always emits this key; `null` when raw content was not requested. */
  raw_content: string | null
  /** Tavily includes this for `topic: "news"` responses. */
  published_date?: string
}

/** Response body exactly as Tavily serializes it. */
export interface TavilyResponse {
  query: string
  /** Tavily's answer is a plain string, or null when not requested. */
  answer: string | null
  /** Image URLs (strings) or descriptive objects when include_image_descriptions. */
  images: Array<string | { url: string; description?: string }>
  results: TavilyResult[]
  /** Elapsed time in SECONDS (Tavily's unit), not milliseconds. */
  response_time: number
  /** Present on Tavily responses that follow up on a previous query. */
  follow_up_questions?: string[] | null
}

/**
 * Normalize this project's `answer` (object) into Tavily's `answer` (string).
 *
 * Accepts the union of shapes that have existed on the wire so old cache
 * entries and legacy payloads degrade cleanly instead of emitting `"[object
 * Object]"`.
 */
export function flattenAnswer(answer: SearchResponse['answer'] | string | null | undefined): string | null {
  if (answer === null || answer === undefined) return null
  if (typeof answer === 'string') return answer.length > 0 ? answer : null
  if (typeof answer === 'object' && typeof (answer as { text?: unknown }).text === 'string') {
    const text = (answer as { text: string }).text
    return text.length > 0 ? text : null
  }
  return null
}

/**
 * Convert milliseconds to Tavily's seconds-with-2-decimals convention.
 * Tavily reports e.g. `1.92`, this project measured `1918`.
 */
export function msToSeconds(ms: number | undefined): number {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 0
  return Math.round(ms) / 1000
}

/**
 * Map an internal ImageResult to Tavily's image entry.
 *
 * Tavily emits bare URL strings by default and `{url, description}` objects when
 * `include_image_descriptions: true`.
 */
export function toTavilyImages(
  images: ImageResult[] | undefined,
  includeDescriptions = false,
): Array<string | { url: string; description?: string }> {
  if (!images || images.length === 0) return []
  if (!includeDescriptions) return images.map((img) => img.url)
  return images.map((img) => ({
    url: img.url,
    description: img.content ?? img.title ?? undefined,
  }))
}

/**
 * Ensure `raw_content` is always an explicit key.
 *
 * Tavily's schema declares `raw_content: string | null`, so a missing key breaks
 * strictly-typed clients (notably the Python SDK's pydantic models). Internally
 * the field is optional, so `undefined` is normalized to `null`.
 */
export function normalizeResult(result: SearchResult): TavilyResult {
  const out: TavilyResult = {
    title: result.title ?? '',
    url: result.url,
    content: result.content ?? '',
    score: typeof result.score === 'number' ? result.score : 0,
    raw_content: result.raw_content ?? null,
  }
  if (result.published_date) out.published_date = result.published_date
  return out
}

/**
 * Full strict-Tavily projection of a native SearchResponse.
 *
 * Only the fields Tavily documents are emitted, so a client that iterates keys
 * (or validates strictly) sees nothing unexpected.
 */
export function toTavilyResponse(
  response: SearchResponse,
  options: { includeImageDescriptions?: boolean } = {},
): TavilyResponse {
  return {
    query: response.query,
    answer: flattenAnswer(response.answer),
    images: toTavilyImages(response.images, options.includeImageDescriptions),
    results: (response.results ?? []).map(normalizeResult),
    response_time: msToSeconds(response.response_time_ms),
    follow_up_questions: response.related_queries?.length ? response.related_queries : null,
  }
}

/**
 * Additive compatibility fields for the DEFAULT (native) response.
 *
 * This keeps every existing field — including the structured `answer` object
 * that the dashboard and OpenAI-compat route depend on — while adding the
 * Tavily fields whose absence was a pure defect:
 *
 *   - `response_time` (seconds) alongside the native `response_time_ms`
 *   - `raw_content: null` normalized on every result
 *   - `images: []` so the key always exists
 *   - `answer_text`, a string mirror of `answer.text`, so clients that only
 *     need text don't have to reach into the object
 *
 * Nothing is removed, so this cannot regress an existing consumer.
 */
export function withCompatFields(response: SearchResponse): SearchResponse & {
  response_time: number
  answer_text: string | null
} {
  const answerText = flattenAnswer(response.answer)
  return {
    ...response,
    results: (response.results ?? []).map((r) => ({
      ...r,
      raw_content: r.raw_content ?? null,
    })) as SearchResult[],
    images: response.images ?? [],
    response_time: msToSeconds(response.response_time_ms),
    answer_text: answerText,
  }
}

/**
 * Decide whether the caller wants the strict Tavily projection.
 *
 * Three equivalent opt-ins, so SDK users can pick whichever their client
 * supports:
 *   1. body   `{"api_compat": "tavily"}`
 *   2. header `X-API-Compat: tavily`
 *   3. route  `POST /api/tavily/search`
 */
export function wantsTavilyCompat(input: {
  bodyFlag?: unknown
  header?: string | null
  path?: string
}): boolean {
  if (typeof input.bodyFlag === 'string' && input.bodyFlag.toLowerCase() === 'tavily') return true
  if (typeof input.header === 'string' && input.header.toLowerCase() === 'tavily') return true
  if (typeof input.path === 'string' && input.path.startsWith('/api/tavily')) return true
  return false
}
