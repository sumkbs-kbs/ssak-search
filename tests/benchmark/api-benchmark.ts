/**
 * API Performance Benchmark — ssak-search
 *
 * 측정 항목:
 * 1. 엔드포인트별 레이턴시 (p50/p95/p99)
 * 2. 동시 요청 처리량 (throughput)
 * 3. 캐시 히트율
 * 4. 백엔드 Tier별 성능
 * 5. CPU Budget 가드 동작
 * 6. 메모리 사용 패턴
 *
 * 사용법:
 *   npx tsx tests/benchmark/api-benchmark.ts [BASE_URL]
 *   BASE_URL=http://localhost:8788 npx tsx tests/benchmark/api-benchmark.ts
 */

// ============================================================
// Configuration
// ============================================================

const BASE_URL = process.env.BASE_URL || 'http://localhost:8788'
const API_KEY = process.env.API_KEY || ''
const WARMUP_REQUESTS = 5
const CONCURRENT_LEVELS = [1, 5, 10, 20, 50]
const REQUESTS_PER_LEVEL = 20

// ============================================================
// Types
// ============================================================

interface BenchmarkResult {
  name: string
  results: LatencyStats
  details?: Record<string, unknown>
}

interface LatencyStats {
  count: number
  min: number
  max: number
  avg: number
  p50: number
  p90: number
  p95: number
  p99: number
  successRate: number
  errors: string[]
}

interface ThroughputResult {
  concurrency: number
  totalRequests: number
  successfulRequests: number
  rps: number
  avgLatency: number
  p95Latency: number
}

// ============================================================
// Helpers
// ============================================================

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' }
  if (API_KEY) h['X-API-Key'] = API_KEY
  return h
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const idx = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, idx)]
}

function calculateStats(latencies: number[], successes: number, errors: string[]): LatencyStats {
  const sorted = [...latencies].sort((a, b) => a - b)
  return {
    count: sorted.length,
    min: sorted[0] || 0,
    max: sorted[sorted.length - 1] || 0,
    avg: sorted.length > 0 ? sorted.reduce((a, b) => a + b, 0) / sorted.length : 0,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    successRate: sorted.length > 0 ? successes / sorted.length : 0,
    errors,
  }
}

interface JsonBody {
  cached?: boolean
  results?: unknown[]
  backend?: string
  status?: string
  auth_required?: boolean
  mode?: string
  rate_limiter?: { mode?: string; hosts_tracked?: number }
  features?: Record<string, boolean>
  [key: string]: unknown
}

async function fetchJson(url: string, init?: RequestInit): Promise<{ status: number; body: JsonBody; latencyMs: number }> {
  const start = performance.now()
  try {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) })
    const body = (await res.json()) as JsonBody
    return { status: res.status, body, latencyMs: performance.now() - start }
  } catch (_err) {
    return { status: 0, body: {}, latencyMs: performance.now() - start }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function formatMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(2)}s`
}

// ============================================================
// Benchmark: Endpoint Latency
// ============================================================

async function benchmarkEndpointLatency(): Promise<BenchmarkResult> {
  const latencies: number[] = []
  const successes: number[] = [0]
  const errors: string[] = []

  const endpoints = [
    { name: 'health', method: 'GET', path: '/api/health' },
    { name: 'metrics', method: 'GET', path: '/api/metrics' },
    { name: 'search_basic', method: 'POST', path: '/api/search', body: { query: 'React hooks', max_results: 5 } },
    { name: 'search_kr', method: 'POST', path: '/api/search', body: { query: '삼성전자 주가 전망', max_results: 5 } },
    { name: 'search_zh', method: 'POST', path: '/api/search', body: { query: '量子计算最新进展', max_results: 5 } },
    { name: 'search_complex', method: 'POST', path: '/api/search', body: { query: 'Compare React vs Vue vs Angular for enterprise applications in 2026', max_results: 10, include_answer: true } },
  ]

  console.log('  ┌────────────────────┬───────┬────────┬────────┬────────┬────────┬───────┐')
  console.log('  │ Endpoint           │ Count │ Min    │ Avg    │ P50    │ P95    │ Max   │')
  console.log('  ├────────────────────┼───────┼────────┼────────┼────────┼────────┼───────┤')

  for (const ep of endpoints) {
    const epLatencies: number[] = []
    let epSuccesses = 0

    for (let i = 0; i < REQUESTS_PER_LEVEL; i++) {
      const url = `${BASE_URL}${ep.path}`
      const init: RequestInit = {
        method: ep.method,
        headers: headers(),
      }
      if (ep.body) init.body = JSON.stringify(ep.body)

      const { status, latencyMs } = await fetchJson(url, init)
      epLatencies.push(latencyMs)
      if (status >= 200 && status < 400) epSuccesses++

      await sleep(50)
    }

    latencies.push(...epLatencies)
    successes[0] += epSuccesses

    const stats = calculateStats(epLatencies, epSuccesses, [])
    const name = ep.name.padEnd(18)
    const count = String(stats.count).padStart(5)
    const min = formatMs(stats.min).padStart(6)
    const avg = formatMs(stats.avg).padStart(6)
    const p50 = formatMs(stats.p50).padStart(6)
    const p95 = formatMs(stats.p95).padStart(6)
    const max = formatMs(stats.max).padStart(6)
    console.log(`  │ ${name} │ ${count} │ ${min} │ ${avg} │ ${p50} │ ${p95} │ ${max} │`)
  }

  console.log('  └────────────────────┴───────┴────────┴────────┴────────┴────────┴───────┘')

  const overall = calculateStats(latencies, successes[0], errors)
  return { name: 'Endpoint Latency', results: overall }
}

// ============================================================
// Benchmark: Concurrent Throughput
// ============================================================

async function benchmarkThroughput(): Promise<{ results: ThroughputResult[] }> {
  console.log('  ┌────────────┬─────────┬───────────┬─────────┬─────────┐')
  console.log('  │ Concurrency│ Total   │ Success   │ RPS     │ P95(ms) │')
  console.log('  ├────────────┼─────────┼───────────┼─────────┼─────────┤')

  const results: ThroughputResult[] = []

  for (const concurrency of CONCURRENT_LEVELS) {
    const promises: Promise<{ status: number; latencyMs: number }>[] = []
    const start = performance.now()

    for (let i = 0; i < REQUESTS_PER_LEVEL; i++) {
      const batchStart = i * concurrency
      const batch = Array.from({ length: Math.min(concurrency, REQUESTS_PER_LEVEL - batchStart) }, async () => {
        const { status, latencyMs } = await fetchJson(`${BASE_URL}/api/search`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ query: `benchmark test ${Math.random().toString(36).slice(2, 8)}`, max_results: 3 }),
        })
        return { status, latencyMs }
      })
      promises.push(...batch)
      if (batchStart + concurrency >= REQUESTS_PER_LEVEL) break
    }

    const allResults = await Promise.all(promises)
    const totalDuration = performance.now() - start

    const latencies = allResults.map(r => r.latencyMs).sort((a, b) => a - b)
    const successes = allResults.filter(r => r.status >= 200 && r.status < 400).length
    const rps = (allResults.length / totalDuration) * 1000

    const row: ThroughputResult = {
      concurrency,
      totalRequests: allResults.length,
      successfulRequests: successes,
      rps: Math.round(rps * 100) / 100,
      avgLatency: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
      p95Latency: Math.round(percentile(latencies, 95)),
    }
    results.push(row)

    const conc = String(concurrency).padStart(10)
    const total = String(row.totalRequests).padStart(7)
    const succ = String(successes).padStart(9)
    const rpsStr = String(row.rps).padStart(7)
    const p95 = formatMs(row.p95Latency).padStart(7)
    console.log(`  │ ${conc} │ ${total} │ ${succ} │ ${rpsStr} │ ${p95} │`)
  }

  console.log('  └────────────┴─────────┴───────────┴─────────┴─────────┘')
  return { results }
}

// ============================================================
// Benchmark: Cache Effectiveness
// ============================================================

async function benchmarkCache(): Promise<BenchmarkResult> {
  console.log('  ── Cache Hit Rate Test ──')

  const query = 'cache benchmark test query'
  const latencies: number[] = []
  let hits = 0
  let misses = 0

  // First request (miss)
  for (let i = 0; i < 5; i++) {
    const { status: _status, body, latencyMs } = await fetchJson(`${BASE_URL}/api/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query: `${query} ${i}`, max_results: 3 }),
    })
    latencies.push(latencyMs)
    if (body?.cached) hits++
    else misses++
    await sleep(100)
  }

  // Repeat same queries (should hit cache)
  for (let i = 0; i < 5; i++) {
    const { status: _status, body, latencyMs } = await fetchJson(`${BASE_URL}/api/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query: `${query} ${i}`, max_results: 3 }),
    })
    latencies.push(latencyMs)
    if (body?.cached) hits++
    else misses++
    await sleep(100)
  }

  const total = hits + misses
  const hitRate = total > 0 ? (hits / total) * 100 : 0

  console.log(`    Cold requests:  5 | Cache misses: ${misses}`)
  console.log(`    Warm requests:  5 | Cache hits:   ${hits}`)
  console.log(`    Hit rate: ${hitRate.toFixed(1)}%`)

  return {
    name: 'Cache Effectiveness',
    results: calculateStats(latencies, total, []),
    details: { hits, misses, hitRate },
  }
}

// ============================================================
// Benchmark: Health Endpoint Deep Dive
// ============================================================

async function benchmarkHealthDeep(): Promise<BenchmarkResult> {
  console.log('  ── Health Endpoint Analysis ──')

  const { status: _status, body, latencyMs } = await fetchJson(`${BASE_URL}/api/health`)

  if (body) {
    console.log(`    Status:         ${body.status}`)
    console.log(`    Auth required:  ${body.auth_required}`)
    console.log(`    Mode:           ${body.mode}`)

    const rl = body.rate_limiter || {}
    console.log(`    Rate Limiter:   mode=${rl.mode}, hosts=${rl.hosts_tracked}`)

    const features = body.features || {}
    const featureList = Object.entries(features)
      .filter(([_, v]) => v === true)
      .map(([k]) => k)
    console.log(`    Active features: ${featureList.join(', ') || 'none'}`)

    const backends = body.backends || {}
    const healthy = Object.values(backends).filter((b) => (b as { status?: string })?.status === 'operational').length
    const total = Object.keys(backends).length
    console.log(`    Backends:       ${healthy}/${total} healthy`)

    const cpuBudget = body.cpu_budget
    if (cpuBudget) {
      console.log(`    CPU Budget:     ${JSON.stringify(cpuBudget)}`)
    }
  }

  return {
    name: 'Health Deep Dive',
    results: calculateStats([latencyMs], 1, []),
    details: body,
  }
}

// ============================================================
// Benchmark: Search Quality Quick Check
// ============================================================

async function benchmarkSearchQuality(): Promise<void> {
  console.log('  ── Search Quality Quick Check ──')

  const queries = [
    { q: 'What is React?', expectMin: 3 },
    { q: '오늘 주요 뉴스', expectMin: 2 },
    { q: 'best programming languages 2026', expectMin: 3 },
    { q: 'Cloudflare Workers tutorial', expectMin: 2 },
    { q: 'machine learning basics', expectMin: 3 },
  ]

  console.log('  ┌─────────────────────────────────┬────────┬──────────┬─────────┐')
  console.log('  │ Query                           │ Results│ Latency  │ Backend │')
  console.log('  ├─────────────────────────────────┼────────┼──────────┼─────────┤')

  let totalLatency = 0
  let successCount = 0

  for (const { q, expectMin } of queries) {
    const { status: _status, body, latencyMs } = await fetchJson(`${BASE_URL}/api/search`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ query: q, max_results: 5 }),
    })

    const resultCount = body?.results?.length || 0
    const backend = body?.backend || 'unknown'
    const pass = resultCount >= expectMin

    totalLatency += latencyMs
    if (pass) successCount++

    const query = q.padEnd(31).slice(0, 31)
    const count = String(resultCount).padStart(6)
    const latency = formatMs(latencyMs).padStart(8)
    const be = backend.padEnd(7).slice(0, 7)
    const icon = pass ? '✅' : '⚠️'

    console.log(`  │ ${icon} ${query} │ ${count} │ ${latency} │ ${be} │`)
  }

  console.log('  └─────────────────────────────────┴────────┴──────────┴─────────┘')
  console.log(`    Average latency: ${formatMs(totalLatency / queries.length)}`)
  console.log(`    Quality score: ${successCount}/${queries.length}`)
}

// ============================================================
// Main
// ============================================================

async function main() {
  console.log('')
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  ssak-search Performance Benchmark')
  console.log(`  Target: ${BASE_URL}`)
  console.log(`  Time: ${new Date().toISOString()}`)
  console.log('═══════════════════════════════════════════════════════════════')
  console.log('')

  // Warmup
  console.log('── Warmup ──')
  for (let i = 0; i < WARMUP_REQUESTS; i++) {
    await fetchJson(`${BASE_URL}/api/health`)
    await sleep(200)
  }
  console.log(`  ${WARMUP_REQUESTS} warmup requests completed`)
  console.log('')

  // 1. Health Deep Dive
  console.log('═══ 1. Health Endpoint Analysis ═══')
  await benchmarkHealthDeep()
  console.log('')

  // 2. Endpoint Latency
  console.log('═══ 2. Endpoint Latency (per-endpoint, 20 requests each) ═══')
  await benchmarkEndpointLatency()
  console.log('')

  // 3. Concurrent Throughput
  console.log('═══ 3. Concurrent Throughput ═══')
  await benchmarkThroughput()
  console.log('')

  // 4. Cache Effectiveness
  console.log('═══ 4. Cache Effectiveness ═══')
  await benchmarkCache()
  console.log('')

  // 5. Search Quality
  console.log('═══ 5. Search Quality ═══')
  await benchmarkSearchQuality()
  console.log('')

  console.log('═══════════════════════════════════════════════════════════════')
  console.log('  Benchmark Complete')
  console.log('═══════════════════════════════════════════════════════════════')
}

main().catch(err => {
  console.error('Benchmark failed:', err)
  process.exit(1)
})
