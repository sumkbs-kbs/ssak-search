/**
 * S104-③-fix tests — cron-probe scheduler worker.
 *
 * Covers: the scheduled handler invoking the Pages deep probe URL, parsing
 * down_backends from the response, logging the structured summary, and never
 * throwing on trigger failure (scheduler must be silent-safe).
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { scheduled } from '../../src/cron-probe'
import { logger } from '../../src/lib/logger'

const waitUntil = vi.fn()

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function healthJson(overrides: { status?: string; down?: string[] } = {}): Response {
  const backends: Record<string, { status: string }> = {
    bing: { status: 'operational' },
    naver: { status: 'operational' },
    wikipedia: { status: overrides.down?.includes('wikipedia') ? 'down' : 'operational' },
    github: { status: overrides.down?.includes('github') ? 'down' : 'operational' },
  }
  return new Response(JSON.stringify({ status: overrides.status ?? 'ok', backends }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('cron-probe scheduled handler (S104-③-fix)', () => {
  it('invokes the Pages deep probe URL and logs the structured summary', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const fetchMock = vi.fn().mockResolvedValue(healthJson())
    vi.stubGlobal('fetch', fetchMock)

    await scheduled({ cron: '*/15 * * * *' }, {}, { waitUntil })

    expect(fetchMock).toHaveBeenCalledWith(
      'https://search-engine-api.pages.dev/api/health?depth=full',
      expect.objectContaining({ headers: { 'User-Agent': 'ssak-cron-probe/1.0' } }),
    )
    expect(infoSpy).toHaveBeenCalledWith(
      '[cron-probe] deep health probe triggered',
      expect.objectContaining({
        http_status: 200,
        probe_status: 'ok',
        down_backends: 'none',
        cron: '*/15 * * * *',
      }),
    )
  })

  it('parses down backends from the probe response body', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(healthJson({ status: 'partial_outage', down: ['wikipedia', 'github'] }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, articleCount: 987, outletCount: 21 }), { status: 200 }),
      )
    vi.stubGlobal('fetch', fetchMock)

    await scheduled(
      { cron: '*/15 * * * *' },
      { PROBE_URL: 'https://staging.search-engine-api.pages.dev' },
      { waitUntil },
    )

    const calls = infoSpy.mock.calls.filter(([m]) => String(m).includes('[cron-probe]'))
    expect(calls.find(([m]) => String(m).includes('deep health probe'))![1]).toMatchObject({
      probe_status: 'partial_outage',
      down_backends: 'wikipedia,github',
    })
    // P2-2: 같은 틱에서 뉴스 허브 refresh 를 호출하고 결과를 로깅한다.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://staging.search-engine-api.pages.dev/api/news-hub/refresh',
      expect.objectContaining({ method: 'POST' }),
    )
    expect(calls.find(([m]) => String(m).includes('news hub refresh'))![1]).toMatchObject({
      ok: true,
      articles: 987,
      outlets: 21,
    })
  })

  it('never throws on a failed trigger and logs the error', async () => {
    const errorSpy = vi.spyOn(logger, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network unreachable')))

    await expect(scheduled({ cron: '*/15 * * * *' }, {}, { waitUntil })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledWith(
      '[cron-probe] trigger failed',
      expect.objectContaining({ error: 'network unreachable' }),
    )
  })

  it('records a non-200 probe response without throwing', async () => {
    const infoSpy = vi.spyOn(logger, 'info').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })))

    await scheduled({ cron: '*/15 * * * *' }, {}, { waitUntil })
    expect(infoSpy).toHaveBeenCalledWith(
      '[cron-probe] deep health probe triggered',
      expect.objectContaining({ http_status: 500, probe_status: 'unknown' }),
    )
  })
})
