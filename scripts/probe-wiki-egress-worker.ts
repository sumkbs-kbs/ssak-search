/**
 * wikipedia REST↔Action 429 가용성 모니터 프로브 워커 (수정 69, 2026-08-15).
 *
 * 위키미디어 429 버스트는 **Workers egress 공유 IP** 에서만 실측된다 (수정 57:
 * production zh.wikipedia.org 5/5 트립 — 로컬에선 200, egress 에선 REST 429).
 * 이 워커는 egress 에서 REST(/w/rest.php) 와 Action(/w/api.php) 검색 엔드포인트의
 * 상태를 1 요청당 1 케이스로 반환한다 — 모니터(scripts/monitor-wiki-429.ts)가
 * 주기적으로 호출해 REST↔Action 가용성을 추적한다.
 *
 * ⚠️ Free 플랜 CPU 한도(10ms/호출) 때문에 요청당 1케이스만 실행한다.
 * 클라이언트가 ?case=en_rest|en_action|zh_rest|... 로 반복 호출.
 *
 * 배포: npx wrangler deploy --config wrangler.probe-wiki.jsonc
 * 실행: npx tsx scripts/monitor-wiki-429.ts --worker-url https://wiki-429-monitor.<acct>.workers.dev
 * 철거: npx wrangler delete wiki-429-monitor --config wrangler.probe-wiki.jsonc --force
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

const UA = 'SearchAPI/1.0 (contact@example.com)'

async function tryFetch(
  url: string,
  init?: RequestInit,
): Promise<{ status: number; ok: boolean; latencyMs: number; snippet: string }> {
  const t0 = Date.now()
  try {
    const res = await fetch(url, init)
    const text = await res.text()
    return {
      status: res.status,
      ok: res.ok,
      latencyMs: Date.now() - t0,
      snippet: text.replace(/\s+/g, ' ').slice(0, 120),
    }
  } catch (err) {
    return { status: -1, ok: false, latencyMs: Date.now() - t0, snippet: `fetch throw: ${String(err).slice(0, 120)}` }
  }
}

function restCase(lang: string, q: string) {
  return () =>
    tryFetch(`https://${lang}.wikipedia.org/w/rest.php/v1/search/page?q=${encodeURIComponent(q)}&limit=3`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
    })
}

function actionCase(lang: string, q: string) {
  return () =>
    tryFetch(
      `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(q)}&format=json&srlimit=3`,
      {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      },
    )
}

function robotsCase(lang: string) {
  return () =>
    tryFetch(`https://${lang}.wikipedia.org/robots.txt`, {
      headers: { 'User-Agent': UA },
    })
}

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const c = url.searchParams.get('case') ?? 'en_rest'

  const cases: Record<string, () => Promise<unknown>> = {
    en_rest: restCase('en', 'quantum computing'),
    en_action: actionCase('en', 'quantum computing'),
    zh_rest: restCase('zh', '量子计算'),
    zh_action: actionCase('zh', '量子计算'),
    ko_rest: restCase('ko', '양자 컴퓨터'),
    ko_action: actionCase('ko', '양자 컴퓨터'),
    en_robots: robotsCase('en'),
    zh_robots: robotsCase('zh'),
    ko_robots: robotsCase('ko'),
  }

  const fn = cases[c] ?? cases.en_rest
  const result = (await fn()) as { status: number; ok: boolean; latencyMs: number; snippet: string }
  return new Response(
    JSON.stringify({
      case: c,
      timestamp: new Date().toISOString(),
      ...result,
    }),
    {
      status: 200,
      headers: { 'content-type': 'application/json' },
    },
  )
}
