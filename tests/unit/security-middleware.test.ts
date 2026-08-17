/**
 * Security Middleware — rate limit slot consumption tests.
 *
 * Regression guard for the double-counting bug: the response-header reporting
 * call used to call checkIpRateLimit() WITHOUT record:false, so every API
 * request consumed TWO slots and the effective per-IP limit was silently
 * halved (10/min → 5/min).
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { checkIpRateLimit, resolveIpRateLimit } from '../../src/lib/security-middleware'

const IP_RATE_LIMIT = 10

// Fresh IP per test group — the module-level map is shared across tests.
function uniqueIp(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}`
}

describe('checkIpRateLimit slot accounting', () => {
  beforeEach(() => {
    // no-op — map is module-level; unique IPs keep tests isolated
  })

  it('consumes exactly one slot per recorded call', () => {
    const ip = uniqueIp('single')
    const first = checkIpRateLimit(ip)
    expect(first.allowed).toBe(true)
    expect(first.remaining).toBe(IP_RATE_LIMIT - 1)

    const second = checkIpRateLimit(ip)
    expect(second.allowed).toBe(true)
    expect(second.remaining).toBe(IP_RATE_LIMIT - 2)
  })

  it('does NOT consume a slot when record:false (header reporting path)', () => {
    const ip = uniqueIp('peek')
    // One real request
    checkIpRateLimit(ip)
    // Header reporting must not consume another slot
    const peek = checkIpRateLimit(ip, IP_RATE_LIMIT, { record: false })
    expect(peek.allowed).toBe(true)
    expect(peek.remaining).toBe(IP_RATE_LIMIT - 1)

    // A second real request sees the same remaining as after the first
    const again = checkIpRateLimit(ip)
    expect(again.remaining).toBe(IP_RATE_LIMIT - 2)
  })

  it('blocks once the window is exhausted (limit requests recorded)', () => {
    const ip = uniqueIp('exhaust')
    for (let i = 0; i < IP_RATE_LIMIT; i++) {
      const r = checkIpRateLimit(ip)
      expect(r.allowed).toBe(true)
    }
    const blocked = checkIpRateLimit(ip)
    expect(blocked.allowed).toBe(false)
    expect(blocked.remaining).toBe(0)
  })

  it('reporting calls never push a window over the limit', () => {
    const ip = uniqueIp('peek-heavy')
    // Fill the window with REAL requests
    for (let i = 0; i < IP_RATE_LIMIT; i++) checkIpRateLimit(ip)
    // Many reporting calls (headers on every response) must not block anyone
    for (let i = 0; i < 50; i++) {
      const peek = checkIpRateLimit(ip, IP_RATE_LIMIT, { record: false })
      expect(peek.remaining).toBe(0)
      expect(peek.allowed).toBe(false) // window is full — reports 0 remaining
    }
  })

  it('respects custom limits', () => {
    const ip = uniqueIp('custom')
    const customLimit = 3
    for (let i = 0; i < customLimit; i++) {
      expect(checkIpRateLimit(ip, customLimit).allowed).toBe(true)
    }
    expect(checkIpRateLimit(ip, customLimit).allowed).toBe(false)
  })
})

describe('resolveIpRateLimit (수정 97 — 무인증 게이트 RATE_LIMIT_PER_MIN 오버라이드)', () => {
  it('미설정/빈값/비숫자/0 이하 → 기본 10 유지 (보안 게이트 불변)', () => {
    expect(resolveIpRateLimit({})).toBe(10)
    expect(resolveIpRateLimit({ RATE_LIMIT_PER_MIN: '' })).toBe(10)
    expect(resolveIpRateLimit({ RATE_LIMIT_PER_MIN: 'abc' })).toBe(10)
    expect(resolveIpRateLimit({ RATE_LIMIT_PER_MIN: '0' })).toBe(10)
    expect(resolveIpRateLimit({ RATE_LIMIT_PER_MIN: '-3' })).toBe(10)
  })

  it('양의 정수 → 그 값 (60/min 상향 옵션 — auth.ts 와 같은 env 공유)', () => {
    expect(resolveIpRateLimit({ RATE_LIMIT_PER_MIN: '60' })).toBe(60)
    expect(resolveIpRateLimit({ RATE_LIMIT_PER_MIN: 60 })).toBe(60)
  })
})
