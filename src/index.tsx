import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { searchRoute } from './routes/search'
import { extractRoute } from './routes/extract'
import { healthRoute, metricsRoute } from './routes/health'
import { usageRoute } from './routes/usage'
import { imagesRoute } from './routes/images'
import { newsRoute } from './routes/news'
import { canaryRoute } from './routes/canary'
import { suggestRoute } from './routes/suggest'
import { researchRoute } from './routes/research'
import { chatRoute } from './routes/chat'
import { dashboardPage } from './pages/dashboard'
import { chatPage } from './pages/chat'
import { pageViewPage } from './pages/page-view'
import { docsPage } from './pages/docs'
import { statusPage } from './pages/status'
import { usagePage } from './pages/usage'
import { spacesPage } from './pages/spaces'
import { councilPage } from './pages/council'
import { RateLimiterDO } from './lib/rate-limiter-do'
import { ThreadDO } from './lib/thread-do'
import { PagesDO } from './lib/pages-do'
import { pagesRoute } from './routes/pages'
import { uploadRoute } from './routes/upload'
import { libraryRoute } from './routes/library'
import { councilRoute } from './routes/council'
import { profileRoute } from './routes/profile'
import { spacesRoute } from './routes/spaces'
import { videoRoute } from './routes/video'
import { productsRoute } from './routes/products'
import { LibraryDO } from './lib/library-do'
import { UserProfileDO } from './lib/user-profile-do'
import { SpaceDO } from './lib/space-do'
import { ApiKeyDO } from './lib/api-key-do'
import { keysRoute } from './routes/keys'
import { monitorRoute } from './routes/monitor'
import { openaiRoute } from './routes/openai'
import { analyticsProxyRoute } from './routes/analytics-proxy'
import { CrawlerDO } from './lib/crawler-do'
import { crawlRoute } from './routes/crawl'
import { indexRoute } from './routes/index'
import { blacklistRoute } from './routes/blacklist'
import { queueRoute } from './routes/queue'
import { createLoggingMiddleware } from './lib/logger'
import { securityMiddleware } from './lib/security-middleware'
import { wrapApp, sentryMiddleware } from './lib/sentry'
import type { AppBindings, ErrorResponse } from './types'
import openapiSpec from '../openapi.yaml?raw'

// Named export so Wrangler can discover the Durable Object in dev/preview mode
export { RateLimiterDO }
export { ThreadDO }
export { PagesDO }
export { LibraryDO }
export { UserProfileDO }
export { SpaceDO }
export { ApiKeyDO }
export { CrawlerDO }

const app = new Hono<{ Bindings: AppBindings }>()

// Sentry performance tracing (must be early in middleware chain)
// Captures request-level spans with method, path, and status code
app.use('*', sentryMiddleware)

// Structured logging middleware (must be first for full request coverage)
app.use('*', createLoggingMiddleware({
  ddEnv: 'production', // Override via Cloudflare Pages env vsn to set 'preview' dynamically
}))
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
  maxAge: 86400,
}))

// Security middleware — CSP, rate limiting, security headers
app.use('*', securityMiddleware)

// Metrics middleware — must be before routes to capture all requests
app.use('*', async (c, next) => {
  const { setMetricsEnv } = await import('./lib/metrics')
  setMetricsEnv(c.env)
  await next()
})

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// ============================================================
// API Routes
// ============================================================
app.route('/api/search', searchRoute)
app.route('/api/extract', extractRoute)
app.route('/api/health', healthRoute)
// Dedicated metrics route — separate Hono app so its `/` handler serves
// Prometheus text at /api/metrics (not /api/metrics/metrics as the previous
// shadow-mount via healthRoute did).
app.route('/api/metrics', metricsRoute)
app.route('/api/usage', usageRoute)
app.route('/api/images', imagesRoute)
app.route('/api/news', newsRoute)
app.route('/api/canary', canaryRoute)
app.route('/api/suggest', suggestRoute)
app.route('/api/research', researchRoute)
app.route('/api/chat', chatRoute)
app.route('/api/pages', pagesRoute)
app.route('/api/upload', uploadRoute)
app.route('/api/library', libraryRoute)
app.route('/api/council', councilRoute)
app.route('/api/profile', profileRoute)
app.route('/api/video', videoRoute)
app.route('/api/products', productsRoute)
app.route('/api/spaces', spacesRoute)
app.route('/api/keys', keysRoute)
app.route('/api/monitor', monitorRoute)
app.route('/api/analytics-proxy', analyticsProxyRoute)
app.route('/api/crawl', crawlRoute)
app.route('/api/index', indexRoute)
app.route('/api/blacklist', blacklistRoute)
app.route('/api/queue', queueRoute)
app.route('/v1', openaiRoute)

// API root - list available endpoints
app.get('/api', (c) => {
  return c.json({
    name: 'Self-Contained Search Engine API',
    version: '2.0.0',
    description: 'Tavily-compatible AI search engine API — no API keys required',
    endpoints: {
      search: {
        method: ['GET', 'POST'],
        path: '/api/search',
        description: 'Search the web and get structured results with optional AI answer',
        parameters: {
          focus: 'Focus mode: all, academic, news, writing, video, social, finance, math',
        },
      },
      extract: {
        method: ['GET', 'POST'],
        path: '/api/extract',
        description: 'Extract clean content from URLs (Tavily-compatible)',
      },
      health: {
        method: ['GET'],
        path: '/api/health',
        description: 'Live backend health check + circuit breaker status (cached 30s)',
      },
      metrics: {
        method: ['GET'],
        path: '/api/metrics',
        description: 'Prometheus-format metrics for scraping',
      },
      images: {
        method: ['GET', 'POST'],
        path: '/api/images',
        description: 'Image search with size/color/type filters',
      },
      news: {
        method: ['GET', 'POST'],
        path: '/api/news',
        description: 'News search with trending and source filtering',
      },
      canary: {
        method: ['GET'],
        path: '/api/canary',
        description: 'Parser regression detection (requires HEALTH_CANARY_ENABLED)',
      },
      suggest: {
        method: ['GET'],
        path: '/api/suggest',
        description: 'Query autocomplete suggestions',
      },
      research: {
        method: ['GET', 'POST'],
        path: '/api/research',
        description: 'Multi-step deep research with sub-query decomposition',
      },
      chat: {
        method: ['POST'],
        path: '/api/chat',
        description: 'Multi-turn conversational threads with context-aware research',
        parameters: {
          thread_id: 'Optional thread ID to continue an existing conversation',
        },
      },
      pages: {
        method: ['GET', 'POST', 'PUT', 'DELETE'],
        path: '/api/pages',
        description: 'Save and manage research reports as shareable pages',
      },
      upload: {
        method: ['POST', 'GET'],
        path: '/api/upload',
        description: 'Upload files (TXT/MD/PDF) for analysis with AI summarization',
      },
      products: {
        method: ['GET', 'POST'],
        path: '/api/products',
        description: 'Search Product Hunt and G2 for software products and reviews',
      },
      library: {
        method: ['GET', 'POST', 'PUT', 'DELETE'],
        path: '/api/library',
        description: 'Manage saved search collections and bookmarked results',
      },
      council: {
        method: ['POST', 'GET'],
        path: '/api/council',
        description: 'Multi-model comparison — send one query to multiple LLMs side-by-side',
      },
      profile: {
        method: ['GET', 'PUT', 'POST'],
        path: '/api/profile',
        description: 'User profiles, preferences, and domain visit tracking for personalization',
      },
      video: {
        method: ['GET', 'POST'],
        path: '/api/video',
        description: 'YouTube video search with optional transcript extraction (Phase 3.1b)',
      },
      spaces: {
        method: ['GET', 'POST', 'PUT', 'DELETE'],
        path: '/api/spaces',
        description: 'Spaces/Projects workspaces with files, instructions, and search context (Phase 3.3)',
      },
      crawl: {
        method: ['POST', 'GET', 'DELETE'],
        path: '/api/crawl',
        description: 'Web crawler — seed URLs for autonomous crawling, indexing, and content discovery (Phase 2.1)',
      },
      index: {
        method: ['POST', 'GET', 'DELETE'],
        path: '/api/index',
        description: 'Search index management — index URLs, semantic search, D1 schema init, stats, refresh scheduling (Phase 2.2)',
      },
    },
    docs: '/docs',
    dashboard: '/',
  })
})

// 404 for unknown API routes
app.all('/api/*', (c) => {
  return c.json<ErrorResponse>(
    { detail: `Unknown API endpoint: ${c.req.method} ${c.req.path}`, code: 'not_found' },
    404,
  )
})

// ============================================================
// Pages
// ============================================================
app.get('/docs', (c) => c.html(docsPage()))
app.get('/', (c) => c.html(dashboardPage()))
app.get('/chat', (c) => c.html(chatPage()))
app.get('/page/:id', (c) => c.html(pageViewPage()))
app.get('/status', (c) => c.html(statusPage()))
app.get('/usage', (c) => c.html(usagePage()))
app.get('/spaces', (c) => c.html(spacesPage()))
app.get('/council', (c) => c.html(councilPage()))

// ============================================================
// PWA Manifest
// ============================================================
const manifest = {
  name: 'Search Engine API',
  short_name: 'Search Engine',
  description: 'Self-contained AI search engine with multi-backend aggregation',
  start_url: '/',
  display: 'standalone',
  background_color: '#f8fafc',
  theme_color: '#6366f1',
  icons: [
    { src: 'data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' viewBox=\'0 0 100 100\'%3E%3Ctext y=\'.9em\' font-size=\'90\'%3E%26%23x1F50D%3B%3C/text%3E%3C/svg%3E', sizes: 'any', type: 'image/svg+xml' },
  ],
}

app.get('/manifest.json', (c) => {
  return c.json(manifest)
})

// ============================================================
// OpenAPI Spec
// ============================================================
app.get('/openapi.yaml', (c) => {
  return new Response(openapiSpec, {
    headers: { 'Content-Type': 'text/yaml; charset=utf-8' },
  })
})

// Wrap with Sentry APM for error tracking and performance monitoring.
// SENTRY_DSN must be configured via Cloudflare Pages secret.
// Without SENTRY_DSN, Sentry is a no-op (no errors, no traces).
export default wrapApp(app, {
  tracesSampleRate: 0.1, // 10% sampling for performance traces
})