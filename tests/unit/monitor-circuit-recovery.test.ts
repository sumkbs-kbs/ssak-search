/**
 * 서킷 회복 ETA 모니터 (수정 82) 순수 로직 테스트 —
 * classifyCircuit / shouldNotify / formatRemaining / buildAlertPayload /
 * parseStateLine / fixtureHealth.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyCircuit,
  shouldNotify,
  formatRemaining,
  buildAlertPayload,
  parseStateLine,
  fixtureHealth,
  type BackendHealth,
  type StateRecord,
} from '../../scripts/monitor-circuit-recovery'

const NOW = 1_800_000_000_000

function backend(overrides: Partial<BackendHealth>): BackendHealth {
  return { tripped: false, tripCount: 0, backoffMs: 30_000, openedAt: 0, ...overrides }
}

describe('classifyCircuit — ETA 산출 (openedAt + backoff)', () => {
  it('tripCount>=2 + openedAt → backoff 상태 + 정확한 ETA (openedAt+backoff)', () => {
    // 30분 스테이지, 5분 전 오픈 → 25분 남음
    const eta = classifyCircuit(
      backend({ tripped: true, tripCount: 2, backoffMs: 1_800_000, openedAt: NOW - 300_000 }),
      NOW,
      NOW - 600_000,
      2,
    )
    expect(eta.state).toBe('backoff')
    expect(eta.recoveryAt).toBe(NOW - 300_000 + 1_800_000)
    expect(eta.remainingMs).toBe(1_500_000)
    expect(eta.source).toBe('openedAt')
  })

  it('backoff 경과 후에도 tripped → overdue (프로브 미회복)', () => {
    const eta = classifyCircuit(
      backend({ tripped: true, tripCount: 2, backoffMs: 1_800_000, openedAt: NOW - 2_100_000 }),
      NOW,
      NOW - 600_000,
      2,
    )
    expect(eta.state).toBe('overdue')
    expect(eta.remainingMs).toBeLessThanOrEqual(0)
    expect(eta.source).toBe('openedAt')
  })

  it('openedAt 미노출(배포 전) → firstSeen 상한 추정 (source=firstSeen)', () => {
    const eta = classifyCircuit(
      backend({ tripped: true, tripCount: 2, backoffMs: 1_800_000 }), // openedAt 없음
      NOW,
      NOW - 120_000,
      2,
    )
    expect(eta.state).toBe('backoff')
    expect(eta.recoveryAt).toBe(NOW - 120_000 + 1_800_000)
    expect(eta.source).toBe('firstSeen')
  })

  it('tripCount < 임계 → none (알림 대상 아님)', () => {
    const eta = classifyCircuit(
      backend({ tripped: true, tripCount: 1, backoffMs: 300_000, openedAt: NOW - 60_000 }),
      NOW,
      NOW - 60_000,
      2,
    )
    expect(eta.state).toBe('none')
  })

  it('닫힌 서킷 → none', () => {
    const eta = classifyCircuit(backend({ tripped: false, tripCount: 2 }), NOW, NOW, 2)
    expect(eta.state).toBe('none')
  })

  it('backoffMs 누락 시 30분 기본값 사용', () => {
    const eta = classifyCircuit(
      backend({ tripped: true, tripCount: 2, openedAt: NOW, backoffMs: undefined }), // backoffMs 없음
      NOW,
      NOW,
      2,
    )
    expect(eta.recoveryAt).toBe(NOW + 1_800_000)
  })
})

describe('shouldNotify — 전이 dedup', () => {
  const prev: StateRecord = {
    ts: '2026-08-16T00:00:00.000Z',
    host: 'h',
    state: 'backoff',
    tripCount: 2,
    openedAt: NOW - 300_000,
    backoffMs: 1_800_000,
    eta: NOW + 1_500_000,
    source: 'openedAt',
  }

  it('첫 관측(prev 없음) → 알림', () => {
    expect(shouldNotify(undefined, { state: 'backoff', openedAt: NOW - 300_000 })).toBe(true)
  })

  it('같은 상태 유지 → dedup (no-op)', () => {
    expect(shouldNotify(prev, { state: 'backoff', openedAt: NOW - 300_000 })).toBe(false)
  })

  it('backoff → overdue 전이 → 알림', () => {
    expect(shouldNotify(prev, { state: 'overdue', openedAt: NOW - 300_000 })).toBe(true)
  })

  it('재오픈 (openedAt 변경) → 알림', () => {
    expect(shouldNotify(prev, { state: 'backoff', openedAt: NOW - 10_000 })).toBe(true)
  })

  it('none → 알림 안 함', () => {
    expect(shouldNotify(prev, { state: 'none', openedAt: 0 })).toBe(false)
  })
})

describe('formatRemaining — 상대 시간', () => {
  it('미래 → "N분 N초 후"', () => {
    expect(formatRemaining(1_500_000)).toBe('25분 0초 후')
  })
  it('과거 → "N분 N초 지남"', () => {
    expect(formatRemaining(-130_000)).toBe('2분 10초 지남')
  })
  it('1분 미만 → 초 단위', () => {
    expect(formatRemaining(45_000)).toBe('45초 후')
  })
})

describe('buildAlertPayload — Slack 스키마 (수정 73)', () => {
  const payload = buildAlertPayload({
    host: 'en.wikipedia.org',
    state: 'backoff',
    tripCount: 2,
    backoffMs: 1_800_000,
    eta: NOW + 1_500_000,
    source: 'openedAt',
    now: NOW,
    healthUrl: 'https://search-engine-api.pages.dev/api/health',
    buildCommit: 'abcdef0',
  })

  it('text(문자열) + attachments[].color + blocks 구조', () => {
    expect(typeof payload.text).toBe('string')
    expect(payload.attachments).toHaveLength(1)
    expect(payload.attachments[0].color).toBe('warning')
    expect(Array.isArray(payload.attachments[0].blocks)).toBe(true)
  })

  it('ETA(ISO)와 ETA 근거 필드를 포함한다', () => {
    const blocks = payload.attachments[0].blocks as Array<Record<string, unknown>>
    const json = JSON.stringify(blocks)
    expect(json).toContain(new Date(NOW + 1_500_000).toISOString())
    expect(json).toContain('openedAt+backoff (정확)')
  })

  it('overdue → danger 색상', () => {
    const p = buildAlertPayload({
      host: 'h',
      state: 'overdue',
      tripCount: 2,
      backoffMs: 1_800_000,
      eta: NOW - 1000,
      source: 'openedAt',
      now: NOW,
      healthUrl: 'u',
      buildCommit: 'abcdef0',
    })
    expect(p.attachments[0].color).toBe('danger')
  })

  it('closed → good 색상 + 회복 문구', () => {
    const p = buildAlertPayload({
      host: 'h',
      state: 'closed',
      tripCount: 0,
      backoffMs: 1_800_000,
      eta: null,
      source: null,
      now: NOW,
      healthUrl: 'u',
      buildCommit: undefined,
    })
    expect(p.attachments[0].color).toBe('good')
    expect(JSON.stringify(p.attachments[0].blocks)).toContain('서킷 회복')
  })
})

describe('parseStateLine — JSONL 파싱', () => {
  it('정상 라인 → StateRecord', () => {
    const rec = parseStateLine(
      '{"ts":"2026-08-16T00:00:00.000Z","host":"h","state":"backoff","tripCount":2,"openedAt":1,"backoffMs":1800000,"eta":2,"source":"openedAt"}',
    )
    expect(rec?.host).toBe('h')
    expect(rec?.state).toBe('backoff')
  })
  it('파손 라인 → null', () => {
    expect(parseStateLine('{not json')).toBeNull()
    expect(parseStateLine('')).toBeNull()
    expect(parseStateLine('{"ts":"x"}')).toBeNull()
  })
})

describe('fixtureHealth — 오프라인 검증 데이터', () => {
  it('backoff/overdue/임계미달/닫힘 4종 상태를 포함한다', () => {
    const f = fixtureHealth(NOW)
    const b = f.backends!
    expect(b['en.wikipedia.org'].tripped).toBe(true)
    expect(b['en.wikipedia.org'].tripCount).toBe(2)
    expect(b['lookup.dbpedia.org'].tripped).toBe(true)
    expect(b['api.stackexchange.com'].tripCount).toBe(1) // 임계 미달
    expect(b['www.bing.com'].tripped).toBe(false)
  })
})
