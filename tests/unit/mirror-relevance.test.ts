import { describe, it, expect } from 'vitest'
import { filterMirrorResults } from '../../src/lib/util'

const mk = (title: string, url: string) => ({
  title,
  url,
  content: `${title} snippet`,
  score: 0.3,
  domain: 'en.wikipedia.org',
})

describe('filterMirrorResults — FINDING-1 relevance gate', () => {
  it('drops fuzzy label matches sharing no query token', () => {
    const results = [
      mk('FK Željezničar Sarajevo', 'https://en.wikipedia.org/wiki/FK_Zeljeznicar_Sarajevo'),
      mk('Rosario Central', 'https://en.wikipedia.org/wiki/Rosario_Central'),
      mk('Cloudflare Workers', 'https://en.wikipedia.org/wiki/Cloudflare_Workers'),
    ]
    const kept = filterMirrorResults('cloudflare workers tutorial', results)
    expect(kept.map((r) => r.title)).toEqual(['Cloudflare Workers'])
  })

  it('keeps S35 gold recovery for factual queries', () => {
    const results = [mk('Quantum computing', 'https://en.wikipedia.org/wiki/Quantum_computing')]
    expect(filterMirrorResults('what is quantum computing', results)).toHaveLength(1)
  })

  it('passes through when query has no usable tokens', () => {
    const results = [mk('Anything', 'https://en.wikipedia.org/wiki/Anything')]
    expect(filterMirrorResults('???', results)).toHaveLength(1)
  })

  it('matches CJK queries via character bigrams', () => {
    const results = [mk('量子計算', 'https://zh.wikipedia.org/wiki/量子計算')]
    expect(filterMirrorResults('什么是量子计算', results)).toHaveLength(1)
  })

  it('keeps everything when every result is relevant', () => {
    const results = [
      mk('React hooks guide', 'https://en.wikipedia.org/wiki/React'),
      mk('Hooks API reference', 'https://en.wikipedia.org/wiki/Hooks_API'),
    ]
    expect(filterMirrorResults('react hooks guide', results)).toHaveLength(2)
  })
})
