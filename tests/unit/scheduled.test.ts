/**
 * S104-③ tests — scheduled deep health probe.
 *
 * Covers: runDeepHealthProbe firing Slack alerts on down backends, the
 * scheduled handler running the probe without throwing, and the probe being
 * the ONLY quota-burning path (light /api/health stays fetch-free — asserted
 * in health-status.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../src/lib/slack-alert', () => ({
  alertBackendDown: vi.fn().mockResolvedValue(true),
}))

import type { AppBindings } from '../../src/types'
import { scheduled } from '../../src/scheduled'
import { runDeepHealthProbe } from '../../src/routes/health'
import { alertBackendDown } from '../../src/lib/slack-alert'

const waitUntil = vi.fn()

beforeEach(() => {
  vi.mocked(alertBackendDown).mockClear()
  waitUntil.mockClear()
})

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
})
