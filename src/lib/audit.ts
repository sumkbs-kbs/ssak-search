/**
 * Audit Logger — Security and Compliance Event Trail
 *
 * Provides structured logging for security-sensitive events that must be:
 * - Shipped to Cloudflare Logpush for retention (separate from app logs)
 * - Alertable on (auth failures, rate limit abuse, SSRF attempts, etc.)
 * - Compatible with Datadog/Splunk ingestion
 *
 * Logpush setup:
 *   Cloudflare Dashboard → Workers & Pages → Logs & Analytics → Logs → Logpush
 *   → Add job → select fields (custom log fields are supported)
 *   → Destination: R2 bucket or HTTP endpoint (e.g. Datadog Logs Intake)
 *
 * For SIEM/alerting, ship to:
 * - Datadog: https://http-intake.logs.datadoghq.com/api/v2/logs
 * - Splunk: https://<host>.splunkcloud.com/services/collector/event
 * - S3: via Cloudflare Logpush → R2 → S3 lifecycle
 */

import { logger } from './logger'

export type AuditEventType =
  | 'auth_failure'
  | 'auth_success'
  | 'rate_limit_exceeded'
  | 'ssrf_attempt'
  | 'invalid_input'
  | 'backend_error'
  | 'circuit_breaker_tripped'
  | 'admin_action'
  | 'config_change'
  | 'secret_access'
  | 'prompt_injection'

export type AuditSeverity = 'low' | 'medium' | 'high' | 'critical'

export interface AuditEvent {
  eventType: AuditEventType
  severity: AuditSeverity
  /** Resource being accessed (URL path, endpoint name, etc.) */
  resource?: string
  /** Acting client (IP, API key hash, user identifier) */
  actor?: string
  /** Outcome description */
  outcome: 'success' | 'failure' | 'blocked'
  /** Free-form additional context */
  context?: Record<string, unknown>
}

const AUDIT_PREFIX = 'AUDIT_SECURITY:'

/**
 * Emit a security audit event. Always logged at warn+ level for visibility.
 */
export function audit(event: AuditEvent): void {
  const timestamp = new Date().toISOString()
  const message = `${AUDIT_PREFIX} ${event.eventType}`

  // Structured log with all event fields
  logger.warn(message, {
    audit: 'true', // Flag for Logpush field selection
    severity: event.severity, // Also at top-level for Datadog/Logpush queries
    eventType: event.eventType,
    outcome: event.outcome,
    auditEventType: event.eventType,
    auditSeverity: event.severity,
    auditOutcome: event.outcome,
    auditTimestamp: timestamp,
    resource: event.resource,
    actor: event.actor,
    ...event.context,
  })

  // Critical events also go to console.error for Logpush capture
  if (event.severity === 'critical') {
    logger.error(`${AUDIT_PREFIX} CRITICAL ${event.eventType}`, {
      audit: 'true',
      severity: event.severity,
      eventType: event.eventType,
      outcome: event.outcome,
      auditEventType: event.eventType,
      auditSeverity: event.severity,
      auditOutcome: event.outcome,
      auditTimestamp: timestamp,
      resource: event.resource,
      actor: event.actor,
      ...event.context,
    })
  }
}

/**
 * Convenience: log a failed authentication attempt.
 */
export function auditAuthFailure(opts: {
  reason: string
  clientIp: string
  resource: string
  attempt?: 'bearer' | 'x-api-key' | 'none'
}): void {
  audit({
    eventType: 'auth_failure',
    severity: 'high',
    outcome: 'blocked',
    resource: opts.resource,
    actor: opts.clientIp,
    context: {
      reason: opts.reason,
      attemptType: opts.attempt || 'unknown',
    },
  })
}

/**
 * Convenience: log a successful auth (useful for elevation events).
 */
export function auditAuthSuccess(opts: {
  clientIp: string
  resource: string
  authMethod: 'bearer' | 'x-api-key'
}): void {
  audit({
    eventType: 'auth_success',
    severity: 'low',
    outcome: 'success',
    resource: opts.resource,
    actor: opts.clientIp,
    context: {
      authMethod: opts.authMethod,
    },
  })
}

/**
 * Convenience: log when a client exceeds rate limits.
 */
export function auditRateLimit(clientIp: string, resource: string, limit: number): void {
  audit({
    eventType: 'rate_limit_exceeded',
    severity: 'medium',
    outcome: 'blocked',
    resource,
    actor: clientIp,
    context: { limit },
  })
}

/**
 * Convenience: log an SSRF attempt (private IP, metadata endpoint, etc.).
 */
export function auditSsrfAttempt(url: string, reason: string, clientIp: string): void {
  audit({
    eventType: 'ssrf_attempt',
    severity: 'critical',
    outcome: 'blocked',
    resource: url,
    actor: clientIp,
    context: { reason },
  })
}

/**
 * Convenience: log an upstream backend error (for parser regression detection).
 */
export function auditBackendError(backend: string, url: string, error: string): void {
  audit({
    eventType: 'backend_error',
    severity: 'medium',
    outcome: 'failure',
    resource: `${backend}:${url}`,
    context: { backend, error },
  })
}

/**
 * Convenience: log when the circuit breaker trips for a backend.
 */
export function auditCircuitTripped(host: string, failures: number): void {
  audit({
    eventType: 'circuit_breaker_tripped',
    severity: 'high',
    outcome: 'failure',
    resource: host,
    context: { host, failures },
  })
}

/**
 * Convenience: log a prompt-injection attempt detected in untrusted search
 * content (06 Security Review — S3). The offending source is quarantined from
 * the LLM evidence pool and the event is shipped to Logpush/SIEM.
 */
export function auditPromptInjection(opts: {
  sourceUrl: string
  patterns: string[]
  severity: 'low' | 'medium' | 'high'
  stage: string
}): void {
  audit({
    eventType: 'prompt_injection',
    severity: opts.severity,
    outcome: 'blocked',
    resource: opts.sourceUrl,
    context: {
      patterns: opts.patterns.join(','),
      stage: opts.stage,
    },
  })
}

export default audit