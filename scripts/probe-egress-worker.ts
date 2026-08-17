/**
 * S104 Workers-egress DDG/Bing site: 프로브 워커 (2026-08-14).
 *
 * 로컬 IP에서는 DDG가 202 챌린지라 분리 검증이 불가능했으므로 (probe-ddg-zh.ts),
 * 이 워커를 **신규 격리 프로젝트**로 배포해 Cloudflare Workers egress에서 직접
 * 검증한다. 프로덕션(search-engine-api)과 무관한 스탠드얼론 워커 — 바인딩 없음.
 *
 * ⚠️ Free 플랜 CPU 한도(10ms/호출) 때문에 요청당 1케이스만 실행한다 (일괄 실행은
 * 1104 CPU-exceeded). 클라이언트가 ?q=...&engine=ddg|bing 로 반복 호출.
 *
 * 배포: npx wrangler deploy --config wrangler.probe.jsonc
 * 실행: bash scripts/probe-egress.sh (배포→배터리→정리)
 * 철거: npx wrangler delete s104-egress-probe --config wrangler.probe.jsonc --force
 *
 * 실측 결과 (2026-08-14, HKG colo): DDG site:는 7개 gold 도메인 전부 100% 회수
 * (mafengwo/ctrip/dianping/trip/qunar/zhihu/xiaohongshu) — 유일 상한은 버스트 202
 * (연속 2~4회 후 ~10~30초, docs/15 일치). bing site:는 plain과 완전 동일 (무시).
 */
export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await handle(request)
    } catch (err) {
      return new Response(JSON.stringify({ error: String(err) }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })
    }
  },
}

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const engine = url.searchParams.get('engine') ?? 'ddg'
  const query = url.searchParams.get('q') ?? ''
  const label = url.searchParams.get('label') ?? `${engine} ${query.slice(0, 30)}`
  const t0 = Date.now()

  const out: Record<string, unknown> = { label, query, engine, status: null, latencyMs: null }

  try {
    if (engine === 'se') {
      // Phase 1-4 (2026-08-17): api.stackexchange.com egress 상태 — SE keyless
      // 일일 쿼터(300/day/IP)는 400+error_id 502 로 온다. /2.3/info 는 쿼터 1건
      // 소모하지만 헬스 판정에 최소 (프로덕션 alarm 프로브와 동일 경로).
      const res = await fetch('https://api.stackexchange.com/2.3/info?site=stackoverflow', {
        headers: { 'User-Agent': 'SearchAPI/1.0 (egress probe)' },
      })
      out.status = res.status
      out.latencyMs = Date.now() - t0
      const text = await res.text()
      out.bodyBytes = text.length
      out.bodySnippet = text.replace(/\s+/g, ' ').slice(0, 220)
      try {
        const j = JSON.parse(text)
        out.quota = j.quota_remaining
        out.errorId = j.error_id
        out.errorMessage = j.error_message
      } catch {
        /* non-JSON */
      }
    } else if (engine === 'ddg') {
      const params = new URLSearchParams({ q: query, kl: 'wt-wt', df: '', b: '' })
      const res = await fetch('https://html.duckduckgo.com/html/', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9,ko;q=0.8',
          Referer: 'https://html.duckduckgo.com/',
        },
        body: params.toString(),
      })
      out.status = res.status
      out.latencyMs = Date.now() - t0
      const html = await res.text()
      out.bodyBytes = html.length
      out.domains = topDomains(extractDdgDomains(html))
      out.count = (out.domains as Array<[string, number]>).reduce((a, [, n]) => a + n, 0)
      if (res.status === 202) {
        const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? ''
        out.challengeTitle = title.slice(0, 80)
      }
    } else {
      const params = new URLSearchParams({ q: query, count: '20' })
      const res = await fetch(`https://www.bing.com/search?${params.toString()}`, {
        headers: { 'User-Agent': MOBILE_UA, 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      })
      out.status = res.status
      out.latencyMs = Date.now() - t0
      const html = await res.text()
      out.bodyBytes = html.length
      out.domains = topDomains(extractBingDomains(html))
      out.count = (out.domains as Array<[string, number]>).reduce((a, [, n]) => a + n, 0)
    }
  } catch (err) {
    out.error = String(err).slice(0, 300)
  }

  return new Response(JSON.stringify(out), { headers: { 'content-type': 'application/json' } })
}

/** result__a 링크의 도메인만 추출 (상위 N개 카운트). 파싱은 CPU 절약을 위해 슬라이스 스캔. */
function extractDdgDomains(html: string): string[] {
  const out: string[] = []
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const href = m[1]
    const mm = href.match(/uddg=([^&]+)/)
    const decoded = mm ? decodeURIComponent(mm[1]) : href
    try {
      out.push(new URL(decoded).hostname.replace(/^www\./, ''))
    } catch {
      /* skip */
    }
    if (out.length >= 20) break
  }
  return out
}

function extractBingDomains(html: string): string[] {
  const out: string[] = []
  const re = /<li class="b_algo"[^>]*>([\s\S]*?)<\/li>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) {
    const u = m[1].match(/<a[^>]*href="(https?:\/\/[^"]+)"[^>]*>/i)?.[1]
    if (u) {
      try {
        out.push(new URL(u).hostname.replace(/^www\./, ''))
      } catch {
        /* skip */
      }
    }
    if (out.length >= 20) break
  }
  return out
}

function topDomains(domains: string[], n = 8): Array<[string, number]> {
  const counts = new Map<string, number>()
  for (const d of domains) counts.set(d, (counts.get(d) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}
