/**
 * Cross-isolate Rate Limiter & Circuit Breaker using Cloudflare Durable Objects.
 *
 * This replaces the in-memory rate-limiter.ts with a version that provides
 * true cross-request, cross-isolate coordination.
 *
 * Architecture:
 * - One Durable Object per host (or shared DO with host as key)
 * - DO maintains inflight counts, circuit state, and rate-limit windows
 * - Workers call DO via RPC for acquire/release/canRequest
 * - DO persists state to SQLite (automatic via DO storage)
 */

import { DurableObject } from 'cloudflare:workers'
import { logger } from './logger'
import type { Env } from '../types'
import { rateLimiterInstanceName } from './deploy-env'

// ============================================================
// Types
// ============================================================

export interface HostConfig {
  maxConcurrent: number
  failureThreshold: number
  resetTimeoutMs: number
  // Per-minute rate limit (cross-request)
  rateLimitPerMinute?: number
}

export interface CircuitState {
  failures: number
  lastFailureTime: number
  tripped: boolean
  openedAt: number
  // Self-healing (D.2): exponential backoff stage + half-open probe flag
  tripCount: number
  probeInFlight: boolean
  // S73 후속 (2026-08-14): 프로브 임대 시작 시각. S105 inflight 슬롯 리퍼와
  // 같은 원칙 — 프로브는 몇 초면 완료되는데, 프로브 요청이 DO 재시작/RPC 유실로
  // release를 못 하면 probeInFlight가 true로 persist되어 이후 모든 요청이
  // 'circuit_open (probe in flight)' 거부를 받고 **새 프로브가 영영 발화하지
  // 못 하는 deadlock**이 된다 (실측: wikidata/zh는 업스트림 200 정상인데 서킷이
  // 17분+ stuck). PROBE_STALE_MS 지난 임대는 canRequest에서 지연 회수한다.
  probeStartedAt: number
}

export interface HostHealth {
  status: 'healthy' | 'degraded' | 'down'
  failures: number
  inflight: number
  tripped: boolean
  // Cross-isolate metrics
  totalRequests: number
  totalFailures: number
  rateLimitedCount: number
  // Self-healing state (D.2)
  tripCount?: number
  probeInFlight?: boolean
  backoffMs?: number
  /**
   * 'durable' — state persisted in DO storage, shared across isolates
   * (S88 evidence surfacing: getBackendHealth's DO path stamps every host
   * with this so /api/health clearly distinguishes cross-isolate state from
   * the in-memory fallback's per-isolate 'local').
   */
  source?: 'local' | 'durable'
}

export interface RateLimitResult {
  allowed: boolean
  remaining: number
  resetAt: number
  retryAfter?: number
}

// ============================================================
// Default Configuration
// ============================================================

export const DEFAULT_HOST_CONFIG: HostConfig = {
  maxConcurrent: 2,
  failureThreshold: 5,
  resetTimeoutMs: 60_000,
  rateLimitPerMinute: 60,
}

export const HOST_CONFIGS: Record<string, HostConfig> = {
  'www.bing.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 120 },
  'html.duckduckgo.com': { maxConcurrent: 1, failureThreshold: 3, resetTimeoutMs: 120_000, rateLimitPerMinute: 30 },
  'search.naver.com': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 80 },
  'en.wikipedia.org': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 30_000, rateLimitPerMinute: 100 },
  'api.github.com': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'hacker-news.firebaseio.com': {
    maxConcurrent: 3,
    failureThreshold: 5,
    resetTimeoutMs: 30_000,
    rateLimitPerMinute: 100,
  },
  'www.reddit.com': { maxConcurrent: 2, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
  'export.arxiv.org': { maxConcurrent: 2, failureThreshold: 3, resetTimeoutMs: 60_000, rateLimitPerMinute: 30 },
  'r.jina.ai': { maxConcurrent: 3, failureThreshold: 5, resetTimeoutMs: 60_000, rateLimitPerMinute: 60 },
}

// ============================================================
// Self-healing circuit breaker configuration (D.2)
// ============================================================

// Exponential backoff stages: 30s → 5min → 30min (indexed by tripCount, capped)
export const BACKOFF_STAGES_MS = [30_000, 300_000, 1_800_000]
// Periodic health-check interval while a circuit is open (1 min)
export const CIRCUIT_PROBE_INTERVAL_MS = 60_000
// 방안 A (docs/18, 2026-08-14): api.stackexchange.com 전용 프로브 최소 간격.
// alarm 은 60s 주기로 돌지만 SE 는 10분에 1회만 프로브한다 — 60s 마다의
// 프로브가 SE egress IP rate-limit(하루 ~300 쿼터와 공유)을 갱신·연장해
// 회복을 방해하는 것을 막는다 (실측: 60s robots.txt 프로브 → 502 상태 유지).
export const STACKEXCHANGE_PROBE_INTERVAL_MS = 600_000
// S73 후속 (2026-08-14): 하프오픈 프로브 임대 TTL. 프로브는 실제 fetch 체인
// (REST 3s + Action 1.5s 최악 ≈ 4.5s, fanout 천장)보다 훨씬 짧게 끝나는데,
// release RPC 유실/DO 재시작으로 프로브가 영영 완료되지 않으면 probeInFlight가
// true로 persist되어 이후 모든 요청이 'circuit_open (probe in flight)' 거부를
// 받고 새 프로브가 발화하지 못 하는 deadlock이 된다 (실측: wikidata/zh는
// 업스트림 200 정상인데 서킷이 17분+ stuck). 15s는 모든 fetch 체인 상한보다
// 넉넉한 여유를 준다.
export const PROBE_STALE_MS = 15_000
// Timeout for a single health-check probe request
const CIRCUIT_PROBE_TIMEOUT_MS = 3_000

export function getBackoffMs(tripCount: number): number {
  const stage = Math.min(Math.max(tripCount, 0), BACKOFF_STAGES_MS.length - 1)
  return BACKOFF_STAGES_MS[stage]
}

// ============================================================
// Durable Object: RateLimiterDO
// ============================================================

/**
 * State stored in DO's SQLite (automatic persistence)
 */
interface DOState {
  inflight: Map<string, number>
  /**
   * acquire() 호출 시각 (host → 오름차순 배열) — 누수 슬롯 리핑의 진실 원본.
   * S105 (2026-08-14): isolate가 fetch 도중 죽거나 acquire RPC가 DO-측 증분
   * 이후 실패하면 release가 영영 오지 않아 inflight가 영구 누수된다 (프로덕션
   * bing 3/3 포화 → 전 fetch "circuit open or at capacity" 거부 → partial_outage).
   * inflight 카운터는 persist()로 DO 스토리지에 저장되어 재시작에도 남으므로,
   * 만료 임대가 없으면 영구 포화다.
   */
  inflightSlots: Map<string, number[]>
  circuits: Map<string, CircuitState>
  rateLimitWindows: Map<string, number[]> // host -> array of timestamps
  stats: Map<string, { totalRequests: number; totalFailures: number; rateLimitedCount: number }>
  // Shared cooldown windows (cross-isolate 429 pacing guards, e.g.
  // 'cooldown:wikipedia') — key -> epoch-ms deadline until which the window
  // is armed. Lets every isolate observe the SAME upstream 429 window that
  // the wikipedia/github module-level guards (specialized.ts) track locally.
  cooldowns: Map<string, number>
}

export class RateLimiterDO extends DurableObject<Env> {
  private state: DOState

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.state = {
      inflight: new Map(),
      inflightSlots: new Map(),
      circuits: new Map(),
      rateLimitWindows: new Map(),
      stats: new Map(),
      cooldowns: new Map(),
    }
    // Load persisted state
    this.ctx.blockConcurrencyWhile(async () => {
      const stored = await this.ctx.storage.get<DOState>('state')
      if (stored) {
        this.state = {
          inflight: new Map(Object.entries(stored.inflight)),
          // S105: 이전 배포는 inflightSlots 필드가 없음 — 누수된 카운터는 빈
          // 슬롯으로 취급해 즉시 리핑 대상이 된다 (최초 canRequest에서 복구).
          inflightSlots: new Map(Object.entries(stored.inflightSlots ?? {})),
          circuits: new Map(Object.entries(stored.circuits)),
          rateLimitWindows: new Map(Object.entries(stored.rateLimitWindows)),
          stats: new Map(Object.entries(stored.stats)),
          cooldowns: new Map(Object.entries(stored.cooldowns ?? {})),
        }
      }
    })
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('state', {
      inflight: Object.fromEntries(this.state.inflight),
      inflightSlots: Object.fromEntries(this.state.inflightSlots),
      circuits: Object.fromEntries(this.state.circuits),
      rateLimitWindows: Object.fromEntries(this.state.rateLimitWindows),
      stats: Object.fromEntries(this.state.stats),
      cooldowns: Object.fromEntries(this.state.cooldowns),
    })
  }

  /**
   * 인플라이트 슬롯 임대 TTL — 가장 긴 정당 fetch(백엔드 천장 4.5s + 인리치
   * ~15s)보다 훨씬 여유 있게 60s. 이보다 오래된 슬롯은 정의상 고아다
   * (isolate 사망 / acquire RPC 유실 후 release 미도착).
   */
  private static readonly INFLIGHT_LEASE_MS = 60_000

  /**
   * 만료된 inflight 슬롯을 회수한다 (S105, 2026-08-14).
   *
   * 프로덕션 partial_outage 근본 원인: worker isolate가 fetch 도중 종료되거나
   * acquire RPC가 DO-측 증분 뒤 실패하면 release가 오지 않아 슬롯이 영구 누수
   * (실측 bing inflight 3/3 · html.duckduckgo 2/1 — maxConcurrent 초과 상태),
   * 이후 모든 fetch가 "Upstream unavailable (circuit open or at capacity)"로
   * 거부 → bing이 전 쿼리에 0건 → partial_outage. 만료 슬롯은 모든 진입점
   * (canRequest/acquire/release/getAllHealth)에서 지연 회수되어 포화가 자가치유
   * 된다. persist()에 저장되므로 재시작에도 잔존했던 누수가 여기서 해소된다.
   */
  private reapInflight(host: string, now: number): void {
    const slots = this.state.inflightSlots.get(host) ?? []
    const cutoff = now - RateLimiterDO.INFLIGHT_LEASE_MS
    const fresh = slots.filter((ts) => ts > cutoff)
    const persistedCount = this.state.inflight.get(host) ?? 0
    // 슬롯이 변했거나 카운터와 불일치할 때만 갱신. 불일치 케이스가 곧 레거시
    // 마이그레이션이다: 이전 배포의 persisted state는 inflightSlots가 없어
    // slots=[]인데 inflight=3 — 최초 진입점에서 카운터를 0으로 정규화해
    // 프로덕션의 영구 누수를 즉시 해소한다 (배포 직후 첫 요청에서 복구).
    if (fresh.length === slots.length && fresh.length === persistedCount) return
    const reaped = slots.length - fresh.length
    this.state.inflightSlots.set(host, fresh)
    this.state.inflight.set(host, fresh.length)
    logger.warn(
      `[DO-rate-limiter] Reaped ${reaped} stale inflight slot(s) for ${host} (lease ${RateLimiterDO.INFLIGHT_LEASE_MS}ms; ${fresh.length} fresh)`,
    )
  }

  /**
   * Canonical wikipedia window key: every language subdomain
   * (en/ko/zh/ja/…) shares ONE rate window because they resolve to the same
   * upstream IP and burst-ban together. Mirrors rate-limiter.ts's
   * WIKIPEDIA_RATE_KEY so the DO and the local fallback behave identically.
   */
  private static readonly WIKIPEDIA_RATE_KEY = 'wikipedia.org'

  /** True for any Wikipedia language subdomain — they share one upstream IP budget. */
  private isWikipediaHost(host: string): boolean {
    return host === 'wikipedia.org' || host.endsWith('.wikipedia.org')
  }

  /**
   * 방안 A (docs/18): api.stackexchange.com — 프로브 경로/판정/간격이 특수화된다
   * (robots.txt 는 API 가 아니라 400 JSON 이 왜곡 응답; 502 = egress rate-limit).
   */
  private isStackExchangeHost(host: string): boolean {
    return host === 'api.stackexchange.com'
  }

  private getConfig(host: string): HostConfig {
    // All Wikipedia language subdomains (en/ko/zh/ja/…) share one upstream IP
    // and burst-ban together — give them ONE shared budget (mirrors the local
    // fallback in rate-limiter.ts).
    if (this.isWikipediaHost(host)) {
      return HOST_CONFIGS['en.wikipedia.org']
    }
    return HOST_CONFIGS[host] ?? DEFAULT_HOST_CONFIG
  }

  /** Window storage key for a host — wikipedia subdomains collapse to one key. */
  private rateWindowKey(host: string): string {
    if (this.isWikipediaHost(host)) {
      return RateLimiterDO.WIKIPEDIA_RATE_KEY
    }
    return host
  }

  private getCircuit(host: string): CircuitState {
    let circuit = this.state.circuits.get(host)
    if (!circuit) {
      circuit = {
        failures: 0,
        lastFailureTime: 0,
        tripped: false,
        openedAt: 0,
        tripCount: 0,
        probeInFlight: false,
        probeStartedAt: 0,
      }
      this.state.circuits.set(host, circuit)
    }
    return circuit
  }

  /**
   * S73 후속 (2026-08-14): 레거시 stuck-probe deadlock 마이그레이션.
   *
   * TTL 수정 이전에 persist된 deadlock 상태는 probeInFlight=true + probeStartedAt
   * 부재(undefined) + backoff stage 3(30분) — 리퍼는 backoff 게이트 뒤에 있어
   * 발화할 수 없고 alarm도 불신뢰 상태. 이 조합을 감지하면 회로를 fresh backoff
   * (stage 0, 30s)로 리셋해 다음 요청이 즉시 새 프로브가 되게 한다. 정상 회로
   * (probeInFlight=false)는 무변경 — 상시 리셋이 아니라 deadlock 서명만 정리한다.
   * canRequest와 getAllHealth 진입점에서 호출된다.
   */
  private migrateLegacyProbeDeadlock(circuit: CircuitState): boolean {
    if (circuit.tripped && circuit.probeInFlight && !circuit.probeStartedAt) {
      circuit.probeInFlight = false
      circuit.probeStartedAt = 0
      circuit.tripCount = 0
      circuit.openedAt = 0
      logger.warn('[DO-rate-limiter] Legacy stuck-probe deadlock reset — fresh 30s backoff probe armed on next request')
      return true
    }
    return false
  }

  private getStats(host: string) {
    let stats = this.state.stats.get(host)
    if (!stats) {
      stats = { totalRequests: 0, totalFailures: 0, rateLimitedCount: 0 }
      this.state.stats.set(host, stats)
    }
    return stats
  }

  /**
   * Check if a request can proceed (RPC entry point).
   * Called BEFORE making the upstream request.
   */
  async canRequest(host: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }> {
    const config = this.getConfig(host)
    const circuit = this.getCircuit(host)
    const now = Date.now()

    // S73 후속: 레거시 stuck-probe deadlock 마이그레이션 (canRequest 진입점).
    if (this.migrateLegacyProbeDeadlock(circuit)) {
      await this.persist()
    }

    // S73c: 열린 서킷이 있으면 alarm self-healing 체인을 보장 — orchestrator가
    // 서킷 오픈 시 이 백엔드를 호출하지 않아 하프오픈 프로브가 발화하지 못하는
    // 상황에서도 주기 프로브가 계속 도도록 한다.
    await this.ensureCircuitProbeScheduled()

    // S105: 만료 슬롯 회수 — 누수된 슬롯이 maxConcurrent를 영구 점유하지 않도록
    // (concurrency 검사 이전에 실행해 포화 상태에서도 자가치유되게 한다).
    this.reapInflight(host, now)

    // Circuit breaker check
    if (circuit.tripped) {
      const elapsed = now - circuit.openedAt
      if (elapsed < getBackoffMs(circuit.tripCount)) {
        return {
          allowed: false,
          reason: 'circuit_open',
          retryAfter: Math.ceil((getBackoffMs(circuit.tripCount) - elapsed) / 1000),
        }
      }
      // Half-open: allow exactly one probe request
      if (circuit.probeInFlight) {
        // S73 후속: 프로브 임대 TTL — release 유실(DO 재시작/RPC 타임아웃)로
        // probeInFlight가 영구 true가 되면 새 프로브가 발화하지 못 한다.
        // 레거시 상태(probeStartedAt=0)도 stale로 간주해 배포 직후 즉시 회수
        // → 이 요청이 새 프로브가 된다. 정상 프로브는 15s 안에 완료되므로
        // 임대가 살아있을 때만 거부한다.
        // ⚠️ `!circuit.probeStartedAt` — 레거시 상태는 키 자체가 없어(undefined)
        // `=== 0` 비교가 false가 되어 stale로 안 잡히는 버그가 있었다 (실측:
        // TTL 배포 후에도 probe: True 30분+ 지속). undefined/0 모두 stale.
        const probeStale = !circuit.probeStartedAt || now - circuit.probeStartedAt > PROBE_STALE_MS
        if (!probeStale) {
          return { allowed: false, reason: 'circuit_open', retryAfter: 10 }
        }
        circuit.probeInFlight = false
        circuit.probeStartedAt = 0
      }
      circuit.probeInFlight = true
      circuit.probeStartedAt = now
      circuit.failures = 0
    }

    // Concurrency limit
    const current = this.state.inflight.get(host) ?? 0
    if (current >= config.maxConcurrent) {
      return { allowed: false, reason: 'concurrency_limit' }
    }

    // Rate limit (sliding window per minute)
    if (config.rateLimitPerMinute) {
      const windowKey = this.rateWindowKey(host)
      const window = this.state.rateLimitWindows.get(windowKey) ?? []
      const windowStart = now - 60_000
      const recent = window.filter((ts) => ts > windowStart)
      if (recent.length >= config.rateLimitPerMinute) {
        const oldest = recent[0]
        const retryAfter = Math.ceil((oldest + 60_000 - now) / 1000)
        this.getStats(host).rateLimitedCount++
        await this.persist()
        return { allowed: false, reason: 'rate_limit', retryAfter }
      }
      // Update window
      this.state.rateLimitWindows.set(windowKey, [...recent, now])
    }

    await this.persist()
    return { allowed: true }
  }

  /**
   * Mark request as started (increment inflight).
   */
  async acquire(host: string): Promise<void> {
    const now = Date.now()
    this.reapInflight(host, now)
    const slots = this.state.inflightSlots.get(host) ?? []
    slots.push(now)
    this.state.inflightSlots.set(host, slots)
    this.state.inflight.set(host, slots.length)
    this.getStats(host).totalRequests++
    await this.persist()
  }

  /**
   * S105 후속 (2026-08-14): acquire RPC가 DO-측 증분 이후 실패했을 때
   * 클라이언트가 호출하는 보상 RPC. 인플라이트 슬롯만 제거하고 서킷/통계는
   * 건드리지 않는다 — release(success=false)는 실패 카운트를 올리고, 하프오픈
   * 프로브 단계에선 회로를 닫아버려, 업스트림에 도달하기 전에 실패한 acquire를
   * 업스트림 실패로 오집계하면 안 되기 때문. 빈 슬롯에서 호출돼도 no-op
   * (FIFO shift + inflight 클램프).
   */
  async cancelAcquire(host: string): Promise<void> {
    const now = Date.now()
    this.reapInflight(host, now)
    const slots = this.state.inflightSlots.get(host) ?? []
    if (slots.length > 0) slots.shift()
    this.state.inflightSlots.set(host, slots)
    this.state.inflight.set(host, slots.length)
    await this.persist()
  }

  /**
   * Mark request as completed (decrement inflight, update circuit).
   */
  async release(host: string, success: boolean): Promise<void> {
    const now = Date.now()
    this.reapInflight(host, now)
    // FIFO: 가장 오래된 슬롯 제거 (리핑 후 남은 최고령 = 이 요청의 슬롯).
    const slots = this.state.inflightSlots.get(host) ?? []
    if (slots.length > 0) slots.shift()
    this.state.inflightSlots.set(host, slots)
    this.state.inflight.set(host, slots.length)

    const config = this.getConfig(host)
    const circuit = this.getCircuit(host)
    const stats = this.getStats(host)

    if (circuit.probeInFlight) {
      circuit.probeInFlight = false
      circuit.probeStartedAt = 0
      if (success) {
        // Half-open probe succeeded → close circuit (gradual recovery complete)
        circuit.tripped = false
        circuit.failures = 0
        circuit.tripCount = 0
        circuit.openedAt = 0
        logger.info(`[DO-rate-limiter] Circuit closed for ${host} after successful probe`)
      } else {
        // Half-open probe failed → reopen with next backoff stage
        circuit.tripped = true
        circuit.failures = 0
        circuit.tripCount = Math.min(circuit.tripCount + 1, BACKOFF_STAGES_MS.length - 1)
        circuit.openedAt = Date.now()
        stats.totalFailures++
        logger.warn(`[DO-rate-limiter] Circuit re-opened for ${host} (stage ${circuit.tripCount})`)
      }
      await this.persist()
      return
    }

    if (success) {
      circuit.failures = 0
    } else {
      circuit.failures++
      circuit.lastFailureTime = Date.now()
      stats.totalFailures++
      if (circuit.failures >= config.failureThreshold) {
        circuit.tripped = true
        circuit.openedAt = Date.now()
        logger.warn(`[DO-rate-limiter] Circuit tripped for ${host} after ${circuit.failures} failures`)
        // Schedule periodic health checks while open (self-healing, D.2)
        await this.scheduleCircuitProbe()
      }
    }

    await this.persist()
  }

  /**
   * Schedule the next periodic health-check alarm for open circuits.
   * No-op when a probe alarm is already pending.
   */
  private async scheduleCircuitProbe(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm()
    if (existing !== null) return
    await this.ctx.storage.setAlarm(Date.now() + CIRCUIT_PROBE_INTERVAL_MS)
  }

  /**
   * S73c (2026-08-14): alarm self-healing 체인 보장.
   *
   * alarm()은 트립 시 scheduleCircuitProbe()로만 스케줄되므로, alarm이 유실
   * (스케줄 실패/DO 재생성/예외로 인한 체인 단절)되면 서킷이 영원히 열린 채
   * 남는다 — canRequest 하프오픈 프로브는 orchestrator가 서킷 오픈 시 해당
   * 백엔드를 호출하지 않아 발화하지 않는다 (실측: en/ko/wikidata가 30s
   * backoff 상태로 90s+ 무변화). 모든 공개 RPC 진입점에서 열린 서킷이
   * 있으면 alarm을 (재)스케줄해, /api/health 폴링만으로도 자가회복이
   * 재개되게 한다. 무해: 이미 pending alarm이 있으면 no-op.
   */
  private async ensureCircuitProbeScheduled(): Promise<void> {
    for (const circuit of this.state.circuits.values()) {
      if (circuit.tripped) {
        await this.scheduleCircuitProbe()
        return
      }
    }
  }

  /**
   * DO alarm handler — probes open circuits and auto-closes recovered backends.
   * Runs every CIRCUIT_PROBE_INTERVAL_MS while any circuit is open.
   */
  async alarm(): Promise<void> {
    const now = Date.now()
    let stillOpen = false

    for (const [host, circuit] of this.state.circuits) {
      if (!circuit.tripped) continue
      stillOpen = true

      const elapsed = now - circuit.openedAt
      const backoff = getBackoffMs(circuit.tripCount)
      // 방안 A (docs/18, 2026-08-14): SE 프로브는 backoff 와 무관하게 10분
      // 최소 간격을 둔다 — 60s 프로브가 SE egress rate-limit 을 갱신·연장하는
      // 것을 방지. 리셋 후엔 다음 10분 틱에서 502→alive 로 닫힌다.
      const minWait = this.isStackExchangeHost(host)
        ? Math.max(backoff, STACKEXCHANGE_PROBE_INTERVAL_MS)
        : backoff
      // Probe only after the current backoff window has elapsed
      if (elapsed < minWait) {
        // S73d 진단: backoff 창 미경과로 프로브를 건너뜀 — alarm이 실제 도는지와
        // openedAt/backoff 관계를 로그로 남겨 회복 지연 원인을 확정한다.
        logger.debug(`[DO-rate-limiter] Alarm tick — skipping ${host}: elapsed=${elapsed}ms < minWait=${minWait}ms (backoff=${backoff}ms, tripCount=${circuit.tripCount})`)
        continue
      }

      const probe = await this.probeHost(host)
      if (probe.alive) {
        circuit.tripped = false
        circuit.failures = 0
        circuit.tripCount = 0
        circuit.openedAt = 0
        circuit.probeInFlight = false
        circuit.probeStartedAt = 0
        logger.info(`[DO-rate-limiter] Health probe OK (HTTP ${probe.status}) — circuit auto-closed for ${host}`)
      } else {
        circuit.tripCount = Math.min(circuit.tripCount + 1, BACKOFF_STAGES_MS.length - 1)
        circuit.openedAt = now
        logger.warn(`[DO-rate-limiter] Health probe failed for ${host} — upstream HTTP ${probe.status} (${probe.snippet}) — escalating to stage ${circuit.tripCount}`)
      }
    }

    if (stillOpen) {
      await this.ctx.storage.setAlarm(now + CIRCUIT_PROBE_INTERVAL_MS)
    }
    await this.persist()
  }

  /**
   * Lightweight liveness probe: GET /robots.txt with a short timeout.
   * 429 (rate-limited) still counts as alive — the server is responding.
   * Returns status + body snippet so the alarm log records WHY a probe failed
   * (S73d: e.g. 403 Cloudflare challenge vs timeout vs 5xx) — without this,
   * "probe failed" leaves the upstream response unobservable.
   *
   * S73e (2026-08-14): sends a User-Agent — wikimedia rejects UA-less robots.txt
   * fetches with HTTP 403 "Please set a user-agent", which failed every wikipedia/
   * wikidata probe (실측: en/ko/wikidata 403 UA-less vs 200/429 with UA) and kept
   * healthy circuits open forever. The UA mirrors the production search fetch UA.
   *
   * 방안 A (docs/18, 2026-08-14): api.stackexchange.com 은 robots.txt 가 API 가
   * 아니라 400 JSON 이 왜곡 응답이라, 실제 API 헬스 경로
   * /2.3/info?site=stackoverflow 로 프로브한다. 400 + error_id:502 ("too many
   * requests from this IP") 는 서버가 살아있는 일시적 egress rate-limit 이므로
   * alive 로 인정 — 서킷을 down 이 아니라 실제 상태로 정직화하고, rate-limit
   * 리셋 후 자동으로 닫히게 한다. (실측: egress /2.3/search → error_id:502.)
   */
  private async probeHost(host: string): Promise<{ alive: boolean; status: number; snippet: string }> {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), CIRCUIT_PROBE_TIMEOUT_MS)
      const url = this.isStackExchangeHost(host)
        ? 'https://api.stackexchange.com/2.3/info?site=stackoverflow'
        : `https://${host}/robots.txt`
      const resp = await fetch(url, {
        signal: controller.signal,
        headers: { 'User-Agent': 'SearchAPI/1.0 (https://search-engine-api.pages.dev; contact: admin@example.com)' },
      })
      clearTimeout(timer)
      const text = await resp.text().catch(() => '')
      let alive = resp.ok || resp.status === 429 || resp.status === 301 || resp.status === 302
      if (this.isStackExchangeHost(host) && resp.status === 400) {
        // SE API: 400 + error_id 502 = egress IP rate-limit (throttle_violation).
        alive = /error_id["']?\s*[:=]\s*502/.test(text)
      }
      return {
        alive,
        status: resp.status,
        snippet: text.replace(/\s+/g, ' ').slice(0, 60),
      }
    } catch {
      return { alive: false, status: -1, snippet: 'fetch timeout/throw' }
    }
  }

  /**
   * Force-open a circuit (used by canary regression detection, D.1).
   * Starts at backoff stage 0 (30s) so recovery probing begins immediately.
   */
  async forceOpen(host: string): Promise<void> {
    const circuit = this.getCircuit(host)
    circuit.tripped = true
    circuit.failures = 0
    circuit.tripCount = 0
    circuit.openedAt = Date.now()
    circuit.probeInFlight = false
    circuit.probeStartedAt = 0
    logger.warn(`[DO-rate-limiter] Circuit force-opened for ${host} (canary regression)`)
    await this.scheduleCircuitProbe()
    await this.persist()
  }

  /**
   * Get health status for all tracked hosts (for /api/health).
   */
  async getAllHealth(): Promise<Record<string, HostHealth>> {
    const now = Date.now()
    const result: Record<string, HostHealth> = {}
    for (const [host, circuit] of this.state.circuits) {
      // S73 후속: 레거시 stuck-probe deadlock 마이그레이션 (헬스 진입점 —
      // /api/health만으로도 회복이 시작되게).
      this.migrateLegacyProbeDeadlock(circuit)
      // S73c: alarm self-healing 체인 보장 — /api/health 폴링만으로도
      // 열린 서킷의 주기 프로브가 유지된다.
      await this.ensureCircuitProbeScheduled()
      // S105: 헬스 보고 전 만료 슬롯 회수 — 누수가 실시간 표시되지 않게.
      this.reapInflight(host, now)
      const inflight = this.state.inflight.get(host) ?? 0
      const stats = this.state.stats.get(host) ?? { totalRequests: 0, totalFailures: 0, rateLimitedCount: 0 }
      result[host] = {
        status: circuit.tripped ? 'down' : circuit.failures > 2 ? 'degraded' : 'healthy',
        failures: circuit.failures,
        inflight,
        tripped: circuit.tripped,
        totalRequests: stats.totalRequests,
        totalFailures: stats.totalFailures,
        rateLimitedCount: stats.rateLimitedCount,
        tripCount: circuit.tripCount,
        probeInFlight: circuit.probeInFlight,
        backoffMs: getBackoffMs(circuit.tripCount),
        // Cross-isolate marker — this state lives in DO storage, visible to
        // every isolate's /api/health (S88: contrast with 'local').
        source: 'durable',
      }
    }
    return result
  }

  /**
   * Arm or clear a shared cooldown window (cross-isolate 429 pacing guards,
   * e.g. the wikipedia/github module-level guards in specialized.ts). `untilMs`
   * is an epoch-ms deadline; values ≤ now clear the entry. Mirrored from every
   * isolate so all of them observe the SAME upstream 429 window instead of
   * each discovering it independently with its own request burst.
   */
  async setCooldown(key: string, untilMs: number): Promise<void> {
    if (untilMs > Date.now()) this.state.cooldowns.set(key, untilMs)
    else this.state.cooldowns.delete(key)
    await this.persist()
  }

  /**
   * Current cooldown deadline for a key (epoch ms; 0 = none). Expired entries
   * are pruned so a long-lived DO doesn't accumulate stale windows.
   */
  async getCooldown(key: string): Promise<number> {
    const untilMs = this.state.cooldowns.get(key) ?? 0
    if (untilMs <= Date.now()) {
      this.state.cooldowns.delete(key)
      await this.persist()
      return 0
    }
    return untilMs
  }

  /**
   * Get rate limit status for a specific host (for headers).
   */
  async getRateLimitStatus(host: string): Promise<RateLimitResult> {
    const config = this.getConfig(host)
    const now = Date.now()
    const windowKey = this.rateWindowKey(host)
    const window = this.state.rateLimitWindows.get(windowKey) ?? []
    const recent = window.filter((ts) => ts > now - 60_000)
    const remaining = Math.max(0, (config.rateLimitPerMinute ?? 60) - recent.length)
    const resetAt = recent.length > 0 ? recent[0] + 60_000 : now + 60_000
    return { allowed: remaining > 0, remaining, resetAt }
  }

  /**
   * Reset all state (admin/testing).
   */
  async reset(): Promise<void> {
    this.state = {
      inflight: new Map(),
      inflightSlots: new Map(),
      circuits: new Map(),
      rateLimitWindows: new Map(),
      stats: new Map(),
      cooldowns: new Map(),
    }
    await this.ctx.storage.deleteAll()
  }
}

// ============================================================
// Client-side RPC stub (used by Workers)
// ============================================================

export interface RateLimiterRPC {
  canRequest(host: string): Promise<{ allowed: boolean; reason?: string; retryAfter?: number }>
  acquire(host: string): Promise<void>
  release(host: string, success: boolean): Promise<void>
  getAllHealth(): Promise<Record<string, HostHealth>>
  getRateLimitStatus(host: string): Promise<RateLimitResult>
  forceOpen(host: string): Promise<void>
  setCooldown(key: string, untilMs: number): Promise<void>
  getCooldown(key: string): Promise<number>
  reset(): Promise<void>
}

/**
 * Create a client stub for the RateLimiter DO.
 * Usage: const limiter = getRateLimiter(env); await limiter.acquire('www.bing.com');
 */
export function getRateLimiter(env: Env): RateLimiterRPC {
  if (!env.RATE_LIMITER) throw new Error('RATE_LIMITER binding missing — configure the Durable Object binding first')
  // 배포 환경별 인스턴스 키 (방안 B — staging/production 서킷 독립화).
  // DO 워커 빌드(wrangler esbuild)에는 define 이 없으므로 'global' 폴백이다 —
  // 이 헬퍼는 현재 호출처가 없으며, 실제 경로는 Pages 번들의 rate-limiter.ts
  // getDOClient() 가 사용한다.
  const id = env.RATE_LIMITER.idFromName(rateLimiterInstanceName())
  return env.RATE_LIMITER.get(id) as unknown as RateLimiterRPC
}

export {}
