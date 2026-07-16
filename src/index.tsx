import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { serveStatic } from 'hono/cloudflare-workers'
import { logger } from 'hono/logger'
import { searchRoute } from './routes/search'
import { extractRoute } from './routes/extract'
import { healthRoute } from './routes/health'
import { dashboardPage } from './pages/dashboard'
import { docsPage } from './pages/docs'
import type { AppBindings, ErrorResponse } from './types'

const app = new Hono<{ Bindings: AppBindings }>()

// Global middleware
app.use('*', logger())
app.use('/api/*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization'],
  maxAge: 86400,
}))

// Serve static files
app.use('/static/*', serveStatic({ root: './public' }))

// ============================================================
// API Routes
// ============================================================
app.route('/api/search', searchRoute)
app.route('/api/extract', extractRoute)
app.route('/api/health', healthRoute)

// API root - list available endpoints
app.get('/api', (c) => {
  return c.json({
    name: 'Search Engine API',
    version: '1.0.0',
    description: 'Tavily-compatible AI search engine API',
    endpoints: {
      search: {
        method: ['GET', 'POST'],
        path: '/api/search',
        description: 'Search the web and get structured results',
      },
      extract: {
        method: ['GET', 'POST'],
        path: '/api/extract',
        description: 'Extract clean content from URLs',
      },
      health: {
        method: ['GET'],
        path: '/api/health',
        description: 'Service health check',
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

export default app
