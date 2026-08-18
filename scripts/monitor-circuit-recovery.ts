#!/usr/bin/env -S npx tsx
/**
 * production 열린 서킷 회복 ETA 모니터 (수정 82, 2026-08-16).
 *
 * production /api/health 를 주기적으로 폴링해 **tripCount >= 2** (30분 backoff
 * 스테이지 — BACKOFF_STAGES_MS=[30s, 5m, 30m], tripCount 가 2 로 클램프) 인
 * 열린 서킷이 나타나면 `openedAt + backoffMs` 로 **회복 예정 시각**을 산출하고
 * Slack 으로 알린다. tripCount < 2 는 알림 대상이 아니다 (30s/5m 스테이지는
 * 짧아 알림 노이즈 — 정보성 로그만).
 *
 * 상태 전이별 알림:
 *   backoff  (openedAt + backoff > now)     → ETA 알림 (warning)
 *   overdue  (openedAt + backoff <= now 이고
 *             여전히 tripped)               → 프로브 미회복 알림 (danger) —
 *             DO alarm 의 backoff 게이트가 지났는데도 회로가 안 닫히면
 *             프로브 실패 지속/스턱 의심 (S73 계열)
 *   closed   (이전에 알림한 host 가 닫힘)    → 회복 알림 (good, RECOVERY_NOTIFY=1)
 *
 * openedAt 이 헬스 응답에 아직 없으면 (src/lib/rate-limiter.* 의 openedAt 노출이
 * 배포되기 전) 모니터 자신의 firstSeen(첫 관측 시각) 을 **상한 추정치**로 쓰고
 * source='firstSeen' 으로 표시한다 — openedAt 기반 exact ETA 는 배포 후 활성화.
 *
 * 중복 알림 방지: 상태 파일(JSONL) 에 host 별 마지막 알림 상태를 기록하고
 * **상태 전이**(신규 트립 / backoff→overdue / 재오픈=openedAt 변경 / 회복) 시에만
 * 알린다. 같은 상태 유지는 no-op. firstSeen 은 프로세스 내부 Map(재시작 시
 * 초기화) — 재시작 후 dedup 은 상태 파일의 openedAt/state 로 유지된다.
 *
 * 사용법:
 *   # 1회 폴링 (cron 등에 등록하기 좋음)
 *   npx tsx scripts/monitor-circuit-recovery.ts --once
 *   # 주기 폴링 (60s 간격, Ctrl-C 까지)
 *   npx tsx scripts/monitor-circuit-recovery.ts --interval 60
 *   # Slack 미전송 — 페이로드만 출력 (드라이런)
 *   npx tsx scripts/monitor-circuit-recovery.ts --once --dry-run
 *   # 오프라인 검증 — 합성 열린 서킷으로 알림 경로 확인
 *   npx tsx scripts/monitor-circuit-recovery.ts --fixture --dry-run
 *   # 누적 이력 리포트
 *   npx tsx scripts/monitor-circuit-recovery.ts --report
 *
 * 옵션:
 *   --url <url>          헬스 URL (기본 https://search-engine-api.pages.dev/api/health)
 *   --interval <sec>     폴링 간격 (기본 60)
 *   --once               1회 실행 후 종료 (== --iterations 1)
 *   --iterations <n>     라운드 수 (기본 0 = Ctrl-C 까지)
 *   --min-trip-count <n> 알림 기준 tripCount (기본 2 — 30분 스테이지)
 *   --state <path>       상태 파일 (기본 logs/circuit-recovery-monitor/state.jsonl)
 *   --dry-run            Slack POST 대신 페이로드 출력
 *   --fixture            실서버 대신 합성 데이터 (오프라인 검증)
 *   --report             상태 이력 리포트만 (폴링 없음)
 *
 * Slack: SLACK_WEBHOOK 또는 ALERT_SLACK_WEBHOOK env (없으면 no-op, 수정 73
 * 스키마 — text + attachments[].color + attachments[].blocks; channel/username/
 * icon 커스터마이즈는 레거시 웹훅 전용이라 미지원).
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'

const DEFAULT_URL = 'https://search-engine-api.pages.dev/api/health'
const DEFAULT_STATE = 'logs/circuit-recovery-monitor/state.jsonl'
const FETCH_TIMEOUT_MS = 20_000
// openedAt 미노출 시(배포 전) 사용하는 상한 추정의 backoff 기본값 — 30분 스테이지.
// 실제 값은 헬스 응답의 backoffMs 를 우선한다.
const DEFAULT_BACKOFF_MS = 1_800_000

// ============================================================
// Types
// ============================================================

export interface BackendHealth {
  status?: string
  failures?: number
  inflight?: number
  tripped?: boolean
  tripCount?: number
  probeInFlight?: boolean
  backoffMs?: number
  /** 서킷이 열린 시각 (epoch ms, 0 = 닫힘) — 수정 82 노출 필드. */
  openedAt?: number
  source?: string
}

export interface HealthResponse {
  status?: string
  build_commit?: string
  timestamp?: string
  backends?: Record<string, BackendHealth>
}

export type CircuitState = 'backoff' | 'overdue' | 'closed' | 'none'

export interface EtaInfo {
  /** none = 알림 대상 아님 (닫힘 또는 tripCount < 임계) */
  state: CircuitState
  /** 회복 예정 시각 (epoch ms) — backoff/overdue 일 때만 */
  recoveryAt: number | null
  /** 남은 시간 (ms) — backoff >0, overdue <=0 */
  remainingMs: number | null
  /** ETA 계산 근거 — openedAt=정확 / firstSeen=상한 추정 */
  source: 'openedAt' | 'firstSeen' | null
}

export interface StateRecord {
  ts: string
  host: string
  state: CircuitState
  tripCount: number
  openedAt: number
  backoffMs: number
  eta: number | null
  source: 'openedAt' | 'firstSeen' | null
}

// ============================================================
// 순수 로직 (유닛 테스트 대상)
// ============================================================

/**
 * 서킷 분류 + 회복 ETA 산출.
 * openedAt 이 있으면 정확한 `openedAt + backoffMs`, 없으면 firstSeen(상한 추정).
 * tripCount < minTripCount 이거나 tripped 가 아니면 none.
 */
export function classifyCircuit(b: BackendHealth, now: number, firstSeen: number, minTripCount: number): EtaInfo {
  if (!b.tripped) return { state: 'none', recoveryAt: null, remainingMs: null, source: null }
  const tripCount = b.tripCount ?? 0
  if (tripCount < minTripCount) return { state: 'none', recoveryAt: null, remainingMs: null, source: null }

  const backoffMs = b.backoffMs && b.backoffMs > 0 ? b.backoffMs : DEFAULT_BACKOFF_MS
  if (b.openedAt && b.openedAt > 0) {
    const recoveryAt = b.openedAt + backoffMs
    return {
      state: recoveryAt > now ? 'backoff' : 'overdue',
      recoveryAt,
      remainingMs: recoveryAt - now,
      source: 'openedAt',
    }
  }
  // openedAt 미노출(배포 전) — firstSeen 상한 추정 (실제로는 더 일찍 열렸을 수 있음)
  const recoveryAt = firstSeen + backoffMs
  return {
    state: recoveryAt > now ? 'backoff' : 'overdue',
    recoveryAt,
    remainingMs: recoveryAt - now,
    source: 'firstSeen',
  }
}

/**
 * 알림 여부 판정 — 상태 전이(신규 관측 / backoff↔overdue / 재오픈) 시에만 true.
 * 같은 상태 유지는 dedup (no-op). prev 가 없으면(첫 관측) 알림.
 */
export function shouldNotify(prev: StateRecord | undefined, cur: { state: CircuitState; openedAt: number }): boolean {
  if (cur.state === 'none') return false
  if (!prev) return true
  if (prev.state !== cur.state) return true
  // 같은 backoff 상태에서 재오픈 (openedAt 변경 = 새 에피소드) → 재알림
  if (cur.openedAt > 0 && prev.openedAt > 0 && cur.openedAt !== prev.openedAt) return true
  return false
}

/** 사람이 읽는 상대 시간 (예: "25분 30초 후" / "2분 10초 지남"). */
export function formatRemaining(remainingMs: number): string {
  const abs = Math.abs(remainingMs)
  const min = Math.floor(abs / 60_000)
  const sec = Math.round((abs % 60_000) / 1000)
  const body = min > 0 ? `${min}분 ${sec}초` : `${sec}초`
  return remainingMs >= 0 ? `${body} 후` : `${body} 지남`
}

/**
 * Slack Incoming Webhook 페이로드 (수정 73 스키마: text + attachments[].color +
 * attachments[].blocks). sendSlackAlert(src/lib/slack-alert.ts) 와 동일 블록 구조.
 */
export function buildAlertPayload(opts: {
  host: string
  state: 'backoff' | 'overdue' | 'closed'
  tripCount: number
  backoffMs: number
  eta: number | null
  source: 'openedAt' | 'firstSeen' | null
  now: number
  healthUrl: string
  buildCommit?: string
}): { text: string; attachments: Array<Record<string, unknown>> } {
  const { host, state, tripCount, backoffMs, eta, source, now, healthUrl, buildCommit } = opts
  const color = state === 'overdue' ? 'danger' : state === 'closed' ? 'good' : 'warning'

  let title: string
  let message: string
  if (state === 'closed') {
    title = `✅ 서킷 회복: ${host}`
    message = `Circuit *${host}* has *closed* — backends reachable again.`
  } else if (state === 'overdue') {
    title = `⚠️ 서킷 회복 지연: ${host}`
    message = `Circuit *${host}* is still open past its backoff window — recovery probe is failing or stuck (S73 alarm chain).`
  } else {
    title = `⏱️ 서킷 회복 예정: ${host}`
    message = `Circuit *${host}* is open — recovery expected around *${eta ? new Date(eta).toISOString() : 'unknown'}* (${eta ? formatRemaining(eta - now) : 'unknown'}).`
  }

  const fields: Array<{ type: 'mrkdwn'; text: string }> = [
    { type: 'mrkdwn', text: `*Host*\n${host}` },
    { type: 'mrkdwn', text: `*TripCount*\n${tripCount}` },
    { type: 'mrkdwn', text: `*Backoff*\n${Math.round(backoffMs / 60_000)}분` },
    {
      type: 'mrkdwn',
      text: `*ETA 근거*\n${source === 'openedAt' ? 'openedAt+backoff (정확)' : 'firstSeen+backoff (상한 추정 — openedAt 미노출)'}`,
    },
  ]

  const blocks: Array<Record<string, unknown>> = [
    { type: 'header', text: { type: 'plain_text', text: title, emoji: true } },
    { type: 'section', text: { type: 'mrkdwn', text: message } },
    { type: 'section', fields },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: `monitor-circuit-recovery · ${healthUrl}${buildCommit ? ` · build ${buildCommit.slice(0, 7)}` : ''} · ${new Date(now).toISOString()}`,
        },
      ],
    },
  ]

  return { text: `${title} — ${message}`, attachments: [{ color, blocks }] }
}

/** 상태 파일 JSONL 라인 파싱 — 파손 라인은 null (무시). */
export function parseStateLine(line: string): StateRecord | null {
  const t = line.trim()
  if (!t) return null
  try {
    const o = JSON.parse(t)
    if (typeof o?.host !== 'string' || typeof o?.ts !== 'string') return null
    return o as StateRecord
  } catch {
    return null
  }
}

// ============================================================
// 상태 파일 I/O
// ============================================================

function readStateMap(path: string): Map<string, StateRecord> {
  const map = new Map<string, StateRecord>()
  if (!existsSync(path)) return map
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const rec = parseStateLine(line)
    if (rec) map.set(rec.host, rec) // host 별 마지막 기록 우선
  }
  return map
}

function appendState(path: string, rec: StateRecord): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, JSON.stringify(rec) + '\n')
}

// ============================================================
// 합성 픽스처 (오프라인 검증)
// ============================================================

export function fixtureHealth(now: number): HealthResponse {
  return {
    status: 'partial_outage',
    build_commit: 'fixture0000000000000000000000000000000000',
    backends: {
      'www.bing.com': {
        status: 'healthy',
        failures: 0,
        inflight: 0,
        tripped: false,
        tripCount: 0,
        backoffMs: 30_000,
        openedAt: 0,
        source: 'durable',
      },
      // backoff — 30분 스테이지, 25분 전 오픈 → 5분 남음
      'en.wikipedia.org': {
        status: 'down',
        failures: 6,
        inflight: 0,
        tripped: true,
        tripCount: 2,
        backoffMs: 1_800_000,
        openedAt: now - 300_000,
        probeInFlight: false,
        source: 'durable',
      },
      // overdue — 35분 전 오픈 → 30분 backoff 지남 (프로브 미회복)
      'lookup.dbpedia.org': {
        status: 'down',
        failures: 9,
        inflight: 0,
        tripped: true,
        tripCount: 2,
        backoffMs: 1_800_000,
        openedAt: now - 2_100_000,
        probeInFlight: true,
        source: 'durable',
      },
      // 임계 미달 — tripCount 1 (5분 스테이지) → 알림 없음
      'api.stackexchange.com': {
        status: 'down',
        failures: 3,
        inflight: 0,
        tripped: true,
        tripCount: 1,
        backoffMs: 300_000,
        openedAt: now - 60_000,
        probeInFlight: false,
        source: 'durable',
      },
    },
  }
}

// ============================================================
// Slack 전송
// ============================================================

async function sendSlack(
  webhookUrl: string | undefined,
  payload: { text: string; attachments: Array<Record<string, unknown>> },
  dryRun: boolean,
): Promise<boolean> {
  if (dryRun) {
    console.log('  ── [dry-run] Slack 페이로드 (POST 하지 않음) ──')
    console.log(JSON.stringify(payload, null, 2))
    return true
  }
  if (!webhookUrl) {
    console.log('  (SLACK_WEBHOOK/ALERT_SLACK_WEBHOOK 미설정 — 알림 no-op)')
    return false
  }
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    if (!resp.ok) {
      console.log(`  ❌ Slack POST 실패 (HTTP ${resp.status})`)
      return false
    }
    console.log('  ✅ Slack 알림 전송됨')
    return true
  } catch (err) {
    console.log(`  ❌ Slack POST 오류: ${String(err)}`)
    return false
  }
}

// ============================================================
// 메인
// ============================================================

interface Options {
  url: string
  intervalSec: number
  once: boolean
  iterations: number
  minTripCount: number
  statePath: string
  dryRun: boolean
  fixture: boolean
  report: boolean
}

function usage(): string {
  return `사용법: npx tsx scripts/monitor-circuit-recovery.ts [옵션]
  --once              1회 실행 후 종료
  --interval <sec>    폴링 간격 (기본 60)
  --iterations <n>    라운드 수 (기본 0 = Ctrl-C 까지)
  --min-trip-count <n> 알림 기준 tripCount (기본 2)
  --url <url>         헬스 URL (기본 ${DEFAULT_URL})
  --state <path>      상태 파일 (기본 ${DEFAULT_STATE})
  --dry-run           Slack POST 대신 페이로드 출력
  --fixture           합성 데이터로 오프라인 검증
  --report            상태 이력 리포트만
  --help|-h           이 도움말`
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    url: DEFAULT_URL,
    intervalSec: 60,
    once: false,
    iterations: 0,
    minTripCount: 2,
    statePath: DEFAULT_STATE,
    dryRun: false,
    fixture: false,
    report: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = (): string => argv[++i] ?? ''
    switch (a) {
      case '--once':
        opts.once = true
        break
      case '--interval':
        opts.intervalSec = Number(next())
        break
      case '--iterations':
        opts.iterations = Number(next())
        break
      case '--min-trip-count':
        opts.minTripCount = Number(next())
        break
      case '--url':
        opts.url = next()
        break
      case '--state':
        opts.statePath = next()
        break
      case '--dry-run':
        opts.dryRun = true
        break
      case '--fixture':
        opts.fixture = true
        break
      case '--report':
        opts.report = true
        break
      case '--help':
      case '-h':
        console.log(usage())
        process.exit(0)
        break // process.exit 로 종료되므로 default 로 빠지지 않는다 (eslint no-fallthrough)
      default:
        console.error(`알 수 없는 옵션: ${a}\n${usage()}`)
        process.exit(2)
    }
  }
  if (opts.once) opts.iterations = 1
  return opts
}

function reportOnly(statePath: string): void {
  const map = readStateMap(statePath)
  if (map.size === 0) {
    console.log('상태 이력 없음 (아직 알림 없음)')
    return
  }
  console.log('═══ 서킷 회복 모니터 상태 이력 ═══')
  for (const [host, rec] of [...map.entries()].sort()) {
    console.log(
      `  ${host}\n` +
        `    최종 상태 : ${rec.state} (tripCount=${rec.tripCount}) @ ${rec.ts}\n` +
        `    openedAt  : ${rec.openedAt ? new Date(rec.openedAt).toISOString() : 'n/a'}\n` +
        `    backoff   : ${Math.round((rec.backoffMs ?? 0) / 60_000)}분\n` +
        `    ETA       : ${rec.eta ? new Date(rec.eta).toISOString() : 'n/a'} (${rec.source ?? 'n/a'})`,
    )
  }
}

async function fetchHealth(url: string): Promise<HealthResponse | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
  try {
    const resp = await fetch(url, { signal: ctrl.signal })
    if (!resp.ok) {
      console.log(`  ❌ 헬스 HTTP ${resp.status}`)
      return null
    }
    return (await resp.json()) as HealthResponse
  } catch (err) {
    console.log(`  ❌ 헬스 fetch 오류: ${String(err)}`)
    return null
  } finally {
    clearTimeout(timer)
  }
}

async function runRound(
  opts: Options,
  stateMap: Map<string, StateRecord>,
  firstSeen: Map<string, number>,
): Promise<number> {
  const now = Date.now()
  const health = opts.fixture ? fixtureHealth(now) : await fetchHealth(opts.url)
  if (!health) return 1

  const webhook = process.env.SLACK_WEBHOOK || process.env.ALERT_SLACK_WEBHOOK
  let alerted = 0

  for (const [host, b] of Object.entries(health.backends ?? {})) {
    if (!firstSeen.has(host) && b.tripped) firstSeen.set(host, now)
    if (!b.tripped) firstSeen.delete(host)

    const eta = classifyCircuit(b, now, firstSeen.get(host) ?? now, opts.minTripCount)
    const prev = stateMap.get(host)
    const tripCount = b.tripCount ?? 0
    const backoffMs = b.backoffMs && b.backoffMs > 0 ? b.backoffMs : DEFAULT_BACKOFF_MS
    const openedAt = b.openedAt ?? 0

    if (eta.state !== 'none') {
      if (shouldNotify(prev, { state: eta.state, openedAt })) {
        const payload = buildAlertPayload({
          host,
          state: eta.state,
          tripCount,
          backoffMs,
          eta: eta.recoveryAt,
          source: eta.source,
          now,
          healthUrl: opts.url,
          buildCommit: health.build_commit,
        })
        await sendSlack(webhook, payload, opts.dryRun)
        alerted++
        appendState(opts.statePath, {
          ts: new Date(now).toISOString(),
          host,
          state: eta.state,
          tripCount,
          openedAt,
          backoffMs,
          eta: eta.recoveryAt,
          source: eta.source,
        })
        stateMap.set(host, {
          ts: new Date(now).toISOString(),
          host,
          state: eta.state,
          tripCount,
          openedAt,
          backoffMs,
          eta: eta.recoveryAt,
          source: eta.source,
        })
      }
    } else if (
      prev &&
      (prev.state === 'backoff' || prev.state === 'overdue') &&
      !b.tripped &&
      process.env.RECOVERY_NOTIFY !== '0'
    ) {
      // 회복 — 열린 상태로 알림했던 host 가 닫힘 (이미 'closed' 기록이면 반복 알림 안 함)
      const payload = buildAlertPayload({
        host,
        state: 'closed',
        tripCount: 0,
        backoffMs,
        eta: null,
        source: null,
        now,
        healthUrl: opts.url,
        buildCommit: health.build_commit,
      })
      await sendSlack(webhook, payload, opts.dryRun)
      alerted++
      appendState(opts.statePath, {
        ts: new Date(now).toISOString(),
        host,
        state: 'closed',
        tripCount: 0,
        openedAt: 0,
        backoffMs,
        eta: null,
        source: null,
      })
      stateMap.set(host, {
        ts: new Date(now).toISOString(),
        host,
        state: 'closed',
        tripCount: 0,
        openedAt: 0,
        backoffMs,
        eta: null,
        source: null,
      })
    }
  }

  const openCount = Object.entries(health.backends ?? {}).filter(
    ([, b]) => b.tripped && (b.tripCount ?? 0) >= opts.minTripCount,
  ).length
  console.log(
    `[monitor] ${new Date(now).toISOString()} backends=${Object.keys(health.backends ?? {}).length} ` +
      `open(tripCount>=${opts.minTripCount})=${openCount} alerts=${alerted} ` +
      `status=${health.status ?? '?'}${health.build_commit ? ` build=${health.build_commit.slice(0, 7)}` : ''}`,
  )
  return 0
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.report) {
    reportOnly(opts.statePath)
    return
  }

  const stateMap = readStateMap(opts.statePath)
  const firstSeen = new Map<string, number>()
  console.log('═══ 서킷 회복 ETA 모니터 ═══')
  console.log(`  URL        : ${opts.url}${opts.fixture ? ' (fixture — 실서버 아님)' : ''}`)
  console.log(`  기준 tripCount : >= ${opts.minTripCount} (기본 2 = 30분 스테이지)`)
  console.log(`  상태 파일  : ${opts.statePath}`)
  console.log(
    `  Slack      : ${opts.dryRun ? 'DRY-RUN (미전송)' : process.env.SLACK_WEBHOOK || process.env.ALERT_SLACK_WEBHOOK ? '설정됨' : '미설정 (no-op)'}`,
  )

  let round = 0
  for (;;) {
    round++
    const rc = await runRound(opts, stateMap, firstSeen)
    if (rc !== 0) {
      console.log(`  ⚠️ 라운드 실패 — ${opts.once || opts.iterations > 0 ? '종료' : '다음 라운드'}`)
      if (opts.once || (opts.iterations > 0 && round >= opts.iterations)) process.exitCode = 1
    }
    if (opts.iterations > 0 && round >= opts.iterations) break
    await new Promise((r) => setTimeout(r, opts.intervalSec * 1000))
  }
}

main().catch((err) => {
  console.error(`❌ 모니터 오류: ${String(err)}`)
  process.exit(1)
})
