/**
 * Unit tests for the per-isolate fluctuation classifier (S88/S89/S93).
 *
 * classifyHealthProbe() turns a sequence of /api/health rate_limiter samples
 * into a verdict: does the reported state live in DO storage (durable,
 * cross-isolate consistent) or per-isolate in-memory maps (local, bypass
 * risk)? Since S89 the payload carries an explicit `source` stamp — that is
 * the primary signal, with hosts_tracked monotonicity as the pre-S89
 * fallback (the 6→8→6 fluctuation is the local signature).
 */
import { describe, it, expect } from 'vitest'
import { classifyHealthProbe, type HealthProbeSample } from '../../scripts/probe-inmemory-bypass'

function sample(source: HealthProbeSample['source'], hostsTracked: number): HealthProbeSample {
  return { mode: source === 'durable' ? 'durable_object' : 'in_memory_fallback', source, hostsTracked }
}

describe('classifyHealthProbe — S89 source stamp (primary signal)', () => {
  it('classifies all-durable constant sequence as durable_consistent', () => {
    const v = classifyHealthProbe([sample('durable', 9), sample('durable', 9), sample('durable', 9)])
    expect(v.kind).toBe('durable_consistent')
    expect(v.reason).toContain('source=durable')
  })

  it('classifies all-durable monotonic growth as durable_consistent', () => {
    // DO mode only ever grows (new hosts discovered) — still consistent.
    const v = classifyHealthProbe([sample('durable', 6), sample('durable', 8), sample('durable', 9)])
    expect(v.kind).toBe('durable_consistent')
  })

  it('classifies any local stamp as local_fluctuating', () => {
    const v = classifyHealthProbe([sample('local', 6), sample('local', 8), sample('local', 6)])
    expect(v.kind).toBe('local_fluctuating')
    expect(v.reason).toContain('source=local')
  })

  it('flags mixed stamps as mixed_sources (old + new isolates)', () => {
    const v = classifyHealthProbe([sample('durable', 9), sample('local', 9)])
    expect(v.kind).toBe('mixed_sources')
  })
})

describe('classifyHealthProbe — pre-S89 fallback (no source stamp)', () => {
  it('constant hosts_tracked without stamp infers durable_consistent', () => {
    const v = classifyHealthProbe([sample(undefined, 9), sample(undefined, 9)])
    expect(v.kind).toBe('durable_consistent')
    expect(v.reason).toContain('no source stamp')
  })

  it('monotonic growth without stamp infers durable_consistent', () => {
    const v = classifyHealthProbe([sample(undefined, 6), sample(undefined, 8), sample(undefined, 9)])
    expect(v.kind).toBe('durable_consistent')
    expect(v.reason).toContain('monotonic')
  })

  it('non-monotonic 6→8→6 without stamp infers local_fluctuating (S88 signature)', () => {
    const v = classifyHealthProbe([sample(undefined, 6), sample(undefined, 8), sample(undefined, 6)])
    expect(v.kind).toBe('local_fluctuating')
    expect(v.reason).toContain('6→8→6')
  })

  it('empty sequence is unknown', () => {
    expect(classifyHealthProbe([]).kind).toBe('unknown')
  })

  it('missing hosts_tracked entirely is unknown, not a fake constant-0 durable', () => {
    // S93 review nit: a `?? 0` default would have collapsed this to
    // hosts_tracked=[0,0,0] → durable_consistent false positive.
    const v = classifyHealthProbe([{ mode: 'durable_object' }, { mode: 'durable_object' }])
    expect(v.kind).toBe('unknown')
    expect(v.reason).toContain('hosts_tracked missing')
  })

  it('partial all-durable stamps fall back with an honest reason (rollout)', () => {
    const v = classifyHealthProbe([{ source: 'durable', hostsTracked: 9 }, { hostsTracked: 9 }])
    expect(v.kind).toBe('durable_consistent')
    expect(v.reason).toContain('partial source stamps')
  })
})
