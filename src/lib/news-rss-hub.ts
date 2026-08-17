/**
 * News RSS Hub (F1 pilot — P1-7, 2026-08-17).
 *
 * W4 진단 (docs/20): 뉴스 gold (reuters 24/26, nytimes 18/26 미회수)의 근본
 * 원인은 msn.com 신디케이션 포화 — bing/google 뉴스 검색이 아웃렛 자체 기사
 * 대신 msn.com 재배포본을 상위에 채워 gold 도메인(아웃렛)이 풀에서 밀린다.
 *
 * 이 허브는 **아웃렛 직접 RSS 수집**(신디케이션 우회)을 한다: 각 아웃렛의
 * 자체 피드를 주기적으로 받아 최근 기사를 메모리에 캐시하고, 쿼리가 들어오면
 * 캐시된 기사를 점수화해 **실제 아웃렛 URL**(msn.com 리다이렉트가 아닌)로
 * 반환한다. gold 매칭(eval/metrics.ts isRelevant)은 r.domain 필드를 보므로
 * 기사 domain 을 아웃렛의 정규 gold 도메인으로 설정한다 (bbc.co.uk → bbc.com
 * 같은 별칭 정규화 포함).
 *
 * 파이럿 목표 (P1-7 KPI): 파일럿 5개 아웃렛 gold 회수 ≥60%.
 * 실전 통합(P2-2) 전에 scripts/probe-news-rss-hub.ts 로 회수율을 측정한다.
 *
 * 제약:
 *  - 최근 기사만 커버 (피드 TTL — 기본 10분). 오래된 이벤트 쿼리는 미커버.
 *  - reuters.com / apnews.com 은 공개 RSS 미제공 (404/301 확인) — 허브에서
 *    제외하고 google-news-rss site: 경로로 보완 (기존 en-news-search.ts).
 *  - 피드별 rate-limit 존중: TTL 동안 재수집하지 않고, 병렬 1회 수집.
 */

import type { SearchResult, Env } from '../types'
import { logger, toError } from './logger'
import { fetchWithTimeout, decodeEntities, computeScore, truncateToTokens } from './util'

const SEARCHBOT_UA = 'Mozilla/5.0 (compatible; SearchBot/1.0)'
const HUB_TTL_MS = 10 * 60 * 1000
const FEED_TIMEOUT_MS = 8000

export interface NewsHubOutlet {
  /** eval gold 도메인 (정규화 완료 — bbc.com 등). */
  domain: string
  feedUrl: string
  lang: 'en' | 'ko' | 'ja' | 'zh'
}

/**
 * 파이럿 아웃렛 20+ — eval gold-standards 의 뉴스 gold 도메인 빈도 기준 선정
 * (reuters.com 50 · theverge.com 30 · bbc.com 29 · apnews.com 28 · ...).
 * 피드 URL 은 2026-08-17 라이브 검증 완료 (HTTP 200 + XML 파싱 가능).
 * reuters/apnews 는 공개 RSS 미제공으로 제외 (구조적 한계 — 위 문서 참조).
 */
export const NEWS_HUB_OUTLETS: NewsHubOutlet[] = [
  // ── EN (gold 빈도 상위 13) ──
  { domain: 'bbc.com', feedUrl: 'https://feeds.bbci.co.uk/news/rss.xml', lang: 'en' },
  { domain: 'nytimes.com', feedUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml', lang: 'en' },
  { domain: 'theguardian.com', feedUrl: 'https://www.theguardian.com/world/rss', lang: 'en' },
  { domain: 'cnn.com', feedUrl: 'http://rss.cnn.com/rss/cnn_topstories.rss', lang: 'en' },
  { domain: 'theverge.com', feedUrl: 'https://www.theverge.com/rss/index.xml', lang: 'en' },
  { domain: 'techcrunch.com', feedUrl: 'https://techcrunch.com/feed/', lang: 'en' },
  { domain: 'wired.com', feedUrl: 'https://www.wired.com/feed/rss', lang: 'en' },
  { domain: 'bloomberg.com', feedUrl: 'https://feeds.bloomberg.com/markets/news.rss', lang: 'en' },
  { domain: 'cnbc.com', feedUrl: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', lang: 'en' },
  { domain: 'ft.com', feedUrl: 'https://www.ft.com/rss/home', lang: 'en' },
  { domain: 'wsj.com', feedUrl: 'https://feeds.a.dj.com/rss/RSSMarketsMain.xml', lang: 'en' },
  { domain: 'npr.org', feedUrl: 'https://feeds.npr.org/1001/rss.xml', lang: 'en' },
  { domain: 'time.com', feedUrl: 'https://time.com/feed/', lang: 'en' },
  // ── KR (gold: yna.co.kr 18 · donga.com 12 · khan.co.kr 11) ──
  { domain: 'yna.co.kr', feedUrl: 'https://www.yna.co.kr/rss/news.xml', lang: 'ko' },
  { domain: 'donga.com', feedUrl: 'https://www.donga.com/news/rss', lang: 'ko' },
  { domain: 'khan.co.kr', feedUrl: 'http://www.khan.co.kr/rss/rssdata/total_news.xml', lang: 'ko' },
  // ── JP (gold: japantimes.co.jp 12 · nhk.or.jp 5) ──
  { domain: 'japantimes.co.jp', feedUrl: 'https://www.japantimes.co.jp/feed/', lang: 'ja' },
  { domain: 'nhk.or.jp', feedUrl: 'https://www3.nhk.or.jp/rss/news/cat0.xml', lang: 'ja' },
  // ── ZH (gold: people.com.cn 18 · xinhuanet.com 17 · ithome.com 14) ──
  { domain: 'people.com.cn', feedUrl: 'http://www.people.com.cn/rss/politics.xml', lang: 'zh' },
  { domain: 'xinhuanet.com', feedUrl: 'http://www.xinhuanet.com/politics/news_politics.xml', lang: 'zh' },
  { domain: 'ithome.com', feedUrl: 'https://www.ithome.com/rss/', lang: 'zh' },
]

export interface NewsHubArticle {
  title: string
  url: string
  /** eval gold 매칭용 정규 도메인 (아웃렛 도메인). */
  domain: string
  lang: 'en' | 'ko' | 'ja' | 'zh'
  published?: string
  source?: string
}

interface HubCache {
  articles: NewsHubArticle[]
  fetchedAt: number
}

let hubCache: HubCache | null = null

/** 테스트 훅 — 캐시 초기화. */
export function resetNewsHubCache(): void {
  hubCache = null
}

/** 캐시 TTL 조회 (테스트/프로브용). */
export function getHubTtlMs(): number {
  return HUB_TTL_MS
}

function cleanText(raw: string): string {
  return decodeEntities(raw.trim())
}

/**
 * 단일 피드 파싱 — RSS 2.0 (<item>) + Atom (<entry>) 모두 지원.
 * 제목/link/날짜를 추출하고, 아웃렛 도메인으로 gold 정규화한다.
 * EXPORTED FOR TESTS.
 */
export function parseHubFeed(xml: string, outlet: NewsHubOutlet): NewsHubArticle[] {
  const articles: NewsHubArticle[] = []
  const lower = xml.toLowerCase()

  if (lower.includes('<entry')) {
    // Atom: <entry> … <title>, <link href>, <published>/<updated>
    const entries = xml.split(/<entry[ >]/).slice(1)
    for (const raw of entries) {
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/)
      if (!titleMatch) continue
      const title = cleanText(titleMatch[1])
      if (title.length < 5) continue
      const linkMatch = raw.match(/<link[^>]*href=["']([^"']+)["'][^>]*>/)
      if (!linkMatch) continue
      const url = cleanText(linkMatch[1])
      if (!/^https?:\/\//i.test(url)) continue
      const dateMatch = raw.match(/<(?:published|updated)[^>]*>([\s\S]*?)<\/(?:published|updated)>/)
      const published = dateMatch ? normalizeDate(dateMatch[1]) : undefined
      articles.push({ title, url, domain: outlet.domain, lang: outlet.lang, published })
    }
  } else {
    // RSS 2.0: <item> … <title>, <link>, <pubDate>
    const items = xml.split('<item>').slice(1)
    for (const raw of items) {
      const titleMatch = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/)
      if (!titleMatch) continue
      const title = cleanText(titleMatch[1])
      if (title.length < 5) continue
      const linkMatch = raw.match(/<link[^>]*>([\s\S]*?)<\/link>/) || raw.match(/<link[^>]*href=["']([^"']+)["']/)
      if (!linkMatch) continue
      const url = cleanText(linkMatch[1])
      if (!/^https?:\/\//i.test(url)) continue
      const dateMatch = raw.match(/<pubDate[^>]*>([\s\S]*?)<\/pubDate>/)
      const published = dateMatch ? normalizeDate(dateMatch[1]) : undefined
      articles.push({ title, url, domain: outlet.domain, lang: outlet.lang, published })
    }
  }

  return articles
}

function normalizeDate(raw: string): string | undefined {
  const d = new Date(raw.trim())
  return isNaN(d.getTime()) ? undefined : d.toISOString()
}

/**
 * 아웃렛 1개 피드 수집 — fetch + 파싱. 실패 시 빈 배열 (fanout 의 다른
 * 백엔드에 영향을 주지 않는 부가형). 429/5xx 는 1회 재시도 없이 폐기 —
 * 허브는 TTL 캐시 기반이라 단일 실패가 커버리지를 영구히 떨어뜨리지 않는다.
 */
export async function fetchNewsHubFeed(
  outlet: NewsHubOutlet,
  env: Env | undefined,
  timeoutMs = FEED_TIMEOUT_MS,
): Promise<NewsHubArticle[]> {
  try {
    const res = await fetchWithTimeout(
      env,
      outlet.feedUrl,
      {
        method: 'GET',
        headers: {
          'User-Agent': SEARCHBOT_UA,
          Accept: 'application/rss+xml, application/xml;q=0.9, */*;q=0.8',
        },
      },
      timeoutMs,
    )
    if (res.status !== 200) {
      res.body?.cancel().catch(() => {})
      logger.warn('[news-hub] feed non-200', { outlet: outlet.domain, status: res.status })
      return []
    }
    const xml = await res.text()
    const articles = parseHubFeed(xml, outlet)
    if (articles.length === 0) {
      logger.warn('[news-hub] feed parsed 0 items', { outlet: outlet.domain })
    }
    return articles
  } catch (err) {
    logger.warn('[news-hub] feed fetch failed', { outlet: outlet.domain, error: toError(err) })
    return []
  }
}

/**
 * 허브 전체 수집 — 아웃렛 전부 병렬 fetch 후 병합. TTL(10분) 캐시.
 * 파이럿/프로브는 --fresh 로 강제 재수집할 수 있다.
 */
export async function fetchNewsHub(
  env: Env | undefined,
  opts: { forceFresh?: boolean; outlets?: NewsHubOutlet[] } = {},
): Promise<NewsHubArticle[]> {
  if (!opts.forceFresh && hubCache && Date.now() - hubCache.fetchedAt < HUB_TTL_MS) {
    return hubCache.articles
  }
  const outlets = opts.outlets ?? NEWS_HUB_OUTLETS
  const results = await Promise.all(outlets.map((o) => fetchNewsHubFeed(o, env)))
  const articles = results.flat()
  hubCache = { articles, fetchedAt: Date.now() }
  return articles
}

/**
 * 허브 검색 — 캐시된 기사를 쿼리와 점수화해 상위 maxResults 반환.
 *
 * 커버리지 설계: gold 회수는 "쿼리와 관련된 아웃렛별 기사"가 풀에 들어가는
 * 것이므로, 전역 top-K (한 아웃렛이 상위를 독점) 대신 **아웃렛별 최적 기사
 * 1건씩**을 기여하게 한 뒤 점수순으로 K 개를 고른다 (S104/S95 site: 패턴과
 * 동일한 다양성 보장 — 한 아웃렛이 쿼리를 독점해도 다른 gold 도메인이
 * 밀리지 않는다). computeScore(제목·쿼리·발행일) 재사용.
 * domain 필드가 gold 도메인이므로 eval 매칭이 바로 동작한다.
 * EXPORTED FOR TESTS.
 */
export function newsHubSearch(
  query: string,
  articles: NewsHubArticle[],
  opts: { maxResults?: number; minScore?: number; lang?: 'en' | 'ko' | 'ja' | 'zh' } = {},
): SearchResult[] {
  const { maxResults = 8, minScore = 0.08, lang } = opts
  const pool = lang ? articles.filter((a) => a.lang === lang) : articles

  // 아웃렛별 최적 1건 (도메인 → 최고 점수 기사)
  const byDomain = new Map<string, { article: NewsHubArticle; score: number }>()
  for (const a of pool) {
    const score = computeScore(a.title, a.title, query, a.published, a.url)
    if (score < minScore) continue
    const cur = byDomain.get(a.domain)
    if (!cur || score > cur.score) byDomain.set(a.domain, { article: a, score })
  }

  const scored = [...byDomain.values()].sort((a, b) => b.score - a.score)

  return scored.slice(0, maxResults).map((s) => ({
    title: s.article.title,
    url: s.article.url,
    content: truncateToTokens(
      `[${s.article.domain}] ${s.article.title}${s.article.published ? ' — ' + s.article.published.slice(0, 10) : ''}`,
      300,
    ),
    score: s.score,
    domain: s.article.domain,
  }))
}

/** 허브 아티팩트의 도메인 집합 — gold 매칭용 헬퍼. */
export function hubDomains(results: SearchResult[]): Set<string> {
  return new Set(results.map((r) => r.domain).filter(Boolean))
}

// ============================================================
// P2-2 (2026-08-18): 프로덕션 검색 경로 로더 — NewsHubDO 가 CACHE_KV 에
// 쓴 기사 풀을 읽는다. KV 미스(첫 배포 직후 등)면 라이브 수집으로 폴백하되
// fanout 예산(4000ms)을 넘지 않게 3500ms 로 캡한다.
// ============================================================

const NEWS_HUB_KV_KEY = 'news-hub-articles'
/** KV 미스 시 라이브 폴백의 전체 예산 — fanout 'news-hub' 4000ms 내 보장. */
const HUB_LIVE_BUDGET_MS = 3500

/**
 * 검색 경로용 기사 풀 로드 — ① CACHE_KV → ② 라이브 수집(3500ms 캡).
 * 둘 다 실패하면 null (호출부가 빈 결과로 처리).
 * EXPORTED FOR TESTS.
 */
export async function loadNewsHubArticles(env: Env | undefined): Promise<NewsHubArticle[] | null> {
  if (env?.CACHE_KV) {
    try {
      const raw = await env.CACHE_KV.get<NewsHubArticle[]>(NEWS_HUB_KV_KEY, 'json')
      if (raw && raw.length > 0) return raw
    } catch {
      // KV 읽기 실패 → 라이브 폴백
    }
  }
  try {
    const articles = await Promise.race([
      fetchNewsHub(env, { forceFresh: false }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), HUB_LIVE_BUDGET_MS)),
    ])
    return articles && articles.length > 0 ? articles : null
  } catch {
    return null
  }
}
