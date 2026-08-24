import { describe, it, expect } from 'vitest'
import { TieredFanout } from '../../src/lib/search/tiered-fanout'
import type { SearchResult } from '../../src/types'

function makeResult(backend: string, n: number): SearchResult[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `${backend} result ${i}`,
    url: `https://example.com/${backend}/${i}`,
    content: `${backend} content ${i}`,
    score: 0.5,
    domain: 'example.com',
  }))
}

function task(name: string, results: SearchResult[], delayMs = 0) {
  return {
    name,
    run: async () => {
      if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs))
      return results
    },
  }
}

const BASE_OPTIONS = {
  targetLatencyMs: 500,
  minResults: 5,
  maxResults: 10,
}

describe('TieredFanout protectedBackends', () => {
  it('minResults 충족 시 보호 대상 없으면 기존처럼 조기 종료한다 (tier2 미실행)', async () => {
    const fanout = new TieredFanout()
    const tasks = [
      task('self-index', makeResult('self', 3)),
      task('bing', makeResult('bing', 5)),
      task('github', makeResult('github', 2)),
      task('wikipedia', makeResult('wiki', 2)),
    ]

    const result = await fanout.execute(tasks, BASE_OPTIONS)

    expect(result.usedBackends).not.toContain('github')
    expect(result.usedBackends).not.toContain('wikipedia')
    expect(result.usedBackends).toContain('bing')
  })

  it('보호된 백엔드가 하위 tier에 있으면 minResults 충족 후에도 실행한다', async () => {
    const fanout = new TieredFanout()
    const tasks = [
      task('self-index', makeResult('self', 3)),
      task('bing', makeResult('bing', 5)),
      task('github', makeResult('github', 2)),
      // wikipedia는 보호 대상이 아니므로 여전히 생략되어야 한다
      task('wikipedia', makeResult('wiki', 2)),
    ]

    const result = await fanout.execute(tasks, {
      ...BASE_OPTIONS,
      protectedBackends: ['github'],
    })

    expect(result.usedBackends).toContain('github')
    expect(result.usedBackends).not.toContain('wikipedia')
    expect(result.results.length).toBeGreaterThanOrEqual(5)
  })

  it('보호 대상이 태스크 플랜에 없으면 동작이 변하지 않는다 (no-op)', async () => {
    const fanout = new TieredFanout()
    const tasks = [task('bing', makeResult('bing', 6)), task('hackernews', makeResult('hn', 2))]

    const result = await fanout.execute(tasks, {
      ...BASE_OPTIONS,
      protectedBackends: ['arxiv'],
    })

    expect(result.usedBackends).not.toContain('hackernews')
    expect(result.usedBackends).not.toContain('arxiv')
  })

  it('보호 대상 실패 시에도 전체 팬아웃은 성공한다 (부분 결과 반환)', async () => {
    const fanout = new TieredFanout()
    const failingProtected = {
      name: 'github',
      run: async () => {
        throw new Error('github down')
      },
    }
    const tasks = [task('bing', makeResult('bing', 8)), failingProtected]

    const result = await fanout.execute(tasks, {
      ...BASE_OPTIONS,
      protectedBackends: ['github'],
    })

    expect(result.usedBackends).toContain('bing')
    expect(result.results.length).toBeGreaterThanOrEqual(5)
  })
})
