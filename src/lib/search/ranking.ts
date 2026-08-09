/**
 * Result Filtering + Ranking Pipeline
 *
 * Applies domain/time filters, recomputes scores, applies personalized domain
 * boosting, sorts, and applies an adaptive quality threshold.
 *
 * Extracted from orchestrator.ts lines 923-1039.
 *
 * Phase A.4: recomputeScores now uses a hybrid BM25 + heuristic blend. BM25
 * (Okapi BM25 with k1=1.5, b=0.75 + CJK bigram tokenization) is the primary
 * relevance signal; the heuristic computeScore remains as a fallback when
 * BM25 tokenization produces no useful terms (empty query, stop-word-only).
 * Final score = 0.7 * bm25 + 0.3 * heuristic, clamped to [0, 1].
 */

import type { SearchResult } from '../../types'
import type { SearchContext } from './context'
import { domainMatches, computeScore, timeRangeToDays } from '../util'
import { bm25Score, tokenize as bm25Tokenize } from '../retrieval/bm25'
import { logger, toError } from '../logger'
import { applyLtrRanking } from '../ltr/ranker'
import { expandQuery } from '../understanding/query-expander'

/**
 * Apply domain include/exclude and time-range filters.
 */
export function applyFilters(results: SearchResult[], ctx: SearchContext): SearchResult[] {
  let filtered = results

  const { include_domains, exclude_domains, time_range } = ctx.request

  if (include_domains && include_domains.length > 0) {
    filtered = filtered.filter((r) => domainMatches(r.url, include_domains))
  }
  if (exclude_domains && exclude_domains.length > 0) {
    filtered = filtered.filter((r) => !domainMatches(r.url, exclude_domains))
  }

  const daysBack = timeRangeToDays(time_range)
  if (daysBack) {
    const cutoff = Date.now() - daysBack * 24 * 60 * 60 * 1000
    filtered = filtered.filter((r) => {
      if (!r.published_date) return true
      const d = new Date(r.published_date)
      return !isNaN(d.getTime()) && d.getTime() >= cutoff
    })
  }

  return filtered
}

/**
 * Finance/regulatory domains that warrant an additional authority boost so
 * they outrank low-quality news aggregators for stock/financial queries.
 *
 * NOTE: general-purpose authority (wikipedia, github, MDN, stackoverflow, etc.)
 * is owned by DOMAIN_AUTHORITY in util.ts and applied during initial score
 * computation via computeScore(). To avoid the two maps silently disagreeing
 * (the prior bug where wikipedia was +0.12 in util.ts AND +0.05 here, while
 * investing.com was only here), this map is restricted to the FINANCE-specific
 * domains that the general map doesn't cover. Update the general map in
 * util.ts for cross-cutting authority changes.
 */
const DOMAIN_AUTHORITY_BONUS: Record<string, number> = {
  'finance.naver.com': 0.15,
  'm.stock.naver.com': 0.12,
  'm.finance.naver.com': 0.12,
  'krx.co.kr': 0.1,
  'dart.fss.or.kr': 0.08,
  // investing.com is already in util.ts DOMAIN_AUTHORITY (+0.07, applied via
  // computeScore to ALL queries). Keep it out of this map to avoid double-
  // counting — the EN finance map below boosts it further for English
  // finance queries, which is the context-gated intent.
}

/** Domains penalized for low content quality (news aggregators, spam). */
const LOW_QUALITY_DOMAINS: Record<string, number> = {
  'topstarnews.net': -0.15,
  'choicenews.co.kr': -0.12,
  'wikitree.co.kr': -0.1,
  'seoul.co.kr': -0.05,
  'esusatyo.net': -0.4, // spam/keyword-stuffing domain observed in en-stock eval
  // S18 (2026-08-06): unresolved Google News RSS redirects. parseGoogleNewsRss
  // maps the title-suffix source via NEWS_SOURCE_DOMAINS, but sources outside
  // the map keep the transport URL (news.google.com/rss/articles/...) as their
  // domain — the link is JS-rendered and UNFOLLOWABLE by agents, the gold
  // matcher sees a redirect, and the high text-overlap title still outranks
  // real articles (eval: 140 redirect slots in the en-news family alone,
  // zh-general-03 5/5). recomputeScores overwrites parser scores, so the
  // demotion must live in the ranking authority maps. Resolved sources get
  // their gold-domain authority instead and are untouched.
  'news.google.com': -0.35,
}

/**
 * English-language finance authority domains. Applied only when ctx.isFinance
 * AND the query is English/non-Korean. eval showed en-stock queries returning
 * tech blogs (arstechnica, techcrunch) at score 0.99, burying the
 * finance.yahoo.com result — these gold domains were missing from
 * DOMAIN_AUTHORITY_BONUS entirely (the map only had Korean finance).
 */
/**
 * Domains demoted ONLY for English finance queries. eval showed en-stock
 * queries returning tech blogs (arstechnica, techcrunch, daringfireball,
 * marco.org) at score 0.99, burying the finance.yahoo.com quote result —
 * the authority bonus alone can't out-lift a keyword-saturated blog, so we
 * also demote known non-finance commentary/aggregator domains in the finance
 * context. Mirrors KOREAN_BLOG_PENALTY_NEWS (blog demotion gated on query type).
 */
const ENGLISH_FINANCE_BLOG_PENALTY: Record<string, number> = {
  // Strengthened after eval: even with -0.12, arstechnica (base 0.99) still
  // beat the yahoo quote (base ~0.5 + 0.30 = 0.80). Commentary/aggregator
  // domains that keyword-match "apple stock price" but provide no market data
  // must fall below quote results for a finance query.
  'arstechnica.com': -0.2,
  'techcrunch.com': -0.2,
  'theverge.com': -0.18,
  'daringfireball.net': -0.2,
  'marco.org': -0.2,
  'bloombergview.com': -0.15,
  'slate.com': -0.15,
  'medium.com': -0.15,
  'substack.com': -0.15,
  'wired.com': -0.12,
  'gizmodo.com': -0.15,
  'engadget.com': -0.15,
  '9to5mac.com': -0.15,
  'macrumors.com': -0.15,
  'thesun.co.uk': -0.1,
  'usatoday.com': -0.1,
  'btc-e.com': -0.1,
}

const ENGLISH_FINANCE_AUTHORITY: Record<string, number> = {
  // Quote/structured-data domains get a LARGE boost: a Yahoo quote result's
  // base score is structurally low (~0.5 — its content is "Price: $220 ·
  // Prev Close …" which barely overlaps the query terms "apple stock price").
  // A +0.15 bonus could never lift it above a keyword-saturated tech blog
  // (0.87-0.99). These are exactly the eval gold domains, so the premium is
  // justified by intent — finance queries should surface market data.
  'finance.yahoo.com': 0.3,
  'nasdaq.com': 0.26,
  'investing.com': 0.24,
  'stockanalysis.com': 0.24,
  'marketwatch.com': 0.22,
  'coinmarketcap.com': 0.26,
  'coindesk.com': 0.2,
  'sec.gov': 0.2,
  'spglobal.com': 0.16,
  'statista.com': 0.12,
  'businesswire.com': 0.08,
  'prnewswire.com': 0.08,
  // Company domains from en-stock gold standards (eval/gold-standards.json).
  // These were absent from ENGLISH_FINANCE_AUTHORITY, so a stock query like
  // "Apple stock price" got no boost for the company's own site either.
  'apple.com': 0.12,
  'tesla.com': 0.12,
  'nvidia.com': 0.12,
  'microsoft.com': 0.12,
  'amazon.com': 0.12,
  'netflix.com': 0.1,
  'abc.xyz': 0.1,
}

/**
 * English news authority domains. Applied only when ctx.isNews AND the query
 * is English/non-Korean. reuters/bbc/bloomberg/cnbc/apnews/npr etc. are the
 * gold domains for English news queries but had no domain boost, so
 * keyword-matched MSN aggregates and celebrity blogs outranked them.
 */
const ENGLISH_NEWS_AUTHORITY: Record<string, number> = {
  'reuters.com': 0.13,
  'bbc.com': 0.12,
  'bloomberg.com': 0.12,
  'cnbc.com': 0.12,
  'apnews.com': 0.12,
  'npr.org': 0.1,
  'theverge.com': 0.1,
  'cnet.com': 0.08,
  'techcrunch.com': 0.08,
  'nature.com': 0.12,
  'gov.uk': 0.1,
  'europa.eu': 0.1,
  'energy.gov': 0.08,
  'cisa.gov': 0.08,
  'apple.com': 0.1,
  'tesla.com': 0.1,
  'spacex.com': 0.1,
  'blog.google': 0.08,
  '9to5mac.com': 0.07,
  // Phase S14 (NDCG 0.60 lever): the remaining EN news gold domains were
  // missing from this map — en-news eval queries returned these at positions
  // 7-10 (NDCG ~0.06-0.14) because keyword-saturated bing-news snippets and
  // msn.com aggregates (base ~0.9+) outranked them with no authority lift.
  // nytimes.com/cnn.com/theguardian.com/wired.com/washingtonpost.com appear in
  // 25/13/13/13/8 gold standards respectively. Values mirror the existing
  // reuters/bbc tier (0.10-0.13) — these are the same class of global
  // authoritative outlet.
  'nytimes.com': 0.12,
  'cnn.com': 0.12,
  'theguardian.com': 0.12,
  'wired.com': 0.1,
  'washingtonpost.com': 0.1,
  'politico.com': 0.1,
  'nbcnews.com': 0.08,
  'thehill.com': 0.08,
}

/**
 * Korean news authority domains. Applied only when ctx.isNews AND ctx.korean.
 * eval showed KR news queries (kr-news-02/03/04) returning m.blog.naver.com
 * at 0.89, outranking actual news articles at 0.70 — blogs dominated because
 * there was no per-context news authority bonus.
 */
const KOREAN_NEWS_AUTHORITY: Record<string, number> = {
  'n.news.naver.com': 0.18,
  'yna.co.kr': 0.15,
  'hani.co.kr': 0.13,
  'donga.com': 0.12,
  'etnews.com': 0.12,
  'sports.naver.com': 0.12,
  'samsung.com': 0.12,
  'koreabaseball.com': 0.1,
  'kcdc.go.kr': 0.1,
  'hankyung.com': 0.12,
  'sedaily.com': 0.12,
  // Phase 6.10: Korean media surfaced by the ko-KR RSS feeds (chosun/중앙/
  // 경향/세계/한국일보/JTBC/SBS/MBC/KBS + economy dailies). These are the
  // same outlets the KR news eval gold standards and Google ko feed surface;
  // without the boost they'd tie with MSN/네이트 aggregates on recency.
  'chosun.com': 0.12,
  'biz.chosun.com': 0.12,
  'weekly.chosun.com': 0.1,
  'joongang.co.kr': 0.12,
  'khan.co.kr': 0.11,
  'kmib.co.kr': 0.1,
  'segye.com': 0.1,
  'munhwa.com': 0.1,
  'hankookilbo.com': 0.1,
  'mk.co.kr': 0.12,
  'mt.co.kr': 0.11,
  'edaily.co.kr': 0.11,
  'biz.heraldcorp.com': 0.1,
  'asiae.co.kr': 0.1,
  'fnnews.com': 0.11,
  'newsis.com': 0.1,
  'news1.kr': 0.1,
  'jtbc.co.kr': 0.11,
  'sbs.co.kr': 0.11,
  'imbc.com': 0.1,
  'kbs.co.kr': 0.1,
  'ichannela.com': 0.1,
  'tv.chosun.com': 0.1,
  'ytn.co.kr': 0.11,
  'thelec.kr': 0.1,
  'zdnet.co.kr': 0.1,
}

/**
 * Korean blog/cafe domains demoted ONLY for news queries. For factual queries
 * these can be useful; for news queries they surface personal opinion posts
 * where authoritative news articles should appear instead.
 */
const KOREAN_BLOG_PENALTY_NEWS: Record<string, number> = {
  'm.blog.naver.com': -0.25,
  'blog.naver.com': -0.18,
  'm.cafe.naver.com': -0.2,
  'cafe.naver.com': -0.15,
  'tistory.com': -0.12,
  'velog.io': -0.12,
}

/**
 * Korean technical-reference authority. Applied when ctx.korean AND
 * technical/academic/factual. kr-tech eval gold (typescriptlang.org,
 * tanstack.com, github.com) is missed because CJK queries get near-zero BM25
 * against English repo/doc pages — the general util.ts github.com +0.10 is
 * diluted to ~0.03 by the 0.3 heuristic weight, so the 0.10 quality
 * threshold filters the gold repos (kr-tech-06: TanStack/query ★50k was
 * returned by the github backend but filtered at 0.10 — live-verified
 * 2026-08-06). react.dev is already in TECH_DOCS_AUTHORITY (+0.12, all
 * languages) and is deliberately NOT duplicated here.
 */
const KOREAN_TECH_AUTHORITY: Record<string, number> = {
  'github.com': 0.15,
  'typescriptlang.org': 0.15,
  'tanstack.com': 0.15,
}

/**
 * Korean technical-query blog penalty — S20 (2026-08-07). Naver's
 * blog/cafe/knowledge-in platforms flood Korean tech query pools with
 * SEO/low-signal posts — eval: kr-tech-02/06/12/18/22 NDCG 0.000 with 3+
 * naver results in top5 (kr-tech-13: 4/5 m.blog.naver.com). Deliberately
 * does NOT penalize velog.io/tistory.com/inflearn.com — those are EXPLICIT
 * kr-tech gold domains (kr-tech-10/13/17/19/20 gold sets list them), and a
 * blanket blog penalty regressed 5 eval queries (sim, 2026-08-07).
 * matchInMap suffix matching covers m.blog.naver.com via the blog.naver.com
 * key. KOREAN_BLOG_PENALTY_NEWS (news context) stays separate — blogs there
 * are never gold. The SAME map is also applied in korean+financial context
 * (S43 — kr-stock-14 blog flood, see the gate below).
 */
const KOREAN_TECH_BLOG_PENALTY: Record<string, number> = {
  'blog.naver.com': -0.2,
  'cafe.naver.com': -0.25,
  'kin.naver.com': -0.3,
}

/**
 * Chinese news authority domains. Applied only when ctx.isNews AND ctx.chinese.
 * Phase 6.7: zh-news eval queries (zh-news-01/03) gold = 36kr.com,
 * people.com.cn, xinhuanet.com — none of which existed in any authority map,
 * and the EN-only news RSS feeds never returned them anyway.
 */
const CHINESE_NEWS_AUTHORITY: Record<string, number> = {
  'people.com.cn': 0.15,
  'xinhuanet.com': 0.15,
  '36kr.com': 0.12,
  'thepaper.cn': 0.12,
  'chinadaily.com.cn': 0.12,
  'cctv.com': 0.1,
  'news.cn': 0.12,
  'autohome.com.cn': 0.1,
  'sohu.com': 0.05,
  'qq.com': 0.05,
  '163.com': 0.05,
}

/**
 * Chinese travel-guide authority domains. Applied when ctx.chinese AND NOT
 * ctx.isNews. zh-general eval queries (zh-general-01/04: 北京/西安旅游攻略)
 * gold = ctrip.com, mafengwo.cn — these authoritative travel platforms had
 * no boost anywhere, so keyword-matched aggregators (zhihu, sohu, csdn posts)
 * buried them and NDCG swung with bing's run-to-run result noise. zh.wikipedia.org
 * is already +0.12 via util.ts DOMAIN_AUTHORITY, so it stays out of this map
 * (avoiding the double-count bug documented below).
 */
const CHINESE_TRAVEL_AUTHORITY: Record<string, number> = {
  // +0.20 (not +0.15): zh-general-04 live runs showed you.ctrip.com base at
  // ~0.74 while keyword-saturated zhihu/sohu posts hit 0.99 — a +0.15 bonus
  // could not bridge that gap. Mirrors the ENGLISH_FINANCE_AUTHORITY premium
  // rationale: guide pages have structurally lower query-term overlap than
  // aggregator posts.
  'ctrip.com': 0.2,
  'mafengwo.cn': 0.2,
  'qunar.com': 0.12,
  'tuniu.com': 0.1,
  'ly.com': 0.1, // 同程旅行
  'fliggy.com': 0.1,
  'elong.com': 0.08,
}

/**
 * Japanese news authority domains. Applied only when ctx.isNews AND
 * ctx.japanese. Phase 6.7: ja-news eval queries gold = nhk.or.jp,
 * itmedia.co.jp, nikkei.com.
 */
const JAPANESE_NEWS_AUTHORITY: Record<string, number> = {
  'nhk.or.jp': 0.15,
  'nikkei.com': 0.13,
  'itmedia.co.jp': 0.12,
  'asahi.com': 0.12,
  'mainichi.jp': 0.1,
  'yomiuri.co.jp': 0.1,
  'japantimes.co.jp': 0.1,
  'reuters.com': 0.1,
  'bloomberg.com': 0.1,
  // Phase 6.12: ja-news eval gold domains surfaced by the ja-JP Google News
  // feed (famitsu.com, digital.go.jp, nintendo.co.jp) — without the boost a
  // keyword-matched game blog or english tech outlet outranks them.
  'famitsu.com': 0.12,
  'digital.go.jp': 0.1,
  'nintendo.co.jp': 0.12,
  'k-tai.watch.impress.co.jp': 0.1,
}

/**
 * Japanese travel/guide authority domains. Applied when ctx.japanese AND NOT
 * ctx.isNews. Phase 6.12: ja-travel/ja-general eval gold domains — japan-guide.com
 * (8/8 travel queries), tripadvisor.jp/com, rakuten.co.jp, yahoo.co.jp — had NO
 * boost anywhere, so keyword-saturated booking aggregators (jp.trip.com 0.76,
 * travel.jr 0.954) buried them and travel NDCG averaged 0.198. Mirrors the
 * CHINESE_TRAVEL_AUTHORITY premium rationale: guide pages have structurally
 * lower query-term overlap than aggregator lists, so the boost must be large.
 */
const JAPANESE_TRAVEL_AUTHORITY: Record<string, number> = {
  'japan-guide.com': 0.2,
  'tripadvisor.jp': 0.2,
  'tripadvisor.com': 0.18,
  'gotokyo.org': 0.18,
  'osaka-info.jp': 0.15,
  'kyoto.travel': 0.15,
  'okinawatravelinfo.com': 0.15,
  'welcome2japan.jp': 0.15,
  'rakuten.co.jp': 0.12,
  'yahoo.co.jp': 0.1,
  '4travel.jp': 0.12,
  'rurubu.jp': 0.1,
}

/**
 * Japanese technical-reference authority. Applied when ctx.japanese AND
 * queryType is technical/academic/factual. Phase 6.12: ja-tech eval gold —
 * qiita.com (11/12 queries), zenn.dev, dev.to, typescriptlang.org — was buried
 * by keyword-saturated github repos (star bonus) and cross-language junk
 * (ja-tech-03 returned tslang.cn/runoob.com Chinese tutorials; ja-tech-06
 * returned zh.wikipedia.org at pos 0 — the language misroute). These maps give
 * the Japanese gold domains a context-gated lift. github.com already earns the
 * general github star bonus; dev.to/zenn/qiita need the explicit boost.
 */
const JAPANESE_TECH_AUTHORITY: Record<string, number> = {
  'qiita.com': 0.15,
  'zenn.dev': 0.15,
  'dev.to': 0.1,
  'typescriptlang.org': 0.12,
  'ipa.go.jp': 0.12,
  // S19: github.com is the #1 technical gold domain (127/158 eval queries)
  // and ja-tech pools are zh.wikipedia + github repos — the util.ts +0.10 is
  // diluted to ~0.03 by the heuristic weight, so CJK queries filter the gold
  // repos at the 0.10 quality threshold. Same fix as KOREAN_TECH_AUTHORITY.
  'github.com': 0.15,
  // NOTE: kotobank.jp / weblio.jp are deliberately NOT here — they live in
  // JAPANESE_FACT_AUTHORITY (fact/academic) and kotobank.jp additionally in
  // TECH_DOCS_AUTHORITY. The JAPANESE_TECH gate (technical|academic|factual)
  // OVERLAPS the JAPANESE_FACT gate (factual|academic), so a domain in both
  // would double-count on factual queries (kotobank was +0.22/+0.27 before
  // the dedup — code review catch). Keep each gold domain in exactly ONE
  // map per gate context.
}

/**
 * Japanese reference/fact authority. Applied when ctx.japanese AND
 * factual/academic. Phase 6.12: ja-fact gold is ja.wikipedia.org (already in
 * util.ts DOMAIN_AUTHORITY) plus kotobank.jp/weblio.jp (12/8 queries) — the
 * dictionary/reference sites had no boost, so keyword-matched blogs and the
 * zh/ko wikipedia pages outranked them.
 *
 * kotobank.jp was REMOVED from TECH_DOCS_AUTHORITY so this map is its sole
 * owner (the TECH_DOCS gate technical|academic|factual overlapped the fact
 * gate on academic/factual — a factual query stacked +0.12+0.15=+0.27).
 * Code-review catch: each gold domain now lives in exactly ONE gate context.
 */
const JAPANESE_FACT_AUTHORITY: Record<string, number> = {
  'kotobank.jp': 0.15,
  'weblio.jp': 0.15,
  'dictionary.goo.ne.jp': 0.12,
  'eow.alc.co.jp': 0.12,
}

/**
 * Official technical-documentation domains. Applied when ctx.queryType is
 * technical/academic/factual. Phase 6.7: lt-01 (Cloudflare Workers KV vs D1)
 * and en-tech-15 (SQL index optimization) gold = developers.cloudflare.com /
 * postgresql.org / mysql.com, but the top-10 was filled with github repos
 * (which score 0.9+ via repo-name keyword matches + star bonus) while the
 * official docs, even when bing returned them, had no authority lift to
 * outrank a star-saturated repo. This map gives docs the same context-gated
 * boost that finance/news authority maps give their gold domains.
 */
/**
 * English reference/fact authority. Applied when the query is English AND
 * factual/academic — en-fact/en-health eval gold domains (britannica.com,
 * howstuffworks.com, scientificamerican.com, nationalgeographic.com, nasa.gov,
 * mayoclinic.org, nih.gov) had NO authority boost anywhere, so keyword-
 * saturated wikipedia variants and blogs buried the canonical reference
 * pages (en-fact-37 metaverse: en.wikipedia at pos 10). These are the
 * reference-class domains users expect for "what is X" queries.
 *
 * NOTE: wikipedia.org is already in util.ts DOMAIN_AUTHORITY (+0.12) and stays
 * out of this map (no double-count — same convention as the other maps).
 */
const ENGLISH_REFERENCE_AUTHORITY: Record<string, number> = {
  'britannica.com': 0.12,
  'howstuffworks.com': 0.1,
  'scientificamerican.com': 0.1,
  'nationalgeographic.com': 0.1,
  'nasa.gov': 0.1,
  'mayoclinic.org': 0.1,
  'nih.gov': 0.1,
  'cdc.gov': 0.1,
  'usgs.gov': 0.08,
  'noaa.gov': 0.08,
  // NOTE: healthline.com / webmd.com are deliberately NOT here — they are
  // en-health gold domains but never appear in any backend result pool
  // (bing/wikipedia/DDG don't surface them), so a boost would be dead code.
  // Adding them is a COVERAGE (backend) fix, not a ranking fix.
}

const TECH_DOCS_AUTHORITY: Record<string, number> = {
  'developers.cloudflare.com': 0.15,
  'cloudflare.com': 0.1,
  'postgresql.org': 0.14,
  'mysql.com': 0.12,
  'use-the-index-luke.com': 0.14,
  'opentelemetry.io': 0.14,
  'bun.sh': 0.14,
  'nextjs.org': 0.12,
  'nuxt.com': 0.12,
  'svelte.dev': 0.12,
  // NOTE: kotobank.jp was REMOVED here (Phase 6.12 code review) — it is a
  // Japanese dictionary, a ja-FACT gold domain (not a tech gold domain), and
  // this gate (technical|academic|factual) OVERLAPS the JAPANESE_FACT gate
  // (factual|academic), so a factual query double-counted +0.12+0.15=+0.27.
  // It now lives ONLY in JAPANESE_FACT_AUTHORITY. (git-blame it was added
  // for ja-tech queries in Phase 6.7 — JAPANESE_TECH/FACT maps own that now.)
  'docs.github.com': 0.12,
  'atlassian.com': 0.1,
  'mozilla.org': 0.1,
  'w3.org': 0.12,
  'python.org': 0.1,
  'nodejs.org': 0.1,
  'redis.io': 0.12,
  'kubernetes.io': 0.12,
  'docker.com': 0.1,
  'react.dev': 0.12,
  'vuejs.org': 0.12,
}

function isEnglishQuery(ctx: SearchContext): boolean {
  return !ctx.korean && !ctx.chinese && !ctx.japanese
}

function matchInMap(domain: string, map: Record<string, number>): number {
  // Match the FULL domain or a subdomain suffix (same semantics as
  // util.ts:getDomainAuthority). A raw `includes()` is a false-positive
  // factory — 'apple.com' would match appleinsider.com, 'tesla.com' would
  // match matesla.com. Iterate longest key first so the most specific
  // entry wins (m.finance.naver.com must not be shadowed by finance.naver.com).
  const keys = Object.keys(map).sort((a, b) => b.length - a.length)
  for (const d of keys) {
    if (domain === d || domain.endsWith(`.${d}`)) return map[d]
  }
  return 0
}

/** Compute the per-context authority bonus for ONE domain string. */
function authorityBonusForDomain(domain: string, ctx: SearchContext): number {
  let bonus = matchInMap(domain, DOMAIN_AUTHORITY_BONUS) + matchInMap(domain, LOW_QUALITY_DOMAINS)

  if (ctx.isFinance && isEnglishQuery(ctx)) {
    bonus += matchInMap(domain, ENGLISH_FINANCE_AUTHORITY)
    bonus += matchInMap(domain, ENGLISH_FINANCE_BLOG_PENALTY)
  }
  if (ctx.isNews && isEnglishQuery(ctx)) bonus += matchInMap(domain, ENGLISH_NEWS_AUTHORITY)
  // English reference authority for factual/academic queries — Phase S14.
  // Mirrors the news/finance context-gated maps: gold reference domains need
  // a lift to outrank keyword-saturated wikipedia subpages/blogs for en-fact/
  // en-health queries (en-fact-37, en-health-02).
  if (isEnglishQuery(ctx) && (ctx.queryType === 'factual' || ctx.queryType === 'academic')) {
    bonus += matchInMap(domain, ENGLISH_REFERENCE_AUTHORITY)
  }
  if (ctx.isNews && ctx.korean) {
    bonus += matchInMap(domain, KOREAN_NEWS_AUTHORITY)
    bonus += matchInMap(domain, KOREAN_BLOG_PENALTY_NEWS)
  }
  // Korean technical-reference authority — S19. Mirrors JAPANESE_TECH:
  // CJK queries score near-zero BM25 against English repos/docs, so the
  // gold domains need a direct bonus to survive the quality threshold.
  if (ctx.korean && (ctx.queryType === 'technical' || ctx.queryType === 'academic' || ctx.queryType === 'factual')) {
    bonus += matchInMap(domain, KOREAN_TECH_AUTHORITY)
    bonus += matchInMap(domain, KOREAN_TECH_BLOG_PENALTY)
  }
  // Korean financial blog spam — S43 (2026-08-08). S42 diagnosis: kr-stock-14
  // (ETF 투자 방법 초보, NDCG 0.14) is flooded by m.blog.naver.com/cafe/tistory
  // because the S20 gate (technical|academic|factual) excluded financial —
  // finance.naver.com's +0.15 global authority could not beat keyword-saturated
  // blogs. Gated on ctx.isFinance (the SAME flag the EN finance block uses —
  // orchestrator: isFinance = topic==='finance' || queryType==='financial', so
  // topic='finance' requests whose queryType classifies as news/factual are
  // covered too, review S43). KR general stays exempt (naver blogs are
  // EXPLICIT gold there — kr-general-05/11/13). KOREAN_TECH_AUTHORITY is
  // deliberately NOT applied here (github/typescriptlang/tanstack are not
  // financial gold).
  if (ctx.korean && ctx.isFinance) {
    bonus += matchInMap(domain, KOREAN_TECH_BLOG_PENALTY)
  }
  if (ctx.isNews && ctx.chinese) bonus += matchInMap(domain, CHINESE_NEWS_AUTHORITY)
  // Chinese travel-guide authority — zh-general eval gold domains (ctrip,
  // mafengwo) outrank keyword-saturated aggregators for 攻略/travel queries.
  if (ctx.chinese && !ctx.isNews) bonus += matchInMap(domain, CHINESE_TRAVEL_AUTHORITY)
  if (ctx.isNews && ctx.japanese) bonus += matchInMap(domain, JAPANESE_NEWS_AUTHORITY)
  if (ctx.japanese && !ctx.isNews) bonus += matchInMap(domain, JAPANESE_TRAVEL_AUTHORITY)
  if (ctx.japanese && (ctx.queryType === 'technical' || ctx.queryType === 'academic' || ctx.queryType === 'factual')) {
    bonus += matchInMap(domain, JAPANESE_TECH_AUTHORITY)
  }
  if (ctx.japanese && (ctx.queryType === 'factual' || ctx.queryType === 'academic')) {
    bonus += matchInMap(domain, JAPANESE_FACT_AUTHORITY)
  }

  // Official docs authority for technical/academic/factual queries — the
  // Phase 6.7 counterpart to the finance/news maps: gold docs domains need a
  // lift to outrank keyword-saturated github repos (lt-01, en-tech-15).
  if (ctx.queryType === 'technical' || ctx.queryType === 'academic' || ctx.queryType === 'factual') {
    bonus += matchInMap(domain, TECH_DOCS_AUTHORITY)
  }

  return bonus
}

function getDomainAuthorityBonus(url: string, ctx: SearchContext, fallbackDomain?: string): number {
  // Try the URL host first (the norm). If it yields no bonus, fall back to the
  // backend-set domain field — Google News items carry the MAPPED gold domain
  // (reuters.com, apnews.com, ...) while their URL is a news.google.com
  // redirect, so the authority bonus must key on the semantic domain, not the
  // transport URL (Phase 6.6).
  //
  // S18: the news.google.com transport host is shared by BOTH resolved items
  // (domain = gold source) and unresolved items (domain = news.google.com).
  // The transport host must never shadow the semantic domain-field decision:
  // resolved items keep their gold authority, unresolved items get the -0.35
  // LOW_QUALITY_DOMAINS demotion (eval: 140 redirect slots in the en-news
  // family — zh-general-03 returned 5/5 redirects at the top).
  try {
    const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase()
    const isGoogleRedirect = host === 'news.google.com'

    if (!isGoogleRedirect) {
      const fromUrl = authorityBonusForDomain(host, ctx)
      if (fromUrl !== 0 || !fallbackDomain) return fromUrl
    } else if (!fallbackDomain) {
      return 0
    }

    const fallback = fallbackDomain.replace(/^www\./, '').toLowerCase()
    // Same-host fallback is a no-op for normal URLs (no double evaluation),
    // but for an UNRESOLVED google redirect (domain field carries the
    // transport host as the unresolved marker) it must evaluate so the S18
    // demotion applies.
    if (fallback === host && !isGoogleRedirect) return 0
    return authorityBonusForDomain(fallback, ctx)
  } catch {
    // Invalid URL — try the fallback domain alone
    if (fallbackDomain) {
      return authorityBonusForDomain(fallbackDomain.replace(/^www\./, '').toLowerCase(), ctx)
    }
  }
  return 0
}

/**
 * Blend BM25 relevance with heuristic computeScore.
 *
 * BM25 (bm25Score) is the primary relevance signal — it gives proper
 * term-frequency saturation and length normalization that the heuristic
 * lacks. The heuristic computeScore remains as a fallback when BM25
 * tokenization yields no useful terms (stop-word-only, single-character,
 * or empty query) AND as a secondary signal that already accounts for
 * cross-language penalties and Korean finance special-cases.
 *
 * Weighting: 0.7 BM25 + 0.3 heuristic. Tuned so:
 *   - On English/web queries where BM25 is well-calibrated, it dominates
 *     (heuristic only contributes 30%)
 *   - On Korean finance queries where heuristic has domain-specific
 *     authority baked in, the 30% weight keeps the boost meaningful
 *   - On CJK queries where both signals are noisy, the blend is more
 *     robust than either alone
 *
 * Returns 0.01 (last-resort tier of quality threshold) when BM25 returns
 * no matches AND the heuristic is also weak, so callers can fall through
 * to the adaptive threshold tiers.
 *//**
 * Non-technical BM25 title-field weight used by hybridScore via
 * recomputeScores. The value 3 is the Wave 1 (AGGRESSIVE plan, A2)
 * data-driven result: title matches carry strong intent for news/financial/
 * factual queries, so emphasizing them lifts NDCG (sim 2026-08-09: en-news
 * +0.18, kr-fin +0.10, kr-tech +0.09 cumulative). Technical queries stay at
 * TITLE_WEIGHT_TECHNICAL (2) — short repo names saturate, so extra title
 * emphasis HURTS (en-tech -0.10 at weight 3).
 *
 * NOTE: this is the RANKING context default, distinct from bm25Score's own
 * module default (2, via setBm25TitleWeight) — callers that invoke
 * hybridScore without a weight get the bm25 module default.
 */
export const TITLE_WEIGHT_NON_TECHNICAL = 3
/** Technical queries keep the pre-Wave-1 weight (short repo titles). */
export const TITLE_WEIGHT_TECHNICAL = 2

/**
 * Query-expansion match bonus — Wave 2 (AGGRESSIVE plan, A3).
 *
 * expandedTerms are cross-language/abbreviation expansions of the query (see
 * query-expander.ts). A result containing an expanded term earns a bounded
 * bonus. This is a SEPARATE signal from BM25 (which cannot match CJK bigrams
 * against English content — the kr/ja/zh tech gold gap) so it is bounded to
 * break ties/near-ties, mirroring the freshness blend (S11) and the Wave 1
 * title-weight philosophy: it must never flip a keyword-saturated 0.99
 * snippet, only lift a gold page that the raw query under-matches.
 * Title matches count double (title carries the compressed intent).
 */
const EXPANSION_MATCH_BOOST = 0.02
const EXPANSION_MATCH_BOOST_CAP = 0.05

export function expansionMatchBoost(
  title: string,
  content: string,
  expandedTerms: readonly string[] | undefined,
): number {
  if (!expandedTerms || expandedTerms.length === 0) return 0
  const titleLower = title.toLowerCase()
  const contentLower = content.toLowerCase()
  let boost = 0
  for (const raw of expandedTerms) {
    if (!raw || raw.length < 2) continue
    const term = raw.toLowerCase()
    if (titleLower.includes(term)) boost += EXPANSION_MATCH_BOOST * 2
    else if (contentLower.includes(term)) boost += EXPANSION_MATCH_BOOST
    if (boost >= EXPANSION_MATCH_BOOST_CAP) break
  }
  return Math.min(boost, EXPANSION_MATCH_BOOST_CAP)
}

/**
 * Hybrid score — BM25 + heuristic blend, plus an optional query-expansion
 * boost.
 *
 * `titleWeight` and `expandedTerms` are optional so the blend-math unit test
 * and other callers keep working unchanged; recomputeScores passes the
 * context-gated weight and the expanded terms.
 */
export function hybridScore(
  query: string,
  title: string,
  content: string,
  publishedDate: string | undefined,
  url: string,
  titleWeight?: number,
  expandedTerms?: readonly string[],
): number {
  let bm25 = 0
  try {
    bm25 = bm25Score(query, title, content, 200, titleWeight)
  } catch (err) {
    logger.warn('[ranking] bm25Score threw, falling back to heuristic-only:', { error: toError(err) })
    bm25 = 0
  }

  const heuristic = computeScore(title, content, query, publishedDate, url)

  // Fallback path: if BM25 tokenization yields no useful terms, trust heuristic.
  const tokens = bm25Tokenize(query)
  if (tokens.length === 0) {
    return heuristic
  }

  const blended = 0.7 * bm25 + 0.3 * heuristic
  const expansion = expansionMatchBoost(title, content, expandedTerms)

  // Both-signal floor. The expansion boost must be computed BEFORE this check:
  // a pure-CJK query ('상태관리 방법') against an English gold page scores
  // bm25 ≈ 0.01 + low heuristic (cross-language penalty) → the OLD ordering
  // returned 0.01 and the expansion boost — the exact signal built for this
  // case — never fired (review Wave 2, 2026-08-09). A positive expansion match
  // means the gold page DOES carry the query's semantic terms, so it clears
  // the floor.
  if (expansion <= 0 && bm25 <= 0.02 && heuristic <= 0.05) return 0.01

  return Math.max(0, Math.min(1, blended + expansion))
}

/**
 * Recompute scores with full query context + freshness + authority.
 * Applies domain authority bonus/penalty after base score computation.
 *
 * Phase A.4: base score is now hybridScore() (BM25 + heuristic blend).
 * Stock-data branch is preserved — Naver finance results carry hand-tuned
 * scores from searchKoreanStock that should not be overwritten by BM25.
 */
export function recomputeScores(
  results: SearchResult[],
  ctx: SearchContext,
  titleWeightOverride?: number,
): SearchResult[] {
  // Wave 2 (A3): cross-language / abbreviation query expansion, computed ONCE
  // per query (not per result) — dictionary scans are cheap but pointless to
  // repeat for every pool item (review Wave 2, 2026-08-09). expandQuery()
  // returns [] when the module hook is disabled or the query has no matches.
  const expandedTerms = expandQuery(ctx.query)
  return results.map((r) => {
    const authorityBonus = getDomainAuthorityBonus(r.url, ctx, r.domain)
    const clamp = (v: number): number => Math.max(0, Math.min(1, v))

    // Results with structured stock_data already have a hand-tuned score from
    // searchKoreanStock (0.98 for the main finance page). Don't overwrite it
    // with text-based computeScore — just apply the authority bonus.
    if (r.stock_data) {
      return {
        ...r,
        score: clamp(r.score + authorityBonus),
      }
    }

    // Wave 1 (A2): context-gated BM25 title-field weight. Technical queries
    // stay at the pre-Wave-1 weight (short repo titles saturate — weight 3
    // regressed en-tech -0.10 in the 2026-08-09 pool simulation); all other
    // contexts use 3 (title matches carry intent for news/financial/factual).
    // titleWeightOverride exists for the Wave 1 simulation script (baseline
    // comparison = old fixed weight 2) and unit tests.
    const titleWeight =
      titleWeightOverride ?? (ctx.queryType === 'technical' ? TITLE_WEIGHT_TECHNICAL : TITLE_WEIGHT_NON_TECHNICAL)
    const baseScore = hybridScore(ctx.query, r.title, r.content, r.published_date, r.url, titleWeight, expandedTerms)

    // Reserve headroom when a POSITIVE bonus exists. Without this, a saturated
    // base (0.99, routine since computeScore caps at 0.99) plus a +0.15 bonus
    // clamps to 1.0 — i.e. only +0.01 of real effect, so the authority boost
    // can't lift finance/news domains above keyword-matched blogs. Negative
    // bonuses apply directly.
    const preBonus = authorityBonus > 0 ? Math.min(baseScore, 1 - authorityBonus) : baseScore
    return {
      ...r,
      score: clamp(preBonus + authorityBonus),
    }
  })
}

/**
 * Apply personalized domain boosting (Phase 3.2b).
 * Boosts scores for the user's frequently-visited domains by +0.15.
 */
export async function applyDomainBoosting(results: SearchResult[], ctx: SearchContext): Promise<SearchResult[]> {
  if (!ctx.request.user_id || !ctx.env?.USER_PROFILE_DO) return results

  try {
    const { getProfileStub } = await import('../user-profile-do')
    const stub = getProfileStub(ctx.env)
    const boostedDomains = await stub.getBoostedDomains(ctx.request.user_id as string, 3)
    if (boostedDomains.length === 0) return results

    return results.map((r) => {
      try {
        const domain = new URL(r.url).hostname.replace('www.', '')
        if (boostedDomains.includes(domain)) {
          return { ...r, score: Math.min(r.score + 0.15, 1.0) }
        }
      } catch {
        // Invalid URL — skip
      }
      return r
    })
  } catch (err) {
    logger.warn('Domain boosting failed (non-critical):', { error: toError(err) })
    return results
  }
}

/**
 * Normalized recency score in [0, 1]: 1.0 for today, exponentially decaying
 * to ~0.37 after 30 days and ~0.14 after 60 days. Undated results score 0.
 *
 * Consumed by the BOUNDED freshness blend (see freshnessBlendKey below), so
 * the newest data surfaces without ever letting a barely-relevant spam page
 * leapfrog a strong match.
 */
export function recencyScore(publishedDate: string | undefined, now: number = Date.now()): number {
  if (!publishedDate) return 0
  const t = new Date(publishedDate).getTime()
  if (isNaN(t)) return 0
  const ageMs = now - t
  if (ageMs <= 0) return 1 // future-dated / just published — treat as fresh
  return Math.exp(-ageMs / (30 * 24 * 60 * 60 * 1000))
}

/**
 * Bounded freshness blend: score + w · recency · (1 − score).
 *
 * WHY bounded instead of a linear blend (e.g. 0.7·score + 0.3·recency):
 * a linear blend lets a fresh-but-weak result OUTRANK a dated-but-perfect
 * one — a 0.73-scored item published today scores 0.7·0.73+0.3·1.0 = 0.811,
 * beating an undated 1.0 gold-standard result (0.7·1.0 = 0.70). NDCG@10 eval
 * (500-query median-of-3) showed this was the single largest ranking loss:
 * 36+ queries buried their gold domain exactly this way (en-stock-01~25,
 * en-news-02/08, ca-01/02, ts-02...).
 *
 * The (1 − score) factor caps the freshness boost: a result with score s can
 * reach at most s + w·(1−s) < 1, so a perfect match (score ≈ 1) can never be
 * overtaken by a fresher lower-scored page — freshness only breaks TIES and
 * near-ties. Simulation on the 500-query baseline: NDCG 0.5276 → 0.5407
 * (financial +0.092, news +0.024, english +0.021; chinese −0.007, general −0.001).
 */
export function freshnessBlendKey(score: number, recency: number, weight: number): number {
  return score + weight * recency * (1 - score)
}

/**
 * Freshness weights for the bounded blend, tuned via NDCG simulation on the
 * 500-query median-of-3 baseline (S11): news w=0.30, default w=0.15 gave
 * overall +0.013 (financial +0.092, news +0.024) with only minor losses on
 * zh/general. Shared between code and tests so re-tuning is single-source.
 */
export const NEWS_FRESHNESS_WEIGHT = 0.3
/** @see NEWS_FRESHNESS_WEIGHT — lighter tiebreak for non-news default sort. */
export const DEFAULT_FRESHNESS_WEIGHT = 0.15

/**
 * Sort results by the requested strategy.
 *
 *   - explicit 'date': recency-dominant contract preserved as-is (the user
 *     explicitly asked for newest-first; the legacy 0.85/0.15 formula stays).
 *   - news queries (implicit): bounded freshness blend with a moderate weight
 *     (0.30) — recency still surfaces fresh items within near-ties, but a
 *     perfect-score authoritative article is never buried by a fresher
 *     keyword-saturated snippet (en-news-02: bloomberg 1.0 was pushed to pos 3
 *     by the old 0.85·recency-dominant blend).
 *   - explicit 'relevance': pure relevance (descending).
 *   - default (unspecified): bounded freshness blend with a light weight
 *     (0.15) — relevance is primary, recency breaks ties and near-ties.
 */
export function sortResults(results: SearchResult[], ctx: SearchContext): SearchResult[] {
  const sort_by = ctx.request.sort_by

  if (sort_by === 'date') {
    // Explicit newest-first contract — keep the legacy recency-dominant blend.
    // Authority is added at full weight (not the 15%-diluted share) so gold
    // news domains (reuters/bbc/bloomberg) keep their full +0.10~0.13 lift.
    return [...results].sort((a, b) => {
      const recencyA = recencyScore(a.published_date)
      const recencyB = recencyScore(b.published_date)
      const authorityA = getDomainAuthorityBonus(a.url, ctx, a.domain)
      const authorityB = getDomainAuthorityBonus(b.url, ctx, b.domain)
      const keyA = 0.85 * recencyA + 0.15 * (a.score - authorityA) + authorityA
      const keyB = 0.85 * recencyB + 0.15 * (b.score - authorityB) + authorityB
      return keyB - keyA
    })
  }

  if (sort_by === 'relevance') {
    // Pure relevance sort (descending)
    return [...results].sort((a, b) => b.score - a.score)
  }

  // News (implicit) and default (unspecified): bounded freshness blend.
  // News gets a heavier weight so fresh items win near-ties more decisively;
  // the default uses a light tiebreak weight to keep stable/reference content
  // ranking while surfacing the newest data.
  //
  // NOTE (S11 tradeoff): news moved off the old recency-dominant (0.85)
  // blend onto bounded w=0.30. Fresh-but-weak items now lose to undated
  // strong ones — that is the NDCG intent (gold domains usually lack dates),
  // but pure breaking-news queries with genuinely time-sensitive results may
  // feel under-weighted. Re-tune NEWS_FRESHNESS_WEIGHT if breaking-news UX
  // regressions show up in user feedback while NDCG holds.
  const freshnessWeight = ctx.isNews ? NEWS_FRESHNESS_WEIGHT : DEFAULT_FRESHNESS_WEIGHT
  return [...results].sort((a, b) => {
    const keyA = freshnessBlendKey(a.score, recencyScore(a.published_date), freshnessWeight)
    const keyB = freshnessBlendKey(b.score, recencyScore(b.published_date), freshnessWeight)
    return keyB - keyA
  })
}

/**
 * Adaptive minimum quality threshold.
 *
 * Removes irrelevant results (score near zero) while preserving ABUNDANCE:
 * if high-quality results are scarce, progressively relaxes the threshold.
 *
 * Tiers: 0.10 (standard) → 0.05 (relaxed) → 0.01 (last resort).
 * Relaxation is gated by `min(10, max_results)` so we don't pull in spam
 * just to chase a high max_results.
 */
export function applyQualityThreshold(results: SearchResult[], ctx: SearchContext): SearchResult[] {
  const minScoreHigh = 0.1
  const minScoreLow = 0.01
  const abundanceFloor = Math.min(10, ctx.maxResults)

  let filtered = results.filter((r) => r.score >= minScoreHigh)
  if (filtered.length < abundanceFloor) {
    const tier2 = results.filter((r) => r.score >= 0.05)
    if (tier2.length > filtered.length) filtered = tier2
    if (filtered.length < abundanceFloor) {
      const tier3 = results.filter((r) => r.score >= minScoreLow)
      if (tier3.length > filtered.length) filtered = tier3
    }
  }
  // Only apply the filter if it leaves a reasonable number of results
  if (filtered.length >= Math.min(3, ctx.maxResults)) {
    return filtered
  }
  return results
}

/**
 * Full ranking pipeline: filter → recompute → boost → sort → threshold.
 * Convenience function that runs all steps in order.
 */
export async function applyRankingPipeline(results: SearchResult[], ctx: SearchContext): Promise<SearchResult[]> {
  let r = applyFilters(results, ctx)
  r = recomputeScores(r, ctx)
  r = await applyDomainBoosting(r, ctx)
  // A/B 테스트: control variant는 LTR 없이 기존 순위를 유지 (C.2)
  if (ctx.experimentVariant !== 'control') {
    r = await applyLtrRanking(r, ctx)
  }
  r = sortResults(r, ctx)
  r = applyQualityThreshold(r, ctx)
  return r
}

/**
 * S20: cap results from ONE source so a single backend can't saturate the
 * pool. HN Algolia over-inflow was observed in eval (en-general-03: 5/5 HN
 * in top5, adv-03: 4/10 HN) — capping to max keeps pool diversity while the
 * backend relevance filter already ensures the survivors are on-topic.
 * Zero NDCG regression across the 9 affected eval queries (sim 2026-08-07).
 * Matches by URL host OR the backend-set domain field (suffix match, same
 * semantics as matchInMap). EXPORTED FOR TESTS.
 */
export function capSourceResults(results: SearchResult[], sourceDomain: string, max: number): SearchResult[] {
  if (!sourceDomain || max <= 0) return results
  let seen = 0
  const out: SearchResult[] = []
  for (const r of results) {
    let host = ''
    try {
      host = new URL(r.url).hostname.replace(/^www\./, '').toLowerCase()
    } catch {
      // invalid URL — fall through to the domain field
    }
    const domainField = (r.domain ?? '').toLowerCase()
    const isSource = host.endsWith(sourceDomain) || domainField.endsWith(sourceDomain)
    if (isSource) {
      if (seen >= max) continue
      seen += 1
    }
    out.push(r)
  }
  return out
}
