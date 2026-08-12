/**
 * S104-③-② 잔여 (2026-08-11): alert-capture worker.
 *
 * Temporary stand-in for a real Slack Incoming Webhook. The production deep
 * probe posts backend-down alerts to SLACK_WEBHOOK; registering this worker's
 * URL lets us verify the FULL production delivery path (cron → deep probe →
 * alertBackendDown → HTTP POST) live, without needing a Slack workspace webhook.
 *
 * It simply echoes the request as structured logs (visible via
 * `npx wrangler tail ssak-alert-capture`). Real Slack arrival still requires
 * a genuine Incoming Webhook URL — swap SLACK_WEBHOOK to that URL once
 * available and redeploy.
 */
import { logger } from './lib/logger'

export default {
  async fetch(request: Request): Promise<Response> {
    let body = ''
    try {
      body = await request.text()
    } catch {
      body = '<unreadable>'
    }
    logger.info('[alert-capture] received alert POST', {
      method: request.method,
      url: request.url,
      content_type: request.headers.get('content-type') ?? '',
      user_agent: request.headers.get('user-agent') ?? '',
      body_preview: body.slice(0, 400),
    })
    return new Response('ok', { status: 200 })
  },
}
