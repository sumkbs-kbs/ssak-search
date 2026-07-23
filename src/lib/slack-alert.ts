/**
 * Slack Alert Utility
 *
 * Sends structured alerts to a Slack webhook for:
 * - Health check backend failures
 * - Eval regression detection
 * - Circuit breaker trips
 *
 * Environment:
 *   SLACK_WEBHOOK — Slack Incoming Webhook URL
 *
 * Without SLACK_WEBHOOK, all alert functions are no-ops (logged to stderr).
 */

import { logger } from './logger'

// ============================================================
// Types
// ============================================================

export interface SlackAlertOptions {
  /** Alert title / header */
  title: string
  /** Alert body text (markdown supported) */
  message: string
  /** Color for the sidebar: 'good' (green), 'warning' (orange), 'danger' (red) */
  color: 'good' | 'warning' | 'danger'
  /** Optional fields to display in a structured format */
  fields?: Array<{ label: string; value: string; short?: boolean }>
  /** Optional extra context line */
  context?: string
}

// ============================================================
// Core Sender
// ============================================================

/**
 * Send a structured alert to Slack via webhook.
 * No-op if SLACK_WEBHOOK is not configured.
 */
export async function sendSlackAlert(
  webhookUrl: string | undefined,
  options: SlackAlertOptions,
): Promise<boolean> {
  if (!webhookUrl) {
    logger.info('[Slack] No webhook configured, alert skipped', { title: options.title })
    return false
  }

  const { title, message, color, fields, context } = options

  const blocks: Array<Record<string, unknown>> = [
    {
      type: 'header',
      text: { type: 'plain_text', text: title, emoji: true },
    },
    {
      type: 'section',
      text: { type: 'mrkdwn', text: message },
    },
  ]

  if (fields && fields.length > 0) {
    blocks.push({
      type: 'section',
      fields: fields.map((f) => ({
        type: 'mrkdwn',
        text: `*${f.label}*\n${f.value}`,
      })),
    })
  }

  if (context) {
    blocks.push({
      type: 'context',
      elements: [{ type: 'mrkdwn', text: context }],
    })
  }

  const payload = {
    text: `${title} — ${message.slice(0, 100)}`,
    attachments: [{ color, blocks }],
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })

    if (!resp.ok) {
      logger.warn('[Slack] Webhook send failed', { status: resp.status })
      return false
    }

    logger.info('[Slack] Alert sent', { title })
    return true
  } catch (err) {
    logger.warn('[Slack] Webhook error', { error: String(err) })
    return false
  }
}

// ============================================================
// Convenience Senders
// ============================================================

/**
 * Alert when a backend goes down during health check.
 */
export async function alertBackendDown(
  webhookUrl: string | undefined,
  backendName: string,
  latencyMs: number,
  healthStatus: string,
): Promise<boolean> {
  return sendSlackAlert(webhookUrl, {
    title: `🔴 Backend Down: ${backendName}`,
    message: `Backend *${backendName}* is *${healthStatus}* (${latencyMs}ms)`,
    color: 'danger',
    fields: [
      { label: 'Backend', value: backendName, short: true },
      { label: 'Status', value: healthStatus, short: true },
      { label: 'Latency', value: `${latencyMs}ms`, short: true },
    ],
    context: `Health check at ${new Date().toISOString()}`,
  })
}

/**
 * Alert when circuit breaker trips for a backend.
 */
export async function alertCircuitTripped(
  webhookUrl: string | undefined,
  host: string,
  failures: number,
): Promise<boolean> {
  return sendSlackAlert(webhookUrl, {
    title: `⚡ Circuit Breaker Tripped: ${host}`,
    message: `Circuit breaker tripped for *${host}* after *${failures}* consecutive failures`,
    color: 'warning',
    fields: [
      { label: 'Host', value: host, short: true },
      { label: 'Failures', value: String(failures), short: true },
    ],
    context: `Automatic recovery will attempt after cooldown period`,
  })
}

/**
 * Alert when eval regression is detected.
 */
export async function alertEvalRegression(
  webhookUrl: string | undefined,
  params: {
    passRate: number
    failedQueries: number
    regressions: Array<{ queryId: string; metric: string; baseline: string; current: string }>
    avgTimeMs: number
  },
): Promise<boolean> {
  const { passRate, failedQueries, regressions, avgTimeMs } = params
  const pct = (passRate * 100).toFixed(1)

  const regressionText = regressions
    .slice(0, 5)
    .map((r) => `• *${r.queryId}*: ${r.metric} (was ${r.baseline}, now ${r.current})`)
    .join('\n')

  return sendSlackAlert(webhookUrl, {
    title: `⚠️ Eval Regression Detected`,
    message: `Pass rate dropped to *${pct}%* with *${failedQueries}* failures and *${regressions.length}* regressions`,
    color: 'danger',
    fields: [
      { label: 'Pass Rate', value: `${pct}%`, short: true },
      { label: 'Failed', value: String(failedQueries), short: true },
      { label: 'Avg Latency', value: `${avgTimeMs}ms`, short: true },
      { label: 'Regressions', value: String(regressions.length), short: true },
    ],
    context: regressionText || 'No specific regressions',
  })
}

/**
 * Alert for general warning (subrequest quota high, etc.)
 */
export async function alertWarning(
  webhookUrl: string | undefined,
  title: string,
  message: string,
): Promise<boolean> {
  return sendSlackAlert(webhookUrl, {
    title: `⚠️ ${title}`,
    message,
    color: 'warning',
  })
}
