/**
 * Bing region(mkt) 라우팅 레버 타당성 검토 프로브 (S105-②, 2026-08-14).
 *
 * 배경: Workers egress(HKG) 실측에서 bing plain(무 mkt)이 zh 여행 gold 도메인을
 * 그대로 반환 (m.mafengwo.cn·dianping.com 전부) — 반면 로컬(US IP) eval에서는
 * mkt=zh-CN이 크로스랭귀지 쓰레기로 오염된다 (docs/02·08: "bing mkt=zh-CN from a
 * US IP"). 즉 변수는 ① mkt 파라미터 ② egress IP 지리다. 이 프로브는 로컬 US
 * egress에서 mkt 변형만 통제해, "mkt가 오염의 원인인지"를 분리한다.
 *
 * 실행: npx tsx scripts/probe-bing-region.ts [--json]
 */
import { bingSearch } from '../src/lib/bing-search'
import { extractDomain } from '../src/lib/util'

export {}

const QUERIES: Array<{ id: string; query: string; gold: string[] }> = [
  { id: 'zh-travel-01', query: '张家界旅游攻略', gold: ['ctrip.com', 'mafengwo.cn', 'xiaohongshu.com', 'trip.com', 'qunar.com'] },
  { id: 'zh-general-01', query: '北京旅游攻略', gold: ['ctrip.com', 'mafengwo.cn'] },
  { id: 'zh-general-02', query: '上海美食推荐', gold: ['dianping.com', 'mafengwo.cn'] },
  { id: 'zh-general-06', query: '成都美食攻略', gold: ['ctrip.com', 'mafengwo.cn', 'dianping.com', 'xiaohongshu.com', 'trip.com'] },
  { id: 'zh-general-08', query: '三亚旅游攻略', gold: ['ctrip.com', 'mafengwo.cn', 'dianping.com', 'xiaohongshu.com', 'trip.com'] },
  { id: 'zh-general-15', query: '智能手表推荐', gold: ['ctrip.com', 'mafengwo.cn', 'dianping.com', 'xiaohongshu.com', 'trip.com'] },
]

const REGIONS: Array<{ label: string; region: string | undefined }> = [
  { label: 'mkt=zh-CN (현재)', region: 'zh-CN' },
  { label: '무 mkt (wt-wt)', region: undefined },
  { label: 'mkt=en-US', region: 'en-US' },
  { label: 'mkt=zh-CN+cc', region: 'zh-CN' }, // bingSearch는 region에 cc 포함 — 대조
]

async function main(): Promise<void> {
  const json = process.argv.includes('--json')
  const rows: Array<Record<string, unknown>> = []
  for (const q of QUERIES) {
    for (const r of REGIONS) {
      const res = await bingSearch(q.query, { maxResults: 10, region: r.region })
      let _gold = 0
      let inTop10 = 0
      const doms = new Map<string, number>()
      for (let i = 0; i < res.length; i++) {
        const d = (res[i].domain || extractDomain(res[i].url)).replace(/^www\./, '')
        doms.set(d, (doms.get(d) ?? 0) + 1)
        if (q.gold.some((g) => d === g || d.endsWith('.' + g))) {
          _gold++
          if (i < 10) inTop10++
        }
      }
      const top = [...doms.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
      const row = { id: q.id, region: r.label, n: res.length, goldInTop10: inTop10, domains: top }
      rows.push(row)
      if (!json) {
        console.log(`${q.id.padEnd(14)} ${r.label.padEnd(16)} → ${String(res.length).padStart(2)}건  gold@10=${inTop10}  [${top.map(([d, n]) => `${d}×${n}`).join(' ')}]`)
      }
    }
  }
  if (json) console.log(JSON.stringify(rows, null, 2))
}

const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-bing-region.ts') || scriptPath.endsWith('probe-bing-region')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
