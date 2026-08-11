/**
 * CanaryOrchestratorDO — Parser Regression Detection (D.1)
 *
 * Durable Object that runs backend test queries, persists per-backend
 * snapshots, and detects regressions (previously passing backend now
 * returning fewer results than expected). On regression it:
 *  1. Sends a Slack alert (SLACK_WEBHOOK)
 *  2. Creates a GitHub issue (GITHUB_TOKEN + GITHUB_REPO, max 1 per backend/day)
 *  3. Force-opens the backend circuit (auto-fallback via RateLimiterDO)
 *
 * Cooldown is enforced through DO storage so the 5-min throttle holds
 * across isolates (the old route-level in-memory counter did not).
 */

import { DurableObject } from 'cloudflare:workers'
import { logger, toError } from '../logger'
import { resolveWebhookUrl, sendSlackAlert } from '../slack-alert'
import { forceOpenBackend } from '../rate-limiter'
import type { Env } from '../../types'
import { bingSearch, bingNewsSearch } from '../bing-search'
import { naverSearch } from '../naver-search'
import { wikipediaSearch, githubSearch, hackerNewsSearch } from '../specialized'

export const CANARY_COOLDOWN_MS = 300_000
// Only create one GitHub issue per backend per day to avoid alert spam
const ISSUE_COOLDOWN_MS = 24 * 60 * 60 * 1000

export interface CanaryResult {
  backend: string
  status: 'pass' | 'fail' | 'skip'
  results_count: number
  expected_min: number
  latency_ms: number
  error?: string
}

export interface CanarySnapshot {
  status: 'pass' | 'fail'
  results_count: number
  latency_ms: number
  timestamp: string
}

interface CanaryRunResponse {
  status: 'ok' | 'degraded' | 'rate_limited'
  timestamp: string
  results: CanaryResult[]
  summary: { total: number; passed: number; failed: number; skipped: number }
  regressions: string[]
  circuits_opened: string[]
  issue_created: boolean
  cooldown_remaining_ms: number
}

// Backend name → host used by the rate limiter circuit breaker
const BACKEND_HOSTS: Record<string, string> = {
  bing: 'www.bing.com',
  'bing-news': 'www.bing.com',
  naver: 'search.naver.com',
  wikipedia: 'en.wikipedia.org',
  github: 'api.github.com',
  hackernews: 'hacker-news.firebaseio.com',
}

// Test queries with expected minimum results per backend
const CANARY_TESTS: Array<{
  backend: string
  expected_min: number
  timeout_ms: number
  run: (env: Env) => Promise<number>
}> = [
  {
    backend: 'bing',
    expected_min: 3,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await bingSearch('test search query', {
        maxResults: 5,
        timeoutMs: 12000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'bing-news',
    expected_min: 2,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await bingNewsSearch('latest technology news', {
        maxResults: 5,
        timeoutMs: 12000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'naver',
    expected_min: 3,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await naverSearch('삼성전자 주가', {
        maxResults: 5,
        timeoutMs: 12000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'wikipedia',
    expected_min: 1,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await wikipediaSearch('Quantum computing', {
        maxResults: 3,
        timeoutMs: 10000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'github',
    expected_min: 1,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await githubSearch('rust programming language', {
        maxResults: 3,
        timeoutMs: 10000,
        env,
      })
      return results.length
    },
  },
  {
    backend: 'hackernews',
    expected_min: 1,
    timeout_ms: 15000,
    run: async (env) => {
      const results = await hackerNewsSearch('technology', {
        maxResults: 3,
        timeoutMs: 10000,
        env,
      })
      return results.length
    },
  },
]

interface OrchestratorState {
  lastRunAt: number
  snapshots: Record<string, CanarySnapshot>
  lastIssueAt: Record<string, number>
}

export class CanaryOrchestratorDO extends DurableObject<Env> {
  private state: OrchestratorState

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.state = { lastRunAt: 0, snapshots: {}, lastIssueAt: {} }
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<OrchestratorState>('state')
      if (stored) this.state = stored
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('state', this.state)
  }

  async getStatus(): Promise<{
    lastRunAt: number
    cooldown_remaining_ms: number
    snapshots: Record<string, CanarySnapshot>
  }> {
    return {
      lastRunAt: this.state.lastRunAt,
      cooldown_remaining_ms: this.cooldownRemaining(),
      snapshots: this.state.snapshots,
    }
  }

  async runCanary(): Promise<CanaryRunResponse> {
    const cooldown = this.cooldownRemaining()
    if (cooldown > 0) {
      return {
        status: 'rate_limited',
        timestamp: new Date().toISOString(),
        results: [],
        summary: { total: 0, passed: 0, failed: 0, skipped: 0 },
        regressions: [],
        circuits_opened: [],
        issue_created: false,
        cooldown_remaining_ms: cooldown,
      }
    }
    this.state.lastRunAt = Date.now()

    const env = this.env
    const results: CanaryResult[] = []

    const checkResults = await Promise.allSettled(
      CANARY_TESTS.map(async (test) => {
        const start = Date.now()
        try {
          const count = await test.run(env)
          const latency = Date.now() - start
          const passed = count >= test.expected_min
          return {
            backend: test.backend,
            status: passed ? ('pass' as const) : ('fail' as const),
            results_count: count,
            expected_min: test.expected_min,
            latency_ms: latency,
            error: passed ? undefined : `Expected ≥${test.expected_min} results, got ${count}`,
          }
        } catch (err) {
          return {
            backend: test.backend,
            status: 'fail' as const,
            results_count: 0,
            expected_min: test.expected_min,
            latency_ms: Date.now() - start,
            error: toError(err),
          }
        }
      }),
    )

    for (const r of checkResults) {
      if (r.status === 'fulfilled') {
        results.push(r.value)
      } else {
        results.push({
          backend: 'unknown',
          status: 'fail',
          results_count: 0,
          expected_min: 0,
          latency_ms: 0,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        })
      }
    }

    // Snapshot comparison — regression = previously passing, now failing
    const regressions: string[] = []
    for (const r of results) {
      if (r.status !== 'fail') continue
      const prev = this.state.snapshots[r.backend]
      if (prev && prev.status === 'pass') {
        regressions.push(r.backend)
      }
    }

    // Persist new snapshots
    for (const r of results) {
      if (r.status === 'skip') continue
      this.state.snapshots[r.backend] = {
        status: r.status,
        results_count: r.results_count,
        latency_ms: r.latency_ms,
        timestamp: new Date().toISOString(),
      }
    }

    const passed = results.filter((r) => r.status === 'pass').length
    const failed = results.filter((r) => r.status === 'fail').length
    const skipped = results.filter((r) => r.status === 'skip').length
    const overallStatus = failed === 0 ? 'ok' : 'degraded'

    const response: CanaryRunResponse = {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      results,
      summary: { total: results.length, passed, failed, skipped },
      regressions,
      circuits_opened: [],
      issue_created: false,
      cooldown_remaining_ms: CANARY_COOLDOWN_MS,
    }

    // Regression response: alert + auto-fallback (circuit open)
    for (const backend of regressions) {
      const host = BACKEND_HOSTS[backend]
      if (host) {
        try {
          await forceOpenBackend(env, `https://${host}`)
          response.circuits_opened.push(host)
        } catch (err) {
          logger.warn('[Canary] Failed to open circuit:', { backend, error: toError(err) })
        }
      }
      await this.alertRegression(backend)
    }

    await this.persist()
    return response
  }

  private cooldownRemaining(): number {
    const elapsed = Date.now() - this.state.lastRunAt
    return Math.max(0, CANARY_COOLDOWN_MS - elapsed)
  }

  private async alertRegression(backend: string): Promise<void> {
    const snapshot = this.state.snapshots[backend]
    const detail = snapshot
      ? `Previous run: ${snapshot.results_count} results (${snapshot.status}).`
      : 'No previous snapshot.'

    // Slack alert — S104-③-②: accept SLACK_WEBHOOK or ALERT_SLACK_WEBHOOK
    await sendSlackAlert(resolveWebhookUrl(this.env), {
      title: `🐛 Parser Regression: ${backend}`,
      message: `Backend *${backend}* stopped returning expected results — parser may have broken due to markup changes. ${detail}`,
      color: 'danger',
      fields: [
        { label: 'Backend', value: backend, short: true },
        { label: 'Action', value: 'Circuit force-opened (auto-fallback)', short: true },
      ],
      context: `Canary run at ${new Date().toISOString()}`,
    })

    // GitHub issue (deduped: 1 per backend per day)
    const token = this.env.GITHUB_TOKEN
    const repo = this.env.GITHUB_REPO
    const lastIssue = this.state.lastIssueAt[backend] ?? 0
    if (token && repo && Date.now() - lastIssue > ISSUE_COOLDOWN_MS) {
      try {
        const resp = await fetch(`https://api.github.com/repos/${repo}/issues`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'ssak-search-canary',
          },
          body: JSON.stringify({
            title: `[canary] Parser regression detected: ${backend}`,
            body: [
              `Canary detected that backend \`${backend}\` stopped returning expected results.`,
              '',
              `- Test query: ${CANARY_TESTS.find((t) => t.backend === backend) ? 'configured canary test' : 'unknown'}`,
              `- ${detail}`,
              '- The backend circuit has been force-opened (requests now fail fast).',
              '',
              `_Automated alert from canary run at ${new Date().toISOString()}._`,
            ].join('\n'),
            labels: ['canary', 'regression'],
          }),
        })
        if (resp.ok) {
          this.state.lastIssueAt[backend] = Date.now()
        } else {
          logger.warn('[Canary] GitHub issue creation failed:', { status: resp.status, backend })
        }
      } catch (err) {
        logger.warn('[Canary] GitHub issue creation error:', { error: toError(err), backend })
      }
    }
  }
}

// ============================================================
// Client-side RPC stub
// ============================================================

export interface CanaryOrchestratorRPC {
  getStatus(): Promise<{ lastRunAt: number; cooldown_remaining_ms: number; snapshots: Record<string, CanarySnapshot> }>
  runCanary(): Promise<CanaryRunResponse>
}

/**
 * Create a client stub for the CanaryOrchestrator DO.
 * Returns null when the CANARY_DO binding is not configured.
 */
export function getCanaryOrchestrator(env: Env): CanaryOrchestratorRPC | null {
  if (!env.CANARY_DO) {
    logger.info('[Canary] CANARY_DO binding not available — skipping')
    return null
  }
  const id = env.CANARY_DO.idFromName('global')
  return env.CANARY_DO.get(id) as unknown as CanaryOrchestratorRPC
}

export { CANARY_TESTS }
