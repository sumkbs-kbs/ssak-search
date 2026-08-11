/**
 * Unit tests for /api/health status rollup logic.
 *
 * Guards the fix where an OPTIONAL backend (e.g. brave) with a missing API key
 * was reported as `down` and flipped the GLOBAL status to `partial_outage` —
 * a false-positive outage for a backend the deployment isn't even using.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  computeOverallStatus,
  shouldProbeBackend,
  resolveRateLimiterSource,
  buildRateLimiterSourceMetricLines,
  buildLightHealthData,
  healthRoute,
} from '../../src/routes/health'
import { logger } from '../../src/lib/logger'
import type { AppBindings } from '../../src/types'

type ProbeStatus = 'operational' | 'degraded' | 'down'

function probes(statuses: ProbeStatus[]): Array<{ status: ProbeStatus }> {
  return statuses.map((status) => ({ status }))
}

describe('computeOverallStatus', () => {
  it('returns ok when every probed backend is operational', () => {
    expect(computeOverallStatus(probes(['operational', 'operational', 'operational']))).toBe('ok')
  })

  it('returns ok for an empty probe set (all optional backends unconfigured)', () => {
    expect(computeOverallStatus(probes([]))).toBe('ok')
  })

  it('returns degraded when at least one backend is degraded but none down', () => {
    expect(computeOverallStatus(probes(['operational', 'degraded', 'operational']))).toBe('degraded')
  })

  it('returns partial_outage when any backend is down', () => {
    expect(computeOverallStatus(probes(['operational', 'down']))).toBe('partial_outage')
  })

  it('returns partial_outage when backends are both down and degraded', () => {
    expect(computeOverallStatus(probes(['down', 'degraded']))).toBe('partial_outage')
  })
})

describe('resolveRateLimiterSource (S88 mode-transition surfacing)', () => {
  it('returns local when every tracked host is source: local', () => {
    const health = { 'www.bing.com': { source: 'local' as const }, 'en.wikipedia.org': { source: 'local' as const } }
    expect(resolveRateLimiterSource(health, false)).toBe('local')
  })

  it('returns durable when every tracked host is source: durable', () => {
    const health = {
      'www.bing.com': { source: 'durable' as const },
      'en.wikipedia.org': { source: 'durable' as const },
    }
    expect(resolveRateLimiterSource(health, true)).toBe('durable')
  })

  it('falls back to binding-based mode when no hosts are tracked yet (fresh isolate)', () => {
    // Empty state — a fresh in-memory isolate reports hosts_tracked: 0.
    expect(resolveRateLimiterSource({}, false)).toBe('local')
    expect(resolveRateLimiterSource({}, true)).toBe('durable')
  })

  it('falls back to binding-based mode when sources are mixed', () => {
    const health = { a: { source: 'local' as const }, b: { source: 'durable' as const } }
    expect(resolveRateLimiterSource(health, true)).toBe('durable')
    expect(resolveRateLimiterSource(health, false)).toBe('local')
  })

  it('ignores hosts without a source stamp (backward compat)', () => {
    const health = { a: {}, b: { source: 'local' as const } }
    expect(resolveRateLimiterSource(health, false)).toBe('local')
  })
})

describe('buildRateLimiterSourceMetricLines (S89-③ Prometheus gauge)', () => {
  it('emits the durable gauge with HELP/TYPE headers', () => {
    const lines = buildRateLimiterSourceMetricLines('durable')
    expect(lines[0]).toBe(
      '# HELP search_rate_limiter_source Rate limiter state source (1 = active mode; durable = DO storage, local = per-isolate in-memory)',
    )
    expect(lines[1]).toBe('# TYPE search_rate_limiter_source gauge')
    expect(lines[2]).toBe('search_rate_limiter_source{source="durable"} 1')
  })

  it('emits the local gauge when in-memory fallback is active', () => {
    const lines = buildRateLimiterSourceMetricLines('local')
    expect(lines[2]).toBe('search_rate_limiter_source{source="local"} 1')
  })

  it('emits exactly ONE sample — only the active source label', () => {
    const samples = buildRateLimiterSourceMetricLines('durable').filter((l) =>
      l.startsWith('search_rate_limiter_source'),
    )
    expect(samples).toHaveLength(1)
    expect(samples[0]).not.toContain('source="local"')
  })

  it('produces Prometheus-parseable lines for both modes', () => {
    for (const source of ['durable', 'local'] as const) {
      for (const l of buildRateLimiterSourceMetricLines(source)) {
        expect(l).toMatch(/^(# (HELP|TYPE) |[a-z_]+\{[^}]*\} \d+$)/)
      }
    }
  })
})

describe('shouldProbeBackend', () => {
  const env = (overrides: Partial<AppBindings> = {}): AppBindings => overrides as AppBindings

  it('probes required backends even with no credentials (bing, naver, ...)', () => {
    expect(shouldProbeBackend('bing', env())).toBe(true)
    expect(shouldProbeBackend('naver', env())).toBe(true)
    expect(shouldProbeBackend('wikipedia', env())).toBe(true)
  })

  it('skips brave when BRAVE_API_KEY is missing', () => {
    expect(shouldProbeBackend('brave', env())).toBe(false)
    expect(shouldProbeBackend('brave', env({ BRAVE_API_KEY: '' }))).toBe(false)
  })

  it('skips brave when BRAVE_API_KEY is only whitespace', () => {
    expect(shouldProbeBackend('brave', env({ BRAVE_API_KEY: '   ' }))).toBe(false)
  })

  it('probes brave when BRAVE_API_KEY is configured', () => {
    expect(shouldProbeBackend('brave', env({ BRAVE_API_KEY: 'test-key' }))).toBe(true)
  })
})

describe('buildLightHealthData (P0-1 zero-subrequest liveness)', () => {
  afterEach(() => vi.restoreAllMocks())

  it('performs ZERO network fetches — a fetch stub that throws on call proves it', async () => {
    const fetchSpy = vi.fn().mockImplementation(() => {
      throw new Error('network call in light mode! (P0-1 regression)')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const data = await buildLightHealthData({} as AppBindings)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(data.status).toBe('ok')
    expect(data.features.rate_limiter_do).toBe(false)
    expect(data.rate_limiter!.source).toBe('local')
    expect(data.rate_limiter!.hosts_tracked).toBe(0)
  })

  it('reports binding presence without probing — workers_ai/self_index/answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        throw new Error('no network in light mode')
      }),
    )

    const data = await buildLightHealthData({
      AI: {} as AppBindings['AI'],
      VECTORIZE_INDEX: {} as AppBindings['VECTORIZE_INDEX'],
      SEARCH_INDEX_DB: {} as AppBindings['SEARCH_INDEX_DB'],
    } as AppBindings)

    expect(data.backends.workers_ai).toEqual({ status: 'operational', latency_ms: 0 })
    expect(data.features.answer).toBe(true)
    expect(data.features.self_index).toBe(true)
    expect(data.index!.configured).toBe(true)
    expect(data.index!.total_documents).toBe(0) // corpus query is full-mode only
  })

  it('GET /api/health returns 200 with zero subrequests by default (light)', async () => {
    const fetchSpy = vi.fn().mockImplementation(() => {
      throw new Error('network call in default health! (P0-1 regression)')
    })
    vi.stubGlobal('fetch', fetchSpy)

    const res = await healthRoute.request('/', {}, {} as AppBindings)
    const body = (await res.json()) as { status: string; cached?: boolean; rate_limiter: { source: string } }

    expect(res.status).toBe(200)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(body.status).toBe('ok')
    expect(body.cached).toBeUndefined() // light mode is always fresh — never the 30s probe cache
    expect(body.rate_limiter.source).toBe('local')
  })

  it('explicit depth=light behaves identically to the default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() => {
        throw new Error('no network in light mode')
      }),
    )

    const res = await healthRoute.request('/?depth=light', {}, {} as AppBindings)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { features: Record<string, boolean> }
    expect(body.features.search).toBe(true)
  })
})

describe('?depth=full emits the shared deep-probe summary log (S104-③-③)', () => {
  it('logs [health] deep health probe complete with down_backends on a fresh probe', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    try {
      // All probes healthy + no down alerts (no SLACK_WEBHOOK) + no index
      // bindings (probeIndexHealth short-circuits without D1/Vectorize).
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))

      const res = await healthRoute.request('/?depth=full', {}, {} as AppBindings)
      expect(res.status).toBe(200)

      expect(infoSpy).toHaveBeenCalledWith(
        '[health] deep health probe complete',
        expect.objectContaining({ status: 'ok', down_backends: 'none', cached: false }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('emits the same line with cached: true when served from the 30s probe cache', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    try {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status: 200 })))

      // First call populates the module-level 30s cache; the second (within
      // TTL) is served from it and must STILL emit the summary line.
      await healthRoute.request('/?depth=full', {}, {} as AppBindings)
      await healthRoute.request('/?depth=full', {}, {} as AppBindings)

      const calls = infoSpy.mock.calls.filter(([m]) => String(m).includes('deep health probe complete'))
      expect(calls.length).toBeGreaterThanOrEqual(2)
      expect(calls[calls.length - 1][1]).toMatchObject({ cached: true, down_backends: 'none' })
    } finally {
      infoSpy.mockRestore()
    }
  })
})
