/**
 * Unit tests for /api/health status rollup logic.
 *
 * Guards the fix where an OPTIONAL backend (e.g. brave) with a missing API key
 * was reported as `down` and flipped the GLOBAL status to `partial_outage` —
 * a false-positive outage for a backend the deployment isn't even using.
 */
import { describe, it, expect } from 'vitest'
import {
  computeOverallStatus,
  shouldProbeBackend,
  resolveRateLimiterSource,
  buildRateLimiterSourceMetricLines,
} from '../../src/routes/health'
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
