import type {
  SearchRequest,
  SearchResponse,
  ExtractRequest,
  ExtractResponse,
  ErrorResponse,
  StreamEvent,
  ClientOptions,
} from './types.js'
import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT } from './types.js'
import { parseSSEStream } from './stream.js'

export class AnswerClient {
  private baseUrl: string
  private apiKey?: string
  private timeout: number

  constructor(options: ClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '')
    this.apiKey = options.apiKey
    this.timeout = options.timeout ?? DEFAULT_TIMEOUT
  }

  private get headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`
    }
    return h
  }

  private async request<T>(path: string, body: unknown): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText, code: 'http_error' })) as ErrorResponse
        throw new AnswerApiError(res.status, err.detail, err.code)
      }

      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Execute a search query.
   *
   * ```ts
   * const client = new AnswerClient({ baseUrl: 'https://api.example.com', apiKey: 'sk-...' })
   * const res = await client.search({ query: 'what is quantum computing', max_results: 5 })
   * console.log(res.results)
   * ```
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    return this.request<SearchResponse>('/api/search', request)
  }

  /**
   * Extract content from one or more URLs.
   *
   * ```ts
   * const res = await client.extract({ urls: 'https://example.com' })
   * ```
   */
  async extract(request: ExtractRequest): Promise<ExtractResponse> {
    return this.request<ExtractResponse>('/api/extract', request)
  }

  /**
   * Stream search results and AI answer via Server-Sent Events.
   * Returns an async generator of StreamEvent objects.
   *
   * ```ts
   * for await (const event of client.stream({ query: 'what is quantum computing' })) {
   *   if (event.event === 'token') process.stdout.write(event.data.text)
   *   if (event.event === 'done') break
   * }
   * ```
   */
  async *stream(request: SearchRequest): AsyncGenerator<StreamEvent, void, void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeout)

    const params = new URLSearchParams({ query: request.query })
    if (request.max_results) params.set('max_results', String(request.max_results))
    if (request.search_depth) params.set('search_depth', request.search_depth)
    if (request.topic) params.set('topic', request.topic)

    try {
      const res = await fetch(`${this.baseUrl}/api/search/stream?${params}`, {
        headers: this.headers,
        signal: controller.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: res.statusText, code: 'http_error' })) as ErrorResponse
        throw new AnswerApiError(res.status, err.detail, err.code)
      }

      if (!res.body) {
        throw new AnswerApiError(0, 'Response body is null', 'no_body')
      }

      for await (const event of parseSSEStream(res.body)) {
        yield event
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

export class AnswerApiError extends Error {
  constructor(
    public status: number,
    detail: string,
    public code: string,
  ) {
    super(detail)
    this.name = 'AnswerApiError'
  }
}
