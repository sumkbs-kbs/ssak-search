/**
 * Logger Tests
 * Tests for structured logging, request ID generation, middleware, and audit events
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  logger,
  generateRequestId,
  getRequestId,
  createLoggingMiddleware,
  logAuthFailure,
  logRateLimitExceeded,
  logBackendError,
  getLogBuffer,
  clearLogBuffer,
} from '../../src/lib/logger'

describe('Logger', () => {
  beforeEach(() => {
    clearLogBuffer()
    vi.clearAllMocks()
  })

  afterEach(() => {
    clearLogBuffer()
  })

  describe('generateRequestId', () => {
    it('generates a unique ID', () => {
      const id1 = generateRequestId()
      const id2 = generateRequestId()
      expect(id1).toBeTruthy()
      expect(id2).toBeTruthy()
      expect(id1).not.toBe(id2)
    })

    it('returns a string with reasonable length', () => {
      const id = generateRequestId()
      expect(typeof id).toBe('string')
      expect(id.length).toBeGreaterThan(8)
    })
  })

  describe('getRequestId', () => {
    it('returns x-request-id header when present', () => {
      const headers = new Headers({ 'x-request-id': 'test-request-id-123' })
      expect(getRequestId(headers)).toBe('test-request-id-123')
    })

    it('returns cf-ray header when x-request-id is absent', () => {
      const headers = new Headers({ 'cf-ray': 'ray-abc-456' })
      expect(getRequestId(headers)).toBe('ray-abc-456')
    })

    it('returns traceparent header when x-request-id and cf-ray are absent', () => {
      const headers = new Headers({ traceparent: '00-trace-123-span-456' })
      expect(getRequestId(headers)).toBe('00-trace-123-span-456')
    })

    it('generates a new ID when no ID headers are present', () => {
      const headers = new Headers()
      const id = getRequestId(headers)
      expect(id).toBeTruthy()
      expect(typeof id).toBe('string')
    })

    it('prioritizes x-request-id over cf-ray', () => {
      const headers = new Headers({
        'x-request-id': 'primary-id',
        'cf-ray': 'secondary-id',
      })
      expect(getRequestId(headers)).toBe('primary-id')
    })
  })

  describe('Logger instance', () => {
    it('logs debug messages', () => {
      const spy = vi.spyOn(console, 'log')
      logger.debug('Debug message', { foo: 'bar' })
      expect(spy).toHaveBeenCalled()
      const buffer = getLogBuffer()
      expect(buffer.some(e => e.message === 'Debug message' && e.level === 'debug')).toBe(true)
      spy.mockRestore()
    })

    it('logs info messages', () => {
      const spy = vi.spyOn(console, 'info')
      logger.info('Info message')
      expect(spy).toHaveBeenCalled()
      const buffer = getLogBuffer()
      expect(buffer.some(e => e.message === 'Info message' && e.level === 'info')).toBe(true)
      spy.mockRestore()
    })

    it('logs warn messages', () => {
      const spy = vi.spyOn(console, 'warn')
      logger.warn('Warning message')
      expect(spy).toHaveBeenCalled()
      const buffer = getLogBuffer()
      expect(buffer.some(e => e.message === 'Warning message' && e.level === 'warn')).toBe(true)
      spy.mockRestore()
    })

    it('logs error messages', () => {
      const spy = vi.spyOn(console, 'error')
      logger.error('Error message')
      expect(spy).toHaveBeenCalled()
      const buffer = getLogBuffer()
      expect(buffer.some(e => e.message === 'Error message' && e.level === 'error')).toBe(true)
      spy.mockRestore()
    })

    it('merges context from base and call-level', () => {
      const child = logger.child({ requestId: 'req-123', method: 'GET' })
      const spy = vi.spyOn(console, 'info')
      child.info('Request started', { path: '/api/search' })
      expect(spy).toHaveBeenCalled()
      const loggedEntry = spy.mock.calls[0][0]
      const parsed = JSON.parse(loggedEntry)
      expect(parsed.requestId).toBe('req-123')
      expect(parsed.method).toBe('GET')
      expect(parsed.path).toBe('/api/search')
      spy.mockRestore()
    })

    it('includes Datadog-compatible fields in output', () => {
      const spy = vi.spyOn(console, 'info')
      logger.info('Test message')
      const loggedEntry = spy.mock.calls[0][0]
      const parsed = JSON.parse(loggedEntry)
      expect(parsed).toHaveProperty('ddsource', 'cloudflare-workers')
      expect(parsed).toHaveProperty('ddService', 'ssak-search')
      expect(parsed).toHaveProperty('ddVersion', '2.0.0')
      expect(parsed).toHaveProperty('service', 'ssak-search')
      expect(parsed).toHaveProperty('version', '2.0.0')
      expect(parsed).toHaveProperty('timestamp')
      expect(parsed).toHaveProperty('level', 'info')
      spy.mockRestore()
    })

    it('produces valid JSON output for log aggregation', () => {
      const spy = vi.spyOn(console, 'info')
      logger.info('Test message', { customField: 'value' })
      const loggedEntry = spy.mock.calls[0][0]
      expect(() => JSON.parse(loggedEntry)).not.toThrow()
      const parsed = JSON.parse(loggedEntry)
      expect(parsed.customField).toBe('value')
      spy.mockRestore()
    })

    it('preserves ddEnv override from context', () => {
      const spy = vi.spyOn(console, 'info')
      logger.info('Test', { ddEnv: 'staging' })
      const parsed = JSON.parse(spy.mock.calls[0][0])
      expect(parsed.ddEnv).toBe('staging')
      spy.mockRestore()
    })
  })

  describe('Audit logging', () => {
    it('audit method logs as warn level with AUDIT: prefix', () => {
      const spy = vi.spyOn(console, 'warn')
      logger.audit('security_event', { severity: 'high' })
      expect(spy).toHaveBeenCalled()
      const loggedEntry = spy.mock.calls[0][0]
      const parsed = JSON.parse(loggedEntry)
      expect(parsed.level).toBe('warn')
      expect(parsed.message).toBe('AUDIT: security_event')
      expect(parsed.eventType).toBe('security_event')
      spy.mockRestore()
    })

    it('defaults severity to medium when not specified', () => {
      const spy = vi.spyOn(console, 'warn')
      logger.audit('test_event')
      const parsed = JSON.parse(spy.mock.calls[0][0])
      expect(parsed.severity).toBe('medium')
      spy.mockRestore()
    })

    it('preserves custom severity when specified', () => {
      const spy = vi.spyOn(console, 'warn')
      logger.audit('critical_event', { severity: 'critical' })
      const parsed = JSON.parse(spy.mock.calls[0][0])
      expect(parsed.severity).toBe('critical')
      spy.mockRestore()
    })
  })

  describe('logAuthFailure', () => {
    it('logs auth failure as high-severity audit event', () => {
      const spy = vi.spyOn(console, 'warn')
      logAuthFailure('Invalid API key', { clientIp: '1.2.3.4' })
      expect(spy).toHaveBeenCalled()
      const warnCalls = spy.mock.calls
      const auditEntry = warnCalls.find(c => JSON.parse(c[0]).message === 'AUDIT: auth_failure')
      expect(auditEntry).toBeDefined()
      const parsed = JSON.parse(auditEntry![0])
      expect(parsed.eventType).toBe('auth_failure')
      expect(parsed.severity).toBe('high')
      spy.mockRestore()
    })

    it('includes client IP in context', () => {
      const spy = vi.spyOn(console, 'warn')
      logAuthFailure('Invalid', { clientIp: '192.168.1.1' })
      const warnCalls = spy.mock.calls
      const auditEntry = warnCalls.find(c => JSON.parse(c[0]).message === 'AUDIT: auth_failure')
      const parsed = JSON.parse(auditEntry![0])
      expect(parsed.clientIp).toBe('192.168.1.1')
      spy.mockRestore()
    })
  })

  describe('logRateLimitExceeded', () => {
    it('logs rate limit as medium-severity audit event', () => {
      const spy = vi.spyOn(console, 'warn')
      logRateLimitExceeded('1.2.3.4')
      const warnCalls = spy.mock.calls
      const auditEntry = warnCalls.find(c => JSON.parse(c[0]).message === 'AUDIT: rate_limit_exceeded')
      const parsed = JSON.parse(auditEntry![0])
      expect(parsed.eventType).toBe('rate_limit')
      expect(parsed.severity).toBe('medium')
      expect(parsed.clientIp).toBe('1.2.3.4')
      spy.mockRestore()
    })

    it('preserves additional context', () => {
      const spy = vi.spyOn(console, 'warn')
      logRateLimitExceeded('1.2.3.4', { remaining: 0, path: '/api/search' })
      const warnCalls = spy.mock.calls
      const auditEntry = warnCalls.find(c => JSON.parse(c[0]).message === 'AUDIT: rate_limit_exceeded')
      const parsed = JSON.parse(auditEntry![0])
      expect(parsed.remaining).toBe(0)
      expect(parsed.path).toBe('/api/search')
      spy.mockRestore()
    })
  })

  describe('logBackendError', () => {
    it('logs backend error with backend name and URL', () => {
      const spy = vi.spyOn(console, 'warn')
      logBackendError('bing', 'https://bing.com/search', new Error('Connection failed'))
      const warnCalls = spy.mock.calls
      const auditEntry = warnCalls.find(c => JSON.parse(c[0]).message === 'AUDIT: backend_error')
      const parsed = JSON.parse(auditEntry![0])
      expect(parsed.eventType).toBe('backend_error')
      expect(parsed.resource).toBe('bing')
      expect(parsed.error).toBe('Connection failed')
      spy.mockRestore()
    })

    it('handles non-Error error objects', () => {
      const spy = vi.spyOn(console, 'warn')
      logBackendError('naver', 'https://naver.com', 'string error message')
      const warnCalls = spy.mock.calls
      const auditEntry = warnCalls.find(c => JSON.parse(c[0]).message === 'AUDIT: backend_error')
      const parsed = JSON.parse(auditEntry![0])
      expect(parsed.error).toBe('string error message')
      spy.mockRestore()
    })
  })

  describe('Log buffer management', () => {
    it('getLogBuffer returns array of log entries', () => {
      logger.info('test1')
      logger.warn('test2')
      const buffer = getLogBuffer()
      expect(Array.isArray(buffer)).toBe(true)
      expect(buffer.length).toBeGreaterThanOrEqual(2)
      expect(buffer.some(e => e.message === 'test1')).toBe(true)
      expect(buffer.some(e => e.message === 'test2')).toBe(true)
    })

    it('clearLogBuffer empties the buffer', () => {
      logger.info('test')
      expect(getLogBuffer().length).toBeGreaterThan(0)
      clearLogBuffer()
      expect(getLogBuffer().length).toBe(0)
    })

    it('returns a copy of the buffer (not a reference)', () => {
      logger.info('test')
      const buf1 = getLogBuffer()
      const initialLength = buf1.length
      buf1.push({ level: 'info', message: 'injected', context: {}, timestamp: '' })
      const buf2 = getLogBuffer()
      expect(buf2.length).toBe(initialLength)
    })
  })

  describe('createLoggingMiddleware', () => {
    it('returns a middleware function', () => {
      const middleware = createLoggingMiddleware()
      expect(typeof middleware).toBe('function')
    })

    it('accepts logging options without throwing', () => {
      const middleware = createLoggingMiddleware({
        logCached: true,
        ddEnv: 'staging',
        baseContext: { customField: 'value' },
      })
      expect(typeof middleware).toBe('function')
    })

    it('logs request start and completion for successful requests', async () => {
      const consoleSpy = vi.spyOn(console, 'info')
      const middleware = createLoggingMiddleware()
      const mockContext: any = {
        req: {
          raw: {
            headers: new Headers({ 'x-request-id': 'test-id' }),
            signal: { addEventListener: () => {} },
          },
          method: 'GET',
          path: '/api/search',
          header: (name: string) => mockContext.req.raw.headers.get(name),
        },
        res: {
          status: 200,
          headers: new Headers(),
        },
      }

      await middleware(mockContext, async () => {
        // Simulate next()
      })

      expect(consoleSpy).toHaveBeenCalled()
      const starts = consoleSpy.mock.calls.filter(c => JSON.parse(c[0]).message === 'Request started')
      const completes = consoleSpy.mock.calls.filter(c => JSON.parse(c[0]).message === 'Request completed')
      expect(starts.length).toBeGreaterThanOrEqual(1)
      expect(completes.length).toBeGreaterThanOrEqual(1)
      consoleSpy.mockRestore()
    })

    it('includes request ID in response headers', async () => {
      const middleware = createLoggingMiddleware()
      const mockHeaders = new Headers({ 'x-request-id': 'injected-id' })
      mockHeaders.set = vi.fn()
      const mockContext: any = {
        req: {
          raw: { headers: new Headers({ 'x-request-id': 'injected-id' }), signal: { addEventListener: () => {} } },
          method: 'GET',
          path: '/api/search',
          header: (name: string) => mockHeaders.get(name),
        },
        res: {
          status: 200,
          headers: {
            set: vi.fn(),
            get: vi.fn(() => null),
          },
        },
      }

      await middleware(mockContext, async () => {})
      expect(mockContext.res.headers.set).toHaveBeenCalledWith('x-request-id', 'injected-id')
    })

    it('logs request failed audit event when handler throws', async () => {
      const warnSpy = vi.spyOn(console, 'warn')
      const middleware = createLoggingMiddleware()
      const mockContext: any = {
        req: {
          raw: { headers: new Headers(), signal: { addEventListener: () => {} } },
          method: 'POST',
          path: '/api/search',
          header: () => null,
        },
        res: {
          status: 500,
          headers: new Response().headers,
        },
      }

      await expect(
        middleware(mockContext, async () => {
          throw new Error('Handler failed')
        }),
      ).rejects.toThrow('Handler failed')

      const auditLogs = warnSpy.mock.calls.filter(c => {
        try {
          const parsed = JSON.parse(c[0])
          return parsed.message === 'AUDIT: request_failed'
        } catch {
          return false
        }
      })
      expect(auditLogs.length).toBeGreaterThanOrEqual(1)
      const parsed = JSON.parse(auditLogs[0][0])
      expect(parsed.severity).toBe('high')
      expect(parsed.error).toBe('Handler failed')
      warnSpy.mockRestore()
    })
  })

  describe('Child logger', () => {
    it('inherits context from parent', () => {
      const parent = logger.child({ requestId: 'parent-id' })
      const child = parent.child({ path: '/api/search' })
      const spy = vi.spyOn(console, 'info')
      child.info('test')
      const parsed = JSON.parse(spy.mock.calls[0][0])
      expect(parsed.requestId).toBe('parent-id')
      expect(parsed.path).toBe('/api/search')
      spy.mockRestore()
    })

    it('child can override parent context', () => {
      const parent = logger.child({ requestId: 'parent-id' })
      const child = parent.child({ requestId: 'child-id' })
      const spy = vi.spyOn(console, 'info')
      child.info('test')
      const parsed = JSON.parse(spy.mock.calls[0][0])
      expect(parsed.requestId).toBe('child-id')
      spy.mockRestore()
    })
  })
})