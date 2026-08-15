/**
 * S73 wikipedia/wikidata 서킷 회복 검증 프로브 워커 (2026-08-14).
 *
 * 프로덕션 서킷이 여전히 open인데 원인이 "Workers egress IP가 wikimedia에
 * 계속 차단됐는지" vs "서킷 상태가 stale한지"를 분리한다. 로컬 IP에서 wikipedia
 * REST는 200이므로, 같은 요청을 **Workers egress에서** 실측해 업스트림 차단
 * 여부를 확정한다.
 *
 * ⚠️ Free 플랜 CPU 한도(10ms/호출) 때문에 요청당 1케이스만 실행한다.
 * 클라이언트가 ?case=en_rest|zh_rest|en_action|wikidata 로 반복 호출.
 *
 * 배포: npx wrangler deploy --config wrangler.probe.jsonc (프로젝트명 변경 후)
 * 실행: bash scripts/probe-wiki-egress.sh
 * 철거: npx wrangler delete s73-wiki-probe --config wrangler.probe.jsonc --force
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

async function handle(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const c = url.searchParams.get('case') ?? 'en_rest'

  const cases: Record<string, () => Promise<unknown>> = {
    en_rest: () =>
      tryFetch('https://en.wikipedia.org/w/rest.php/v1/search/page?q=quantum%20computing&limit=3', {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      }),
    zh_rest: () =>
      tryFetch('https://zh.wikipedia.org/w/rest.php/v1/search/page?q=' + encodeURIComponent('量子计算') + '&limit=3', {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      }),
    en_action: () =>
      tryFetch('https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=quantum&format=json&srlimit=3', {
        headers: { 'User-Agent': UA },
      }),
    zh_action: () =>
      tryFetch(
        'https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=' +
          encodeURIComponent('量子计算') +
          '&format=json&srlimit=3',
        {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
        },
      ),
    wikidata: () =>
      tryFetch('https://www.wikidata.org/w/api.php?action=wbsearchentities&search=quantum&language=en&format=json', {
        headers: { 'User-Agent': UA },
      }),
    en_robots: () =>
      tryFetch('https://en.wikipedia.org/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    zh_robots: () =>
      tryFetch('https://zh.wikipedia.org/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    wiki_robots: () =>
      tryFetch('https://www.wikidata.org/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    se_robots: () =>
      tryFetch('https://stackoverflow.com/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    se_api_robots: () =>
      tryFetch('https://api.stackexchange.com/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    se_api_search: () =>
      tryFetch(
        'https://api.stackexchange.com/2.3/search/advanced?site=stackoverflow&q=python&pagesize=2&order=desc&sort=relevance',
        {
          headers: { 'User-Agent': UA, Accept: 'application/json' },
        },
      ),
    se_api_info: () =>
      tryFetch('https://api.stackexchange.com/2.3/info?site=stackoverflow', {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      }),
    dbpedia_lookup: () =>
      tryFetch('https://lookup.dbpedia.org/api/search?query=quantum%20computing&format=json&maxResults=3', {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      }),
    dbpedia_robots: () =>
      tryFetch('https://lookup.dbpedia.org/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    dbpedia_root: () =>
      tryFetch('https://lookup.dbpedia.org/', {
        headers: { 'User-Agent': UA },
      }),
    // 수정 60 후속 검증 (오탐 리스크 점검): robots.txt 가 로컬 404 인 호스트들이
    // egress(WAF) 에서도 404 를 주는지 — 404-alive 가 실제로 어느 호스트에
    // 적용되는지 확정한다.
    gh_robots: () =>
      tryFetch('https://api.github.com/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    algolia_robots: () =>
      tryFetch('https://hn.algolia.com/robots.txt', {
        headers: { 'User-Agent': UA },
      }),
    github_api: () =>
      tryFetch('https://api.github.com/rate_limit', {
        headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
      }),
    algolia_api: () =>
      tryFetch('https://hn.algolia.com/api/v1/search?query=quantum&hitsPerPage=1', {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
      }),
  }

  const fn = cases[c] ?? cases.en_rest
  const result = (await fn()) as { status: number; ok: boolean; latencyMs: number; snippet: string }
  return new Response(JSON.stringify({ case: c, ...result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}
