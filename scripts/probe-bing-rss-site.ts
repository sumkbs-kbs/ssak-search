/** Bing RSS 엔드포인트(format=rss)의 site: 인정 여부 — S104 "bing site:" 레버 가용성 진단. */

export {} // 모듈 격리 — scripts/*.ts 전역 스크립트 스코프와의 선언 충돌 방지

const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchXml(url: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': DESKTOP_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8', Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8' },
      signal: ctrl.signal,
    })
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

function parseRssItems(xml: string): Array<{ title: string; link: string }> {
  const items: Array<{ title: string; link: string }> = []
  const itemRegex = /<item>([\s\S]*?)<\/item>/gi
  let m: RegExpExecArray | null
  while ((m = itemRegex.exec(xml)) !== null) {
    const title = m[1].match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
    const link = m[1].match(/<link[^>]*>([\s\S]*?)<\/link>/i)?.[1] ?? ''
    items.push({ title: title.replace(/<!\[CDATA\[|\]\]>/g, '').trim(), link: link.trim() })
  }
  return items
}

async function main(): Promise<void> {
  const cases: Array<{ label: string; query: string }> = [
    { label: 'rss plain zh', query: '张家界旅游攻略' },
    { label: 'rss site:mafengwo.cn', query: 'site:mafengwo.cn 张家界旅游攻略' },
    { label: 'rss site:ctrip.com', query: 'site:ctrip.com 张家界旅游攻略' },
    { label: 'rss site:dianping.com', query: 'site:dianping.com 上海美食推荐' },
    { label: 'rss site:xiaohongshu.com', query: 'site:xiaohongshu.com 上海美食推荐' },
    { label: 'rss site:trip.com', query: 'site:trip.com 张家界旅游攻略' },
    { label: 'rss site:qunar.com', query: 'site:qunar.com 张家界旅游攻略' },
    { label: 'rss site:zhihu.com', query: 'site:zhihu.com 张家界旅游攻略' },
    { label: 'rss site:youtube.com (대조)', query: 'site:youtube.com how to make pasta' },
  ]
  for (const c of cases) {
    const params = new URLSearchParams({ q: c.query, format: 'rss', count: '20' })
    try {
      const xml = await fetchXml(`https://www.bing.com/search?${params.toString()}`)
      const items = parseRssItems(xml)
      const domains = new Map<string, number>()
      for (const it of items) {
        try {
          const d = new URL(it.link).hostname.replace(/^www\./, '')
          domains.set(d, (domains.get(d) ?? 0) + 1)
        } catch {
          /* skip */
        }
      }
      const top = [...domains.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      console.log(`${c.label.padEnd(26)} → ${String(items.length).padStart(2)}건  [${top.map(([d, n]) => `${d}×${n}`).join(' ') || '(item 없음)'}]`)
    } catch (e) {
      console.log(`${c.label.padEnd(26)} → NET-ERR ${String(e).slice(0, 60)}`)
    }
  }
}

const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-bing-rss-site.ts') || scriptPath.endsWith('probe-bing-rss-site')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
