/**
 * Default "All" Focus Strategy
 *
 * Topic-based dynamic routing — the most complex strategy. Selects backends
 * based on query characteristics (Korean, Chinese, finance, news, technical)
 * and available sources. This is the default when no explicit focus is set.
 *
 * Extracted from orchestrator.ts lines 527-691.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import { isChineseQuery, cleanChineseQuery } from '../../orchestrator'
import {
  isCommunityAdviceIntent,
  isGithubIssuesIntent,
  isProgrammingIntent,
  isZhTravelCommunityIntent,
} from '../../specialized'
import {
  buildBingTask,
  buildBingNewsTask,
  buildBingFinanceTask,
  buildWikipediaTask,
  buildGithubTask,
  buildGithubIssuesTask,
  buildHackerNewsTask,
  buildRedditTask,
  buildArxivTask,
  buildOpenAlexTask,
  buildSearXNGTask,
  buildDuckDuckGoTask,
  buildNaverTask,
  buildNaverNewsTask,
  buildBingNewsRssTask,
  buildGoogleNewsRssTask,
  buildNewsOutletTask,
  buildZhTravelCommunityTask,
  buildKoreanStockTask,
  buildYahooFinanceTask,
  buildBraveTask,
  buildStackExchangeTask,
  buildQiitaTask,
  buildJuejinTask,
  buildCsdnTask,
} from '../backend-tasks'
import { bingSearch } from '../../bing-search'
import { duckDuckGoSearch } from '../../duckduckgo'
import { backendTimeoutMs } from '../fanout'

export class AllStrategy implements SearchStrategy {
  readonly focus = 'all' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    const tasks: BackendTask[] = []
    const searxngConfigured = !!ctx.env?.SEARXNG_URL

    // 0. Brave Search API (PRIMARY for non-Korean, official API, ToS-safe)
    const braveTask = buildBraveTask(ctx)
    if (braveTask) tasks.push(braveTask)

    // 0b. Naver search (PRIMARY for Korean queries)
    if (ctx.korean) {
      tasks.push(buildNaverTask(ctx))
    }

    // 1. Stock Finance (Korean stocks) — Naver Finance API
    if (ctx.isFinance && ctx.korean) {
      tasks.push(buildKoreanStockTask(ctx, 5))
    }

    // 1b. Bing / finance / news routing cascade
    if (ctx.isFinance && !ctx.korean) {
      tasks.push(buildBingFinanceTask(ctx))
      tasks.push(buildYahooFinanceTask(ctx, 5))
      // Finance news RSS — en-stock-08 root cause: bing-finance (query suffix)
      // + yahoo-finance (1 match) totalled only 3 results and the adaptive
      // threshold opened to Tier 3, letting google.co.kr/index.html through.
      tasks.push(buildGoogleNewsRssTask(ctx, 9))
    } else if (ctx.isFinance && ctx.korean) {
      // Global stock data for Korean companies via Yahoo Finance (secondary)
      tasks.push(buildYahooFinanceTask(ctx, 5))
      // General web fallback — the korean finance cascade previously had NO
      // bing/DDG path (korean excludes DDG entirely, and bing only ran in the
      // non-korean finance branch and the general branch). When naver 429s,
      // the only survivors were the naver-finance composite pages (2 filler
      // results) — the kr-stock-12~15 / kr-fin-08 / kr-special-03·04 eval
      // failures (2026-08-05, median-of-3 baseline). Bing results pass the
      // same korean quality thresholds, so they add abundance without noise.
      tasks.push(buildBingTask(ctx))
    } else if (ctx.isNews) {
      tasks.push(buildBingNewsTask(ctx))
      tasks.push(buildBingTask(ctx))
      // Korean news queries: Naver NEWS backend guarantees real n.news.naver.com
      // articles (the general naver backend surfaces blogs/cafes instead — the
      // kr-news-02/04 NDCG 0.000 root cause).
      if (ctx.korean) tasks.push(buildNaverNewsTask(ctx))
      // News RSS feeds run for ALL languages: en-US forces the EN market
      // (en-news NDCG 0.000 root cause), ko-KR/zh-CN/ja-JP localize them
      // (Phase 6.7/6.10). For Korean, the ko feeds add gold domains naver
      // m_news doesn't surface (yna.co.kr/chosun.com/hankyung.com — verified
      // live 2026-08-05: Bing ko-KR returns real domains directly, Google
      // ko-KR resolves via the Korean source map).
      tasks.push(buildBingNewsRssTask(ctx))
      tasks.push(buildGoogleNewsRssTask(ctx))
      // S95 (P1 lever E): curated-outlet site: augmentation — the generic
      // Google News feed alone leaves the gold outlet domain absent from
      // ~93 coverage-gap queries (P1 diagnosis: NDCG=0 is 100% coverage, not
      // ranking). `site:<outlet> <query>` forces a curated gold outlet into
      // the pool; ONE outlet per query keeps the shared feed/rate budget
      // finite (sim-news-outlet.ts: rank-2 insertion averages Δ+0.18/query).
      tasks.push(buildNewsOutletTask(ctx))
    } else {
      tasks.push(buildBingTask(ctx))

      // Chinese query cleaning — second Bing call with cleaned query
      if (ctx.chinese) {
        const cleanedQuery = cleanChineseQuery(ctx.query)
        if (cleanedQuery !== ctx.query && cleanedQuery.length > 0) {
          tasks.push({
            name: 'bing-cleaned',
            run: () =>
              bingSearch(cleanedQuery, {
                maxResults: ctx.overFetch,
                timeRange: ctx.bingTimeRange,
                region: ctx.bingRegion,
                env: ctx.env,
              }),
          })
        }

        // S26: CSDN for zh GENERAL queries — real Chinese community articles
        // for exactly the queries bing mkt=zh-CN from a US IP contaminates
        // with cross-language junk (zh-general-12 考研复习计划: 4/10 results
        // were EU-climate English news — consilium.europa.eu/gov.ie/linkedin).
        // Additive keyless backend; the cross-language penalty + quality
        // threshold sort it against bing in ranking. maxResults 3 (vs 5 for
        // zh-tech): CSDN is SEO-content-farm-prone on non-tech queries, so a
        // smaller cap keeps the 10-slot pool from being 5/10 CSDN (review
        // 2026-08-07).
        tasks.push(buildCsdnTask(ctx, 3))

        // S104: zh 여행·커뮤니티 gold site:-라우팅 레버 (2026-08-14).
        // zh-travel-01~05 + zh-general-06~15의 gold(ctrip/mafengwo/dianping/
        // xiaohongshu/trip/qunar/zhihu)는 bing이 회수하지 못해 run-3에서 7/15
        // NDCG 0.000. 진단(scripts/probe-bing-site.ts 실측): bing은 site:
        // 연산자를 무시하므로, site:를 인정하는 엔진(DDG / SearXNG 설정 시)으로
        // ONE gold 도메인을 결정적으로 라우팅한다 (S95/P24 부가형 패턴).
        if (isZhTravelCommunityIntent(ctx.query)) {
          tasks.push(buildZhTravelCommunityTask(ctx))
        }
      }
    }

    // 2. Wikipedia
    if (ctx.sources.useWikipedia) {
      const wikiMax = isChineseQuery(ctx.query) ? 10 : 5
      const wikiTimeout = isChineseQuery(ctx.query) ? 12000 : 8000
      tasks.push(buildWikipediaTask(ctx, wikiMax, wikiTimeout))
    }

    // 3. GitHub (technical)
    if (ctx.sources.useGitHub) {
      // Note: Phase 6.7 initially capped technical github to 5 to let docs
      // domains through (lt-01), but that REGRESSED the github-gold queries
      // (en-tech-11 1.855→1.324, cmp-05 1.063→0.652 — github.com IS their gold).
      // The TECH_DOCS_AUTHORITY ranking bonus alone lifts docs above star-
      // saturated repos when the docs reach the pool, so keep 8 and let
      // ranking sort it out.
      tasks.push(buildGithubTask(ctx, 8))

      // S19: GitHub Issues for problem/learning-intent queries. github.com is
      // the #1 technical gold domain (127/158 eval queries) and repos alone
      // missed 46/127 — issues surface real github.com problem-solving
      // threads ("how to fix / why error / A vs B"). Gate: technical + EN/KR
      // (zh/ja technical gold is community sites — zhihu/juejin/qiita/zenn —
      // same gate rule as Stack Exchange below, so issues don't crowd them
      // out of the 10-slot pool) + problem-intent regex.
      if (ctx.queryType === 'technical' && !ctx.chinese && !ctx.japanese && isGithubIssuesIntent(ctx.query)) {
        tasks.push(buildGithubIssuesTask(ctx, 5))
      }

      // Phase 3a (lever 3): official-doc routing for ENGLISH technical queries
      // only. bing ignores site: operators entirely and DDG site: trips the 202
      // anti-bot challenge under burst, so the official Stack Exchange API is
      // the only ToS-safe way to surface the stackoverflow.com gold domains
      // (en-tech/lt/adv eval, TECH_DOCS_AUTHORITY). Quota-guarded (300/day/IP).
      //
      // Gate is queryType === 'technical' (NOT useGitHub — that also fires for
      // academic, whose gold is arxiv/github) AND English-only: zh/ja technical
      // gold domains are community sites (zhihu/juejin/qiita/zenn), and English
      // Stack Overflow questions would crowd them out of the 10-slot pool.
      // S16 (lever 3 remainder): zh/ja tech community gold routing. bing
      // zh/ja tech queries return all-wikipedia pools (zh-tech-08/09/13 NDCG
      // 0.000) — no backend surfaces the zhihu.com/juejin.cn (zh) or
      // qiita.com (ja) gold domains. zhihu.com search is 403/400 anti-bot;
      // the two keyless official APIs that work are Juejin search (zh) and
      // Qiita v2 items (ja) — verified live 2026-08-06 (qiita 200/53KB,
      // juejin /search_api/v1/search 200/data[..]). zenn.dev/zhihu/csdn have
      // no usable keyless API and stay on the bing path. Same gate rule as
      // Stack Exchange: technical queries only, language-specific target.
      if (ctx.queryType === 'technical' && ctx.japanese) {
        tasks.push(buildQiitaTask(ctx, 5))
      }
      if (ctx.queryType === 'technical' && ctx.chinese) {
        tasks.push(buildJuejinTask(ctx, 5))
        // S26: CSDN complements Juejin with the csdn.net gold (10 zh gold
        // queries — zh-tech-03/04 etc. list csdn.net alongside juejin.cn).
        // Juejin is dev/tech focused; CSDN adds blog tutorials + community Q&A.
        tasks.push(buildCsdnTask(ctx, 5))
      }

      // S100 (S98 ①): English Stack Exchange for BOTH technical and academic
      // routing. Academic used to skip it (github-issues stays technical-only),
      // but stackoverflow.com is gold in academic-classified queries (en-tech-40
      // 'machine learning model deployment' pre-S99) and community Q&A adds
      // real-user value for hybrid usage-intent queries. English-only gate —
      // zh/ja/ko academic gold is community sites (zhihu/juejin/qiita/zenn),
      // same rule as the technical branch.
      if (
        (ctx.queryType === 'technical' || ctx.queryType === 'academic') &&
        !ctx.korean &&
        !ctx.chinese &&
        !ctx.japanese
      ) {
        tasks.push(buildStackExchangeTask(ctx, 8))

        // MDN official-doc routing. MDN's /api/v1/search is disallowed by
        // robots.txt (Disallow: /api/) so it is deliberately NOT used. DDG
        // site:developer.mozilla.org works (first-batch verified: 10/10 MDN
        // hits) but the IP anti-bot 202-challenge can kick in under burst — the
        // task is additive, so a rate-limited DDG returns [] and the pool falls
        // back to other backends. Restricted to doc/reference-style queries to
        // limit shared-DDG budget pressure (the main duckduckgo backend uses
        // the same endpoint/IP).
        if (
          /\b(docs?|documentation|reference|guide|tutorial|example|examples|api|how\s+to|explain(ed)?|what\s+is)\b/i.test(
            ctx.query,
          )
        ) {
          tasks.push({
            name: 'ddg-site-mdn',
            run: () =>
              duckDuckGoSearch(`site:developer.mozilla.org ${ctx.query}`, {
                maxResults: 5,
                timeoutMs: 6000,
                env: ctx.env,
              }),
          })
        }
      }
    }

    // 4. HackerNews
    if (ctx.sources.useHackerNews) {
      tasks.push(buildHackerNewsTask(ctx, 8))
    }

    // 5. Reddit
    if (ctx.sources.useReddit) {
      tasks.push(buildRedditTask(ctx, 5))
    }

    // 5a. DDG site:reddit.com community augmentation (P24, 2026-08-14).
    // reddit.com is gold in 15/16 English general queries but the reddit
    // backend's .json endpoint is 403-blocked from datacenter IPs and its .rss
    // fallback rate-limits at ~1/15s (production-only). DDG honors
    // site:reddit.com (10/10 live — real reddit.com post URLs) where bing
    // ignores site: operators entirely. Mirrors the S95 news-outlet pattern:
    // ONE site: call, small maxResults, additive — irrelevant threads are
    // sorted out by ranking/quality thresholds. Gated by an INTENT gate, not
    // queryType: detectQueryType scatters the reddit-gold how-to queries
    // across general/technical/financial/factual ('how to improve sleep
    // quality' → technical, 'how to invest for beginners' → financial), so a
    // general-only gate misses most of the set (probe 2026-08-14). English
    // only (the reddit-gold set is English) and !searxngConfigured (DDG is
    // the keyless fallback only when SearXNG is absent — same rule as the
    // main duckduckgo task below).
    if (
      isCommunityAdviceIntent(ctx.query) &&
      !ctx.korean &&
      !ctx.chinese &&
      !ctx.japanese &&
      !searxngConfigured
    ) {
      tasks.push({
        name: 'ddg-site-reddit',
        run: () =>
          duckDuckGoSearch(`site:reddit.com ${ctx.query}`, {
            maxResults: 5,
            timeoutMs: backendTimeoutMs('ddg-site-reddit', 6000),
            env: ctx.env,
          }),
      })
    }

    // 5a2. Stack Exchange for programming-intent queries (P24, 2026-08-14).
    // stackoverflow.com is gold in non-technical-classified queries too
    // (adv-11 'what language should i learn first' → factual, gold
    // reddit.com|stackoverflow.com) but the SE gate above is
    // technical/academic-only, so it never fired there. The intent gate
    // replaces the old queryType==='general' guard (which missed adv-11
    // entirely). isProgrammingIntent excludes human-language contexts
    // (en-general-04 duolingo). English-only, same language rule as the
    // technical/academic gate.
    if (
      !ctx.korean &&
      !ctx.chinese &&
      !ctx.japanese &&
      isProgrammingIntent(ctx.query)
    ) {
      tasks.push(buildStackExchangeTask(ctx, 8))
    }

    // 5b. arXiv
    if (ctx.sources.useArxiv) {
      tasks.push(buildArxivTask(ctx, 8))
    }

    // 5c. OpenAlex (academic — keyless works API, replaces the captcha-dead
    // Google Scholar scraper; S96). See backend-tasks.ts / openalex.ts.
    if (ctx.sources.useOpenAlex) {
      tasks.push(buildOpenAlexTask(ctx, 8))
    }

    // 5d. SearXNG — PRIMARY general backend when configured
    if (searxngConfigured && !ctx.isNews && !ctx.isFinance) {
      tasks.push(buildSearXNGTask(ctx))
    }

    // 6. DuckDuckGo (fallback: only when SearXNG is NOT configured)
    //
    // chinese is NOT excluded: zh-general-04 (西安旅游攻略) failed eval with
    // only 4 results because the chinese general path was bing+wikipedia only
    // — no DDG breadth. DDG's zh results pass through the same cross-language
    // penalty + quality threshold, so they add abundance without polluting
    // (and when bing mkt=zh-CN is unavailable, DDG is the only non-wiki
    // source left for chinese general queries).
    if (!searxngConfigured && !ctx.korean && !ctx.isNews) {
      tasks.push(buildDuckDuckGoTask(ctx))
    }

    return tasks
  }
}
