# 13. 상용 초월(AGGRESSIVE) 개선 개발 계획 — 정확도·속도·방대함 3축

> 작성: 2026-08-09 · 상태: 진행 중 (Wave 1 구현 시작)
> 직전 완성도 평가(08-09): 베타서비스 수준 — NDCG@10 0.284(신규 규칙), p50 5.9s(429 창),
> 유닛 1,505건, 4대 게이트 그린. **측정·게이트 인프라는 상용 수준 초과, 검색 정확도·속도가 문턱 미달.**

---

## 0. 현재 실측 베이스라인 (모든 개선의 비교 기준)

| 지표 | 실측값 | 비고 |
|---|---|---|
| NDCG@10 | **0.2839** | S49/S50 신규 규칙(label-suffix + DCG 캡) 기준 |
| MRR | 0.5179 | |
| P@10 | 0.3140 | |
| passRate | 82.4% (412/500) | run-1 wikipedia 429 창 저하, run-2는 95.2% |
| p50 / p95 지연 | 5.9s / 10.0s | 429 창 기준 — 평상시 p50 ~1.7s 추정 |
| 캐시 hitRate | 1.0 (500/500, skipped 0) | S80 인터리브 warm pass |
| 백엔드 | 13종 + 미러 3-tier | bing/naver/wikipedia/github/hn/reddit/arxiv/ddg/qiita/juejin/stack-exchange/yahoo-finance/naver-news + dbpedia/wikidata/dbpedia-lang |
| gold 쿼리 | 507 | 4개 언어, 10+ 태그 |

**대조 (상용 벤치마크)**: 검색 상용 서비스의 NDCG@10은 0.5~0.7 (TREK-150 기준 0.48~0.58,
상위 상용 0.65+). 우리 목표는 이 기준을 **아득히 초과**하는 것: 신규 규칙 하 NDCG@10 **0.45+**,
MRR **0.6+**, p50 **<1.5s**, passRate **>95%**.

---

## 1. 3축 목표와 레버 맵

### 축 A — 정확도 (NDCG@10 0.284 → 0.45+)

| 레버 | 현재 상태 | 개선 방향 | 예상 효과 | 검증 |
|---|---|---|---|---|
| A1 **Entity-aware 스코어링** | entityHints 추출하지만 스코어링 미사용 | 엔터티(org/tech/product)가 title에 있으면 부스트 | 중~대 | 유닛+풀 시뮬레이션 |
| A2 **BM25 제목 필드 가중치** | title+content+title 문자열 연결 | 필드 분리 scoring (titleWeight) | 중 | 유닛+풀 시뮬레이션 |
| A3 쿼리 확장 | 없음 (raw query만) | 동의어/번역/축약어 확장 | 중 | 유닛+평가 |
| A4 재랭킹 기본화 | advanced depth + config.ai 게이트 | basic에서도 reranker 활성화 | 대 | 평가 |
| A5 freshness/authority 튜닝 | S11~S23 레버 반영됨 | 태그별 weight 재튜닝 | 소 | 풀 시뮬레이션 |

### 축 B — 속도 (p50 5.9s → <1.5s, 429 창 제외)

| 레버 | 현재 상태 | 개선 방향 | 예상 효과 | 검증 |
|---|---|---|---|---|
| B1 429 창 완화 | 미러 3-tier + rate guard | wikipedia 페이싱/병렬 미러 | 대 (지연 안정화) | eval 로그 |
| B2 스트리밍/부분 응답 | 전체 완료 후 응답 | 첫 결과 도착 즉시 전송 | UX 체감 대 | 로드테스트 |
| B3 캐시 계층 최적화 | memory 120s/30s + semantic | Cache API/KV 상향, TTL 튜닝 | 중 | 캐시 메트릭 |
| B4 팬아웃 ceiling 튜닝 | wikipedia 4500ms 등 | 태그별 예산 재조정 | 소 | eval 로그 |

### 축 C — 방대함 (백엔드/언어/인덱스)

| 레버 | 현재 상태 | 개선 방향 | 예상 효과 | 검증 |
|---|---|---|---|---|
| C1 백엔드 확장 | 13종 | 특허/정부/유튜브/금융 데이터 추가 | 중 | 라이브 프로브 |
| C2 언어 커버리지 | en/ko/zh/ja | 미러 다국어 (zh/ko 2차 티어) | 중 | eval 로그 |
| C3 자체 인덱스 | 크롤러-DO 초기 단계 | 시드 도메인 확장, 인덱싱 파이프라인 | 대 (장기) | hybrid 검색 |
| C4 뉴스 소스맵 확장 | NEWS_SOURCE_DOMAINS | 미해석 소스 지속 추가 | 소 | 파서 테스트 |

---

## 2. Wave 로드맵 (각 Wave = 독립 검증 단위)

| Wave | 범위 | 산출물 | 완료 기준 |
|---|---|---|---|
| **Wave 1** | A1 + A2 (랭킹 코어) | bm25 필드 가중 + entity 부스트 | 유닛 + **전체 풀 시뮬레이션 Δ 실측** |
| Wave 2 | A3 (쿼리 확장) | 동의어/축약어 사전 + 확장 파이프라인 | 유닛 + 평가 |
| Wave 3 | A4 + A5 (재랭킹/튜닝) | reranker 게이트 완화 + weight 재튜닝 | 풀 시뮬레이션 |
| Wave 4 | B1 + B4 (지연 안정화) | wikipedia 페이싱 + 팬아웃 예산 | eval 로그 비교 |
| Wave 5 | B2 + B3 (응답 경로) | 스트리밍 + 캐시 계층 | 로드테스트 |
| Wave 6 | C1~C4 (방대함) | 백엔드/언어/인덱스 확장 | 라이브 프로브 |

각 Wave 종료 후: 유닛 전체 + tsc/lint/format 그린 유지 → `eval:median:save`로 실측 확정
(약 60분, 별도 세션) → STRATEGIC_PLAN.md + docs/10 갱신.

---

## 3. Wave 1 상세 (구현 완료 — 2026-08-09)

### A1 — Entity-aware relevance 부스트: **검증 후 제외**
- 초안: 엔터티(org/tech/product)가 title에 있으면 +0.025 (cap +0.05) 부스트.
- **전체 풀 시뮬레이션 (507쿼리 × 저장 run)**: 순수 효과 Δ +0.001 (17쿼리만 영향) —
  BM25가 이미 title 매칭을 강하게 반영해 부스트가 중복. 복잡성 대비 이득 없음 → **채택 안 함**
  (최소주의 원칙). 시뮬레이션은 `--entity on/off/gated`로 이 사실을 재현 가능.

### A2 — BM25 제목 필드 가중치: **컨텍스트 게이트로 채택**
- `bm25Score`에 optional `titleWeight` 추가 (기본 2 = pre-Wave-1과 **정확히 동일 출력**, 회귀 0).
- **docLen은 title 1회 카운트 유지** — docLen에 가중치를 넣으면 스케일이 바뀌어 품질
  임계값 티어를 이동시키는 회귀 발생 (실측으로 발견, 수정). maxScore는 tf=1 가정 유지.
- **컨텍스트 게이트** (데이터 기반): 기술 = 2 (짧은 repo 제목이 포화 — weight 3에서 en-tech -0.10
  회귀), 그 외(뉴스/금융/사실/일반 등) = 3.
- `recomputeScores(_, _, titleWeightOverride?)` — 시뮬레이션/테스트용 baseline 비교 훅.

### 실측 결과 (전체 풀 시뮬레이션, baseline = pre-Wave-1 동등 설정과 비교)
| 설정 | 영향 쿼리 | affected-only Δ | 비고 |
|---|---|---|---|
| entity only | 17 | +0.0010 | 미미 → 제외 |
| titleWeight 3 전면 | 39 | +0.0078 | en-tech -0.10 회귀 |
| **게이트 (tech=2, else=3)** | **26** | **+0.0130** | **채택** |

게이트 구성 태그별 누적 Δ: **en-news +0.181, kr-fin +0.103, kr-tech +0.093** 개선 /
손실 소규모 (kr-news-09 -0.036, adv-08 -0.035 — 제목 완전 매칭이 비권위 도메인을
끌어올린 사례). **전체 NDCG 추정 Δ +0.0007** (26/507 쿼리만 영향 — 국소적이지만 명확히 양수).

### 검증 완료 (리뷰 반영 포함)
1. 단위 테스트: +5건 (게이트 계약: 일반=3 / 기술=2 / override / weight 효과 / 기본 동작 —
   기본 동작 테스트는 실제 blend 산식으로 강화) + 기존 topstarnews 기대값을 게이트 계약으로
   갱신. **96건 통과** (3개 랭킹 파일), 유닛 전체 **1,510건** (76파일).
2. 전체 풀 시뮬레이션 스크립트 `scripts/sim-wave1-accuracy.ts` — baseline(이전 동작 재현) 대비
   순수 레버 효과 실측. `--title-weight N|gated`. entity 축은 제거 (무동작 방지 — production이
   entityHints를 소비하지 않으므로 재현 불가, 수치는 위 기록으로 보존).
3. 게이트: tsc 0 / lint 0 / format 0 (리뷰 지적 반영 — 중복 import 제거, 미사용 getter 제거,
   네이밍 TITLE_WEIGHT_NON_TECHNICAL로 명확화).
4. 리뷰 지적 반영: ① sim entity 축 제거 (inert 방지) ② 기본 동작 테스트를 blend 검증으로 강화
   ③ hybridScore 삼항연산 단순화 ④ getBm25TitleWeight dead export 제거 (reset 계약 주석화)
   ⑤ 네이밍 명확화 ⑥ 0-affected NaN 가드. 한계 기록: 기술 콘텐츠지만 queryType이 다른 쿼리
   (adv-08, -0.035)는 게이트를 피해감 — net 양수라 수용.

**잔여**: 라이브 eval:median 재실행으로 실측 확정 (Wave 1은 풀 시뮬레이션 국소 개선이라
유닛·시뮬레이션으로 검증, 전면 NDCG 재측정은 별도 ~60분 세션에서).

---

## 3b. Wave 2 구현 완료 — Query Expansion (A3, 2026-08-09)

### 설계
- **`src/lib/understanding/query-expander.ts` 신규**: ① CJK→EN 교차언어 사전 (한/중/일 기술·금융
  용어 — '상태관리'→'state management', '入門'→'tutorial', '泛型'→'generics') ② 축약어 확장
  (aws→amazon web services, k8s→kubernetes 등). `setQueryExpansionEnabled` 훅 (기본 ON).
- **ranking.ts**: `expansionMatchBoost` (title 매칭 2x, cap 0.05 — bounded 신호, BM25 스케일 불변),
  `hybridScore` optional `expandedTerms`, `recomputeScores`에서 쿼리당 1회 확장 계산 후 전달.
- **동기**: CJK 기술 쿼리의 gold가 전부 영어 페이지(react.dev/github/typescriptlang.org)인데
  CJK bigram은 영어 콘텐츠와 매칭 불가 — 확장이 BM25가 아예 못 잡는 신호를 채움.

### 실측 (전체 풀 시뮬레이션)
| 설정 | 영향 쿼리 | affected-only Δ | 손실 |
|---|---|---|---|
| 확장 단독 (titleWeight 2) | 3 (전부 CJK 기술) | **+0.0321** | 0건 |
| Wave 1 게이트 + 확장 | 29 | **+0.0149** | 소규모 |

태그별: zh-tech +0.052, kr-tech +0.027, ja-tech +0.018 (kr-tech-05 AWS Lambda→amazon
web services, zh-tech-06, ja-tech-04). 확장이 정확히 타깃 쿼리에만 작동하고 다른 컨텍스트는
무영향 (사전 매칭 없으면 빈 배열).

### 리뷰 반영 (2026-08-09)
1. **플로어-이전-부스트 순서 버그 수정**: 순수 CJK 쿼리(라틴 토큰 없음)는 bm25≤0.02 ∧
   heuristic≤0.05에서 0.01로 조기 반환되어 확장 부스트가 발동 불가였음 — 플로어 체크를
   `expansion ≤ 0` 조건으로 이동 (양성 확장 매칭이면 플로어 통과).
2. **모호 축약어 키 제거**: cv/ml/pe/be/cd/os/db 등 다의어 키 30+개 제거 (word-boundary 토큰
   매칭이 일반 단어에 오발동 — '500 ml water'→machine learning 등). eval에서 발동 사례 0건이라
   이득 미검증 vs 오탐 비용 실재.
3. **단일 문자 CJK 키 제거**: '型'/'库' — '模型'/'数据库' 등 다른 단어에 `includes` 오발동.
4. `expandQuery`를 results.map 밖으로 호이스팅 (쿼리당 1회), `?? []`·stale 주석 정리.
5. 확장 부스트는 headroom 예약과 무충돌 (baseScore에 포함되어 권위 부스트 정상 동작 확인).

### 검증
유닛 +17건 (query-expander.test.ts — 사전 매칭/가드/부스트/통합/플로어) / 전체 **1,527건** (77파일)
/ tsc 0 / lint 0 / format 0.

**잔여**: 라이브 eval:median 재실행으로 실측 확정 (Wave 1·2 모두 풀 시뮬레이션 국소 개선 —
전면 NDCG 재측정은 별도 ~60분 세션에서). 축약어 사전은 기술 시그널 게이트와 함께 추가 검증 후
확장 가능.

---

## 3c. Wave 4 구현 완료 — B1 (wikipedia 429 페이싱 + 병렬 미러, 2026-08-09)

### 설계
- **`wikipediaSearch` 429 페이싱 가드** (`src/lib/specialized.ts`): S23 GitHub /search 가드 패턴을
  wikipedia에 적용 — `wikipediaRateLimitedUntil` 모듈 상태 + `reset/is/record` export.
  쿨다운은 **Retry-After 인지** (있으면 [1s, 120s] 클램프, 없으면 기본 30s).
  - 가드 트립 시 `wikipediaSearch`는 **캐시 체크 후 네트워크 체인(REST+Action) 전체 스킵** —
    창 안의 쿼리가 429 재시도 체인(~1.1s)을 소진하지 않고 즉시 빈 결과를 반환.
  - REST/Action 429에서 `recordWikipediaRateLimit()` — 디스커버리 쿼리(창을 최초 발견)만
    기존 300/600ms 재시도 체인을 수행하고, 이후 쿼리는 가드에 의해 즉시 스킵.
- **병렬 미러** (`src/lib/orchestrator.ts`): 기존 5b의 순차 미러 체인을
  `runWikipediaMirrorChain(query, language, env)`로 추출 (EN→dbpedia, non-EN→wikidata,
  ja 2차→dbpedia-lang — S35/S36/S38 배선 그대로).
  - **fanout 이전(4.5)** 가드가 트립돼 있으면 미러를 백그라운드로 시작 → 미러 fetch(~1.4s
    라이브)가 fanout과 **동시에** 진행 → 5b에서 이미 settled된 프라미스를 await (추가 지연 ~0).
  - wikipedia 정상 시 가드는 클린 → **미러 미시작** (S35 'wikipedia 성공 시 0 추가 지연'
    테스트 계약 보존). 가드 스테일 엣지(wikipedia가 미드플라이트 회복)는 좀비 프라미스가
    되지만 미러 함수는 자체 에러를 삼키므로 누수 없음 (희귀 + 문서화).
  - 5b 로그에 `parallel` 필드 추가 — S37 `parseMirrorEvents`는 `JSON.parse` 기반이라
    무호환 없음 (검증 완료).

### 실측 (저장 run-1..3, scripts/measure-mirror-latency.ts)
| 지표 | BEFORE (순차 미러, 측정) | AFTER (병렬+pacing, projected) |
|---|---|---|
| 미러 발동 쿼리 p50 | **3,289ms** | **822ms** |
| 미러 발동 쿼리 p95 | **5,292ms** | **1,092ms** |
| 전체 eval p50 | 1,817ms | 842ms |
| 전체 eval p95 | 4,395ms | 2,688ms |
| 동일 쿼리 페어 추가 지연 | n=183, **median 2,465ms / avg 2,706ms** | — |

- **미러 발동 392건/3run (25.8%)** — 순차 미러가 쿼리당 평균 2.7s를 추가했고, 병렬+pacing으로
  제거됨. 전체 eval p50이 **1.8s → 0.84s** (상용 목표 <1.5s 달성), p95 4.4s → 2.7s.
- **추정의 한계 (문서화)**: after는 동일 쿼리 wikiOK 시간(팬아웃 프록시) 기반 **하한 추정** —
  미러 fetch가 fanout 창(~0.8-1s)을 초과하는 쿼리는 실제 after가 프록시보다 약간 높을 수
  있음 (S35 라이브 미러 ~1.4s). 같은 쿼리 페어의 **측정된 Δ(2.5s median)가 순차 비용의
  직접 증거**. wikiOK run이 전무한 42쿼리는 전역 wikiOK p50 폴백 사용 (투명 보고).

### 검증
1. 유닛 +9건: specialized.test.ts 가드 5건 (스킵/캐시 우선/429 기록/Retry-After — 타임스탬프
   기반 [1s,120s] 클램프 검증) + measure-mirror-latency.test.ts 5건 (분류/before-after/폴백
   프록시/전체/빈 run). 기존 'does NOT cache empty results'는 run 간 가드 리셋 반영 갱신.
2. 통합 +1건 (orchestrator.test.ts): **가드 arm 시 wikipedia 검색 체인 미호출 + 병렬 미러가
   gold 회복** — 지식패널 summary 호출과 검색 체인 분리 단언. beforeEach에
   `resetWikipediaRateState` 추가 (모듈 가드 누수 방지). 기존 S35/S36/S38 미러 7건 무회귀.
3. 게이트: 유닛 **1,536건** (78파일) / 통합 22건 / tsc 0 / lint 0 / format 0.
4. 리뷰 반영: ① Retry-After 하한 클램프 추가 (주석 [1s,120s]와 코드 일치) ② 다른 통합
   테스트 파일 wikipedia 429 mock 전수 확인 (orchestrator.test.ts 단독 — 누수 없음)
   ③ S37 parseMirrorEvents `parallel` 필드 호환 확인 (JSON.parse — 무영향) ④ after 하한
   추정의 한계 문서화.

**잔여**: 라이브 `eval:median:save` 재실행으로 실제 p50/p95 회복 실측 확정 (별도 ~60분
세션 — Wave 관례), B4(팬아웃 예산 재조정)는 이번 범위에서 제외 (wikipedia 4500ms ceiling은
페이싱 가드와 직교 — 재시도 체인이 짧아져 사실상 여유분 확보).

### Wave 5 (B3): 캐시 계층 TTL 정렬 + 메모리 키 패리티 + eval 무결성 (2026-08-10)

- **데이터 기반 진단 (저장 500쿼리 × 3-run, Wave 4 실측)**: median-of-3 eval은 **단일
  프로세스**에서 3회 실행되므로 orchestrator 메모리 캐시(Tier 0)가 run 전부를 관통. 그런데
  메모리 TTL(120s/30s)이 run 간격(~20분: 1224s/1253s)보다 짧아 **교차-run 히트 0** —
  run-1/2/3의 p50이 863/842/852ms로 통계적으로 동일 (3-run이 전부 재팬아웃). 같은 응답이
  Cache API 티어에서 30분 살아있는데 메모리에서 2분만에 만료되는 불일치.
- **수정** (4개 파일 + 테스트):
  1. `src/lib/orchestrator.ts` — 메모리 캐시 TTL **120s/30s → 1800s/300s** (cache.ts
     DEFAULT_TTL/NEWS_TTL과 정렬): 반복 쿼리가 Cache API 유효 기간 전체 동안 메모리(~1ms)로
     서빙. ② `getMemoryCacheKey`에 **include_raw_content + location 추가** (cache.ts `irc=`/
     `loc=` 패리티) — TTL 상향으로 stale-stripped 응답 창이 15× 커지는 잠재 키 불일치 선제
     제거 (리뷰 반영).
  2. `src/lib/cache.ts` — KV promote TTL 하드코딩 1800 → `resolveTtl(env, 'general')`
     (KV는 general만 저장 — CACHE_TTL_GENERAL env 오버라이드와 정렬).
  3. `eval/index.ts` — **run 사이 `__clearMemoryCacheForTests()`** (static import): TTL이
     run 간격을 초과하므로 클리어 없으면 run-2/3이 run-1 캐시로 median-of-3 정합성 붕괴.
     S80 인터리브 warm pass는 runEval 내부라 무영향.
  4. `scripts/sim-wave5-cache.ts` — 저장 풀에서 쿼리별 절대 실행 시각 복원(보고서
     timestamp + 누적 responseTimeMs)해 (generalTtl, newsTtl) 시나리오별 교차-run 히트율·
     p50/p95 투영. pacing은 양쪽 run 동일 쿼리셋에서 상쇄 → gap 추정은 편향 없음 (보수성의
     실제 원인은 429-인플레 responseTimeMs — 리뷰 반영).
- **시뮬레이션 실측 (저장 풀)**: 구 TTL(120s/30s) **0/1000 히트** → p50 854ms 유지 (실측과
  일치). B3(1800s/300s) **708/1000 히트 (일반 쿼리 ~83%, 뉴스/금융 146개는 300s TTL로
  미스)** → pooled p50 854→**803ms**, p95 3.50→**2.81s**, avg 1.38s→**694ms**. 3600s/300s는
  동일 (모든 일반 쿼리가 이미 커버됨 — TTL 포화).
- **테스트**: sim-wave5-cache.test.ts +7건 (gap<간격→히트/gap>간격→미스/뉴스-미스-혼합/
  run-3이 run-1 히트/빈 입력/p95 장꼬리 미스 생존) + memory-cache-key.test.ts +4건
  (irc/loc 패리티 + cache.ts 키 동일 필드 + variant). 유닛 **1,547건** (80파일), tsc 0,
  lint 0, format 0. 리뷰 반영 5건 (키 패리티, static import, pacing 주석 정정, dead
  resultCount 제거, baseline 호출 단순화).
- **잔여**: 라이브 `eval:median:save` 재실행으로 run-2/3 p50 붕괴 실측 확정 (별도 ~60분
  세션 — Wave 관례), B2 스트리밍은 `/api/search/stream`(SSE, results-first)이 이미 존재 —
  로드테스트 검증만 남음, B4 팬아웃 예산 재조정.

---

## 4. 리스크와 원칙

- **외부 백엔드 의존**: Bing/Naver 마크업 변경은 parser 회귀 — canary로 감지 (기존).
- **429 창 편향**: eval은 429 창에서 실행되므로 Δ 해석은 run별 분해 필수 (S37/S75 관례).
- **스코어 캡 역학**: authority 부스트는 headroom 예약 방식 유지 (S14~S23 관례).
- **모든 변경은 측정 우선**: 풀 시뮬레이션으로 로컬 실측 후 라이브 eval로 확정.
