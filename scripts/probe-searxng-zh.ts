/**
 * SearXNG zh site: 라우팅 검증 배터리 (S104, 2026-08-14).
 *
 * 결론 요약 (이 스크립트가 증명하는 것):
 *   - SearXNG 경유 **bing도 site:를 무시**한다 (site:ctrip.com 쿼리가 mafengwo 등
 *     자연 랭킹만 반환) → settings.yml에서 비활성.
 *   - **google cse만 site:를 인정**: top5 gold 5/5 (ctrip/dianping/trip/qunar/zhihu),
 *     mafengwo 1/5 · xiaohongshu 4/5 (google 자체 인덱스 한계 — DDG 경로가 보완).
 *   - **language 파라미터를 명시하면 google cse가 site: 쿼리에서 0건**을 반환
 *     (plain 쿼리는 무관) → backend-tasks.ts의 site: 태스크는 language 없이 호출.
 *   - baidu는 비CN IP에서 wappass CAPTCHA — CN VPS 배치 시에만 gold 공급.
 *
 * 실행: npx tsx scripts/probe-searxng-zh.ts [--json]
 *   SEARXNG_URL 환경변수 또는 기본 localhost:8080 사용.
 *
 * 주의: google cse는 버스트 호출(~40건/수분 또는 연속 7건)에서 Google bot 감지
 * suspension (suspended_time=180)에 걸린다 — 쿼리 간 3s 간격을 둔다. IP가 이미
 * flagged면 수십 분간 0건이 정상이므로, 다른 egress(CN VPS/Workers)에서 재시도할 것.
 */
import { searxngSearch } from '../src/lib/searxng-search'

export {}

const SEARXNG_URL = process.env.SEARXNG_URL ?? 'http://localhost:8080'

const TESTS: Array<{ id: string; query: string; gold: string }> = [
  { id: 'mafengwo', query: 'site:mafengwo.cn 张家界旅游攻略', gold: 'mafengwo' },
  { id: 'ctrip', query: 'site:ctrip.com 张家界旅游攻略', gold: 'ctrip' },
  { id: 'dianping', query: 'site:dianping.com 上海美食推荐', gold: 'dianping' },
  { id: 'xiaohongshu', query: 'site:xiaohongshu.com 上海美食推荐', gold: 'xiaohongshu' },
  { id: 'trip', query: 'site:trip.com 北京旅游攻略', gold: 'trip' },
  { id: 'qunar', query: 'site:qunar.com 成都旅游攻略', gold: 'qunar' },
  { id: 'zhihu', query: 'site:zhihu.com 考研复习计划', gold: 'zhihu' },
]

async function main(): Promise<void> {
  const json = process.argv.includes('--json')
  const rows: Array<Record<string, unknown>> = []
  for (let i = 0; i < TESTS.length; i++) {
    const t = TESTS[i]
    // backend-tasks.ts buildZhTravelCommunityTask와 동일한 호출 형태 (language 없음)
    const res = await searxngSearch(t.query, { maxResults: 5, env: { SEARXNG_URL } as never })
    const gold = res.filter((r) => (r.domain ?? '').includes(t.gold)).length
    const topDomains = res.slice(0, 5).map((r) => r.domain ?? '')
    rows.push({ id: t.id, n: res.length, goldInTop5: gold, topDomains })
    if (!json) {
      console.log(
        `${t.id.padEnd(12)} → ${String(res.length).padStart(2)}건  gold@top5=${gold}/5  [${topDomains.join(' ')}]`,
      )
    }
    // google cse 버스트 감지 회피 — 쿼리 간 3s (마지막 쿼리 제외)
    if (i < TESTS.length - 1) {
      await new Promise((r) => setTimeout(r, 3000))
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 2))
}

const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-searxng-zh.ts') || scriptPath.endsWith('probe-searxng-zh')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
