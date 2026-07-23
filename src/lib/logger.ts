/**
 * Structured Logger with Audit Trail & Aggregation Compatibility
 *
 * Features:
 * - JSON structured output for log aggregation
 * - Request ID generation/propagation via headers
 * - Log levels: debug, info, warn, error
 * - Context enrichment (request metadata, latency, etc.)
 * - Audit event logging (auth failures, admin actions, suspicious activity)
 * - Datadog/OpenTelemetry-compatible field names for log shipping
 * - Cloudflare Workers compatible (no Node.js deps)
 *
 * For full audit retention: configure Cloudflare Logpush → R2/HTTP endpoint
 * See: https://developers.cloudflare.com/logs/logpush/
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error'

export interface LogContext {
  requestId?: string
  method?: string
  path?: string
  statusCode?: number
  latencyMs?: number
  userAgent?: string
  clientIp?: string
  error?: string
  stack?: string
  // Datadog/OpenTelemetry compatible fields
  service?: string
  version?: string
  traceId?: string
  spanId?: string
  ddsource?: string
  ddService?: string
  ddEnv?: string
  ddVersion?: string
  // Audit event fields
  eventType?: string // 'auth_failure' | 'rate_limit' | 'admin' | 'error' | etc.
  severity?: 'low' | 'medium' | 'high' | 'critical'
  actor?: string // user identifier (when applicable)
  resource?: string // resource being accessed
  [key: string]: unknown
}

export interface Logger {
  debug(message: string, context?: LogContext): void
  info(message: string, context?: LogContext): void
  warn(message: string, context?: LogContext): void
  error(message: string, context?: LogContext): void
  /** Log an audit event (always error or warn level) */
  audit(eventType: string, context?: LogContext): void
  child(baseContext: LogContext): Logger
}

// In-memory buffer for testing (max 1000 entries)
const logBuffer: Array<{ level: LogLevel; message: string; context: LogContext; timestamp: string }> = []
const MAX_BUFFER = 1000

/** Service identifier for log aggregation (Datadog/compatible systems use this) */
const SERVICE_NAME = 'search-engine-api'
const SERVICE_VERSION = '2.0.0'

/**
 * Format a log entry as a structured JSON line.
 * Output is compatible with Logpush, Datadog, Splunk, and oTel collectors.
 */
function formatLog(level: LogLevel, message: string, context: LogContext = {}): string {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    // Datadog-compatible fields
    ddsource: 'cloudflare-workers',
    ddService: SERVICE_NAME,
    ddEnv: context.ddEnv || (typeof globalThis !== 'undefined' && (globalThis as { ENV?: { ENVIRONMENT?: string } }).ENV?.ENVIRONMENT) || 'production',
    ddVersion: SERVICE_VERSION,
    // OpenTelemetry-compatible fields
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    ...context,
  }
  return JSON.stringify(entry)
}

function pushBuffer(level: LogLevel, message: string, context: LogContext): void {
  logBuffer.push({ level, message, context, timestamp: new Date().toISOString() })
  if (logBuffer.length > MAX_BUFFER) logBuffer.shift()
}

function createLogger(baseContext: LogContext = {}): Logger {
  const log = (level: LogLevel, message: string, context: LogContext = {}) => {
    const mergedContext = { ...baseContext, ...context }
    const formatted = formatLog(level, message, mergedContext)
    // Cloudflare Workers: console.log goes to Workers logs
    console[level === 'debug' ? 'log' : level](formatted)
    pushBuffer(level, message, mergedContext)
  }

  return {
    debug: (message: string, context?: LogContext) => log('debug', message, context),
    info: (message: string, context?: LogContext) => log('info', message, context),
    warn: (message: string, context?: LogContext) => log('warn', message, context),
    error: (message: string, context?: LogContext) => log('error', message, context),
    audit: (eventType: string, context: LogContext = {}) => {
      // Audit events are always warn+ to surface in alert queries
      log('warn', `AUDIT: ${eventType}`, {
        eventType,
        severity: context.severity || 'medium',
        ...context,
      })
    },
    child: (childContext: LogContext) => createLogger({ ...baseContext, ...childContext }),
  }
}

// Global default logger
export const logger = createLogger()

// Request ID generation
export function generateRequestId(): string {
  // Use crypto.randomUUID if available (Cloudflare Workers supports it)
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID()
  }
  // Fallback
  return `${Date.now()}-${Math.random().toString(36).substring(2, 15)}`
}

// Extract or generate request ID from headers
export function getRequestId(headers: Headers): string {
  return (
    headers.get('x-request-id') ||
    headers.get('cf-ray') || // Cloudflare Ray ID
    headers.get('traceparent') || // W3C Trace-Context trace ID
    generateRequestId()
  )
}

// Middleware factory for Hono
export interface LoggingOptions {
  /** Log all requests including cached ones */
  logCached?: boolean
  /** Service environment (e.g. 'production', 'staging') */
  ddEnv?: string
  /** Custom log fields to add to every log */
  baseContext?: LogContext
}

export function createLoggingMiddleware(opts: LoggingOptions = {}) {
  const { logCached = false, ddEnv, baseContext = {} } = opts
  return async (c: any, next: () => Promise<void>) => {
    const requestId = getRequestId(c.req.raw.headers)
    const startTime = Date.now()

    // Add request ID to response headers for tracing
    c.res.headers.set('x-request-id', requestId)

    const requestLogger = logger.child({
      requestId,
      method: c.req.method,
      path: c.req.path,
      clientIp: c.req.header('cf-connecting-ip') || c.req.header('x-forwarded-for') || 'unknown',
      userAgent: c.req.header('user-agent') || 'unknown',
      ddEnv,
      ...baseContext,
    })

    requestLogger.info('Request started')

    try {
      await next()

      const latencyMs = Date.now() - startTime
      const statusCode = c.res.status

      // Skip logging for cached responses if not requested
      if (statusCode === 200 && c.res.headers.get('x-from-cache') && !logCached) {
        return
      }

      requestLogger.info('Request completed', {
        statusCode,
        latencyMs,
      })
    } catch (err) {
      const latencyMs = Date.now() - startTime
      const error = err instanceof Error ? err : new Error(String(err))

      // Audit event for request failures
      requestLogger.audit('request_failed', {
        severity: 'high',
        error: error.message,
        stack: error.stack,
        latencyMs,
      })
      throw err
    }
  }
}

/**
 * Log an authentication failure event (for security audit trail).
 * These events should be shipped to a SIEM or alerting system via Logpush.
 */
export function logAuthFailure(reason: string, context: LogContext = {}): void {
  logger.audit('auth_failure', {
    severity: 'high',
    eventType: 'auth_failure',
    resource: '/api/*',
    ...context,
  })
  logger.warn(`Auth failure: ${reason}`, context)
}

/**
 * Log a rate limit exceeded event.
 */
export function logRateLimitExceeded(clientIp: string, context: LogContext = {}): void {
  logger.audit('rate_limit_exceeded', {
    severity: 'medium',
    eventType: 'rate_limit',
    clientIp,
    ...context,
  })
}

/**
 * Log a parse failure or backend rejection (for monitoring upstream changes).
 */
export function logBackendError(backend: string, url: string, error: unknown, context: LogContext = {}): void {
  logger.audit('backend_error', {
    severity: 'medium',
    eventType: 'backend_error',
    resource: backend,
    error: toError(error),
    ...context,
  })
}

// Utility to get buffered logs (for testing/debugging)
export function getLogBuffer(): typeof logBuffer {
  return [...logBuffer]
}

export function clearLogBuffer(): void {
  logBuffer.length = 0
}

export default logger

/**
 * Safely convert an unknown error value to a string for logging.
 *
 * Handles all error types:
 * - Error instances → err.message (with stack trace preserved in development)
 * - Objects → JSON.stringify (truncated to 500 chars to avoid log flooding)
 * - Primitives → String()
 *
 * Usage:
 *   logger.error('Operation failed:', { error: toError(err) })
 *
 * This eliminates TS2322 (unknown → string) errors from catch blocks
 * in one shot, without needing individual type casts at every call site.
 */
export function toError(err: unknown): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'object' && err !== null) {
    try {
      const json = JSON.stringify(err)
      return json.length > 500 ? json.slice(0, 500) + '…' : json
    } catch {
      return String(err)
    }
  }
  return String(err)
}