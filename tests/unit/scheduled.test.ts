/**
 * S104-③ tests — scheduled deep health probe.
 *
 * Covers: runDeepHealthProbe firing Slack alerts on down backends, the
 * scheduled handler running the probe without throwing, and the probe being
 * the ONLY quota-burning path (light /api/health stays fetch-free — asserted
 * in health-status.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/slack-alert', async (importOriginal) => {
  // Keep the real resolveWebhookUrl (S104-③-②) — mock only the network sender.
  const actual = await importOriginal<typeof import('../../src/lib/slack-alert')>()
  return {
    ...actual,
    alertBackendDown: vi.fn().mockResolvedValue(true),
  }
})

import type { AppBindings } from '../../src/types'
import { scheduled } from '../../src/scheduled'
import { runDeepHealthProbe, buildDeepProbeSummary } from '../../src/routes/health'
import { alertBackendDown } from '../../src/lib/slack-alert'
import { logger } from '../../src/lib/logger'

const waitUntil = vi.fn()

beforeEach(() => {
  vi.mocked(alertBackendDown).mockClear()
  waitUntil.mockClear()
})

/** Spy on logger.info — captures the structured probe summary without console noise. */
function spyLogInfo(): ReturnType<typeof vi.fn> {
  return vi.spyOn(logger, 'info').mockImplementation(() => {})
}

afterEach(() => {
  vi.unstubAllGlobals()
})

/** All probes healthy — every backend URL returns 200. */
function stubAllHealthy(): ReturnType<typeof vi.fn> {
  const mock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
  vi.stubGlobal('fetch', mock)
  return mock
}

describe('runDeepHealthProbe (S104-③ shared deep probe)', () => {
  it('probes all configured backends and reports operational', async () => {
    const fetchMock = stubAllHealthy()
    const data = await runDeepHealthProbe({} as AppBindings, { waitUntil })

    expect(fetchMock).toHaveBeenCalled()
    // brave is excluded (no BRAVE_API_KEY) — 7 required backends probed.
    expect(data.status).toBe('ok')
    expect(data.backends.github).toMatchObject({ status: 'operational' })
    expect(data.backends.bing).toMatchObject({ status: 'operational' })
    expect(data.backends.workers_ai).toEqual({ status: 'disabled', latency_ms: 0 })
  })

  it('fires a Slack alert when a backend probe reports down', async () => {
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).includes('github')) throw new Error('network down')
      return new Response('ok', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchMock)

    const data = await runDeepHealthProbe({ SLACK_WEBHOOK: 'https://hooks.slack.example/xxx' } as AppBindings, {
      waitUntil,
    })

    expect(data.backends.github).toMatchObject({ status: 'down' })
    expect(alertBackendDown).toHaveBeenCalledTimes(1)
    expect(alertBackendDown).toHaveBeenCalledWith(
      'https://hooks.slack.example/xxx',
      'github',
      expect.any(Number),
      'down',
    )
    expect(waitUntil).toHaveBeenCalledTimes(1) // fire-and-forget via waitUntil
  })

  it('does NOT alert when SLACK_WEBHOOK is unset even with a down backend', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('all down'))
    vi.stubGlobal('fetch', fetchMock)

    await runDeepHealthProbe({} as AppBindings, { waitUntil })
    expect(alertBackendDown).not.toHaveBeenCalled()
  })
})

describe('scheduled handler (cron)', () => {
  it('runs the deep probe on a cron tick and never throws', async () => {
    const fetchMock = stubAllHealthy()
    await expect(scheduled({ cron: '*/15 * * * *' }, {} as AppBindings, { waitUntil })).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalled()
  })

  it('survives a total probe failure (no unhandled rejection)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('probe infrastructure down')))
    await expect(scheduled({ cron: '*/15 * * * *' }, {} as AppBindings, { waitUntil })).resolves.toBeUndefined()
  })

  it('logs the structured summary with down_backends: none on a healthy tick', async () => {
    const infoSpy = spyLogInfo()
    try {
      stubAllHealthy()
      await scheduled({ cron: '*/15 * * * *' }, {} as AppBindings, { waitUntil })

      expect(infoSpy).toHaveBeenCalledWith(
        '[scheduled] deep health probe complete',
        expect.objectContaining({
          status: 'ok',
          down_backends: 'none',
          cron: '*/15 * * * *',
        }),
      )
    } finally {
      infoSpy.mockRestore()
    }
  })

  it('includes down backend names in the scheduled log summary (verify-do-binding input)', async () => {
    const infoSpy = spyLogInfo()
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
          if (String(input).includes('github')) throw new Error('network down')
          return new Response('ok', { status: 200 })
        }),
      )

      await scheduled({ cron: '*/15 * * * *' }, {} as AppBindings, { waitUntil })

      const summaryCalls = infoSpy.mock.calls.filter(([m]) => String(m).includes('deep health probe complete'))
      const last = summaryCalls[summaryCalls.length - 1]
      expect(last[1]).toMatchObject({ down_backends: 'github', status: 'partial_outage' })
    } finally {
      infoSpy.mockRestore()
    }
  })
})

describe('buildDeepProbeSummary (S104-③-③ shared summary)', () => {
  it('is a pure function mapping probe data to the log field shape', () => {
    const data = {
      status: 'partial_outage',
      backends: {
        github: { status: 'down', latency_ms: 100 },
        bing: { status: 'operational', latency_ms: 50 },
        wikipedia: { status: 'down', latency_ms: 200 },
      },
      rate_limiter: { mode: 'durable_object' as const, source: 'durable' as const, hosts_tracked: 4 },
    }
    const summary = buildDeepProbeSummary(data as never, 1234)
    expect(summary.down_backends).toBe('github,wikipedia')
    expect(summary.status).toBe('partial_outage')
    expect(summary.latency_ms).toBe(1234)
    expect(summary.rate_limiter_mode).toBe('durable_object')
    expect(summary.hosts_tracked).toBe(4)
  })

  it('reports none when no backend is down', () => {
    const summary = buildDeepProbeSummary({ status: 'ok', backends: { bing: { status: 'operational' } } } as never, 10)
    expect(summary.down_backends).toBe('none')
  })
})
