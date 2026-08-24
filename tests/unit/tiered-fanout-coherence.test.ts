import { describe, it, expect } from 'vitest'
import { TieredFanout } from '../../src/lib/search/tiered-fanout'
import { buildRelevanceProbe } from '../../src/lib/search/ranking'
import type { SearchResult } from '../../src/types'

function task(name: string, results: SearchResult[]) {
  return { name, run: async () => results }
}

function mk(domain: string, title: string, content: string): SearchResult {
  return { title, url: `https://${domain}/x`, content, score: 0.5, domain }
}

const BASE = { targetLatencyMs: 5000, minResults: 5, maxResults: 10 }

describe('TieredFanout relevantFilter (Phase H starvation fix)', () => {
  it('junk-satisfied tier1 does not suppress tier2 when a probe is supplied', async () => {
    const junk = Array.from({ length: 8 }, (_, i) =>
      mk('techcommunity.microsoft.com', `Microsoft 365 Copilot news ${i}`, 'release notes'),
    )
    const organic = [mk('en.wikipedia.org', 'Immune system', 'The immune system protects organisms')]

    const fanout = new TieredFanout()
    const result = await fanout.execute([task('bing', junk), task('wikipedia', organic)], {
      ...BASE,
      relevantFilter: buildRelevanceProbe('how does the immune system work'),
    })
    expect(result.usedBackends).toContain('wikipedia')
    expect(result.results.some((r) => r.domain === 'en.wikipedia.org')).toBe(true)
  })

  it('without a probe the legacy early-exit behavior is preserved', async () => {
    const junk = Array.from({ length: 8 }, (_, i) =>
      mk('techcommunity.microsoft.com', `Microsoft 365 Copilot news ${i}`, 'release notes'),
    )
    let tier2Ran = false
    const fanout = new TieredFanout()
    await fanout.execute(
      [
        task('bing', junk),
        {
          name: 'wikipedia',
          run: async () => {
            tier2Ran = true
            return []
          },
        },
      ],
      { ...BASE },
    )
    expect(tier2Ran).toBe(false)
  })

  it('relevant results still satisfy minResults and keep the fast path', async () => {
    const organic = Array.from({ length: 6 }, (_, i) =>
      mk('example.com', `photosynthesis explained part ${i}`, 'chlorophyll light reactions'),
    )
    const fanout = new TieredFanout()
    const result = await fanout.execute([task('bing', organic), task('wikipedia', [])], {
      ...BASE,
      relevantFilter: buildRelevanceProbe('how does photosynthesis work'),
    })
    expect(result.tierUsed).toBe('tier1')
  })
})
