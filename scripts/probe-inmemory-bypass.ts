#!/usr/bin/env -S npx tsx
/**
 * Per-isolate bypass probe — in-memory fallback vs Durable Object mode
 *
 * S88 (2026-08-10): live measurement showed the in-memory fallback's
 * `hosts_tracked` FLUCTUATING (6→8→6) across repeated /api/health probes —
 * direct evidence that rate-limiter state lives in per-isolate module maps
 * (LOCAL_CIRCUITS / LOCAL_RATE_WINDOWS) that Cloudflare distributes across
 * isolates per request. A circuit tripped in isolate A is invisible to
 * isolate B (bypass); a rate window filled in A still lets B through.
 *
 * This script reproduces that bypass two ways:
 *
 *   1. --sim (default): loads rate-limiter.ts TWICE via cache-busting imports
 *      (file://…?iso=A / ?iso=B) — each import gets its OWN module-level
 *      LOCAL_CIRCUITS/LOCAL_RATE_WINDOWS maps, exactly like two Cloudflare
 *      isolates. Then:
 *        a. rate-window bypass: isolate A fills the wikipedia 100/min window;
 *           isolate B still passes (expected: A=deny, B=allow).
 *        b. circuit bypass: isolate A trips a circuit (5 failures); isolate B
 *           still passes (expected: A=deny, B=allow).
 *      The same checks run against a single (DO-mode equivalent) shared
 *      instance to show the contrast: when state is shared, A's window/circuit
 *      DOES block B.
 *
 *   2. WORKER_URL probe: hits /api/health repeatedly and reports the
 *      rate_limiter mode + source + hosts_tracked sequence. Since S89 the
 *      health payload carries a `source` stamp ('local' | 'durable') — the
 *      classifier uses it as the PRIMARY signal and falls back to
 *      hosts_tracked monotonicity when the stamp is absent (pre-S89 worker):
 *        - durable + monotonic        → cross-isolate shared state (consistent)
 *        - local (or non-monotonic)   → per-isolate fluctuation (bypass)
 *
 * Usage:
 *   npx tsx scripts/probe-inmemory-bypass.ts            # --sim + production health
 *   npx tsx scripts/probe-inmemory-bypass.ts --no-sim    # health probe only
 *   npx tsx scripts/probe-inmemory-bypass.ts --no-health # deterministic sim-only (no network)
 *   WORKER_URL=https://… npx tsx scripts/probe-inmemory-bypass.ts --no-sim
 */

const WIKI_URL = 'https://en.wikipedia.org/wiki/Test'
const BING_URL = 'https://www.bing.com/search?q=test'

interface RateLimiterModule {
  canRequest(env: unknown, url: string): Promise<boolean>
  release(env: unknown, url: string, success: boolean): Promise<void>
  getBackendHealth(env: unknown): Promise<Record<string, unknown>>
}

const MODULE_URL = 'file://' + process.cwd() + '/src/lib/rate-limiter.ts'

/** Fresh module instance = one Cloudflare isolate (cache-busting import). */
async function loadIsolate(tag: string): Promise<RateLimiterModule> {
  const mod = await import(`${MODULE_URL}?iso=${tag}&${Date.now()}`)
  return mod as unknown as RateLimiterModule
}

const EMPTY_ENV: Record<string, never> = {}

function line(title: string): void {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(4, 60 - title.length))}`)
}

/** One /api/health observation used by the fluctuation classifier. */
export interface HealthProbeSample {
  /** rate_limiter.mode — 'durable_object' | 'in_memory_fallback'. */
  mode?: string
  /** S89 source stamp — 'local' (per-isolate maps) | 'durable' (DO storage). */
  source?: 'local' | 'durable'
  /** rate_limiter.hosts_tracked. */
  hostsTracked?: number
}

export type FluctuationVerdict =
  | { kind: 'durable_consistent'; reason: string }
  | { kind: 'local_fluctuating'; reason: string }
  | { kind: 'mixed_sources'; reason: string }
  | { kind: 'unknown'; reason: string }

/**
 * Classify a health probe sequence into durable-vs-local (S89 source-aware).
 *
 * PRIMARY signal: the `source` stamp every host carries since S89.
 *   - all 'durable'   → cross-isolate shared state (DO storage)
 *   - any 'local'     → per-isolate in-memory maps (bypass risk)
 *   - mixed           → inconsistent deployment (old + new isolates)
 *
 * FALLBACK (no stamp at all): hosts_tracked monotonicity — DO mode only ever
 * grows (new hosts discovered), while per-isolate maps fluctuate (6→8→6 —
 * S88 measurement). A non-monotonic sequence (any decrease) is classified
 * local_fluctuating; monotonic + constant is durable_consistent.
 *
 * LIMITATION (fallback only): constant hosts_tracked is NOT uniquely a DO
 * signature — all probes may land on the SAME warm isolate, whose maps also
 * stay constant. Only the non-monotonic dip is a strong local signal; the
 * durable_consistent inference for constant sequences is best-effort.
 *
 * When SOME samples carry stamps and none are 'local', the fallback also
 * applies (rollout with mixed old/new isolates) — the reason string then
 * reflects the partial-stamp reality rather than claiming pre-S89.
 * Pure function — unit-testable without any network/mocks.
 */
export function classifyHealthProbe(samples: readonly HealthProbeSample[]): FluctuationVerdict {
  if (samples.length === 0) {
    return { kind: 'unknown', reason: 'samples empty — nothing to classify' }
  }

  const stamps = samples.map((s) => s.source).filter((v): v is 'local' | 'durable' => !!v)
  // Preserve genuine 0 (empty in-memory state) but drop MISSING fields, so a
  // response without hosts_tracked collapses to an empty sequence instead of
  // a fake constant-[0,0,0] that would read as durable (S93 review nit).
  const trackedSeq = samples.map((s) => s.hostsTracked).filter((v): v is number => v !== undefined)
  const monotonic = trackedSeq.every((v, i) => i === 0 || v >= trackedSeq[i - 1])
  const constant = new Set(trackedSeq).size === 1
  const seqStr = trackedSeq.length ? `hosts_tracked=[${trackedSeq.join('→')}]` : 'hosts_tracked=<missing>'

  // Primary: explicit S89 source stamps.
  if (stamps.length === samples.length) {
    const kinds = new Set(stamps)
    if (kinds.size === 1 && kinds.has('durable')) {
      return {
        kind: 'durable_consistent',
        reason: `all ${samples.length} probes source=durable, ${seqStr} ${monotonic ? '(monotonic — cross-isolate DO storage)' : '(non-monotonic — unexpected)'}`,
      }
    }
    if (kinds.size === 1 && kinds.has('local')) {
      return {
        kind: 'local_fluctuating',
        reason: `all ${samples.length} probes source=local, ${seqStr} — per-isolate in-memory maps, bypass risk`,
      }
    }
    return { kind: 'mixed_sources', reason: `mixed stamps ${[...kinds].join('+')}, ${seqStr}` }
  }

  // Some stamps present — treat any 'local' as the dominant signal.
  if (stamps.includes('local')) {
    return {
      kind: 'local_fluctuating',
      reason: `source=local among stamps (${stamps.length}/${samples.length} stamped), ${seqStr} — per-isolate in-memory maps`,
    }
  }

  // Fallback: no 'local' stamps. Distinguish full absence (pre-S89 worker)
  // from partial stamps (old+new isolate rollout) in the reason string.
  const stampContext =
    stamps.length === 0
      ? 'no source stamp (pre-S89 worker)'
      : `partial source stamps (${stamps.length}/${samples.length} stamped, all durable)`
  if (trackedSeq.length === 0) {
    return { kind: 'unknown', reason: `${stampContext}; hosts_tracked missing entirely — cannot classify` }
  }
  if (monotonic && constant) {
    return {
      kind: 'durable_consistent',
      reason: `${stampContext}; ${seqStr} constant — cross-isolate shared state (inferred; single warm isolate also possible)`,
    }
  }
  if (monotonic) {
    return {
      kind: 'durable_consistent',
      reason: `${stampContext}; ${seqStr} monotonic (new hosts discovered) — DO storage (inferred)`,
    }
  }
  return {
    kind: 'local_fluctuating',
    reason: `${stampContext}; ${seqStr} non-monotonic — per-isolate fluctuation (S88 6→8→6 signature, inferred)`,
  }
}

async function simRateWindow(isoA: RateLimiterModule, isoB: RateLimiterModule): Promise<void> {
  // Isolate A fills the wikipedia 100/min shared window (wikipedia subdomains
  // share one budget — rate-limiter.ts WIKIPEDIA_RATE_KEY). 100 mirrors
  // HOST_CONFIGS['en.wikipedia.org'].rateLimitPerMinute.
  for (let i = 0; i < 100; i++) await isoA.canRequest(EMPTY_ENV, WIKI_URL)
  const aAfter = await isoA.canRequest(EMPTY_ENV, WIKI_URL)
  const bAfter = await isoB.canRequest(EMPTY_ENV, WIKI_URL)
  console.log('  A: window 100건 소진 후 canRequest =', aAfter)
  console.log('  B: 별도 isolate canRequest        =', bAfter)
  console.log('  →', aAfter === false && bAfter === true ? '✅ per-isolate 우회 재현' : '⚠️ 기대와 다름')
}

async function simCircuit(isoA: RateLimiterModule, isoB: RateLimiterModule): Promise<void> {
  // Isolate A trips the bing circuit — 5 mirrors
  // HOST_CONFIGS['www.bing.com'].failureThreshold.
  for (let i = 0; i < 5; i++) await isoA.release(EMPTY_ENV, BING_URL, false)
  const aAfter = await isoA.canRequest(EMPTY_ENV, BING_URL)
  const bAfter = await isoB.canRequest(EMPTY_ENV, BING_URL)
  console.log('  A: 5회 실패 후 canRequest =', aAfter, '(기대 false — circuit trip)')
  console.log('  B: 별도 isolate canRequest =', bAfter, '(기대 true — 우회)')
  console.log('  →', aAfter === false && bAfter === true ? '✅ per-isolate circuit 우회 재현' : '⚠️ 기대와 다름')
}

async function simShared(): Promise<void> {
  // DO-mode equivalent: ONE shared module instance — A's window/circuit state
  // MUST block B (this is what the Durable Object gives you).
  const shared = await loadIsolate('shared')
  for (let i = 0; i < 100; i++) await shared.canRequest(EMPTY_ENV, WIKI_URL)
  const winA = await shared.canRequest(EMPTY_ENV, WIKI_URL)
  const winB = await shared.canRequest(EMPTY_ENV, WIKI_URL)
  console.log('  window: A 소진 후 A =', winA, '| B(동일 인스턴스) =', winB)
  console.log(
    '  →',
    winA === false && winB === false ? '✅ 공유 상태 — B도 차단 (DO 모드와 동일 의미)' : '⚠️ 기대와 다름',
  )

  const shared2 = await loadIsolate('shared2')
  for (let i = 0; i < 5; i++) await shared2.release(EMPTY_ENV, BING_URL, false)
  const circA = await shared2.canRequest(EMPTY_ENV, BING_URL)
  const circB = await shared2.canRequest(EMPTY_ENV, BING_URL)
  console.log('  circuit: A trip 후 A =', circA, '| B(동일 인스턴스) =', circB)
  console.log('  →', circA === false && circB === false ? '✅ 공유 상태 — B도 차단' : '⚠️ 기대와 다름')
}

async function probeHealth(): Promise<void> {
  const url = process.env.WORKER_URL ?? 'https://search-engine-api.pages.dev'
  line(`라이브 /api/health — ${url}`)
  const samples: HealthProbeSample[] = []
  for (let i = 0; i < 5; i++) {
    const res = await fetch(`${url}/api/health?cb=${Date.now()}-${i}`)
    if (!res.ok) {
      console.log(`  probe ${i}: HTTP ${res.status}`)
      continue
    }
    const body = (await res.json()) as {
      rate_limiter?: { mode?: string; hosts_tracked?: number; source?: 'local' | 'durable' }
      features?: { rate_limiter_do?: boolean }
    }
    const mode = body.rate_limiter?.mode ?? 'unknown'
    const source = body.rate_limiter?.source
    const tracked = body.rate_limiter?.hosts_tracked ?? 0
    samples.push({ mode, source, hostsTracked: tracked })
    console.log(
      `  probe ${i}: mode=${mode} source=${source ?? '(none)'} hosts_tracked=${tracked} rate_limiter_do=${body.features?.rate_limiter_do}`,
    )
    await new Promise((r) => setTimeout(r, 800))
  }
  console.log('')
  const verdict = classifyHealthProbe(samples)
  console.log(`  → 판정: ${verdict.kind}`)
  console.log(`    ${verdict.reason}`)
}

async function main(): Promise<void> {
  console.log('═'.repeat(64))
  console.log(' Per-isolate bypass probe — in-memory fallback vs Durable Object')
  console.log(' S88 evidence reproduction (2026-08-10)')
  console.log('═'.repeat(64))

  const sim = !process.argv.includes('--no-sim')
  const health = !process.argv.includes('--no-health')

  if (sim) {
    line('시뮬레이션 1 — rate window per-isolate 우회 (wikipedia 100/min)')
    const isoA = await loadIsolate('A')
    const isoB = await loadIsolate('B')
    await simRateWindow(isoA, isoB)

    line('시뮬레이션 2 — circuit breaker per-isolate 우회 (bing, threshold 5)')
    const isoC = await loadIsolate('C')
    const isoD = await loadIsolate('D')
    await simCircuit(isoC, isoD)

    line('대조 — 단일 공유 인스턴스 (DO 모드와 동일 의미)')
    await simShared()
  }

  if (health) {
    try {
      await probeHealth()
    } catch (e) {
      console.log(`\n  ⚠️ health probe 불가 (네트워크): ${(e as Error).message?.slice(0, 120)}`)
      console.log('    시뮬레이션 결과는 유효 — --no-health로 네트워크 없는 실행 가능')
    }
  }

  console.log('')
  console.log('해석: in-memory fallback의 LOCAL_* 상태는 isolate별 모듈 맵 —')
  console.log('Cloudflare가 요청마다 isolate를 분산하므로 한 isolate의 rate window/')
  console.log('circuit 상태가 다른 isolate에 보이지 않음. DO 바인딩(durable_object)은')
  console.log('단일 DO 인스턴스 storage에 상태를 두어 전역 일관성을 보장.')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
