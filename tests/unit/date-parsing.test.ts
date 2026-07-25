/**
 * Unit tests for date parsing utilities (parseRelativeTime, parseFlexibleDate).
 *
 * These power `sort_by=date` for the dominant Korean backend — Naver mobile
 * HTML exposes publish times only as Korean relative strings ("2시간 전")
 * inside <span class="time">. Without correct parsing, date-sort silently
 * no-ops for those results.
 */
import { describe, it, expect } from 'vitest'
import { parseRelativeTime, parseFlexibleDate } from '../../src/lib/util'

// Fixed "now" so tests are deterministic. 2026-07-25T12:00:00Z.
const NOW = Date.UTC(2026, 5, 25, 12, 0, 0)
const DAY = 24 * 60 * 60 * 1000
const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000

describe('parseRelativeTime', () => {
  it('parses Korean "방금 전"', () => {
    expect(parseRelativeTime('방금 전', NOW)).toBe(new Date(NOW).toISOString())
  })

  it('parses Korean relative minutes/hours/days', () => {
    expect(parseRelativeTime('30분 전', NOW)).toBe(new Date(NOW - 30 * MIN).toISOString())
    expect(parseRelativeTime('2시간 전', NOW)).toBe(new Date(NOW - 2 * HOUR).toISOString())
    expect(parseRelativeTime('3일 전', NOW)).toBe(new Date(NOW - 3 * DAY).toISOString())
  })

  it('parses Korean weeks/months/years', () => {
    expect(parseRelativeTime('1주일 전', NOW)).toBe(new Date(NOW - 7 * DAY).toISOString())
    expect(parseRelativeTime('2주 전', NOW)).toBe(new Date(NOW - 14 * DAY).toISOString())
    expect(parseRelativeTime('1개월 전', NOW)).toBe(new Date(NOW - 30 * DAY).toISOString())
    expect(parseRelativeTime('1달 전', NOW)).toBe(new Date(NOW - 30 * DAY).toISOString())
    expect(parseRelativeTime('1년 전', NOW)).toBe(new Date(NOW - 365 * DAY).toISOString())
  })

  it('parses Korean "어제" as 24h ago', () => {
    expect(parseRelativeTime('어제', NOW)).toBe(new Date(NOW - DAY).toISOString())
  })

  it('parses English relative time', () => {
    expect(parseRelativeTime('just now', NOW)).toBe(new Date(NOW).toISOString())
    expect(parseRelativeTime('yesterday', NOW)).toBe(new Date(NOW - DAY).toISOString())
    expect(parseRelativeTime('2 hours ago', NOW)).toBe(new Date(NOW - 2 * HOUR).toISOString())
    expect(parseRelativeTime('3 days ago', NOW)).toBe(new Date(NOW - 3 * DAY).toISOString())
    expect(parseRelativeTime('45 min ago', NOW)).toBe(new Date(NOW - 45 * MIN).toISOString())
  })

  it('returns null for non-relative input', () => {
    expect(parseRelativeTime('한국경제', NOW)).toBeNull()
    expect(parseRelativeTime('네이버 블로그', NOW)).toBeNull()
    expect(parseRelativeTime('', NOW)).toBeNull()
    expect(parseRelativeTime(undefined, NOW)).toBeNull()
  })
})

describe('parseFlexibleDate', () => {
  it('passes through already-ISO strings', () => {
    expect(parseFlexibleDate('2026-07-25T08:30:00Z', NOW)).toBe('2026-07-25T08:30:00.000Z')
  })

  it('parses YYYY.MM.DD (Korean absolute format)', () => {
    const iso = parseFlexibleDate('2026.07.25', NOW)
    expect(iso).toBeTruthy()
    // Note: parsed as local-time midnight (KST), which serializes as the
    // prior day 15:00 UTC. We just check the date is on/around 2026-07-2x.
    expect(iso!.startsWith('2026-07-2')).toBe(true)
  })

  it('parses YYYY-MM-DD', () => {
    const iso = parseFlexibleDate('2026-07-24', NOW)
    expect(iso).toBeTruthy()
    // Same local→UTC caveat as above.
    expect(iso!.startsWith('2026-07-2')).toBe(true)
  })

  it('parses YYYY.MM.DD with time', () => {
    const iso = parseFlexibleDate('2026.07.25 15:30', NOW)
    expect(iso).toBeTruthy()
    // 15:30 = 06:30 UTC (KST=UTC+9), but local-time construction — just check date
    expect(iso!.startsWith('2026-07-25')).toBe(true)
  })

  it('delegates to parseRelativeTime for relative input', () => {
    expect(parseFlexibleDate('2시간 전', NOW)).toBe(new Date(NOW - 2 * HOUR).toISOString())
    expect(parseFlexibleDate('3 days ago', NOW)).toBe(new Date(NOW - 3 * DAY).toISOString())
  })

  it('returns null for unparseable input', () => {
    expect(parseFlexibleDate('random text', NOW)).toBeNull()
    expect(parseFlexibleDate('', NOW)).toBeNull()
    expect(parseFlexibleDate(null, NOW)).toBeNull()
  })
})
