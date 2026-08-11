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
import { sendSlackAlert, alertBackendDown, resolveWebhookUrl } from '../../src/lib/slack-alert'

afterEach(() => {
  vi.unstubAllGlobals()
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
