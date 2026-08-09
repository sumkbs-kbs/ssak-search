/**
 * PagerDuty Event API v2 client (D.4).
 *
 * Sends incident events to PagerDuty via the Events API v2 endpoint.
 * Uses `dedup_key` (per alerting host/rule) so repeated alerts for the
 * same condition are deduplicated into a single open incident.
 *
 * Environment:
 *   PAGERDUTY_ROUTING_KEY — Events API v2 routing key (optional)
 *
 * Without PAGERDUTY_ROUTING_KEY, all send functions are no-ops (logged).
 */

import { logger } from './logger'

export interface PagerDutyEventInput {
  /** Incident summary shown in the PagerDuty UI */
  summary: string
  /** Source of the event (e.g. backend hostname) */
  source: string
  /** Severity: 'critical' | 'warning' | 'error' | 'info' */
  severity: 'critical' | 'warning' | 'error' | 'info'
  /** Dedup key — same key = same incident (auto-deduplicated) */
  dedupKey: string
}

const PD_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue'

/**
 * Send an incident event to PagerDuty.
 * No-op when the routing key is not configured.
 * Returns true when the event was accepted (HTTP 202).
 */
export async function sendPagerDutyEvent(routingKey: string | undefined, input: PagerDutyEventInput): Promise<boolean> {
  if (!routingKey) {
    logger.info('[PagerDuty] No routing key configured, event skipped', { summary: input.summary })
    return false
  }

  const payload: Record<string, unknown> = {
    routing_key: routingKey,
    event_action: 'trigger',
    dedup_key: input.dedupKey,
    payload: {
      summary: input.summary,
      source: input.source,
      severity: input.severity,
      custom_details: { dedup_key: input.dedupKey },
    },
  }

  try {
    const resp = await fetch(PD_EVENTS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (resp.status !== 202) {
      logger.warn('[PagerDuty] Event rejected', { status: resp.status, dedupKey: input.dedupKey })
      return false
    }
    logger.info('[PagerDuty] Event sent', { dedupKey: input.dedupKey })
    return true
  } catch (err) {
    logger.warn('[PagerDuty] Event send error', { error: String(err) })
    return false
  }
}
