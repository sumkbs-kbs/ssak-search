/**
 * Unit tests for the DDG 202 IP-persistence classifier.
 *
 * classifyDdgChallenge() turns raw probe data (html re-requests from the same
 * IP, a same-IP lite attempt, a Retry-After re-probe) into a verdict on the
 * "202 is IP-persistent" assumption that justifies the fail-fast + lite-skip
 * design in duckduckgo.ts (docs/15).
 */
import { describe, it, expect } from 'vitest'
import {
  classifyDdgChallenge,
  parseRetryAfter,
  type DdgProbeAttempt,
  type DdgProbeData,
} from '../../scripts/probe-ddg-202'

function html(status: number | null, overrides: Partial<DdgProbeAttempt> = {}): DdgProbeAttempt {
  return { endpoint: 'html', status, latencyMs: 100, ...overrides }
}

function data(partial: Partial<DdgProbeData>): DdgProbeData {
  return { htmlAttempts: [], ...partial }
}

describe('classifyDdgChallenge — IP-지속 가정 검증', () => {
  it('202가 전혀 없으면 not-challenged (해당 egress에서 챌린지 미발생)', () => {
    const v = classifyDdgChallenge(data({ htmlAttempts: [html(200), html(200)] }))
    expect(v.kind).toBe('not-challenged')
    if (v.kind === 'not-challenged') expect(v.htmlStatuses).toEqual([200, 200])
  })

  it('html 202가 지속되고 lite도 202면 ip-persistent — fail-fast/lite-skip 정당', () => {
    const v = classifyDdgChallenge(
      data({
        htmlAttempts: [html(202), html(202), html(202)],
        liteAttempt: { endpoint: 'lite', status: 202, latencyMs: 90 },
      }),
    )
    expect(v.kind).toBe('ip-persistent')
    if (v.kind === 'ip-persistent') {
      expect(v.html202Count).toBe(3)
      expect(v.lite202).toBe(true)
    }
  })

  it('html 202 1회 + lite 202 1회도 ip-persistent로 인정 (2개 관측)', () => {
    const v = classifyDdgChallenge(
      data({ htmlAttempts: [html(202)], liteAttempt: { endpoint: 'lite', status: 202, latencyMs: 90 } }),
    )
    expect(v.kind).toBe('ip-persistent')
  })

  it('202 뒤 같은 IP 재요청이 200이면 transient-challenge — 202 재시도 실익 신호', () => {
    const v = classifyDdgChallenge(data({ htmlAttempts: [html(202), html(200)] }))
    expect(v.kind).toBe('transient-challenge')
    if (v.kind === 'transient-challenge') expect(v.recoveredAfter).toBe('html')
  })

  it('Retry-After 대기 후 재요청이 200이면 transient-challenge (retry-after 경로)', () => {
    const v = classifyDdgChallenge(
      data({ htmlAttempts: [html(202)], retryAfterProbe: html(200, { endpoint: 'html' }) }),
    )
    expect(v.kind).toBe('transient-challenge')
    if (v.kind === 'transient-challenge') expect(v.recoveredAfter).toBe('retry-after')
  })

  it('html 202인데 lite 200이면 lite-mismatch — lite-skip 설계 반증', () => {
    const v = classifyDdgChallenge(
      data({
        htmlAttempts: [html(202), html(202)],
        liteAttempt: { endpoint: 'lite', status: 200, latencyMs: 90 },
      }),
    )
    expect(v.kind).toBe('lite-mismatch')
    if (v.kind === 'lite-mismatch') expect(v.liteStatus).toBe(200)
  })

  it('202 1회뿐이고 lite가 네트워크 오류면 inconclusive (표본 부족)', () => {
    const v = classifyDdgChallenge(
      data({
        htmlAttempts: [html(202)],
        liteAttempt: { endpoint: 'lite', status: null, latencyMs: 8000 },
      }),
    )
    expect(v.kind).toBe('inconclusive')
  })
})

describe('parseRetryAfter', () => {
  it('초 단위 숫자 헤더를 파싱', () => {
    expect(parseRetryAfter('120')).toBe(120)
    expect(parseRetryAfter('0')).toBe(0)
  })

  it('HTTP-date 헤더를 남은 초로 파싱', () => {
    const future = new Date(Date.now() + 60_000).toUTCString()
    const secs = parseRetryAfter(future)
    expect(secs).toBeDefined()
    if (secs !== undefined) {
      expect(secs).toBeGreaterThan(50)
      expect(secs).toBeLessThanOrEqual(60)
    }
  })

  it('없거나 파싱 불가면 undefined', () => {
    expect(parseRetryAfter(undefined)).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
    expect(parseRetryAfter('')).toBeUndefined()
    expect(parseRetryAfter('not-a-date')).toBeUndefined()
  })
})
