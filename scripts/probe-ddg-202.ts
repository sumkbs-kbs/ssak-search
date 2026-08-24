/**
 * DDG 202 anti-bot IP-persistence probe (docs/15·16 근거 검증).
 *
 * duckduckgo의 202 fail-fast + lite-skip 설계는 "202 챌린지는 IP/핑거프린트
 * 단위로 지속된다 — 동일 IP 재요청도 202, lite도 202"라는 가정에 의존한다
 * (src/lib/duckduckgo.ts 주석 + docs/15 2절). 이 프로브는 그 가정을 실제
 * 응답 데이터로 검증한다:
 *
 *   Phase 0  egress 신원   — cloudflare /cdn-cgi/trace 로 출발 IP/colo 확인
 *   Phase 1  html 재요청    — 생산과 동일한 POST를 N회 연속(동일 IP) → 202 지속 여부
 *   Phase 2  lite 동일 IP   — html이 202일 때 lite도 202인지 (lite-skip 근거)
 *   Phase 3  Retry-After   — 202의 Retry-After 헤더 파싱 + (선택) 대기 후 재요청
 *
 * 실행: npx tsx scripts/probe-ddg-202.ts [--attempts N] [--retry-wait-ms M]
 *       [--honor-retry-after] [--query Q] [--delay-ms D] [--json] [--strict]
 *
 * ⚠️ 이 프로브가 도는 네트워크 컨텍스트가 곧 검증 대상 IP다. 로컬(가정용/
 * 회사 IP)에서 202가 나오지 않으면 "not-challenged" — 이는 가정을 부정하는
 * 것이 아니라 해당 egress에서 챌린지가 발생하지 않았다는 뜻. IP 기반 가정의
 * 진짜 검증은 Cloudflare Workers egress(데이터센터 IP)에서 실행해야 한다
 * (Phase 0 출력으로 컨텍스트 확인). --strict 는 가정이 반증될 때(202→200
 * transient, lite 200) exit 1 을 반환한다.
 */

// ── 생산 duckduckgo.ts 와 동일한 핑거프린트 (동기화 대상) ────────────────
const DDG_HTML_URL = 'https://html.duckduckgo.com/html/'
const DDG_LITE_URL = 'https://lite.duckduckgo.com/lite/'
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

// ── 순수 분류 로직 (단위 테스트 대상 — probe-ddg-202.test.ts) ─────────────

export interface DdgProbeAttempt {
  /** html 엔드포인트 POST vs lite 엔드포인트 GET. */
  endpoint: 'html' | 'lite'
  /** HTTP 상태; null = 네트워크 오류/타임아웃. */
  status: number | null
  latencyMs: number
  /** 202 응답의 Retry-After (초). 없으면 undefined. */
  retryAfterSec?: number
  /** 202 응답의 전체 헤더 (소문자 키) — 챌린지 쿠키/서버 핑거프린트 확인용. */
  challengeHeaders?: Record<string, string>
  /** 202 페이지 <title> — "challenge"/"Anomaly" 류인지 식별. */
  challengeTitle?: string
  bodyBytes?: number
}

export interface DdgProbeData {
  /** Phase 1 — 동일 IP에서의 연속 html 재요청 결과. */
  htmlAttempts: DdgProbeAttempt[]
  /** Phase 2 — html 202일 때만 실행한 lite 요청 결과. */
  liteAttempt?: DdgProbeAttempt
  /** Phase 3 — Retry-After 대기 후 재요청한 html 결과. */
  retryAfterProbe?: DdgProbeAttempt
}

export type DdgChallengeVerdict =
  | { kind: 'not-challenged'; htmlStatuses: Array<number | null> }
  | {
      /** 가정 확인: 동일 IP에서 202가 지속 + lite도 202 → fail-fast/lite-skip 정당. */
      kind: 'ip-persistent'
      html202Count: number
      lite202: boolean
    }
  | {
      /** 가정 반증(1): 202가 같은 IP에서 200으로 회복 → 202 재시도가 실익. */
      kind: 'transient-challenge'
      recoveredAfter: 'html' | 'retry-after'
    }
  | {
      /** 가정 반증(2): html 202인데 lite 200 → lite-skip 설계가 손실. */
      kind: 'lite-mismatch'
      liteStatus: number
    }
  | { kind: 'inconclusive'; reason: string }

/** Retry-After 헤더(초 또는 HTTP-date)를 초 단위로 파싱. */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const secs = Number(header)
  if (Number.isFinite(secs) && header.trim() !== '') return Math.max(0, secs)
  const date = new Date(header).getTime() - Date.now()
  if (Number.isFinite(date)) return Math.max(0, date / 1000)
  return undefined
}

/**
 * 수집된 프로브 데이터를 IP-지속 가정 관점에서 분류한다.
 *
 * 판정 순서 (가장 놀라운 신호 우선):
 *   1. lite 200 (html 202 뒤) → lite-skip 설계가 결과를 버리는 상황 → lite-mismatch
 *   2. 202 뒤 같은 IP에서 200 (html 재요청 또는 Retry-After 대기 후) → transient-challenge
 *   3. html 202 ≥ 2회 또는 lite 202 → ip-persistent (가정 확인)
 *   4. 202 1회뿐이고 lite가 202/200 모두 아님(네트워크 오류 등) → inconclusive
 *   5. 202 0회 → not-challenged (해당 egress에서 챌린지 미발생)
 */
export function classifyDdgChallenge(data: DdgProbeData): DdgChallengeVerdict {
  const html202 = data.htmlAttempts.filter((a) => a.status === 202)
  if (html202.length === 0) {
    return { kind: 'not-challenged', htmlStatuses: data.htmlAttempts.map((a) => a.status) }
  }

  if (data.liteAttempt?.status === 200) {
    return { kind: 'lite-mismatch', liteStatus: data.liteAttempt.status }
  }

  const recoveredInHtml = data.htmlAttempts.some(
    (a, i) => a.status === 202 && data.htmlAttempts.slice(i + 1).some((b) => b.status === 200),
  )
  if (recoveredInHtml) return { kind: 'transient-challenge', recoveredAfter: 'html' }
  if (data.retryAfterProbe?.status === 200) return { kind: 'transient-challenge', recoveredAfter: 'retry-after' }

  if (html202.length >= 2 || data.liteAttempt?.status === 202) {
    return { kind: 'ip-persistent', html202Count: html202.length, lite202: data.liteAttempt?.status === 202 }
  }

  return {
    kind: 'inconclusive',
    reason: 'html 202 1회뿐이고 lite 결과가 202/200 모두 아님 (네트워크 오류 또는 lite 미실행) — 표본 추가 필요',
  }
}

// ── CLI ────────────────────────────────────────────────────────────────────

interface CliOptions {
  attempts: number
  delayMs: number
  retryWaitMs: number
  honorRetryAfter: boolean
  query: string
  json: boolean
  strict: boolean
}

function parseCli(argv: string[]): CliOptions {
  const opts: CliOptions = {
    attempts: 3,
    delayMs: 1000,
    retryWaitMs: 3000,
    honorRetryAfter: false,
    query: 'hello world',
    json: false,
    strict: false,
  }
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case '--attempts':
        opts.attempts = Number(argv[++i]) || 3
        break
      case '--delay-ms':
        opts.delayMs = Number(argv[++i]) || 1000
        break
      case '--retry-wait-ms':
        opts.retryWaitMs = Number(argv[++i]) || 3000
        break
      case '--honor-retry-after':
        opts.honorRetryAfter = true
        break
      case '--query':
        opts.query = argv[++i] ?? opts.query
        break
      case '--json':
        opts.json = true
        break
      case '--strict':
        opts.strict = true
        break
      case '--help':
        console.log(`Usage: npx tsx scripts/probe-ddg-202.ts [options]

DDG 202 anti-bot 챌린지의 IP-지속 가정을 실제 응답으로 검증한다.

  --attempts N          html 엔드포인트 연속 재요청 횟수 (기본 3)
  --delay-ms D          시도 간 간격 ms (기본 1000)
  --retry-wait-ms M     202 후 재요청까지 대기 ms (기본 3000)
  --honor-retry-after   202의 Retry-After(초)를 우선 대기 (헤더 없으면 retry-wait-ms)
  --query Q             검색어 (기본 'hello world')
  --json                수집 데이터를 JSON으로 출력
  --strict              가정이 반증될 때 exit 1 (transient-challenge / lite-mismatch)
`)
        process.exit(0)
        break // unreachable — no-fallthrough
      default:
        // 알 수 없는 플래그는 무시 (스크립트 관용)
        break
    }
  }
  return opts
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function fetchWithAbort(url: string, init: RequestInit, timeoutMs = 8000): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } finally {
    clearTimeout(timer)
  }
}

function extractTitle(html: string): string | undefined {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  if (!m) return undefined
  return m[1]
    .replace(/<[^>]+>/g, '')
    .trim()
    .slice(0, 80)
}

async function probeHtml(query: string): Promise<DdgProbeAttempt> {
  const params = new URLSearchParams()
  params.append('q', query)
  params.append('kl', 'wt-wt')
  params.append('df', '')
  params.append('b', '')
  const start = Date.now()
  try {
    const res = await fetchWithAbort(DDG_HTML_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
        Referer: 'https://html.duckduckgo.com/',
      },
      body: params.toString(),
    })
    const latencyMs = Date.now() - start
    if (res.status === 202) {
      const body = await res.text()
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
      return {
        endpoint: 'html',
        status: res.status,
        latencyMs,
        retryAfterSec: parseRetryAfter(headers['retry-after']),
        challengeHeaders: headers,
        challengeTitle: extractTitle(body),
        bodyBytes: body.length,
      }
    }
    await res.arrayBuffer() // 소켓/서브리퀘스트 해제
    return { endpoint: 'html', status: res.status, latencyMs }
  } catch (_err) {
    return { endpoint: 'html', status: null, latencyMs: Date.now() - start }
  }
}

async function probeLite(query: string): Promise<DdgProbeAttempt> {
  const params = new URLSearchParams()
  params.append('q', query)
  params.append('kl', 'wt-wt')
  params.append('df', '')
  const start = Date.now()
  try {
    const res = await fetchWithAbort(`${DDG_LITE_URL}?${params.toString()}`, {
      method: 'GET',
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
        Referer: 'https://lite.duckduckgo.com/',
      },
    })
    const latencyMs = Date.now() - start
    if (res.status === 202) {
      const body = await res.text()
      const headers: Record<string, string> = {}
      res.headers.forEach((v, k) => {
        headers[k.toLowerCase()] = v
      })
      return {
        endpoint: 'lite',
        status: res.status,
        latencyMs,
        retryAfterSec: parseRetryAfter(headers['retry-after']),
        challengeHeaders: headers,
        challengeTitle: extractTitle(body),
        bodyBytes: body.length,
      }
    }
    await res.arrayBuffer()
    return { endpoint: 'lite', status: res.status, latencyMs }
  } catch (_err) {
    return { endpoint: 'lite', status: null, latencyMs: Date.now() - start }
  }
}

async function fetchEgressIdentity(): Promise<Record<string, string>> {
  try {
    const res = await fetchWithAbort(
      'https://www.cloudflare.com/cdn-cgi/trace',
      { headers: { 'User-Agent': 'curl/8' } },
      5000,
    )
    const text = await res.text()
    const kv: Record<string, string> = {}
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=')
      if (eq > 0) kv[line.slice(0, eq).trim()] = line.slice(eq + 1).trim()
    }
    return kv
  } catch {
    return {}
  }
}

function fmtAttempt(a: DdgProbeAttempt, label: string): string {
  const status = a.status === null ? 'NET-ERR' : String(a.status)
  const ra = a.retryAfterSec !== undefined ? `  Retry-After: ${a.retryAfterSec}s` : ''
  const title = a.challengeTitle ? `  title: "${a.challengeTitle}"` : ''
  const bytes = a.bodyBytes !== undefined ? `  body: ${a.bodyBytes}B` : ''
  return `  ${label.padEnd(10)} → ${status.padEnd(7)} ${String(a.latencyMs).padStart(5)}ms${ra}${title}${bytes}`
}

function verdictToLine(v: DdgChallengeVerdict): string {
  switch (v.kind) {
    case 'not-challenged':
      return `not-challenged — 이 egress에서는 202 미발생 (html statuses: [${v.htmlStatuses.join(', ')}]). IP-지속 가정은 Workers egress(데이터센터 IP)에서 재실행 필요.`
    case 'ip-persistent':
      return `ip-persistent — html 202 ×${v.html202Count} + lite 202=${v.lite202} → "동일 IP에서 202 지속 + lite도 202" 가정 확인. fail-fast + lite-skip 설계 정당.`
    case 'transient-challenge':
      return `transient-challenge — 202 뒤 ${v.recoveredAfter === 'html' ? '동일 IP 재요청' : 'Retry-After 대기 후'} 200 회복 → 202도 재시도 대상이면 실익 있음 (현재 B안은 202 제외).`
    case 'lite-mismatch':
      return `lite-mismatch — html 202인데 lite ${v.liteStatus} → lite-skip 설계가 결과를 버리는 상황. docs/15의 lite 스킵 근거 반증.`
    case 'inconclusive':
      return `inconclusive — ${v.reason}`
  }
}

async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2))
  const egress = await fetchEgressIdentity()

  console.log('=== DDG 202 IP-persistence probe ===')
  console.log(
    `egress: ip=${egress['ip'] ?? '?'} loc=${egress['loc'] ?? '?'} colo=${egress['colo'] ?? '?'} warp=${egress['warp'] ?? '?'}`,
  )
  console.log(
    `query="${opts.query}" attempts=${opts.attempts} delay=${opts.delayMs}ms retry-wait=${opts.retryWaitMs}ms honor-retry-after=${opts.honorRetryAfter}`,
  )

  // Phase 1 — html 연속 재요청 (동일 IP)
  console.log('\n[Phase 1] html 엔드포인트 연속 재요청:')
  const htmlAttempts: DdgProbeAttempt[] = []
  for (let i = 0; i < opts.attempts; i++) {
    if (i > 0) await sleep(opts.delayMs)
    const a = await probeHtml(opts.query)
    htmlAttempts.push(a)
    console.log(fmtAttempt(a, `html #${i + 1}`))
    if (a.challengeHeaders) {
      const interesting = [
        'retry-after',
        'set-cookie',
        'location',
        'server',
        'content-type',
        'cache-control',
        'expires',
      ]
      for (const h of interesting) {
        if (a.challengeHeaders[h]) console.log(`    header ${h}: ${a.challengeHeaders[h].slice(0, 160)}`)
      }
    }
  }

  const anyHtml202 = htmlAttempts.some((a) => a.status === 202)

  // Phase 2 — lite (html 202일 때만)
  let liteAttempt: DdgProbeAttempt | undefined
  if (anyHtml202) {
    console.log('\n[Phase 2] lite 엔드포인트 (동일 IP — lite-skip 근거 검증):')
    liteAttempt = await probeLite(opts.query)
    console.log(fmtAttempt(liteAttempt, 'lite'))
  }

  // Phase 3 — Retry-After 대기 후 재요청
  let retryAfterProbe: DdgProbeAttempt | undefined
  if (anyHtml202) {
    const firstRa = htmlAttempts.find((a) => a.retryAfterSec !== undefined)?.retryAfterSec
    const waitMs =
      opts.honorRetryAfter && firstRa !== undefined ? Math.max(firstRa * 1000, opts.retryWaitMs) : opts.retryWaitMs
    console.log(`\n[Phase 3] ${waitMs}ms 대기 후 html 재요청 (Retry-After=${firstRa ?? '없음'}):`)
    await sleep(waitMs)
    retryAfterProbe = await probeHtml(opts.query)
    console.log(fmtAttempt(retryAfterProbe, 'retry-after'))
  }

  const data: DdgProbeData = { htmlAttempts, liteAttempt, retryAfterProbe }
  const verdict = classifyDdgChallenge(data)

  console.log('\n=== verdict ===')
  console.log(`  ${verdictToLine(verdict)}`)

  if (opts.json) {
    console.log('\n' + JSON.stringify({ egress, data, verdict }, null, 2))
  }

  if (opts.strict && (verdict.kind === 'transient-challenge' || verdict.kind === 'lite-mismatch')) {
    console.error('\n[strict] IP-지속 가정이 반증됨 — exit 1')
    process.exit(1)
  }
}

// 단위 테스트에서 import 시 CLI가 실행되지 않도록 가드 (vitest의 argv[1]은
// vitest 바이너리 경로 — tsx 직접 실행일 때만 이 파일 경로다).
const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-ddg-202.ts') || scriptPath.endsWith('probe-ddg-202')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
