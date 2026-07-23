/**
 * Service Worker — Search Engine PWA
 *
 * Phase 2.2: Basic offline capability with cache-first strategy for static assets.
 * API requests are network-only to ensure fresh results.
 *
 * Cache strategy:
 * - Static assets (CSS, JS, fonts, icons): Cache-first (offline support)
 * - API calls (/api/*): Network-only (fresh results)
 * - Navigation: Network-first (fall back to cached page)
 */

const CACHE_NAME = 'search-engine-v1'
const STATIC_CACHE = 'search-engine-static-v1'

// Assets to pre-cache on install
const PRECACHE_URLS = [
  '/',
  '/chat',
  '/docs',
]

// Install event — pre-cache key pages
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) => {
      return cache.addAll(PRECACHE_URLS).catch(() => {
        // Pre-cache failure is non-fatal; pages will cache on first visit
        console.warn('[SW] Some pre-cache URLs failed')
      })
    }).then(() => {
      // Activate immediately without waiting for reload
      return self.skipWaiting()
    })
  )
})

// Activate event — clean old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME && name !== STATIC_CACHE)
          .map((name) => caches.delete(name))
      )
    }).then(() => {
      // Start controlling all clients immediately
      return self.clients.claim()
    })
  )
})

// Fetch event — routing strategy
self.addEventListener('fetch', (event) => {
  const { request } = event
  const url = new URL(request.url)

  // Skip non-GET and non-http(s) requests
  if (request.method !== 'GET' || !url.protocol.startsWith('http')) {
    return
  }

  // API requests — network only
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(networkOnly(request))
    return
  }

  // Static assets (fonts, styles, scripts from CDN) — cache first
  if (
    url.hostname.includes('cdn') ||
    url.hostname.includes('fonts.googleapis') ||
    url.hostname.includes('cdnjs.cloudflare')
  ) {
    event.respondWith(cacheFirst(request))
    return
  }

  // Navigation requests — network first with offline fallback
  if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request))
    return
  }

  // Everything else — network first
  event.respondWith(networkFirst(request))
})

/**
 * Cache-first strategy: serve from cache, update in background
 */
async function cacheFirst(request) {
  const cached = await caches.match(request)
  if (cached) {
    // Background update
    fetchAndCache(request).catch(() => {})
    return cached
  }
  return fetchAndCache(request)
}

/**
 * Network-first strategy: try network, fall back to cache
 */
async function networkFirst(request) {
  try {
    const response = await fetchAndCache(request)
    if (response) return response
  } catch (err) {
    // Network failed — try cache
  }
  const cached = await caches.match(request)
  if (cached) return cached

  // If both fail and it's a navigation, return cached root
  if (request.mode === 'navigate') {
    return caches.match('/')
  }

  return new Response('Offline', { status: 503 })
}

/**
 * Network-only strategy — never cache
 */
async function networkOnly(request) {
  return fetch(request)
}

/**
 * Fetch and cache a response
 */
async function fetchAndCache(request) {
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') {
    const cache = await caches.open(CACHE_NAME)
    // Don't await — fire and forget
    cache.put(request, response.clone()).catch(() => {})
  }
  return response
}
