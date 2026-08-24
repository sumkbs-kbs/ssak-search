/**
 * Browser Agent backend — Phase I v1
 *
 * 로컬 Chrome(CDP)으로 Bing/Naver SERP를 읽는 사용자 전용 백엔드.
 * 봇 차단의 판별 축(데이터센터 IP·핑거프린트)을 통과하는 거주 세션이라
 * 클라우드 스크래핑이 막히는 지점을 통과한다 (docs/BROWSER_AGENT.md).
 *
 * 게이트: env.BROWSER_AGENT_URL 있을 때만 태스크 생성 — 미설정 시 기존과
 * 100% 동일 동작. 에이전트 다운 = 일반 백엔드 실패로 회로차단기가 우회.
 *
 * 인증: BROWSER_AGENT_TOKEN(Bearer). 에이전트는 사용자 Mac의 로그인 세션에
 * 접근 가능하므로 토큰 없이 공개 노출하는 것을 금지한다.
 */

import type { SearchResult } from '../types'
import type { SearchContext } from './search/context'

export interface BrowserSerpResult {
  title: string
  url: string
  domain?: string
  snippet?: string
}

/** 에이전트 /serp 응답 → SearchResult 매핑. 위치 기반 초기 점수 부여. */
export function mapBrowserAgentResults(raw: BrowserSerpResult[], maxResults: number): SearchResult[] {
  const out: SearchResult[] = []
  const seen = new Set<string>()
  for (let i = 0; i < raw.length && out.length < maxResults; i++) {
    const r = raw[i]
    if (!r?.url || !r.url.startsWith('http')) continue
    if (seen.has(r.url)) continue
    seen.add(r.url)
    let domain = r.domain || ''
    if (!domain) {
      try {
        domain = new URL(r.url).hostname.replace(/^www\./, '')
      } catch {
        continue
      }
    }
    out.push({
      title: (r.title || '').trim().slice(0, 300),
      url: r.url,
      content: (r.snippet || r.title || '').trim().slice(0, 500),
      score: Math.max(0.35, 0.85 - i * 0.05),
      domain,
    })
  }
  return out
}

export function buildBrowserAgentTask(ctx: SearchContext, maxResults = 8) {
  const env = ctx.env as { BROWSER_AGENT_URL?: string; BROWSER_AGENT_TOKEN?: string } | undefined
  const baseUrl = env?.BROWSER_AGENT_URL
  if (!baseUrl) return null

  // 한국어면 Naver 우선, 그 외 Bing. 두 엔진을 모두 태우지 않는 이유:
  // 에이전트는 사용자 계정 세션을 쓰므로 요청 수 자체를 최소화해야 한다.
  const engine = ctx.korean ? 'naver' : 'bing'

  return {
    name: 'browser',
    run: async () => {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 12_000)
      try {
        const resp = await fetch(`${baseUrl.replace(/\/+$/, '')}/serp`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(env?.BROWSER_AGENT_TOKEN ? { Authorization: `Bearer ${env.BROWSER_AGENT_TOKEN}` } : {}),
          },
          body: JSON.stringify({ engine, query: ctx.query, count: maxResults }),
          signal: controller.signal,
        })
        if (!resp.ok) throw new Error(`browser agent HTTP ${resp.status}`)
        const data = (await resp.json()) as { results?: BrowserSerpResult[] }
        return mapBrowserAgentResults(data.results ?? [], maxResults)
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
