import { describe, it, expect } from 'vitest'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * 수정 96 (2026-08-17) — lib-verify-pace.sh 자가 적응 페이싱 유닛 테스트.
 *
 * X-RateLimit-Remaining 잔량이 낮으면(≤ PACE_ADAPT_THRESHOLD) 다음 요청 간격이
 * VERIFY_PACE_MS → PACE_ADAPT_MS 로 연장되고, 잔량이 높거나 관측이 60s 지나면
 * (창 리셋) 기본 간격으로 복귀한다. 상태 파일은 {last_ms, remaining,
 * remaining_at_ms} JSON (기존 순수 시각 형식도 읽어 JSON 으로 마이그레이션).
 *
 * 타이밍 기반 단언이므로 간격을 크게 축소(100/500ms) 하고 여유 경계(300ms) 로
 * 판정한다 — 네트워크 없음, 순수 파일 연산만.
 */
const LIB = resolve(process.cwd(), 'scripts/lib-verify-pace.sh')

function bashAvailable(): boolean {
  try {
    execFileSync('bash', ['-c', 'true'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}
const BASH_AVAILABLE = bashAvailable()

/** lib 를 source 한 뒤 fn 을 실행 (env 는 pace 파일/간격 설정) */
function runPace(fn: string, env: Record<string, string>): { exit: number; out: string } {
  const res = spawnSync('bash', ['-c', `source "${LIB}"\n${fn}`], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    maxBuffer: 10 * 1024 * 1024,
  })
  return { exit: res.status ?? -1, out: `${res.stdout ?? ''}${res.stderr ?? ''}` }
}

const nowMs = (): number => Number(runPace("python3 -c 'import time; print(int(time.time()*1000))'", {}).out.trim())

interface State {
  last_ms?: number
  remaining?: number | null
  remaining_at_ms?: number
}

function readState(pf: string): State {
  return JSON.parse(readFileSync(pf, 'utf8'))
}

const ENV = (pf: string) => ({
  VERIFY_PACE_FILE: pf,
  VERIFY_PACE_MS: '100',
  PACE_ADAPT_MS: '500',
  PACE_ADAPT_THRESHOLD: '10',
})

describe.skipIf(!BASH_AVAILABLE)('lib-verify-pace.sh (수정 96 — 자가 적응 페이싱)', () => {
  it('잔량 낮음(≤임계) → 다음 요청 간격이 PACE_ADAPT_MS 로 연장된다', () => {
    const pf = join(mkdtempSync(join(tmpdir(), 'pace-')), 'state.json')
    const env = ENV(pf)
    // seed: last_ms 기록
    expect(runPace('pace_request', env).exit).toBe(0)
    // 잔량 5 (낮음) 보고
    expect(runPace('pace_report_remaining 5', env).exit).toBe(0)
    const t0 = nowMs()
    expect(runPace('pace_request', env).exit).toBe(0)
    const elapsed = nowMs() - t0
    expect(elapsed).toBeGreaterThanOrEqual(300) // ~500ms (adapt) — 여유 경계
    const st = readState(pf)
    expect(st.remaining).toBe(5)
  })

  it('잔량 높음(>임계) → 기본 간격 유지', () => {
    const pf = join(mkdtempSync(join(tmpdir(), 'pace-')), 'state.json')
    const env = ENV(pf)
    expect(runPace('pace_request', env).exit).toBe(0)
    expect(runPace('pace_report_remaining 30', env).exit).toBe(0)
    const t0 = nowMs()
    expect(runPace('pace_request', env).exit).toBe(0)
    const elapsed = nowMs() - t0
    expect(elapsed).toBeLessThan(300) // ~100ms (base)
  })

  it('잔량 관측이 60s 지나면(창 리셋) 기본 간격으로 복귀', () => {
    const pf = join(mkdtempSync(join(tmpdir(), 'pace-')), 'state.json')
    const env = ENV(pf)
    expect(runPace('pace_request', env).exit).toBe(0)
    expect(runPace('pace_report_remaining 3', env).exit).toBe(0)
    // remaining_at_ms 를 61s 전으로 되돌려 스테일로 만든다
    const st = readState(pf)
    st.remaining = 3
    st.remaining_at_ms = (st.remaining_at_ms ?? 0) - 61000
    writeFileSync(pf, JSON.stringify(st))
    const t0 = nowMs()
    expect(runPace('pace_request', env).exit).toBe(0)
    const elapsed = nowMs() - t0
    expect(elapsed).toBeLessThan(300) // 스테일 → base
  })

  it('레거시 순수 시각 형식(숫자 한 줄) 을 읽어 JSON 으로 마이그레이션', () => {
    const pf = join(mkdtempSync(join(tmpdir(), 'pace-')), 'state.json')
    const env = ENV(pf)
    // 이전 형식(수정 88~95): epoch ms 한 줄
    writeFileSync(pf, String(nowMs()))
    const t0 = nowMs()
    expect(runPace('pace_request', env).exit).toBe(0)
    const elapsed = nowMs() - t0
    expect(elapsed).toBeLessThan(300) // last_ms 존재 → base 대기만
    const st = readState(pf)
    expect(typeof st.last_ms).toBe('number')
    expect(st.remaining).toBe(null) // 마이그레이션 후 잔량 미관측
  })

  it('pace_report_remaining 은 비숫자/빈 값을 무시한다 (헤더 파싱 실패 안전)', () => {
    const pf = join(mkdtempSync(join(tmpdir(), 'pace-')), 'state.json')
    const env = ENV(pf)
    expect(runPace('pace_report_remaining abc', env).exit).toBe(0)
    expect(runPace('pace_report_remaining', env).exit).toBe(0)
    expect(runPace('pace_report_remaining 12x', env).exit).toBe(0)
    // 숫자 보고 없음 → 상태 파일 미생성 (또는 remaining 없음)
    let st: State = {}
    try {
      st = readState(pf)
    } catch {
      st = {}
    }
    expect(st.remaining).toBeUndefined()
  })
})
