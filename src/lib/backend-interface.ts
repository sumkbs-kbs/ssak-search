/**
 * Plugin architecture for search backends.
 *
 * Each backend implements the SearchBackend interface, allowing new engines
 * to be added without modifying the orchestrator. Backends are registered
 * in a registry and the orchestrator queries them based on query type and
 * language routing.
 *
 * Future backends (SearXNG, Brave API, Yahoo Finance, etc.) can be added
 * by implementing this interface and registering in BACKEND_REGISTRY.
 */

import type { SearchResult, ImageResult } from '../types'

export interface BackendSearchOptions {
  maxResults?: number
  timeoutMs?: number
  language?: string
  timeRange?: string
  region?: string
}

export interface SearchBackend {
  /** Unique backend identifier (e.g. "bing", "naver", "wikipedia") */
  readonly name: string

  /** Human-readable label for UI/logging */
  readonly label: string

  /**
   * Whether this backend should be used for the given query.
   * Called by the orchestrator to decide which backends to fan out to.
   */
  shouldUse(query: string, queryType: string, language: 'korean' | 'chinese' | 'english'): boolean

  /**
   * Execute a search. Returns an array of SearchResult.
   * Must never throw — return [] on failure.
   */
  search(query: string, opts: BackendSearchOptions): Promise<SearchResult[]>

  /**
   * Optional: perform a health check probe.
   * Returns latency in ms, or null if unsupported.
   */
  health?(): Promise<{ status: 'operational' | 'degraded' | 'down'; latency_ms: number }>
}

/**
 * Backend registry — new backends register themselves here.
 * The orchestrator iterates registered backends and calls shouldUse()
 * to determine participation in the fan-out.
 */
class BackendRegistry {
  private backends: Map<string, SearchBackend> = new Map()

  register(backend: SearchBackend): void {
    if (this.backends.has(backend.name)) {
      console.warn(`Backend "${backend.name}" is already registered — overwriting`)
    }
    this.backends.set(backend.name, backend)
  }

  unregister(name: string): void {
    this.backends.delete(name)
  }

  get(name: string): SearchBackend | undefined {
    return this.backends.get(name)
  }

  all(): SearchBackend[] {
    return Array.from(this.backends.values())
  }

  /** Get all backends that should participate for a given query */
  getActiveFor(query: string, queryType: string, language: 'korean' | 'chinese' | 'english'): SearchBackend[] {
    return this.all().filter((b) => {
      try {
        return b.shouldUse(query, queryType, language)
      } catch {
        return false
      }
    })
  }
}

/** Global singleton registry */
export const BACKEND_REGISTRY = new BackendRegistry()
