# Working-Tree Diff Classification (S65, 2026-08-09, tsx 보완 S66)

S62 prettier 전면 정렬분과 S시리즈 로직 변경이 섞인 작업트리를 분류한 리뷰 가이드.
방법: 각 파일에서 `git show HEAD:<f> | prettier`(=HEAD의 순수 포맷 결과)와 작업트리를 비교해
PURE_FORMAT(포맷만) / PURE_LOGIC(로직만) / MIXED(포맷+로직)를 판별. MIXED의 격리 로직 diff는
`/tmp/fmt-classification/logic-diffs/<파일>.diff` (작업트리 vs prettier(HEAD) — 포맷 노이즈 제거).

## 요약

| 버킷 | 파일 수 | diff 줄 수 | 리뷰 방식 |
|---|---|---|---|
| JSON eval 아티팩트 (run-1..3/latest/baselines) | 5 | ~222,000 | **커밋 보류** — eval:median:save가 재생성하는 기계 산출물 + **S63 gold 좁힘으로 저장 ranking이 stale** (kr-tech-05 0.3618은 구 gold 기준). 다음 eval:median:save가 현재 gold로 재생성한 후 커밋 |
| PURE_FORMAT (순수 prettier) | 98 | 8,673 | **스킵 가능** — 공백/줄바꿈/trailing-comma만 (샘플 검증: canary.ts + tsx 8개). 기계 단위로 일괄 커밋 |
| MIXED (포맷+로직) | 122 | 9,471 (logic-bearing 격리) | **주 리뷰 대상** — 격리 로직 diff로 포맷 노이즈 없이 검토 (총량은 PURE_LOGIC 10개 포함) |
| PURE_LOGIC (로직만) | 10 | 183 | **소규모** — HEAD가 이미 clean이라 diff 그대로 로직. 10개 전부 검토 |
| docs/워크플로우/config | 11 | ~1,925 | 문서·설정 — 기존 S시리즈 문서 갱신분 |
| eval/gold-standards.json | 1 | 53 | S63 gold 좁힘 + _s63 메타 (이미 검토 완료) |

> diff 줄 수는 grep `^[+-]` (+++/--- 헤더 포함 — 파일당 ~2줄 과대) 기준. 248개 = 5+98+122+10+11+1
> (+ 삭제된 scripts/verify-zh-backends.mjs 1건, S57).
> 재생성: `bash scripts/classify-format-diff.sh` — 결정적 (동일 분류 보장).
>
> **분류 건전성 증명**: ① MIXED 격리 diff는 작업트리가 prettier-clean임을 `format:check=0`
> (S62/S64 + S66 tsx 포함)이 증명하므로 prettier 잔재가 **구조적으로 불가능** — diff는 전부 로직.
> ② PURE_FORMAT 98개 샘플 검증 — 토큰 수준 차이는 prettier trailing-comma/인용부호 정규화만
> (`PagerDutyEventInput,)`→`)`, `sourceUrl:''`→`sourceUrl:'',`), 로직 변경 0.
> ③ **S66 tsx 보완**: 원래 5개 tsx(Layout/index/chat/dashboard/status) 격리 diff에 prettier
> 잔재가 31~63% 섞여 있었음 (Layout 185줄 중 106줄) — tsx를 format 글롭에 추가하고 정렬해
> 잔재 0 확인 (Layout 185→11줄). 8개 tsx는 새로 diff에 등장 (PURE_FORMAT +8).

## 리뷰 단위 1 — MIXED 122개 (주 검토 대상, 격리 로직 diff 크기순)

| src/lib/specialized.ts |     1080 |
| tests/unit/specialized.test.ts |     1002 |
| tests/integration/orchestrator.test.ts |      728 |
| tests/integration/executeSearch.test.ts |      309 |
| tests/integration/parsers.test.ts |      275 |
| tests/unit/eval-metrics.test.ts |      271 |
| tests/unit/ranking-authority.test.ts |      267 |
| eval/metrics.ts |      256 |
| src/lib/community-search.ts |      206 |
| tests/unit/community-search.test.ts |      198 |
| src/lib/search/ranking.ts |      183 |
| src/lib/en-news-search.ts |      178 |
| eval/runner.ts |      178 |
| tests/unit/en-news-search.test.ts |      170 |
| src/lib/orchestrator.ts |      131 |
| eval/index.ts |      104 |
| src/lib/research.ts |      103 |
| src/lib/util.ts |       95 |
| tests/integration/api.test.ts |       91 |
| src/routes/upload.ts |       91 |
| src/routes/analytics-proxy.ts |       86 |
| src/lib/search/backend-tasks.ts |       85 |
| src/routes/library.ts |       83 |
| src/lib/stock-finance.ts |       81 |
| tests/unit/strategies.test.ts |       80 |
| src/routes/images.ts |       79 |
| scripts/generate-gold-standards.ts |       79 |
| src/lib/index/pipeline.ts |       78 |
| src/lib/search/strategies/all.ts |       77 |
| src/routes/keys.ts |       76 |
| src/lib/agentic/search-tools.ts |       75 |
| src/routes/openai.ts |       71 |
| src/routes/experiments.ts |       70 |
| src/lib/auth.ts |       66 |
| src/routes/ltr.ts |       65 |
| src/lib/index/scheduler.ts |       60 |
| tests/unit/util.test.ts |       59 |
| src/routes/chat.ts |       57 |
| src/routes/council.ts |       55 |
| src/routes/index.ts |       50 |
| src/lib/product-search.ts |       48 |
| tests/unit/stock-finance.test.ts |       47 |
| src/lib/index/chunker.ts |       47 |
| src/routes/blacklist.ts |       45 |
| src/lib/crawler-do.ts |       43 |
| src/lib/answer.ts |       43 |
| src/routes/pages.ts |       42 |
| src/lib/retrieval/hybrid-search.ts |       41 |
| src/lib/knowledge-panel.ts |       41 |
| src/lib/bing-search.ts |       41 |
| eval/e2e-pro-pipeline.ts |       41 |
| src/lib/agentic/index.ts |       39 |
| src/routes/profile.ts |       38 |
| src/pages/dashboard.tsx |       38 |
| eval/reporter.ts |       36 |
| src/routes/search.ts |       35 |
| src/lib/logger.ts |       35 |
| src/lib/sentry.ts |       34 |
| src/lib/security-middleware.ts |       33 |
| eval/index-self.ts |       33 |
| tests/unit/routes.test.ts |       32 |
| tests/unit/snapshots.test.ts |       30 |
| src/lib/cache.ts |       29 |
| src/lib/i18n.ts |       27 |
| src/lib/html-rewriter.ts |       27 |
| src/lib/agentic/planner.ts |       27 |
| src/routes/news.ts |       26 |
| src/routes/crawl.ts |       26 |
| src/lib/experiments/ab-test.ts |       26 |
| src/routes/queue.ts |       25 |
| tests/unit/blacklist-queue.test.ts |       24 |
| src/lib/thread-do.ts |       24 |
| src/lib/jina-search.ts |       24 |
| src/lib/agentic/synthesizer.ts |       24 |
| src/lib/search/auto-index.ts |       23 |
| src/routes/monitor.ts |       21 |
| src/lib/pages-do.ts |       21 |
| src/lib/understanding/classifier.ts |       20 |
| src/lib/retrieval/bm25.ts |       20 |
| src/lib/naver-news-search.ts |       20 |
| src/lib/metrics.ts |       20 |
| src/lib/brave-search.ts |       20 |
| eval/llm-judge.ts |       20 |
| src/lib/rich-snippets.ts |       19 |
| src/lib/llm-router.ts |       16 |
| src/lib/agentic/classifier.ts |       16 |
| scripts/verify-kr-finance.ts |       16 |
| src/lib/rate-limiter-do.ts |       15 |
| src/lib/yahoo-finance-search.ts |       14 |
| src/lib/security-headers.ts |       14 |
| src/lib/ltr/click-logger.ts |       14 |
| src/lib/api-key-do.ts |       14 |
| src/routes/usage.ts |       13 |
| src/lib/user-profile-do.ts |       13 |
| src/lib/space-do.ts |       12 |
| src/lib/library-do.ts |       12 |
| eval/median.ts |       12 |
| tests/unit/subrequest-tracker.test.ts |       11 |
| tests/unit/ranking-bm25.test.ts |       11 |
| tests/unit/queue-consumer.test.ts |       11 |
| tests/unit/orchestrator.test.ts |       11 |
| tests/unit/llm-router.test.ts |       11 |
| tests/unit/api-key-do.test.ts |       11 |
| tests/unit/ab-test.test.ts |       11 |
| src/routes/video.ts |       11 |
| src/routes/research.ts |       11 |
| src/routes/extract.ts |       11 |
| src/pages/chat.tsx |       11 |
| src/lib/search/fallback.ts |       11 |
| src/lib/rate-limiter.ts |       11 |
| src/lib/index/types.ts |       11 |
| src/lib/google-scholar.ts |       11 |
| src/lib/duckduckgo.ts |       11 |
| src/lib/adaptive-scraper.ts |       11 |
| src/index.tsx |       11 |
| src/components/Layout.tsx |       11 |
| scripts/seed-wikipedia.ts |       11 |
| tests/unit/free-image-search.test.ts |       10 |
| tests/integration/agentic-pipeline.test.ts |       10 |
| src/routes/suggest.ts |       10 |
| src/pages/status.tsx |       10 |
| src/lib/canary/canary-orchestrator.ts |       10 |

> 전체 122개 목록: /tmp/fmt-classification/MIXED.txt. 격리 diff: /tmp/fmt-classification/logic-diffs/

## 리뷰 단위 2 — PURE_LOGIC 10개

- eval/baseline-self.ts
- eval/baseline.ts
- eval/types.ts
- scripts/seed-index.ts
- src/lib/backend-interface.ts
- src/lib/sitemap.ts
- src/pages/page-view.ts
- tests/unit/date-parsing.test.ts
- tests/unit/naver-search.test.ts
- tests/unit/youtube-details.test.ts

## 리뷰 단위 3 — PURE_FORMAT 98개 (스킵 단위)

전체: /tmp/fmt-classification/PURE_FORMAT.txt
샘플: src/routes/canary.ts (c.json() 축약) + S66 추가 8개 tsx (AnswerCard/ProgressBar/ResultCard/SearchBar/SourceCard/StatsBar/spaces/usage) — 공백/줄바꿈/trailing-comma만
