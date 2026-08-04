/**
 * Unit tests for ExperimentDO + helpers
 * (src/lib/experiments/ab-test.ts — Phase C.2)
 *
 * Uses a mocked DurableObject state with a storage Map that supports
 * range listing (prefix/start/end/limit). Time is controlled via
 * vi.useFakeTimers for retention/analysis-window tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// DurableObject state mock factory (with range list support)
// ============================================================
function createMockDOState() {
  const storage = new Map<string, unknown>()

  return {
    storage: {
      get: vi.fn(async (key: string) => storage.get(key)),
      put: vi.fn(async (key: string, value: unknown) => { storage.set(key, value) }),
      delete: vi.fn(async (key: string) => storage.delete(key)),
      deleteAll: vi.fn(async () => storage.clear()),
      setAlarm: vi.fn(),
      deleteAlarm: vi.fn(),
      getAlarm: vi.fn(async () => null),
      list: vi.fn(async (opts: { prefix?: string; start?: string; end?: string; limit?: number } = {}) => {
        const { prefix, start, end, limit } = opts
        let keys = [...storage.keys()].sort()
        if (prefix) keys = keys.filter((k) => k.startsWith(prefix))
        if (start) keys = keys.filter((k) => k >= start)
        if (end) keys = keys.filter((k) => k <= end)
        if (limit && limit > 0) keys = keys.slice(0, limit)
        return new Map(keys.map((k) => [k, storage.get(k)]))
      }),
      _map: storage,
    },
    blockConcurrencyWhile: vi.fn(async (fn: () => Promise<void>) => { await fn() }),
    waitUntil: vi.fn(),
    id: { toString: () => 'test-do-id' },
    tags: [],
  }
}

describe('ExperimentDO', () => {
  let ExperimentDOClass: any
  let doState: any
  let doInstance: any
  let mod: any

  beforeEach(async () => {
    vi.mock('cloudflare:workers', () => ({
      DurableObject: class MockDurableObject {
        ctx: any
        env: any
        constructor(ctx: any, env: any) {
          this.ctx = ctx
          this.env = env
        }
      },
    }))
    mod = await import('../../src/lib/experiments/ab-test')
    ExperimentDOClass = mod.ExperimentDO
    doState = createMockDOState()
    doInstance = new ExperimentDOClass(doState, {})
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  // ----------------------------------------------------------
  // Registration & lifecycle
  // ----------------------------------------------------------

  it('register rejects names that violate the pattern', async () => {
    for (const bad of ['UPPER', 'has:colon', 'has space', '한글', '']) {
      const res = await doInstance.register({ name: bad, variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
      expect(res.ok).toBe(false)
    }
    const res = await doInstance.register({ name: 'x'.repeat(41), variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    expect(res.ok).toBe(false)
  })

  it('register rejects duplicate experiment names', async () => {
    const input = { name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] }
    expect((await doInstance.register(input)).ok).toBe(true)
    const res = await doInstance.register(input)
    expect(res.ok).toBe(false)
    expect(res.error).toContain('already exists')
  })

  it('register rejects bad variant sets', async () => {
    // Single variant
    expect((await doInstance.register({ name: 'e1', variants: [{ key: 'control', weight: 100 }] })).ok).toBe(false)
    // Duplicate keys
    expect((await doInstance.register({ name: 'e2', variants: [{ key: 'a', weight: 50 }, { key: 'a', weight: 50 }] })).ok).toBe(false)
    // Weights not summing to 100
    expect((await doInstance.register({ name: 'e3', variants: [{ key: 'a', weight: 30 }, { key: 'b', weight: 30 }] })).ok).toBe(false)
    // Non-integer / out-of-range weight
    expect((await doInstance.register({ name: 'e4', variants: [{ key: 'a', weight: 50.5 }, { key: 'b', weight: 49.5 }] })).ok).toBe(false)
  })

  it('register rejects unknown primary_metric', async () => {
    const res = await doInstance.register({
      name: 'e1',
      variants: [{ key: 'a', weight: 50 }, { key: 'b', weight: 50 }],
      primary_metric: 'bogus' as any,
    })
    expect(res.ok).toBe(false)
  })

  it('register stores a running experiment and list returns it', async () => {
    const res = await doInstance.register({
      name: 'ltr-ranking',
      description: 'LTR A/B',
      variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }],
      primary_metric: 'ctr',
    })
    expect(res.ok).toBe(true)
    expect(res.experiment?.status).toBe('running')
    const list = await doInstance.list()
    expect(list).toHaveLength(1)
    expect(list[0].name).toBe('ltr-ranking')
    expect(list[0].impressions).toBe(0)
  })

  it('setStatus pauses and resumes an experiment', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    expect((await doInstance.setStatus('ltr-ranking', 'paused')).ok).toBe(true)
    expect((await doInstance.setStatus('ltr-ranking', 'running')).ok).toBe(true)
    expect((await doInstance.setStatus('missing', 'running')).ok).toBe(false)
  })

  // ----------------------------------------------------------
  // Deterministic assignment
  // ----------------------------------------------------------

  it('assign is deterministic per user and respects weights', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    const v1 = await doInstance.assign('ltr-ranking', 'user-1')
    const v2 = await doInstance.assign('ltr-ranking', 'user-1')
    expect(v1).toBe(v2)
    expect(['control', 'treatment']).toContain(v1)

    // 200 distinct users → both variants get traffic (50/50 split)
    const counts: Record<string, number> = {}
    for (let i = 0; i < 200; i++) {
      const v = await doInstance.assign('ltr-ranking', `user-${i}`)
      counts[v!] = (counts[v!] ?? 0) + 1
    }
    expect(counts.control).toBeGreaterThan(50)
    expect(counts.treatment).toBeGreaterThan(50)
  })

  it('assign returns null for unknown, paused, or missing-user', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    expect(await doInstance.assign('missing', 'u1')).toBeNull()
    expect(await doInstance.assign('ltr-ranking', null)).toBeNull()
    expect(await doInstance.assign('ltr-ranking', '')).toBeNull()
    await doInstance.setStatus('ltr-ranking', 'paused')
    expect(await doInstance.assign('ltr-ranking', 'u1')).toBeNull()
  })

  // ----------------------------------------------------------
  // Event recording & stats
  // ----------------------------------------------------------

  it('recordImpression/Click/Latency/Error update counters and store events', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    const impId = await doInstance.recordImpression({
      experiment: 'ltr-ranking', variant: 'control', user_id: null,
      impression_id: 'imp-1', query: 'react', result_count: 10,
    })
    expect(impId).toBe('imp-1')
    await doInstance.recordClick({ experiment: 'ltr-ranking', variant: 'control', user_id: null, impression_id: 'imp-1', position: 1 })
    await doInstance.recordLatency({ experiment: 'ltr-ranking', variant: 'control', latency_ms: 120 })
    await doInstance.recordError({ experiment: 'ltr-ranking', variant: 'control' })

    const stats = await doInstance.getStats('ltr-ranking')
    expect(stats?.impressions).toBe(1)
    expect(stats?.clicks).toBe(1)
    expect(stats?.latencies).toBe(1)
    expect(stats?.errors).toBe(1)

    const keys = [...(doState.storage._map as Map<string, unknown>).keys()]
    expect(keys.some((k) => k.startsWith('imp:ltr-ranking:'))).toBe(true)
    expect(keys.some((k) => k.startsWith('clk:ltr-ranking:'))).toBe(true)
    expect(keys.some((k) => k.startsWith('lat:ltr-ranking:'))).toBe(true)
    expect(keys.some((k) => k.startsWith('err:ltr-ranking:'))).toBe(true)
  })

  it('getStats returns null for unknown experiment', async () => {
    expect(await doInstance.getStats('missing')).toBeNull()
  })

  it('mirrors events to Analytics Engine when the binding exists', async () => {
    const writeDataPoint = vi.fn()
    const env = { ANALYTICS: { writeDataPoint } }
    const doWithAnalytics = new ExperimentDOClass(createMockDOState(), env)
    await doWithAnalytics.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    await doWithAnalytics.recordImpression({
      experiment: 'ltr-ranking', variant: 'control', user_id: null,
      impression_id: 'imp-1', query: 'q', result_count: 5,
    })
    expect(writeDataPoint).toHaveBeenCalledTimes(1)
    const args = writeDataPoint.mock.calls[0][0]
    expect(args.blobs[0]).toBe('experiment')
    expect(args.blobs[1]).toBe('ltr-ranking')
    expect(args.blobs[2]).toBe('impression:control')
  })

  it('prunes events older than 30 days during cleanup', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-01T00:00:00Z'))
    await doInstance.recordImpression({
      experiment: 'ltr-ranking', variant: 'control', user_id: null,
      impression_id: 'old-1', query: 'q', result_count: 5,
    })

    vi.setSystemTime(new Date('2026-08-10T00:00:00Z'))
    for (let i = 0; i < 26; i++) {
      await doInstance.recordClick({ experiment: 'ltr-ranking', variant: 'control', user_id: null, impression_id: `imp-${i}`, position: 1 })
    }

    const keys = [...(doState.storage._map as Map<string, unknown>).keys()]
    expect(keys.some((k) => k.startsWith('imp:ltr-ranking:') && k.includes('old-1'))).toBe(false)
  })

  // ----------------------------------------------------------
  // Bayesian analysis
  // ----------------------------------------------------------

  async function seedImpressions(variant: string, count: number, clickEvery = 0, startPos = 1) {
    for (let i = 0; i < count; i++) {
      const impId = `imp-${variant}-${i}`
      await doInstance.recordImpression({
        experiment: 'ltr-ranking', variant, user_id: null,
        impression_id: impId, query: 'q', result_count: 10,
      })
      if (clickEvery > 0 && i % clickEvery === 0) {
        await doInstance.recordClick({ experiment: 'ltr-ranking', variant, user_id: null, impression_id: impId, position: startPos })
      }
    }
  }

  it('analyze reports insufficient_data below the sample threshold', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    await seedImpressions('control', 10)
    await seedImpressions('treatment', 10)
    const a = await doInstance.analyze('ltr-ranking', 30)
    expect(a?.insufficient_data).toBe(true)
    expect(a?.significant).toBe(false)
    expect(a?.variants).toHaveLength(2)
  })

  it('analyze declares the higher-CTR variant the winner', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    await seedImpressions('control', 60) // 0 clicks
    await seedImpressions('treatment', 60, 3) // clicks at position 1 every 3rd impression
    const a = await doInstance.analyze('ltr-ranking', 30)
    expect(a?.insufficient_data).toBe(false)
    expect(a?.significant).toBe(true)
    expect(a?.winner).toBe('treatment')
    expect(a?.control?.ctr).toBe(0)
    expect(a?.treatment?.ctr).toBeGreaterThan(0)
  })

  it('analyze measures latency with lower-is-better direction', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }], primary_metric: 'latency' })
    for (let i = 0; i < 40; i++) {
      await doInstance.recordLatency({ experiment: 'ltr-ranking', variant: 'control', latency_ms: 200 })
      await doInstance.recordLatency({ experiment: 'ltr-ranking', variant: 'treatment', latency_ms: 80 })
    }
    const a = await doInstance.analyze('ltr-ranking', 30)
    expect(a?.insufficient_data).toBe(false)
    expect(a?.significant).toBe(true)
    expect(a?.winner).toBe('treatment')
    expect(a?.treatment?.latency_mean_ms).toBeLessThan(a?.control?.latency_mean_ms!)
  })

  it('analyze returns null for unknown experiment', async () => {
    expect(await doInstance.analyze('missing', 30)).toBeNull()
  })

  // ----------------------------------------------------------
  // reset
  // ----------------------------------------------------------

  it('reset wipes experiments and events', async () => {
    await doInstance.register({ name: 'ltr-ranking', variants: [{ key: 'control', weight: 50 }, { key: 'treatment', weight: 50 }] })
    await seedImpressions('control', 5)
    await doInstance.reset()
    expect(await doInstance.list()).toHaveLength(0)
    expect((doState.storage._map as Map<string, unknown>).size).toBe(0)
  })
})

// ============================================================
// Pure helpers
// ============================================================

describe('ab-test pure helpers', () => {
  it('fnv1a is deterministic and input-sensitive', async () => {
    const { fnv1a } = await import('../../src/lib/experiments/ab-test')
    const h1 = fnv1a('ltr-ranking:user-1')
    const h2 = fnv1a('ltr-ranking:user-1')
    const h3 = fnv1a('ltr-ranking:user-2')
    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(Number.isInteger(h1)).toBe(true)
    expect(h1 >= 0 && h1 <= 0xffffffff).toBe(true)
  })

  it('pickVariant maps [0,1) to weighted buckets', async () => {
    const { pickVariant } = await import('../../src/lib/experiments/ab-test')
    const variants = [{ key: 'control', weight: 30 }, { key: 'treatment', weight: 70 }]
    expect(pickVariant(variants, 0)).toBe('control')
    expect(pickVariant(variants, 0.29)).toBe('control')
    expect(pickVariant(variants, 0.3)).toBe('treatment')
    expect(pickVariant(variants, 0.999)).toBe('treatment')
  })

  it('normalCdf has the expected reference values', async () => {
    const { normalCdf } = await import('../../src/lib/experiments/ab-test')
    expect(normalCdf(0)).toBeCloseTo(0.5, 6)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 2)
    expect(normalCdf(-1.96)).toBeCloseTo(0.025, 2)
  })

  it('getExperimentStub uses a stable DO id', async () => {
    const { getExperimentStub } = await import('../../src/lib/experiments/ab-test')
    const idFromName = vi.fn().mockReturnValue('hub-id')
    const get = vi.fn().mockReturnValue({ stub: true })
    const stub = getExperimentStub({ EXPERIMENT_DO: { idFromName, get } } as any)
    expect(idFromName).toHaveBeenCalledWith('hub')
    expect(stub).toEqual({ stub: true })
  })
})

// ============================================================
// Search-route helpers
// ============================================================

describe('ab-test search-route helpers', () => {
  it('resolveExperimentAssignment returns null without the binding', async () => {
    const { resolveExperimentAssignment } = await import('../../src/lib/experiments/ab-test')
    expect(await resolveExperimentAssignment({} as any, 'user-1')).toBeNull()
    expect(await resolveExperimentAssignment(undefined as any, 'user-1')).toBeNull()
    expect(await resolveExperimentAssignment({ EXPERIMENT_DO: {} } as any, null)).toBeNull()
  })

  it('resolveExperimentAssignment returns an assignment when the experiment is running', async () => {
    const { resolveExperimentAssignment } = await import('../../src/lib/experiments/ab-test')
    const assign = vi.fn().mockResolvedValue('treatment')
    const env = { EXPERIMENT_DO: { idFromName: () => 'hub-id', get: () => ({ assign }) } }
    const a = await resolveExperimentAssignment(env as any, 'user-1')
    expect(assign).toHaveBeenCalledWith('ltr-ranking', 'user-1')
    expect(a?.name).toBe('ltr-ranking')
    expect(a?.variant).toBe('treatment')
    expect(a?.impression_id).toBeTruthy()
  })

  it('resolveExperimentAssignment returns null when the experiment is not assigned', async () => {
    const { resolveExperimentAssignment } = await import('../../src/lib/experiments/ab-test')
    const assign = vi.fn().mockResolvedValue(null)
    const env = { EXPERIMENT_DO: { idFromName: () => 'hub-id', get: () => ({ assign }) } }
    expect(await resolveExperimentAssignment(env as any, 'user-1')).toBeNull()
  })

  it('event log helpers no-op without the binding', async () => {
    const mod = await import('../../src/lib/experiments/ab-test')
    const assignment = { name: 'ltr-ranking', variant: 'treatment', impression_id: 'imp-x' }
    await mod.logExperimentImpression({} as any, assignment, 'q', 10)
    await mod.logExperimentLatency({} as any, assignment, 100)
    await mod.logExperimentError({} as any, assignment)
  })

  it('event log helpers call the DO stub when bound', async () => {
    const mod = await import('../../src/lib/experiments/ab-test')
    const recordImpression = vi.fn().mockResolvedValue('imp-x')
    const recordLatency = vi.fn().mockResolvedValue(undefined)
    const recordError = vi.fn().mockResolvedValue(undefined)
    const env = {
      EXPERIMENT_DO: { idFromName: () => 'hub-id', get: () => ({ recordImpression, recordLatency, recordError }) },
    }
    const assignment = { name: 'ltr-ranking', variant: 'treatment', impression_id: 'imp-x' }
    await mod.logExperimentImpression(env as any, assignment, 'react hooks', 7)
    await mod.logExperimentLatency(env as any, assignment, 250)
    await mod.logExperimentError(env as any, assignment)

    expect(recordImpression).toHaveBeenCalledTimes(1)
    const impInput = recordImpression.mock.calls[0][0]
    expect(impInput.experiment).toBe('ltr-ranking')
    expect(impInput.variant).toBe('treatment')
    expect(impInput.impression_id).toBe('imp-x')
    expect(impInput.query).toBe('react hooks')
    expect(impInput.result_count).toBe(7)

    expect(recordLatency).toHaveBeenCalledWith({ experiment: 'ltr-ranking', variant: 'treatment', latency_ms: 250 })
    expect(recordError).toHaveBeenCalledWith({ experiment: 'ltr-ranking', variant: 'treatment' })
  })
})
