/**
 * Tests for audit logging module
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  audit,
  auditAuthFailure,
  auditAuthSuccess,
  auditRateLimit,
  auditSsrfAttempt,
  auditBackendError,
  auditCircuitTripped,
} from '../../src/lib/audit'
import { clearLogBuffer, getLogBuffer } from '../../src/lib/logger'

describe('Audit Module', () => {
  beforeEach(() => {
    clearLogBuffer()
  })

  it('emits events with structured fields', () => {
    audit({
      eventType: 'auth_failure',
      severity: 'high',
      outcome: 'blocked',
      resource: '/api/search',
      actor: '192.0.2.1',
      context: { reason: 'invalid_key' },
    })
    const logs = getLogBuffer()
    expect(logs.length).toBe(1)
    expect(logs[0].message).toContain('AUDIT_SECURITY:')
    expect(logs[0].context.eventType).toBe('auth_failure')
    expect(logs[0].context.actor).toBe('192.0.2.1')
  })

  it('includes audit flag for Logpush field selection', () => {
    audit({
      eventType: 'rate_limit_exceeded',
      severity: 'medium',
      outcome: 'blocked',
      resource: '/api/search',
    })
    const logs = getLogBuffer()
    expect(logs[0].context.audit).toBe('true')
  })

  it('logs critical events at error level for alerting', () => {
    audit({
      eventType: 'ssrf_attempt',
      severity: 'critical',
      outcome: 'blocked',
      resource: 'http://169.254.169.254/admin',
    })
    const logs = getLogBuffer()
    // Critical events generate both warn and error
    expect(logs.length).toBe(2)
    expect(logs.some((l) => l.level === 'error')).toBe(true)
  })

  describe('convenience functions', () => {
    it('auditAuthFailure captures threat context', () => {
      auditAuthFailure({
        reason: 'invalid_key',
        clientIp: '203.0.113.5',
        resource: '/api/search',
        attempt: 'bearer',
      })
      const logs = getLogBuffer()
      expect(logs[0].context.eventType).toBe('auth_failure')
      expect(logs[0].context.attemptType).toBe('bearer')
      expect(logs[0].context.reason).toBe('invalid_key')
    })

    it('auditAuthSuccess is low severity', () => {
      auditAuthSuccess({
        clientIp: '203.0.113.5',
        resource: '/api/search',
        authMethod: 'x-api-key',
      })
      const logs = getLogBuffer()
      expect(logs[0].context.severity).toBe('low')
      expect(logs[0].context.outcome).toBe('success')
    })

    it('auditRateLimit captures client + limit', () => {
      auditRateLimit('203.0.113.5', '/api/search', 30)
      const logs = getLogBuffer()
      expect(logs[0].context.eventType).toBe('rate_limit_exceeded')
      expect(logs[0].context.limit).toBe(30)
    })

    it('auditSsrfAttempt is critical for blocking', () => {
      auditSsrfAttempt('http://10.0.0.1/admin', 'private_ip', '192.0.2.1')
      const logs = getLogBuffer()
      expect(logs.some((l) => l.context.eventType === 'ssrf_attempt')).toBe(true)
      // Critical = deduplicated/warn + error
      expect(logs.some((l) => l.level === 'error')).toBe(true)
    })

    it('auditBackendError uses medium severity', () => {
      auditBackendError('bing', 'https://www.bing.com/search', 'HTTP 429')
      const logs = getLogBuffer()
      expect(logs[0].context.severity).toBe('medium')
    })

    it('auditCircuitTripped is high severity', () => {
      auditCircuitTripped('www.bing.com', 5)
      const logs = getLogBuffer()
      expect(logs[0].context.severity).toBe('high')
    })
  })
})
