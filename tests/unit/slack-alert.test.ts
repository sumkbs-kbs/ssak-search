/**
 * S104-③-② tests — Slack alert delivery path.
 *
 * Covers the ACTUAL HTTP delivery of sendSlackAlert/alertBackendDown (the
 * mechanism behind the deep-probe down-backend alerts) plus the webhook env
 * resolution that fixes the SLACK_WEBHOOK vs ALERT_SLACK_WEBHOOK naming
 * mismatch. Real Slack receipt additionally requires a webhook secret in the
 * Pages project — that part is an operator step, not a unit concern.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  sendSlackAlert,
  alertBackendDown,
  alertCircuitTripped,
  alertEvalRegression,
  alertWarning,
  alertHighRegenerationRate,
  evaluateRegenerationRateAlert,
  maybeAlertHighRegenerationRate,
  resetAgenticAlertCooldowns,
  DEFAULT_AGENTIC_ALERT_RULE,
  resolveWebhookUrl,
} from '../../src/lib/slack-alert'

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
  resetAgenticAlertCooldowns()
})

describe('sendSlackAlert (delivery path)', () => {
  it('POSTs the structured payload to the webhook and returns true on 200', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const sent = await sendSlackAlert('https://hooks.slack.example/services/T/B/X', {
      title: '🔴 Backend Down: github',
      message: 'Backend *github* is *down* (123ms)',
      color: 'danger',
      fields: [{ label: 'Backend', value: 'github', short: true }],
    })

    expect(sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe('https://hooks.slack.example/services/T/B/X')
    expect(init?.method).toBe('POST')

    const body = JSON.parse(String(init?.body))
    expect(body.text).toContain('Backend Down: github')
    expect(body.attachments[0].color).toBe('danger')
    expect(body.attachments[0].blocks[0]).toEqual({
      type: 'header',
      text: { type: 'plain_text', text: '🔴 Backend Down: github', emoji: true },
    })
    expect(body.attachments[0].blocks[1].text.text).toContain('*github*')
    expect(body.attachments[0].blocks[2].fields[0].text).toContain('github')
  })

  it('is a no-op (false, no fetch) when no webhook is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const sent = await sendSlackAlert(undefined, { title: 't', message: 'm', color: 'warning' })
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('returns false on a non-200 webhook response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('invalid_payload', { status: 400 })))
    const sent = await sendSlackAlert('https://hooks.slack.example/x', { title: 't', message: 'm', color: 'warning' })
    expect(sent).toBe(false)
  })

  it('returns false (never throws) when the webhook fetch fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')))
    const sent = await sendSlackAlert('https://hooks.slack.example/x', { title: 't', message: 'm', color: 'warning' })
    expect(sent).toBe(false)
  })
})

describe('alertBackendDown', () => {
  it('builds the down-backend alert and delivers it', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const sent = await alertBackendDown('https://hooks.slack.example/services/T/B/X', 'wikipedia', 842, 'down')
    expect(sent).toBe(true)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.attachments[0].color).toBe('danger')
    expect(body.attachments[0].blocks[0].text.text).toBe('🔴 Backend Down: wikipedia')
    const fieldText = body.attachments[0].blocks[2].fields.map((f: { text: string }) => f.text).join(' ')
    expect(fieldText).toContain('wikipedia')
    expect(fieldText).toContain('842ms')
  })
})

describe('alertCircuitTripped', () => {
  it('delivers the circuit-breaker alert with host + failure count', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const sent = await alertCircuitTripped('https://hooks.slack.example/services/T/B/X', 'news.naver.com', 5)
    expect(sent).toBe(true)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.attachments[0].color).toBe('warning')
    expect(body.attachments[0].blocks[0].text.text).toBe('⚡ Circuit Breaker Tripped: news.naver.com')
    const fieldText = body.attachments[0].blocks[2].fields.map((f: { text: string }) => f.text).join(' ')
    expect(fieldText).toContain('news.naver.com')
    expect(fieldText).toContain('5')
  })
})

describe('alertEvalRegression', () => {
  it('delivers regression details (truncated to 5)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const regressions = Array.from({ length: 7 }, (_, i) => ({
      queryId: `q${i}`,
      metric: 'pass_rate',
      baseline: '0.9',
      current: '0.6',
    }))
    const sent = await alertEvalRegression('https://hooks.slack.example/services/T/B/X', {
      passRate: 0.6,
      failedQueries: 4,
      regressions,
      avgTimeMs: 1234,
    })
    expect(sent).toBe(true)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.attachments[0].color).toBe('danger')
    expect(body.attachments[0].blocks[0].text.text).toBe('⚠️ Eval Regression Detected')
    expect(body.text).toContain('60.0%')
    // context shows at most 5 regressions
    expect(body.attachments[0].blocks[3].elements[0].text).toContain('q0')
    expect(body.attachments[0].blocks[3].elements[0].text).toContain('q4')
    expect(body.attachments[0].blocks[3].elements[0].text).not.toContain('q5')
  })

  it('uses the no-specific-regressions fallback context', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const sent = await alertEvalRegression('https://hooks.slack.example/services/T/B/X', {
      passRate: 1,
      failedQueries: 0,
      regressions: [],
      avgTimeMs: 500,
    })
    expect(sent).toBe(true)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.attachments[0].blocks[3].elements[0].text).toBe('No specific regressions')
  })
})

describe('alertHighRegenerationRate', () => {
  it('delivers the regeneration-rate alert with diagnostic fields', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const sent = await alertHighRegenerationRate('https://hooks.slack.example/services/T/B/X', {
      regenerationRatio: 0.45,
      synthesisAttempts: 40,
      synthesisRegenerations: 18,
      regenerationTriggerConfidenceAvg: 0.31,
      threshold: 0.3,
    })
    expect(sent).toBe(true)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.attachments[0].color).toBe('warning')
    expect(body.attachments[0].blocks[0].text.text).toBe('🔁 High Synthesis Regeneration Rate')
    expect(body.text).toContain('45.0%')
    const fieldText = body.attachments[0].blocks[2].fields.map((f: { text: string }) => f.text).join(' ')
    expect(fieldText).toContain('40')
    expect(fieldText).toContain('18')
    expect(fieldText).toContain('0.310')
  })
})

describe('evaluateRegenerationRateAlert', () => {
  const metrics = {
    synthesisAttempts: 20,
    synthesisRegenerations: 8,
    regenerationRatio: 0.4,
    regenerationTriggerConfidenceAvg: 0.3,
  }

  it('triggers when the ratio is above the threshold', () => {
    expect(evaluateRegenerationRateAlert(metrics).triggered).toBe(true)
  })

  it('does not trigger at or below the threshold (strict >)', () => {
    expect(evaluateRegenerationRateAlert({ ...metrics, regenerationRatio: 0.3 }).triggered).toBe(false)
    expect(evaluateRegenerationRateAlert({ ...metrics, regenerationRatio: 0.1 }).triggered).toBe(false)
  })

  it('does not trigger on statistically meaningless sample counts (noise guard)', () => {
    // 1 attempt / 1 regeneration → ratio 1.0, but a single sample is not a signal.
    const tiny = {
      synthesisAttempts: 1,
      synthesisRegenerations: 1,
      regenerationRatio: 1.0,
      regenerationTriggerConfidenceAvg: 0.2,
    }
    const r = evaluateRegenerationRateAlert(tiny)
    expect(r.triggered).toBe(false)
    expect(r.reason).toContain('insufficient samples')
  })
})

describe('maybeAlertHighRegenerationRate (rule + dedup)', () => {
  const metrics = {
    synthesisAttempts: 20,
    synthesisRegenerations: 10,
    regenerationRatio: 0.5,
    regenerationTriggerConfidenceAvg: 0.3,
  }
  const kv = () => ({
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  })

  it('sends when the rule triggers and a webhook is configured', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    const sent = await maybeAlertHighRegenerationRate(
      { SLACK_WEBHOOK: 'https://hooks.slack.example/x', CACHE_KV: kv() },
      metrics,
    )
    expect(sent).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('is a no-op without a webhook (no fetch, no KV writes)', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const store = kv()
    const sent = await maybeAlertHighRegenerationRate({ CACHE_KV: store }, metrics)
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(store.put).not.toHaveBeenCalled()
  })

  it('is a no-op when the rule does not trigger', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const sent = await maybeAlertHighRegenerationRate(
      { SLACK_WEBHOOK: 'https://hooks.slack.example/x', CACHE_KV: kv() },
      { ...metrics, regenerationRatio: 0.1 },
    )
    expect(sent).toBe(false)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('dedups within the cooldown and re-alerts after it expires (KV + in-memory)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)
    vi.useFakeTimers()
    const store = kv()
    const env = { SLACK_WEBHOOK: 'https://hooks.slack.example/x', CACHE_KV: store }
    const rule = { ...DEFAULT_AGENTIC_ALERT_RULE, cooldownSeconds: 60 }

    // First trigger → alert sent + cooldown claimed
    expect(await maybeAlertHighRegenerationRate(env, metrics, rule)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(store.put).toHaveBeenCalledTimes(1)
    // The KV claim is written with an expiration TTL equal to the cooldown.
    const putArgs = store.put.mock.calls[0]
    expect(putArgs[2]?.expirationTtl).toBe(60)

    // Second trigger within the cooldown → suppressed
    expect(await maybeAlertHighRegenerationRate(env, metrics, rule)).toBe(false)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    // After the cooldown passes the stale KV claim no longer suppresses
    vi.advanceTimersByTime(60_001)
    expect(await maybeAlertHighRegenerationRate(env, metrics, rule)).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('alertWarning', () => {
  it('delivers a generic warning alert', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('ok', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const sent = await alertWarning('https://hooks.slack.example/services/T/B/X', 'Subrequest Quota High', '90% used')
    expect(sent).toBe(true)

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body))
    expect(body.attachments[0].color).toBe('warning')
    expect(body.attachments[0].blocks[0].text.text).toBe('⚠️ Subrequest Quota High')
    expect(body.attachments[0].blocks[1].text.text).toBe('90% used')
  })
})

describe('resolveWebhookUrl (S104-③-② naming mismatch)', () => {
  it('reads SLACK_WEBHOOK', () => {
    expect(resolveWebhookUrl({ SLACK_WEBHOOK: 'https://hooks.slack.example/a' })).toBe('https://hooks.slack.example/a')
  })

  it('falls back to ALERT_SLACK_WEBHOOK (the documented name)', () => {
    expect(resolveWebhookUrl({ ALERT_SLACK_WEBHOOK: 'https://hooks.slack.example/b' })).toBe(
      'https://hooks.slack.example/b',
    )
  })

  it('prefers SLACK_WEBHOOK when both are set', () => {
    expect(
      resolveWebhookUrl({
        SLACK_WEBHOOK: 'https://hooks.slack.example/a',
        ALERT_SLACK_WEBHOOK: 'https://hooks.slack.example/b',
      }),
    ).toBe('https://hooks.slack.example/a')
  })

  it('returns undefined when neither is set', () => {
    expect(resolveWebhookUrl({})).toBeUndefined()
  })
})
