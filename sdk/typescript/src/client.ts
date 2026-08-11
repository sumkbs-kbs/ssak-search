/**
 * SearchClient — minimal, dependency-free HTTP client for the ssak-search API.
 *
 * Uses the global `fetch` (Node >= 18, Deno, Workers, browsers). Request
 * surfaces are pinned to openapi.yaml via spec.ts and the consistency test.
 */

import type {
  ErrorResponse,
  ExtractGetParams,
  ExtractRequest,
  ExtractResponse,
  HealthResponse,
  SearchGetParams,
  SearchRequest,
  SearchResponse,
} from './types'

export interface SearchClientConfig {
  /** API key — sent as `Authorization: Bearer <key>` (or X-API-Key, see authHeader). */
  apiKey?: string
  /** Base URL without trailing slash. Defaults to the production Pages URL. */
  baseUrl?: string
  /** Auth header style. Default 'authorization' (Bearer token). */
  authHeader?: 'authorization' | 'x-api-key'
  /** Injectable fetch (tests / custom transports). */
  fetchImpl?: typeof fetch
  /** Extra headers applied to every request. */
  headers?: Record<string, string>
}

/** Structured API error — carries HTTP status + ErrorResponse.code. */
export class SearchApiError extends Error {
  readonly status: number
  readonly code: string | undefined
  readonly body: unknown

  constructor(status: number, code: string | undefined, message: string, body?: unknown) {
    super(message)
    this.name = 'SearchApiError'
    this.status = status
    this.code = code
    this.body = body
  }
}

/** Omit `undefined` values and serialize array params (domains) as comma-joined. */
function toQueryString(params: Record<string, unknown>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue
    if (Array.isArray(value)) {
      if (value.length > 0) search.set(key, value.join(','))
    } else {
      search.set(key, String(value))
    }
  }
  return search.toString()
}

export class SearchClient {
  private readonly baseUrl: string
  private readonly apiKey: string | undefined
  private readonly authHeader: 'authorization' | 'x-api-key'
  private readonly fetchImpl: typeof fetch
  private readonly extraHeaders: Record<string, string>

  constructor(config: SearchClientConfig = {}) {
    this.baseUrl = (config.baseUrl ?? 'https://webapp.pages.dev').replace(/\/+$/, '')
    this.apiKey = config.apiKey
    this.authHeader = config.authHeader ?? 'authorization'
    this.fetchImpl = config.fetchImpl ?? fetch
    this.extraHeaders = config.headers ?? {}
  }

  private async request(method: 'GET' | 'POST', path: string, queryString?: string, body?: unknown): Promise<unknown> {
    const url = new URL(path, this.baseUrl)
    if (queryString) url.search = queryString

    const headers: Record<string, string> = { Accept: 'application/json', ...this.extraHeaders }
    if (this.apiKey) {
      if (this.authHeader === 'x-api-key') headers['X-API-Key'] = this.apiKey
      else headers['Authorization'] = `Bearer ${this.apiKey}`
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const response = await this.fetchImpl(url.toString(), {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    if (!response.ok) {
      let code: string | undefined
      let detail = `HTTP ${response.status}`
      let parsed: unknown
      try {
        parsed = await response.json()
        const err = parsed as Partial<ErrorResponse>
        if (err.code) code = err.code
        if (err.detail) detail = err.detail
      } catch {
        // Non-JSON error body — keep the HTTP-status message.
      }
      throw new SearchApiError(response.status, code, detail, parsed)
    }

    if (response.status === 204) return undefined
    return (await response.json()) as unknown
  }

  // ── Search ───────────────────────────────────────────────────────────────

  /** POST /api/search — full-featured search (primary endpoint). */
  async search(params: SearchRequest): Promise<SearchResponse> {
    return (await this.request('POST', '/api/search', undefined, params)) as SearchResponse
  }

  /** GET /api/search — simplified query-string search (incl. spec aliases). */
  async searchGet(params: SearchGetParams): Promise<SearchResponse> {
    return (await this.request(
      'GET',
      '/api/search',
      toQueryString(params as unknown as Record<string, unknown>),
    )) as SearchResponse
  }

  // ── Extract ──────────────────────────────────────────────────────────────

  /** POST /api/extract — extract clean content from URLs (primary). */
  async extract(params: ExtractRequest): Promise<ExtractResponse> {
    return (await this.request('POST', '/api/extract', undefined, params)) as ExtractResponse
  }

  /** GET /api/extract — comma-separated urls query param. */
  async extractGet(params: ExtractGetParams): Promise<ExtractResponse> {
    return (await this.request(
      'GET',
      '/api/extract',
      toQueryString(params as unknown as Record<string, unknown>),
    )) as ExtractResponse
  }

  // ── Health ───────────────────────────────────────────────────────────────

  /** GET /api/health — liveness by default; pass { depth: 'full' } for deep probes. */
  async health(params?: { depth?: 'light' | 'full'; full?: boolean }): Promise<HealthResponse> {
    return (await this.request(
      'GET',
      '/api/health',
      toQueryString((params ?? {}) as unknown as Record<string, unknown>),
    )) as HealthResponse
  }
}

/** Convenience — one-shot search without constructing a client. */
export async function searchOnce(
  query: string,
  config: SearchClientConfig & Partial<SearchRequest> = {},
): Promise<SearchResponse> {
  const client = new SearchClient(config)
  return client.search({ query, ...config })
}
