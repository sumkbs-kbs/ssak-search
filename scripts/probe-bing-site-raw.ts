/** Bing mobile vs desktop 엔드포인트 site: 인정 여부 raw 비교 (S104 진단). */

export {} // 모듈 격리 — scripts/*.ts 전역 스크립트 스코프와의 선언 충돌 방지

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'

async function fetchHtml(url: string, ua: string): Promise<string> {
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), 8000)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': ua, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      signal: ctrl.signal,
    })
    return await res.text()
  } finally {
    clearTimeout(t)
  }
}

/** b_algo 블록의 도메인을 추출한다 (bing-search 파서와 동일 계열). */
function extractDomains(html: string): string[] {
  const out: string[] = []
  const blockRegex = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = blockRegex.exec(html)) !== null) {
    const url = m[1].match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i)?.[1]
    if (url) {
      try {
        out.push(new URL(url).hostname.replace(/^www\./, ''))
      } catch {
        /* skip */
      }
    }
  }
  return out
}

async function main(): Promise<void> {
  const queries = [
    'site:mafengwo.cn 张家界旅游攻略',
    '张家界旅游攻略',
    'site:youtube.com how to make pasta',
    'how to make pasta',
  ]
  for (const q of queries) {
    const params = new URLSearchParams({ q, count: '20' })
    for (const [label, ua] of [
      ['mobile', MOBILE_UA],
      ['desktop', DESKTOP_UA],
    ] as const) {
      try {
        const html = await fetchHtml(`https://www.bing.com/search?${params.toString()}`, ua)
        const doms = extractDomains(html)
        const counts = new Map<string, number>()
        for (const d of doms) counts.set(d, (counts.get(d) ?? 0) + 1)
        const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        console.log(
          `[${label}] "${q.slice(0, 40)}" → ${doms.length}건  [${top.map(([d, n]) => `${d}×${n}`).join(' ') || '(b_algo 없음 / 캡차)'}]`,
        )
      } catch (e) {
        console.log(`[${label}] "${q.slice(0, 40)}" → NET-ERR ${String(e).slice(0, 80)}`)
      }
    }
  }
}

const scriptPath = process.argv[1] ?? ''
if (scriptPath.endsWith('probe-bing-site-raw.ts') || scriptPath.endsWith('probe-bing-site-raw')) {
  main().catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
