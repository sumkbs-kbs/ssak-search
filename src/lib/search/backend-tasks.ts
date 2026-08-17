/**
 * Backend Task Builders
 *
 * Reusable factory functions that create BackendTask objects for each search
 * backend. Strategies compose these to build their task lists, replacing the
 * repetitive `tasks.push(...)` / `taskNames.push(...)` / `incrementBackend()`
 * boilerplate that appeared ~30 times in the original orchestrator.
 */

import type { Env } from '../../types'
import type { BackendTask, SearchContext } from './context'
import { bingSearch, bingNewsSearch } from '../bing-search'
import { bingNewsRssSearch, googleNewsRssSearch } from '../en-news-search'
import { naverSearch } from '../naver-search'
import { naverNewsSearch, isRecencyNewsQuery } from '../naver-news-search'
import {
  wikipediaSearch,
  githubSearch,
  githubIssuesSearch,
  hackerNewsSearch,
  redditSearch,
  arxivSearch,
} from '../specialized'
import { openalexSearch } from '../openalex'
import { duckDuckGoSearch } from '../duckduckgo'
import { searxngSearch } from '../searxng-search'
import { yahooFinanceSearch } from '../yahoo-finance-search'
import { searchKoreanStock } from '../stock-finance'
import { stackExchangeSearch } from '../stack-exchange'
import { qiitaSearch, juejinSearch, csdnSearch } from '../community-search'
import { braveSearch, isBraveAvailable } from '../brave-search'
import { youtubeSearch } from '../youtube-search'
import { isChineseQuery, cleanChineseQuery } from '../orchestrator'
import { backendTimeoutMs } from './fanout'

/** If the query is Chinese, return the cleaned version; otherwise the original. */
function wikiQuery(ctx: SearchContext): string {
  return isChineseQuery(ctx.query) ? cleanChineseQuery(ctx.query) : ctx.query
}

// ── Bing variants ──

export function buildBingTask(ctx: SearchContext, queryOverride?: string): BackendTask {
  return {
    name: 'bing',
    run: () =>
      bingSearch(queryOverride ?? ctx.query, {
        maxResults: ctx.overFetch,
        timeRange: ctx.bingTimeRange,
        region: ctx.bingRegion,
        env: ctx.env,
      }),
  }
}

export function buildBingNewsTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-news',
    run: () =>
      bingNewsSearch(ctx.query, {
        maxResults: ctx.overFetch,
        timeRange: ctx.bingTimeRange,
        region: ctx.bingRegion,
        env: ctx.env,
      }),
  }
}

/**
 * News RSS locale from the search context — the feeds must run in the QUERY
 * language, not always en-US. Phase 6.7: zh/ja news queries previously got
 * English feeds (mkt/hl=en-US), missing gold domains like 36kr.com,
 * people.com.cn, nhk.or.jp, nikkei.com. Phase 6.10: ko-KR added — Korean news
 * queries previously ran only the naver-news backend; the ko-KR Google News
 * feed adds coverage for gold domains naver m_news doesn't surface
 * (chosun.com/joongang.co.kr, verified live 2026-08-05).
 */
function newsRssLocale(ctx: SearchContext): string {
  if (ctx.korean) return 'ko-KR'
  if (ctx.japanese) return 'ja-JP'
  if (ctx.chinese) return 'zh-CN'
  return 'en-US'
}

/**
 * Bing News RSS — English news feed with the REAL article URLs extracted
 * from the apiclick redirect (zero subrequests). mkt=en-US forces English
 * (the en-news NDCG 0.000 fix — generic bing served Korean/Asian outlets
 * for English queries). See en-news-search.ts.
 */
export function buildBingNewsRssTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'bing-news-rss',
    run: () =>
      bingNewsRssSearch(ctx.query, {
        maxResults: maxResults ?? ctx.overFetch,
        env: ctx.env,
        locale: newsRssLocale(ctx),
      }),
  }
}

/**
 * Google News RSS — English news feed with the strongest gold-domain recall
 * (authoritative outlet at rank 1 in live probes). URL stays a google
 * redirect; domain resolves via the title-suffix source map. See
 * en-news-search.ts.
 */
export function buildGoogleNewsRssTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'google-news-rss',
    run: () =>
      googleNewsRssSearch(ctx.query, {
        maxResults: maxResults ?? ctx.overFetch,
        env: ctx.env,
        locale: newsRssLocale(ctx),
      }),
  }
}

/**
 * Curated news outlets for the S95 site:-augmentation task, grouped by query
 * subject (finance / tech / general) and language. Only the dominant global
 * + language-local outlets — a finite budget, so every site: call must target
 * a domain the eval gold standards actually list (sim-news-outlet.ts: rank-2
 * insertion averages Δ+0.18/query across 93 coverage-gap queries).
 */
export const NEWS_OUTLET_BY_SUBJECT: Record<string, string[]> = {
  // finance/stock intent — quote/earnings-grade outlets
  finance: ['bloomberg.com', 'cnbc.com', 'wsj.com', 'marketwatch.com', 'finance.yahoo.com'],
  // tech intent — product/company news outlets
  tech: ['theverge.com', 'techcrunch.com', 'wired.com', 'reuters.com'],
  // general news — global wire + AP/UPI class
  general: ['reuters.com', 'apnews.com', 'bbc.com', 'nytimes.com', 'theguardian.com'],
  // Japanese-localized (ja-news gold: nhk/nikkei)
  ja: ['nhk.or.jp', 'nikkei.com'],
  // Korean-localized (kr-news gold: yna/chosun — google ko-KR resolves via the
  // Korean source map)
  ko: ['yna.co.kr', 'chosun.com'],
  // Chinese-localized (zh-news gold: xinhua/people/36kr)
  zh: ['xinhuanet.com', 'people.com.cn', '36kr.com'],
}

/**
 * Deterministic outlet picker for the S95 site: augmentation task.
 *
 * Subject detection: finance/stock/market/etf (incl. CJK) → finance group,
 * tech/AI/software/app/computer/科技/IT (incl. CJK) → tech group, else general.
 * Language overrides the general group (ja/ko/zh queries want LOCAL outlets —
 * the en outlets won't surface nhk/nikkei gold). A query-hash rotation picks
 * ONE outlet per subject group so repeated same-topic queries spread across
 * the group instead of hammering a single domain (shared Google News RSS
 * budget). Pure function — unit-testable without network.
 */
export function pickNewsOutlet(query: string, opts?: { language?: string }): string {
  const lang = opts?.language ?? 'en'
  const q = query.toLowerCase()
  const finance = /\b(stock|stocks|market|markets|etf|earnings|price|trading)\b|주식|주가|株価|股市|财经|股票/.test(q)
  const tech =
    /\b(ai|a\.i\.|tech|technology|software|app|apps|computer|chip|semiconductor|startup|gpu)\b|科技|AI|ソフト|スタートアップ/.test(
      q,
    )

  let group: string[]
  if (lang === 'ja') group = NEWS_OUTLET_BY_SUBJECT['ja']
  else if (lang === 'ko') group = NEWS_OUTLET_BY_SUBJECT['ko']
  else if (lang === 'zh') group = NEWS_OUTLET_BY_SUBJECT['zh']
  else if (finance) group = NEWS_OUTLET_BY_SUBJECT['finance']
  else if (tech) group = NEWS_OUTLET_BY_SUBJECT['tech']
  else group = NEWS_OUTLET_BY_SUBJECT['general']

  // FNV-1a — deterministic, cheap, stable across isolates. >>> 0 keeps the
  // index NON-NEGATIVE: Math.imul returns a SIGNED 32-bit int, so hash % n
  // can be negative (group[-1] → undefined — caught by the S95 unit tests
  // for CJK queries where the hash happened to land negative).
  let hash = 0x811c9dc5
  for (let i = 0; i < query.length; i++) {
    hash ^= query.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return group[(hash >>> 0) % group.length]
}

/**
 * News-outlet site: augmentation task — S95 (P1 lever E, 2026-08-10).
 *
 * P1 diagnosis: NDCG=0 queries are 100% COVERAGE — the gold outlet domain
 * (reuters/nytimes/bbc...) is ABSENT from the pool, never a ranking failure
 * (gold-visible runs all had NDCG>0, median gold rank 1). The generic Google
 * News feed surfaces whatever the feed ranks; `site:<outlet> <query>`
 * forces the curated outlet to participate (sim-news-outlet.ts verified the
 * site: operator is honored 10/10 and a rank-2 insertion averages Δ+0.18).
 *
 * ONE outlet per query (finite feed/rate budget — the general feed already
 * consumes subrequests; a per-query site: burst would burn the eval fanout
 * ceiling). maxResults 4: the task is a COVERAGE patch, not a pool filler —
 * the outlet's single best article is what the gold matcher needs.
 */
export function buildNewsOutletTask(ctx: SearchContext): BackendTask {
  const language = ctx.korean ? 'ko' : ctx.japanese ? 'ja' : ctx.chinese ? 'zh' : 'en'
  const outlet = pickNewsOutlet(ctx.query, { language })
  return {
    name: 'news-outlet',
    run: () =>
      googleNewsRssSearch(`site:${outlet} ${ctx.query}`, {
        maxResults: 4,
        env: ctx.env,
        locale: newsRssLocale(ctx),
      }),
  }
}

/**
 * zh 여행·커뮤니티 gold 도메인 목록 — S104 (2026-08-14).
 *
 * eval gold-standards의 ZH_TRAVEL/ZH_GENERAL 목록과 1:1 (zh-travel-01~05 +
 * zh-general-06~15 15쿼리; zhihu.com은 ZH_GENERAL 10쿼리에 포함). bing은
 * site: 연산자를 무시하고 (scripts/probe-bing-site.ts 실측 — site: 프리픽스가
 * 결과를 전혀 좁히지 않음) 이 도메인들을 일반 검색으로도 거의 회수하지 못하므로
 * (docs/02 §2), site:-증강은 site:를 인정하는 엔진(DDG / SearXNG)으로 라우팅한다
 * (P24 ddg-site-reddit 선례).
 */
export const ZH_TRAVEL_COMMUNITY_GOLD = [
  'ctrip.com',
  'mafengwo.cn',
  'dianping.com',
  'xiaohongshu.com',
  'trip.com',
  'qunar.com',
  'zhihu.com',
]

/**
 * 쿼리당 ONE gold 도메인을 결정적으로 선택 (S104).
 *
 * S95 pickNewsOutlet과 동일한 FNV-1a 회전: 같은 주제의 반복 쿼리가 한 도메인을
 * 때리지 않고 목록 전체에 분산된다 (DDG 버스트 한도 / 공유 rate 예산 보호).
 * 순수 함수 — 네트워크 없이 단위 테스트 가능. EXPORTED FOR TESTS.
 */
export function pickZhTravelCommunityDomain(query: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < query.length; i++) {
    hash ^= query.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return ZH_TRAVEL_COMMUNITY_GOLD[(hash >>> 0) % ZH_TRAVEL_COMMUNITY_GOLD.length]
}

/**
 * zh 여행·커뮤니티 gold site:-증강 태스크 — S104 (2026-08-14).
 *
 * `site:<gold-domain> <query>`가 해당 gold 도메인을 강제로 풀에 참여시킨다
 * (S95 뉴스 아웃렛 패턴과 동일한 COVERAGE 패치: ONE site: 호출, 작은 maxResults,
 * 부가형 — 무관한 결과는 순위/품질 임계값이 거른다).
 *
 * 엔진 선택 (진단 근거: scripts/probe-bing-site.ts — bing 모바일/데스크톱/RSS
 * 3개 엔드포인트 모두 site: 무시, 일부 쿼리는 키워드 오염까지 발생):
 *  - SEARXNG_URL 미설정 (기본/eval) → DuckDuckGo `site:` (P24 실측 10/10 인정,
 *    docs/15 버스트 202 윈도우 한계 공유 — 부가형이므로 빈 풀은 기존 경로에 폴백)
 *  - SEARXNG_URL 설정 → SearXNG `site:` — 단, 검증 실측 (2026-08-14,
 *    searxng/settings.yml 주석 + scripts/probe-searxng-zh.ts):
 *      · SearXNG 경유 bing도 site: 무시 (자연 랭킹만 반환 — 여행 쿼리에서 mafengwo가
 *        우연히 1위일 뿐, site:ctrip.com도 mafengwo를 반환). 설정에서 비활성.
 *      · google cse만 site: 인정 — top5 gold 5/5 (ctrip/dianping/trip/qunar/zhihu,
 *        mafengwo 1/5 — google의 한계, DDG 경로가 보완). 단, language 파라미터를
 *        명시하면 google cse가 0건을 반환하는 퀴크가 있어 **language를 넘기지 않는다**.
 *      · baidu는 비CN IP에서 CAPTCHA (wappass) — CN VPS 배치 시에만 동작, 설정에 유지.
 *
 * Workers egress 실측 (2026-08-14, scripts/probe-egress-worker.ts): DDG site:는
 * 7개 gold 도메인 전부를 100% 회수 (mafengwo.cn 11/11 · ctrip.com 12/12 ·
 * dianping.com 10/10 · trip.com 12/12 · qunar.com 10/10 · zhihu.com 10/10 ·
 * xiaohongshu.com 9/9) — "DDG가 zh gold 미인덱싱" 우려는 반증됨. 유일 상한은
 * DDG 버스트 202 윈도우 (연속 2~4회 후 ~10~30초, docs/15와 일치): eval 벌크는
 * 윈도우당 소수 쿼리만 gold 회수, 생산 단일 사용자 트래픽은 자연 간격으로 정상.
 */
export function buildZhTravelCommunityTask(ctx: SearchContext): BackendTask {
  const domain = pickZhTravelCommunityDomain(ctx.query)
  const siteQuery = `site:${domain} ${ctx.query}`
  if (ctx.env?.SEARXNG_URL) {
    return {
      name: 'searxng-site-zh-travel',
      run: () =>
        // language를 넘기지 않는다 — google cse는 language 명시 시 0건 (실측).
        searxngSearch(siteQuery, {
          maxResults: 5,
          env: ctx.env,
        }),
    }
  }
  return {
    name: 'ddg-site-zh-travel',
    run: () =>
      duckDuckGoSearch(siteQuery, {
        maxResults: 5,
        timeoutMs: backendTimeoutMs('ddg-site-zh-travel', 6000),
        env: ctx.env,
      }),
  }
}

export function buildBingYouTubeTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-youtube',
    run: () =>
      bingSearch(`site:youtube.com ${ctx.query}`, {
        maxResults: 10,
        timeRange: ctx.bingTimeRange,
        region: ctx.bingRegion,
        env: ctx.env,
      }),
  }
}

/** Direct YouTube search backend — returns videos with title/channel/duration/views/description. */
export function buildYoutubeTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'youtube',
    run: () => youtubeSearch(ctx.query, maxResults, false),
  }
}

/** Bing with a query suffix (e.g. "tutorial guide", "ideas examples inspiration"). */
export function buildBingModifiedTask(ctx: SearchContext, suffix: string, name: string): BackendTask {
  return {
    name,
    run: () =>
      bingSearch(`${ctx.query} ${suffix}`, {
        maxResults: ctx.overFetch,
        timeRange: ctx.bingTimeRange,
        region: ctx.bingRegion,
        env: ctx.env,
      }),
  }
}

/** Bing finance query variant. */
export function buildBingFinanceTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-finance',
    run: () =>
      bingSearch(`${ctx.query} stock price market cap`, {
        maxResults: ctx.overFetch,
        timeRange: ctx.bingTimeRange,
        region: ctx.bingRegion,
        env: ctx.env,
      }),
  }
}

/** Bing finance query with full earnings context. */
export function buildBingFinanceDetailedTask(ctx: SearchContext): BackendTask {
  return {
    name: 'bing-finance',
    run: () =>
      bingSearch(`${ctx.query} stock price market cap earnings`, {
        maxResults: ctx.overFetch,
        timeRange: ctx.bingTimeRange,
        region: ctx.bingRegion,
        env: ctx.env,
      }),
  }
}

// ── Wikipedia ──

export function buildWikipediaTask(ctx: SearchContext, maxResults = 5, timeoutMs = 8000): BackendTask {
  return {
    name: 'wikipedia',
    run: () =>
      wikipediaSearch(wikiQuery(ctx), {
        maxResults,
        language: ctx.effectiveWikiLang,
        timeoutMs,
        env: ctx.env,
      }),
  }
}

// ── Specialized backends ──

export function buildArxivTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'arxiv',
    run: () => arxivSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * Stack Exchange API — official keyless Stack Overflow questions backend
 * (Phase 3a lever 3: tech official-doc routing). bing ignores site:
 * operators, DDG site: trips the 202 anti-bot challenge, so the only
 * ToS-safe way to surface stackoverflow.com gold domains is the official
 * API. See stack-exchange.ts. Quota-guarded (300/day/IP, logs + skips at
 * the floor) so the 500×3 eval run cannot burn the daily budget.
 */
export function buildStackExchangeTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'stack-exchange',
    run: () => stackExchangeSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * Qiita v2 API — official keyless Japanese tech community backend (S16).
 * bing ja-tech queries return zh.wikipedia.org + github repos, never the
 * qiita.com gold (ja-tech eval). The public v2 /items API returns real
 * qiita.com URLs directly. See community-search.ts.
 */
export function buildQiitaTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'qiita',
    run: () => qiitaSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * Juejin search API — public keyless Chinese tech community backend (S16).
 * bing zh-tech queries return all-wikipedia pools (zh-tech-08/09/13 NDCG
 * 0.000) — juejin.cn is the strongest keyless zh gold. See community-search.ts.
 */
export function buildJuejinTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'juejin',
    run: () => juejinSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * CSDN search API — public keyless Chinese community backend (S26).
 * so.csdn.net/api/v3/search returns real blog.csdn.net articles for zh-tech
 * (csdn.net is gold in 10 zh queries) AND zh-general queries where bing
 * mkt=zh-CN from a US IP cross-language-contaminates the pool (zh-general-12
 * returned 4/10 EU-climate English news items). See community-search.ts.
 */
export function buildCsdnTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'csdn',
    run: () => csdnSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

export function buildHackerNewsTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'hackernews',
    run: () => hackerNewsSearch(ctx.query, { maxResults, timeRange: ctx.bingTimeRange, env: ctx.env }),
  }
}

export function buildRedditTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'reddit',
    run: () => redditSearch(ctx.query, { maxResults, timeRange: ctx.bingTimeRange, env: ctx.env }),
  }
}

export function buildGithubTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'github',
    run: () => githubSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * GitHub Issues API — problem/learning-intent backend (S19). The repo search
 * alone missed 46/127 github-gold technical queries; issues surface real
 * github.com/owner/repo/issues/N threads (fixes, errors, A-vs-B) — the same
 * github.com gold domain the eval matcher needs. all.ts gates this on
 * isGithubIssuesIntent + technical routing (EN/KR; zh/ja gold is community
 * sites — same gate rule as Stack Exchange). See specialized.ts.
 */
export function buildGithubIssuesTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'github-issues',
    run: () => githubIssuesSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

/**
 * OpenAlex works API — keyless academic backend (S96). google-scholar.ts was
 * deleted: scholar.google.com answers 200 + CAPTCHA for datacenter IPs, dead
 * in all 78 stored academic eval runs. OpenAlex returns works whose landing
 * pages carry the academic gold domains (openreview.net/aclanthology.org/
 * jmlr.org/nature.com/ieeexplore.ieee.org/semanticscholar.org/...), and the
 * eval matcher's label-suffix rule scores them directly. See openalex.ts.
 */
export function buildOpenAlexTask(ctx: SearchContext, maxResults = 8): BackendTask {
  return {
    name: 'openalex',
    run: () => openalexSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

// ── Finance backends ──

export function buildKoreanStockTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'naver-finance',
    run: () => searchKoreanStock(ctx.query, { maxResults, env: ctx.env }),
  }
}

export function buildYahooFinanceTask(ctx: SearchContext, maxResults = 5): BackendTask {
  return {
    name: 'yahoo-finance',
    run: () => yahooFinanceSearch(ctx.query, { maxResults, env: ctx.env }),
  }
}

export function buildNaverTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'naver',
    run: () => naverSearch(ctx.query, { maxResults: maxResults ?? ctx.overFetch, env: ctx.env }),
  }
}

/**
 * Naver NEWS search backend — collects ONLY n.news.naver.com article links
 * (where=m_news). The general naver backend surfaces blogs/cafes for news
 * queries; this one guarantees real news articles, which is what kr-news
 * eval gold domains (n.news.naver.com/yna.co.kr/donga.com) require.
 *
 * Recency intent ('최신'/'오늘'/'속보' markers, time_range=day, or
 * sort_by=date) flips the backend into dual-fetch mode: relevance page
 * (coverage) + sort=1 newest-first page (freshness), merged — so queries
 * like '삼성전자 뉴스 최신' surface genuinely fresh articles instead of
 * Naver's relevance-sorted picks that can be a week old.
 */
export function buildNaverNewsTask(ctx: SearchContext, maxResults?: number): BackendTask {
  const recencyIntent =
    ctx.request.time_range === 'day' || ctx.request.sort_by === 'date' || isRecencyNewsQuery(ctx.query)
  return {
    name: 'naver-news',
    run: () =>
      naverNewsSearch(ctx.query, {
        maxResults: maxResults ?? ctx.overFetch,
        env: ctx.env,
        sortByRecency: recencyIntent,
      }),
  }
}

// ── SearXNG / DuckDuckGo ──

export function buildSearXNGTask(ctx: SearchContext): BackendTask {
  const category: 'general' | 'news' | 'science' | 'it' = ctx.isNews
    ? 'news'
    : ctx.queryType === 'academic' || ctx.queryType === 'factual'
      ? 'science'
      : ctx.queryType === 'technical'
        ? 'it'
        : 'general'
  return {
    name: 'searxng',
    run: () =>
      searxngSearch(ctx.query, {
        maxResults: ctx.overFetch,
        timeoutMs: 10000,
        category,
        language: ctx.bingLang,
        env: ctx.env,
      }),
  }
}

export function buildDuckDuckGoTask(ctx: SearchContext, maxResults?: number): BackendTask {
  return {
    name: 'duckduckgo',
    run: () =>
      duckDuckGoSearch(ctx.query, {
        maxResults: maxResults ?? Math.max(ctx.maxResults, 10),
        timeoutMs: 5000,
        env: ctx.env,
      }),
  }
}

// ── Brave ──

export function buildBraveTask(ctx: SearchContext): BackendTask | null {
  if (!ctx.env || !isBraveAvailable(ctx.env) || ctx.korean) return null
  const env = ctx.env as Env & { BRAVE_API_KEY: string }
  const timeRange = ctx.request.time_range
  return {
    name: 'brave',
    run: () =>
      braveSearch(ctx.query, {
        maxResults: ctx.overFetch,
        freshness: ctx.bingTimeRange
          ? timeRange === 'day'
            ? 'pd'
            : timeRange === 'week'
              ? 'pw'
              : timeRange === 'month'
                ? 'pm'
                : 'py'
          : undefined,
        country: ctx.request.country,
        searchLang: ctx.bingLang,
        apiKey: env.BRAVE_API_KEY,
        env: ctx.env,
      }),
  }
}
