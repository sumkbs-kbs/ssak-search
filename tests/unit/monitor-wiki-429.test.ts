/**
 * wikipedia REST↔Action 429 모니터 (수정 69) 순수 로직 테스트 —
 * classifyRound / computeReport / parseStateLine.
 */
import { describe, it, expect } from 'vitest'
import {
  classifyRound,
  computeReport,
  parseStateLine,
  type ProbeResult,
  type RoundRecord,
} from '../../scripts/monitor-wiki-429'

function pr(status: number): ProbeResult {
  return { status, ok: status === 200, latencyMs: 100 }
}

function rec(lang: string, rest: number, action: number, overrides: Partial<RoundRecord> = {}): RoundRecord {
  return {
    ts: '2026-08-15T14:00:00.000Z',
    source: 'egress',
    lang,
    rest: pr(rest),
    action: pr(action),
    status: classifyRound(pr(rest), pr(action)),
    ...overrides,
  }
}

describe('classifyRound — REST↔Action 상태 분류', () => {
  it('둘 다 200 → healthy', () => {
    expect(classifyRound(pr(200), pr(200))).toBe('healthy')
  })

  it('REST 429 + Action 200 → rest_limited_action_ok (Action 회복 가능 — 수정 57/58 실측 패턴)', () => {
    expect(classifyRound(pr(429), pr(200))).toBe('rest_limited_action_ok')
  })

  it('REST 200 + Action 429 → action_limited_rest_ok', () => {
    expect(classifyRound(pr(200), pr(429))).toBe('action_limited_rest_ok')
  })

  it('REST+Action 동시 429 → full_block_429 (게이트웨이 전체 블록)', () => {
    expect(classifyRound(pr(429), pr(429))).toBe('full_block_429')
  })

  it('REST 5xx + Action 200 → rest_limited_action_ok (다운이어도 Action 회복)', () => {
    expect(classifyRound(pr(503), pr(200))).toBe('rest_limited_action_ok')
  })

  it('네트워크 오류(-1) 양쪽 → full_block_down', () => {
    expect(classifyRound(pr(-1), pr(-1))).toBe('full_block_down')
  })
})

describe('computeReport — 언어별 가용성 통계', () => {
  it('REST 429 중 Action 회복률과 버스트를 계산한다', () => {
    const rounds: RoundRecord[] = [
      rec('en', 429, 200), // rest-limited, action 회복
      rec('en', 429, 200), // 버스트 시작 (연속 2)
      rec('en', 429, 429), // full block — 회복 아님
      rec('en', 200, 200), // 버스트 종료 (런 길이 3 ≥ 2 → 1건)
      rec('en', 200, 200),
    ]
    const stats = computeReport(rounds)
    const en = stats.find((s) => s.lang === 'en')!
    expect(en.rounds).toBe(5)
    expect(en.rest429).toBe(3)
    expect(en.restOk).toBe(2)
    expect(en.restLimitedRounds).toBe(3)
    expect(en.actionRecoveryRounds).toBe(2)
    expect(en.actionRecoveryRate).toBeCloseTo(2 / 3)
    expect(en.bursts).toBe(1)
    expect(en.currentBurst).toBe(false)
  })

  it('마지막 라운드가 연속 REST-429 런 도중이면 currentBurst=true', () => {
    const rounds: RoundRecord[] = [rec('zh', 429, 200), rec('zh', 429, 429), rec('zh', 429, 200)]
    const stats = computeReport(rounds)
    const zh = stats.find((s) => s.lang === 'zh')!
    expect(zh.bursts).toBe(1)
    expect(zh.currentBurst).toBe(true)
  })

  it('REST 429 가 없으면 회복률 null', () => {
    const rounds: RoundRecord[] = [rec('ko', 200, 200), rec('ko', 200, 429)]
    const stats = computeReport(rounds)
    const ko = stats.find((s) => s.lang === 'ko')!
    expect(ko.restLimitedRounds).toBe(0)
    expect(ko.actionRecoveryRate).toBeNull()
  })

  it('언어를 분리해 집계한다', () => {
    const rounds: RoundRecord[] = [rec('en', 429, 200), rec('zh', 200, 200)]
    const stats = computeReport(rounds)
    expect(stats.map((s) => s.lang).sort()).toEqual(['en', 'zh'])
    expect(stats.find((s) => s.lang === 'en')!.rest429).toBe(1)
    expect(stats.find((s) => s.lang === 'zh')!.rest429).toBe(0)
  })
})

describe('parseStateLine — 손상 라인 내성', () => {
  it('유효한 라운드 라인을 파싱한다', () => {
    const line = JSON.stringify(rec('en', 429, 200))
    const parsed = parseStateLine(line)
    expect(parsed?.lang).toBe('en')
    expect(parsed?.status).toBe('rest_limited_action_ok')
    expect(parsed?.rest.status).toBe(429)
  })

  it('잘린/손상 라인은 null (다음 라운드 기록은 계속 누적)', () => {
    expect(parseStateLine('{"ts":"2026-')).toBeNull()
    expect(parseStateLine('not json')).toBeNull()
    expect(parseStateLine('')).toBeNull()
  })

  it('형식이 다른 객체는 null', () => {
    expect(parseStateLine('{"foo":1}')).toBeNull()
  })
})
