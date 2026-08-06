/**
 * Unit tests for /api/health status rollup logic.
 *
 * Guards the fix where an OPTIONAL backend (e.g. brave) with a missing API key
 * was reported as `down` and flipped the GLOBAL status to `partial_outage` —
 * a false-positive outage for a backend the deployment isn't even using.
 */
import { describe, it, expect } from 'vitest'
import { computeOverallStatus, shouldProbeBackend } from '../../src/routes/health'
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
