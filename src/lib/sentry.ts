/**
 * Sentry APM — Error Tracking & Performance Monitoring
 *
 * Integrates @sentry/cloudflare with the Hono application:
 * - Error capture: automatic + manual (captureException, captureMessage)
 * - Performance tracing: request-level spans via Hono middleware
 * - Context enrichment: request path, method, route, user agent
 *
 * Usage:
 *   import { wrapApp, sentryMiddleware } from './lib/sentry'
 *   export default wrapApp(app, { tracesSampleRate: 0.1 })
 *
 * Configuration:
 *   - SENTRY_DSN environment variable (required for error reporting)
 *   - tracesSampleRate controls performance tracing (0.0 - 1.0)
 */

import * as Sentry from '@sentry/cloudflare'
import type { AppBindings } from '../types'

// ============================================================
// Types
// ============================================================

export interface SentryOptions {
  /** Sentry DSN — falls back to env.SENTRY_DSN if not provided */
  dsn?: string
  /** Performance tracing sample rate (0.0-1.0, default 0.1 = 10%) */
  tracesSampleRate?: number
  /** Environment name (default: 'production') */
  environment?: string
  /** Release version string */
  release?: string
}

// ============================================================
// App Wrapper
// ============================================================

/**
 * Wrap a Hono app's fetch handler with Sentry error/performance monitoring.
 *
 * Usage:
 *   ```ts
 *   export default wrapApp(app, { tracesSampleRate: 0.1 })
 *   ```
 *
 * The wrapped export remains compatible with Cloudflare Pages Functions
 * and Durable Objects (DO exports should NOT be wrapped — they are
 * exported separately from index.tsx).
 */
export function wrapApp(
  honoApp: { fetch: (request: Request, env: AppBindings, ctx: ExecutionContext) => Response | Promise<Response> },
  options: SentryOptions = {},
): { fetch: (request: Request, env: AppBindings, ctx: ExecutionContext) => Response | Promise<Response> } {
  const { tracesSampleRate = 0.1 } = options

  return Sentry.withSentry(
    (env: AppBindings) => ({
      dsn: options.dsn || env.SENTRY_DSN || '',
      tracesSampleRate,
      environment: options.environment || env.ENVIRONMENT || 'production',
      release: options.release || '2.0.0',
      // Enable debug mode in development
      debug: (env.ENVIRONMENT || 'production') === 'development',
      // Denylist URLs that should not generate traces
      tracePropagationTargets: [/\/api\//, /\/v1\//],
      // Integration to deduplicate duplicate errors
      integrations: [
        Sentry.dedupeIntegration(),
      ],
    }),
    {
      async fetch(request: Request, env: AppBindings, ctx: ExecutionContext) {
        return honoApp.fetch(request, env, ctx)
      },
    },
  )
}

// ============================================================
// Hono Middleware — Request-level Performance Tracing
// ============================================================

/**
 * Hono middleware that creates a Sentry span for each request.
 *
 * Adds request metadata (method, path, route) to the span for
 * better performance breakdowns in the Sentry dashboard.
 *
 * Usage:
 *   ```ts
 *   app.use('*', sentryMiddleware)
 *   ```
 */
export function sentryMiddleware(c: any, next: () => Promise<void>): Promise<void> {
  return Sentry.startSpan(
    {
      name: `${c.req.method} ${c.req.path}`,
      op: 'http.server',
      attributes: {
        'http.method': c.req.method,
        'http.path': c.req.path,
        'http.route': c.req.routePath || c.req.path,
      },
    },
    async (span) => {
      try {
        await next()
        span?.setAttribute('http.status_code', c.res.status)
      } catch (err) {
        span?.setAttribute('http.status_code', 500)
        span?.setStatus({ code: 2, message: 'internal_error' })
        Sentry.captureException(err, {
          tags: {
            method: c.req.method,
            path: c.req.path,
          },
        })
        throw err
      }
    },
  )
}

// ============================================================
// Manual Error Capture Helpers
// ============================================================

/**
 * Capture a caught exception with context.
 * Safe to call even before Sentry is initialized (no-op without DSN).
 */
export function captureSentryException(
  error: unknown,
  context: {
    tags?: Record<string, string>
    extra?: Record<string, unknown>
    level?: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'
  } = {},
): void {
  Sentry.captureException(error, {
    tags: context.tags,
    extra: context.extra,
    level: context.level || 'error',
  })
}

/**
 * Capture a message for monitoring (e.g., unusual event, rate limit hit).
 */
export function captureSentryMessage(
  message: string,
  context: {
    tags?: Record<string, string>
    extra?: Record<string, unknown>
    level?: 'fatal' | 'error' | 'warning' | 'log' | 'info' | 'debug'
  } = {},
): void {
  Sentry.captureMessage(message, {
    tags: context.tags,
    extra: context.extra,
    level: context.level || 'info',
  })
}

/**
 * Start a custom span for tracking specific operations
 * (e.g., external API calls, database queries).
 *
 * Usage:
 *   ```ts
 *   const result = await traceOperation('bing.search', async (span) => {
 *     span.setAttribute('query', query)
 *     return await doSearch(query)
 *   })
 *   ```
 */
export async function traceOperation<T>(
  name: string,
  callback: (span: any) => Promise<T>,
  options: {
    op?: string
    attributes?: Record<string, string | number | boolean>
  } = {},
): Promise<T> {
  return Sentry.startSpan(
    {
      name,
      op: options.op || 'function',
      attributes: options.attributes,
    },
    callback,
  )
}
