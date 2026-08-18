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

import type { KVNamespace } from '@cloudflare/workers-types'
import { logger } from './logger'

// ============================================================
// Types
// ============================================================

/**
 * Alerting rule for the synthesis regeneration rate (agentic pipeline).
 *
 * regenerationRatio = low-confidence regenerations ÷ synthesis attempts.
 * When the rate rises, the trigger-confidence average distinguishes a
 * threshold-tuning problem (trigger avg ≈ gate threshold) from synthesis
 * quality degradation (trigger avg low).
 */
export interface AgenticAlertRule {
  /** Regeneration-ratio threshold above which the alert fires (strict >). */
  regenerationRateThreshold: number
  /**
   * Minimum synthesis attempts before the ratio is statistically meaningful.
   * Guards against single-request noise: 1 attempt / 1 regeneration = ratio
   * 1.0 but is NOT a signal.
   */
  minSynthesisAttempts: number
  /** Min seconds between alerts for this rule (KV + in-memory dedup). */
  cooldownSeconds: number
}

export const DEFAULT_AGENTIC_ALERT_RULE: AgenticAlertRule = {
  regenerationRateThreshold: 0.3,
  minSynthesisAttempts: 10,
  cooldownSeconds: 3600,
}

/**
 * Resolve the Slack webhook URL from either env name.
 *
 * The worker code historically reads `SLACK_WEBHOOK`, while README.md /
 * CLOUDFLARE_BINDINGS_GUIDE.md instruct configuring `ALERT_SLACK_WEBHOOK`
 * (S104-③-② naming mismatch — following the docs alone never delivered an
 * alert). Accept both so either configuration path works; explicit
 * SLACK_WEBHOOK wins when both are set.
 * Pure function — unit-testable without any network/mocks.
 */
export function resolveWebhookUrl(env: { SLACK_WEBHOOK?: string; ALERT_SLACK_WEBHOOK?: string }): string | undefined {
  return env.SLACK_WEBHOOK || env.ALERT_SLACK_WEBHOOK || undefined
}

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
export async function sendSlackAlert(webhookUrl: string | undefined, options: SlackAlertOptions): Promise<boolean> {
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
export async function alertWarning(webhookUrl: string | undefined, title: string, message: string): Promise<boolean> {
  return sendSlackAlert(webhookUrl, {
    title: `⚠️ ${title}`,
    message,
    color: 'warning',
  })
}

// ============================================================
// Agentic regeneration-rate alert (rule + dedup + sender)
// ============================================================

/**
 * Alert when the synthesis regeneration rate exceeds its threshold.
 *
 * The trigger-confidence field is the diagnostic: if it sits near the quality
 * gate threshold, the rate rise is a threshold-tuning problem; if it is low,
 * synthesis quality is degrading (LLM/prompt issue).
 */
export async function alertHighRegenerationRate(
  webhookUrl: string | undefined,
  params: {
    regenerationRatio: number
    synthesisAttempts: number
    synthesisRegenerations: number
    regenerationTriggerConfidenceAvg: number
    threshold: number
  },
): Promise<boolean> {
  const pct = (params.regenerationRatio * 100).toFixed(1)
  return sendSlackAlert(webhookUrl, {
    title: '🔁 High Synthesis Regeneration Rate',
    message: `Synthesis regeneration rate is *${pct}%* — above the *${(params.threshold * 100).toFixed(0)}%* threshold`,
    color: 'warning',
    fields: [
      { label: 'Regeneration Rate', value: `${pct}%`, short: true },
      { label: 'Attempts', value: String(params.synthesisAttempts), short: true },
      { label: 'Regenerations', value: String(params.synthesisRegenerations), short: true },
      { label: 'Trigger Confidence (avg)', value: params.regenerationTriggerConfidenceAvg.toFixed(3), short: true },
    ],
    context: `Trigger avg ≈ gate threshold → threshold tuning; trigger avg low → quality degradation. Checked at ${new Date().toISOString()}`,
  })
}

/**
 * Pure rule evaluation — trigger only above the threshold AND with a
 * statistically meaningful sample count (noise guard).
 */
export function evaluateRegenerationRateAlert(
  metrics: {
    synthesisAttempts: number
    synthesisRegenerations: number
    regenerationRatio: number
    regenerationTriggerConfidenceAvg: number
  },
  rule: AgenticAlertRule = DEFAULT_AGENTIC_ALERT_RULE,
): { triggered: boolean; reason?: string } {
  if (metrics.synthesisAttempts < rule.minSynthesisAttempts) {
    return {
      triggered: false,
      reason: `insufficient samples (${metrics.synthesisAttempts} < ${rule.minSynthesisAttempts})`,
    }
  }
  if (metrics.regenerationRatio > rule.regenerationRateThreshold) {
    return { triggered: true }
  }
  return { triggered: false, reason: 'within threshold' }
}

// Cross-isolate dedup: CACHE_KV (best-effort, first-writer wins — KV has no
// CAS so a concurrent trigger may double-send once per cooldown, acceptable
// for an operator alert) + an in-memory fast path for the same isolate.
const AGENTIC_ALERT_KEY = 'alert:regeneration-rate'
const inMemoryAlertTimestamps = new Map<string, number>()

/** Reset the in-memory dedup state (tests / manual re-arm). */
export function resetAgenticAlertCooldowns(): void {
  inMemoryAlertTimestamps.clear()
}

/**
 * Evaluate the regeneration-rate rule and send a Slack alert when it fires,
 * deduped to one alert per cooldown window across isolates (KV) and within an
 * isolate (in-memory). Fire-and-forget at the call site — never blocks the
 * request path (the sender swallows its own failures).
 */
export async function maybeAlertHighRegenerationRate(
  env: { SLACK_WEBHOOK?: string; ALERT_SLACK_WEBHOOK?: string; CACHE_KV?: Pick<KVNamespace, 'get' | 'put'> } | undefined,
  metrics: {
    synthesisAttempts: number
    synthesisRegenerations: number
    regenerationRatio: number
    regenerationTriggerConfidenceAvg: number
  },
  rule: AgenticAlertRule = DEFAULT_AGENTIC_ALERT_RULE,
): Promise<boolean> {
  const { triggered } = evaluateRegenerationRateAlert(metrics, rule)
  if (!triggered) return false

  const webhook = env ? resolveWebhookUrl(env) : undefined
  if (!webhook) return false

  const now = Date.now()
  const cooldownMs = rule.cooldownSeconds * 1000

  // In-memory fast path (same isolate)
  const lastInMem = inMemoryAlertTimestamps.get(AGENTIC_ALERT_KEY) ?? 0
  if (now - lastInMem < cooldownMs) return false

  // Cross-isolate dedup via KV claim (expires with the cooldown)
  const cacheKv = env?.CACHE_KV
  let lastKv = 0
  if (cacheKv) {
    try {
      const raw = await cacheKv.get(AGENTIC_ALERT_KEY)
      lastKv = raw ? Number(raw) : 0
    } catch (err) {
      logger.warn('[Slack] Regeneration-rate dedup KV read failed:', { error: String(err) })
    }
  }
  if (now - lastKv < cooldownMs) return false

  if (cacheKv) {
    try {
      await cacheKv.put(AGENTIC_ALERT_KEY, String(now), { expirationTtl: rule.cooldownSeconds })
    } catch (err) {
      logger.warn('[Slack] Regeneration-rate dedup KV write failed:', { error: String(err) })
    }
  }
  inMemoryAlertTimestamps.set(AGENTIC_ALERT_KEY, now)

  return alertHighRegenerationRate(webhook, {
    regenerationRatio: metrics.regenerationRatio,
    synthesisAttempts: metrics.synthesisAttempts,
    synthesisRegenerations: metrics.synthesisRegenerations,
    regenerationTriggerConfidenceAvg: metrics.regenerationTriggerConfidenceAvg,
    threshold: rule.regenerationRateThreshold,
  })
}
