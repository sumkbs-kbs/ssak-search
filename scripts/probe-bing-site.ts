/**
 * Bing site: operator honors-probe — CJK 여행·커뮤니티 gold (S104 진단).
 *
 * 배경: docs/02·08/10은 "bing은 site: 연산자를 무시한다"고 기록했지만
 * (stack-exchange.ts·all.ts 주석, DDG site:reddit 선례), 동시에 video 전략은
 * bingSearch('site:youtube.com ...')를 생산에 사용 중이다 (buildBingYouTubeTask).
 * 이 모순이 곧 이 프로브의 검증 대상이다:
 *
 *   Phase 0  plain bing      — zh 여행/커뮤니티 gold 쿼리 기본 bing 풀의 도메인
 *   Phase 1  bing site:      — site:mafengwo.cn/ctrip.com/dianping.com/
 *                              xiaohongshu.com/trip.com/qunar.com 프리픽스가
 *                              gold 도메인을 실제로 회수하는지 (0건 = 무시 가정 확인)
 *   Phase 2  DDG site: 대조   — duckDuckGoSearch('site:mafengwo.cn ...') 실측
 *                              (P24 선례: DDG는 site: 10/10 인정)
 *
 * 실행: npx tsx scripts/probe-bing-site.ts [--json] [--query Q]
 *
 * ⚠️ 로컬(가정용/회사 IP) egress에서의 결과는 Workers egress(데이터센터 IP)와
 * 다를 수 있다. 결론은 "해당 egress에서 bing site: 가 인정되는가"다.
 */

import { bingSearch } from '../src/lib/bing-search'
import { duckDuckGoSearch } from '../src/lib/duckduckgo'
import { extractDomain } from '../src/lib/util'

export {} // 모듈 격리 — scripts/*.ts 전역 스크립트 스코프와의 선언 충돌 방지

interface ProbeCase {
  label: string
  engine: 'bing' | 'ddg'
  query: string
}

const GOLD_QUERIES: Array<{ id: string; query: string; gold: string[] }> = [
  { id: 'zh-travel-01', query: '张家界旅游攻略', gold: ['ctrip.com', 'mafengwo.cn', 'xiaohongshu.com', 'trip.com', 'qunar.com'] },
  { id: 'zh-general-01', query: '北京旅游攻略', gold: ['ctrip.com', 'mafengwo.cn', 'zh.wikipedia.org'] },
  { id: 'zh-general-02', query: '上海美食推荐', gold: ['dianping.com', 'mafengwo.cn'] },
  { id: 'zh-general-06', query: '上海迪士尼攻略', gold: ['ctrip.com', 'mafengwo.cn', 'dianping.com', 'xiaohongshu.com', 'zhihu.com', 'trip.com'] },
]

const BING_SITE_DOMAINS = ['mafengwo.cn', 'ctrip.com', 'dianping.com', 'xiaohongshu.com', 'trip.com', 'qunar.com']

function buildCases(): ProbeCase[] {
  const cases: ProbeCase[] = []
  for (const g of GOLD_QUERIES) {
    cases.push({ label: `${g.id} | bing plain`, engine: 'bing', query: g.query })
    for (const d of BING_SITE_DOMAINS) {
      cases.push({ label: `${g.id} | bing site:${d}`, engine: 'bing', query: `site:${d} ${g.query}` })
    }
    cases.push({ label: `${g.id} | ddg site:mafengwo.cn`, engine: 'ddg', query: `site:mafengwo.cn ${g.query}` })
  }
  return cases
}

function domainCounts(results: Array<{ domain?: string; url: string }>): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const r of results) {
    const d = (r.domain || extractDomain(r.url)).replace(/^www\./, '')
    counts[d] = (counts[d] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8))
}

function fmtDomains(counts: Record<string, number>): string {
  const entries = Object.entries(counts)
  if (entries.length === 0) return '(0건)'
  return entries.map(([d, n]) => `${d}×${n}`).join(' ')
}

async function runCase(c: ProbeCase): Promise<{ label: string; total: number; domains: Record<string, number> }> {
  const opts = { maxResults: 10, env: undefined as never, region: 'zh-CN' } as const
  const results = c.engine === 'bing' ? await bingSearch(c.query, opts) : await duckDuckGoSearch(c.query, { maxResults: 10, region: 'wt-wt' })
  return { label: c.label, total: results.length, domains: domainCounts(results) }
}

async function main(): Promise<void> {
  const json = process.argv.includes('--json')
  const qi = process.argv.indexOf('--query')
  const cases = qi >= 0 ? buildCases().filter((c) => c.query.includes(process.argv[qi + 1] ?? '~~')) : buildCases()

  console.log('=== Bing site: operator honors-probe (CJK travel/community gold) ===')
  const rows: Array<{ label: string; total: number; domains: Record<string, number> }> = []
  for (const c of cases) {
    const row = await runCase(c)
    rows.push(row)
    if (!json) console.log(`  ${row.label.padEnd(46)} → ${String(row.total).padStart(3)}건  [${fmtDomains(row.domains)}]`)
  }
  if (json) console.log(JSON.stringify(rows, null, 2))
}

const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-bing-site.ts') || scriptPath.endsWith('probe-bing-site')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
