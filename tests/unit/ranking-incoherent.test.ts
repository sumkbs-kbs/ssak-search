/**
 * Tests for the Phase H pool coherence filter — drops results sharing no
 * signal with the query so anti-bot shell harvests cannot fill responses or
 * suppress the emergency fallback.
 */

import { describe, it, expect } from 'vitest'
import { filterIncoherentResults } from '../../src/lib/search/ranking'
import type { SearchResult } from '../../src/types'

function mk(title: string, content: string, domain = 'example.com'): SearchResult {
  return {
    title,
    url: `https://${domain}/${encodeURIComponent(title.slice(0, 12))}`,
    content,
    score: 0.5,
    domain,
  }
}

describe('filterIncoherentResults', () => {
  it('drops the measured anti-bot harvest (Korean query, Yahoo JP/MS shells)', () => {
    const junk = [
      mk('ユニチカ (株)【3103】：掲示板 - Yahoo!ファイナンス', 'ユニチカの掲示板です'),
      mk("What's New in Microsoft 365 Copilot | June 2026", 'Copilot release notes'),
      mk('Get ready for Windows 11, version 26H2', 'Windows IT Pro Blog'),
    ]
    expect(filterIncoherentResults(junk, '리액트 훅 사용법 설명해줘')).toEqual([])
  })

  it('drops the English-question harvest while keeping organic results', () => {
    const mixed = [
      mk('Turn sound effects on or off in Outlook | Microsoft Support', 'sound settings'),
      mk('Photosynthesis - Wikipedia', 'Photosynthesis is the process used by plants'),
      mk('How photosynthesis works - Khan Academy', 'light-dependent reactions explained'),
    ]
    const out = filterIncoherentResults(mixed, 'how does photosynthesis work')
    expect(out).toHaveLength(2)
    expect(out.every((r) => /photosynthesis/i.test(r.title))).toBe(true)
  })

  it('keeps CJK matches via bigram substrings', () => {
    const results = [mk('什么是区块链技术', '区块链是一种分布式账本'), mk('今日の天気予報', '東京は晴れです')]
    const out = filterIncoherentResults(results, '什么是量子计算')
    expect(out.map((r) => r.title)).toEqual(['什么是区块链技术'])
  })

  it('matches Latin signals on word boundaries ("work" does not match "networks")', () => {
    const results = [mk('Top mesh networks 2026', 'wifi gear roundup')]
    expect(filterIncoherentResults(results, 'how does photosynthesis work')).toEqual([])
    const organic = [mk('How solar panels work', 'photovoltaic cells explained')]
    expect(filterIncoherentResults(organic, 'how do solar panels work')).toHaveLength(1)
  })

  it('is a no-op for symbol-only queries (no usable signals)', () => {
    const results = [mk('anything', 'at all')]
    expect(filterIncoherentResults(results, '!!! ???')).toHaveLength(1)
  })

  it('exempts cross-language knowledge sources (kr query, english github repo)', () => {
    const results = [
      mk('usehooks-ts - React hooks library', 'TypeScript hooks collection', 'github.com'),
      mk('Photosynthesis - Wikipedia', 'the process used by plants', 'en.wikipedia.org'),
      mk('InfraStaking - LinkedIn', 'company page', 'linkedin.com'),
    ]
    const out = filterIncoherentResults(results, '리액트 훅 사용법')
    expect(out.map((r) => r.title)).toEqual(['usehooks-ts - React hooks library', 'Photosynthesis - Wikipedia'])
  })

  it('returns empty for an all-junk pool so the fallback chain can trigger', () => {
    const junk = [mk('defiprime staking pools', 'crypto yields'), mk('baidu zhidao question', '中文问题')]
    expect(filterIncoherentResults(junk, 'who invented the telephone')).toEqual([])
  })
})
