/** DDG zh site: 0건 원인 분리 — 202 챌린지 vs 인덱스 부재 (S104 진단). */
import { duckDuckGoSearch } from '../src/lib/duckduckgo'

export {} // 모듈 격리 — scripts/*.ts 전역 스크립트 스코프와의 선언 충돌 방지

async function main(): Promise<void> {
  const cases: Array<{ label: string; query: string }> = [
    { label: 'ddg plain zh travel', query: '张家界旅游攻略' },
    { label: 'ddg site:mafengwo.cn', query: 'site:mafengwo.cn 张家界旅游攻略' },
    { label: 'ddg site:ctrip.com', query: 'site:ctrip.com 张家界旅游攻略' },
    { label: 'ddg site:zhihu.com', query: 'site:zhihu.com 张家界旅游攻略' },
    { label: 'ddg site:qunar.com', query: 'site:qunar.com 张家界旅游攻略' },
    { label: 'ddg site:reddit.com (대조)', query: 'site:reddit.com how to improve sleep quality' },
    { label: 'ddg plain en (대조)', query: 'how to improve sleep quality' },
  ]
  for (const c of cases) {
    const t0 = Date.now()
    const res = await duckDuckGoSearch(c.query, { maxResults: 10, region: 'wt-wt' })
    const domains = new Map<string, number>()
    for (const r of res) {
      const d = (r.domain ?? '').replace(/^www\./, '')
      domains.set(d, (domains.get(d) ?? 0) + 1)
    }
    const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6)
    console.log(`${c.label.padEnd(38)} → ${String(res.length).padStart(2)}건  ${Date.now() - t0}ms  [${top.map(([d, n]) => `${d}×${n}`).join(' ') || '(빈 풀)'}]`)
  }
}

const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-ddg-zh.ts') || scriptPath.endsWith('probe-ddg-zh')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
