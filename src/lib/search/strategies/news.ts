/**
 * News Focus Strategy
 *
 * Bing News + Bing + HackerNews + Reddit. Dedicated news sources.
 * Extracted from orchestrator.ts lines 513-526.
 */

import type { SearchStrategy } from './types'
import type { BackendTask, SearchContext } from '../context'
import {
  buildBingNewsTask,
  buildBingTask,
  buildHackerNewsTask,
  buildRedditTask,
  buildNaverNewsTask,
  buildBingNewsRssTask,
  buildGoogleNewsRssTask,
} from '../backend-tasks'

export class NewsStrategy implements SearchStrategy {
  readonly focus = 'news' as const

  buildTasks(ctx: SearchContext): BackendTask[] {
    const tasks: BackendTask[] = [
      buildBingNewsTask(ctx),
      buildBingTask(ctx),
      buildHackerNewsTask(ctx, 8),
      buildRedditTask(ctx, 5),
    ]

    // Korean news queries need real Korean articles. Naver NEWS search
    // (where=m_news) is the key-less source that reliably returns
    // n.news.naver.com articles — the gold domains for kr-news eval queries.
    // Phase 6.10: the ko-KR RSS feeds run alongside it for gold domains naver
    // m_news misses (yna.co.kr/hankyung.com — Bing ko-KR returns real domains
    // directly, Google ko-KR resolves via the Korean source map).
    if (ctx.korean) {
      tasks.push(buildNaverNewsTask(ctx))
    }
    // English/news queries in any language run the RSS feeds: en-US forces
    // the EN market (en-news NDCG 0.000 root cause — generic bing returned
    // Korean/Asian outlets), ko-KR/zh-CN/ja-JP localize them (Phase 6.7/6.10).
    tasks.push(buildBingNewsRssTask(ctx))
    tasks.push(buildGoogleNewsRssTask(ctx))

    return tasks
  }
}
