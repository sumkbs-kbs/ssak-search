/**
 * Unit tests for the 방안 B migration cleaner worker (scripts/clean-global-limiter-worker.ts).
 *
 * handle(request, env) 를 가짜 RATE_LIMITER 바인딩과 함께 직접 호출해
 * status/reset 모드, clean 판정, instance 오버라이드, 바인딩 누락을 검증한다.
 * 네트워크/DO 없이 순수 로직 테스트 (node env).
 */
import { describe, it, expect, vi } from 'vitest'
import { handle } from '../../scripts/clean-global-limiter-worker'

interface FakeStub {
  getAllHealth: ReturnType<typeof vi.fn>
  getAlarmInfo: ReturnType<typeof vi.fn>
  reset: ReturnType<typeof vi.fn>
  state: { health: Record<string, { tripped?: boolean }>; alarm: number | null; resetCalls: number }
}

/** 잔존 상태를 들고 있는 가짜 DO stub. reset() 은 상태를 비운다. */
function makeStub(initialHealth: Record<string, { tripped?: boolean }> = {}, alarm: number | null = null): FakeStub {
  const state = { health: initialHealth, alarm, resetCalls: 0 }
  const stub = {
    getAllHealth: vi.fn(async () => state.health),
    getAlarmInfo: vi.fn(async () => ({ pendingAlarmAt: state.alarm })),
    reset: vi.fn(async () => {
      state.resetCalls++
      state.health = {}
      state.alarm = null
    }),
    state,
  }
  return stub
}

function makeEnv(stub: FakeStub, withBinding = true): any {
  if (!withBinding) return {}
  const ids: string[] = []
  return {
    RATE_LIMITER: {
      idFromName: vi.fn((name: string) => {
        ids.push(name)
        return { name }
      }),
      get: vi.fn((id: { name: string }) => {
        expect(id.name).toBe(ids[ids.length - 1])
        return stub
      }),
    },
  }
}

function req(url: string): Request {
  return new Request(url)
}

describe('clean-global-limiter worker (방안 B 마이그레이션 클리너)', () => {
  it('status 모드: 잔존 alarm 프로브 상태를 보고하고 reset 은 호출하지 않는다', async () => {
    const stub = makeStub(
      { 'www.bing.com': { tripped: true }, 'en.wikipedia.org': { tripped: false } },
      Date.now() + 60_000,
    )
    const env = makeEnv(stub)

    const res = await handle(req('https://cleaner/?instance=global&mode=status'), env)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toMatchObject({
      instance: 'global',
      mode: 'status',
      clean: false,
      before: { hosts: 2, openCircuits: 1, alarmPending: true },
    })
    expect(stub.reset).not.toHaveBeenCalled()
  })

  it('status 모드: 이미 깨끗한 인스턴스는 clean=true (잔존 없음)', async () => {
    const stub = makeStub({})
    const env = makeEnv(stub)

    const body = await (await handle(req('https://cleaner/?mode=status'), env)).json()
    expect(body).toMatchObject({
      instance: 'global',
      mode: 'status',
      clean: true,
      before: { hosts: 0, alarmPending: false },
    })
    expect(stub.reset).not.toHaveBeenCalled()
  })

  it('reset 모드: before 대조 → reset() → after clean=true (알람 프로브 정리 확정)', async () => {
    const stub = makeStub(
      { 'www.bing.com': { tripped: true }, 'html.duckduckgo.com': { tripped: true } },
      Date.now() + 60_000,
    )
    const env = makeEnv(stub)

    const res = await handle(req('https://cleaner/?instance=global&mode=reset'), env)
    expect(res.status).toBe(200)
    const body = await res.json()

    expect(body).toMatchObject({
      instance: 'global',
      mode: 'reset',
      clean: true,
      before: { hosts: 2, openCircuits: 2, alarmPending: true },
      after: { hosts: 0, openCircuits: 0, alarmPending: false },
    })
    expect(stub.reset).toHaveBeenCalledTimes(1)
  })

  it('reset 모드: 이미 깨끗한 인스턴스도 멱등하게 reset() 을 호출해 clean 유지', async () => {
    const stub = makeStub({})
    const env = makeEnv(stub)

    const body = await (await handle(req('https://cleaner/?mode=reset'), env)).json()
    expect(body).toMatchObject({ clean: true, after: { hosts: 0, alarmPending: false } })
    expect(stub.reset).toHaveBeenCalledTimes(1)
  })

  it('instance 파라미터로 대상 인스턴스 오버라이드 (기본은 global)', async () => {
    const stub = makeStub({})
    const env = makeEnv(stub)

    await handle(req('https://cleaner/?instance=production&mode=status'), env)
    expect(env.RATE_LIMITER!.idFromName).toHaveBeenCalledWith('production')
  })

  it('RATE_LIMITER 바인딩 누락 시 500 + 명확한 에러', async () => {
    const res = await handle(req('https://cleaner/?mode=reset'), makeEnv(makeStub({}), false))
    expect(res.status).toBe(500)
    const body = (await res.json()) as { error: string }
    expect(body.error).toContain('RATE_LIMITER binding missing')
  })

  it('mode 미지정 시 기본 status (파괴적 동작 없음)', async () => {
    const stub = makeStub({ 'www.bing.com': { tripped: true } }, Date.now() + 60_000)
    const env = makeEnv(stub)

    const body = (await (await handle(req('https://cleaner/?instance=global'), env)).json()) as { mode: string }
    expect(body.mode).toBe('status')
    expect(stub.reset).not.toHaveBeenCalled()
  })
})
