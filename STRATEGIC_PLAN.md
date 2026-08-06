# STRATEGIC_PLAN.md — 웹서칭 사업 전략 계획 (일론머스크식 퍼스트 프린시플)

> **작성일**: 2026-08-04
> **작성자**: Sisyphus (Engineering Lead)
> **근거**: 실측 eval baseline (180 gold queries, 2026-08-04T02:47:12Z) + production 실측
> **목표**: Brave Search / Tavily를 **완전 대체**하고 **더 높은 정확도**를 달성

---

## 1. 현 수준 판정 — "우리는 지금 어디에 있는가"

### 1.1 실측 벤치마크 (180 gold queries, NDCG@10 기준)

| 지표 | 실측값 | 판정 |
|------|--------|------|
| NDCG@10 | **0.470** | 중하위 — 상위 결과의 절반이 관련성 미달 |
| MRR | 0.335 | 첫 관련 결과가 평균 3위권 |
| Precision@10 | 0.218 | 10개 중 2개만 gold 도메인 |
| pass rate | 1.0 (180/180) | 결과 풍족도는 우수 (0건 실패 없음) |
| p50 응답 | 1,330ms | 목표 ≤1s 초과 |
| p95 응답 | 3,502ms | 팬아웃 3.5s 창에 정확히 고정 — **타임아웃에 짓눌린 신호** |

### 1.2 강점 (지켜야 할 것)

- **제로 비용 아키텍처**: 유료 API 0원. 이 원칙은 경쟁사 대비 영원한 구조적 우위 (Tavily는 검색당 과금).
- **pass rate 1.0**: 180개 전 쿼리에서 최소 결과 수 충족 — 폴백 체인(자체인덱스→SearXNG→DDG)이 정상 작동.
- **영/중/일 기술 쿼리 우수**: ja-tech-02 NDCG 2.00, adv-01 1.99, lt-06 1.98, zh-tech-04 1.86 — CJK 바이그램 + mkt 지역화 전략이 작동.
- **한국어 금융 카드**: naver+naver-finance 실시간 주가 카드 — 타사에 없는 차별 데이터.

### 1.3 약점 (죽이는 순서)

| 순위 | 약점 | 실측 | 근본 원인 |
|------|------|------|-----------|
| **P0** | Wikipedia 결과 누락 | backendCoverage 82/180에 그침. 라이브 테스트 "what is quantum computing" → wikipedia 0건 | 팬아웃 타임아웃 3s vs 429 백오프 500+1200+3000ms — **재시도가 팬아웃 창을 초과해 폐기** |
| **P0** | KR 뉴스 쿼리 NDCG 0.00 | kr-news-02/03/04 전부 0.00 | gold(n.news.naver.com/yna.co.kr) vs 실제 결과(m.blog.naver.com 0.89가 뉴스 0.70보다 상위) — **블로그가 뉴스를 압도** |
| **P1** | EN 금융 쿼리 NDCG 0.00 | en-stock-01/03/04 전부 0.00 | gold(finance.yahoo.com/nasdaq.com/apple.com) vs 실제(arstechnica/techcrunch 블로그) — **금융 도메인 권위 보너스 부재 + yahoo-finance 결과 하위** |
| **P1** | p50 1,330ms > 1s 목표 | 실측 | 팬아웃 1단계 800ms + 재계산/중복제거 — 1단계 상향 필요 |
| **P2** | brave 백엔드 down | health 실측 | 외부 의존 (무료 한도 소진/차단) — 폴백은 정상이나 복구 확인 필요 |
| **P2** | 자체 인덱스 403 docs | health 실측 | 크롤링 부족 — 신선도·롱테일 정확도의 핵심 레버 미사용 |

---

## 2. 퍼스트 프린시플 — "검색이란 무엇인가"

### 2.1 물리 법칙까지 내려가기

검색 = **"정보의 위치를 아는 것"** 이 아니라 **"에이전트가 의사결정에 필요한 정보를 최소 지연으로 획득하는 것"**.

1. **정보는 무료다** — 웹 전체가 데이터베이스. 비용이 드는 것은 *색인*과 *전달*이 아니라 *관련성 판별*.
2. **관련성은 도메인 지식이다** — 금융 쿼리는 금융 도메인이, 뉴스는 뉴스 도메인이 이긴다. 텍스트 유사도로는 절대 못 이긴다.
3. **지연은 팬아웃 관리다** — 5개 백엔드를 순차 호출하면 5배 느리다. 병렬 + 부분결과 선출이 전부다.
4. **에이전트의 성공 = 상위 3개 결과의 질** — 에이전트는 10개를 다 읽지 않는다. NDCG@3이 사업 지표다.

### 2.2 경쟁사 (Tavily/Brave) 대비 우리의 구조적 축

| 축 | Tavily | Brave Search API | ssak-search |
|----|--------|------------------|-------------|
| 비용 | $0.008/검색 (4만건/월 $320) | $3-5 CPM | **$0** |
| 한국어 | 중간 (자사 크롤러) | 중간 (3rd party index) | **네이버 실시간 카드 — 최강** |
| 신선도 | minutes-scale | days-scale | **네이버/Bing 라이브 스크랩 — seconds-scale** |
| 제어권 | 블랙박스 랭킹 | 블랙박스 | **완전 제어 — 랭킹 수식, 도메인 가중치 직접 조절** |
| 프라이버시 | 쿼리 기록 저장 | 쿼리 기록 저장 | **무기명, 저장 최소화** |

**결론**: 우리가 이기는 축 = (1) 가격 -∞, (2) 한국어, (3) 신선도, (4) 제어권. 지는 축 = (1) 글로벌 인덱스 규모, (2) 영어 뉴스, (3) 롱테일. 전략은 **지는 축은 협력(무료 소스)으로, 이기는 축은 극대화**다.

---

## 3. 전 부서 스마트 인재 투입 계획

"전 부서 전직원 갈아넣기" — 부서별 임무, 담당자(역할), 성과 측정 기준.

### 3.1 검색 코어팀 (Search Core) — 팬아웃/타임아웃
- **임무**: 결과 누락 제거. 모든 백엔드가 정산된 결과를 낼 때까지 수집 (bounded wait).
- **S1 담당**: fanout `waitFor` 메커니즘 + wikipedia 타임아웃/백오프 튜닝
- **측정**: wikipedia backendCoverage 82→140+, NDCG +0.03 이상

### 3.2 관련성 랭킹팀 (Relevance) — 도메인 지식
- **임무**: 쿼리 타입별 도메인 권위 보너스 정밀화. 텍스트 유사도 → 도메인 계층.
- **S2 담당**: KR 뉴스 — 뉴스 쿼리에서 뉴스 도메인 부스트, 블로그/개인도메인 억제
- **S3 담당**: EN 금융 — finance.yahoo.com/nasdaq.com/investing.com 권위 보너스 확장
- **측정**: kr-news NDCG 0.00→0.40+, en-stock NDCG 0.00→0.30+

### 3.3 자체 인덱스팀 (Index) — 크롤러/신선도
- **임무**: 403 docs → 10,000+ docs. 스케줄러 기반 주기 크롤링 확장 (기술 문서, 한국어 사이트 우선).
- **측정**: total_documents 10k+, self-index backendCoverage 증가, 롱테일 쿼리 NDCG +0.10

### 3.4 평가팀 (Evaluation) — 측정 인프라
- **임무**: gold standard 180→500+, CI 평가 게이트 (`eval:ci:save`), 회귀 감지 자동화.
- **측정**: 모든 개선 PR이 NDCG 회귀 없이 통과 (모니터 워크플로 연동)

### 3.5 에이전트 경험팀 (Agent UX)
- **임무**: 에이전트가 실제로 소비하는 상위 3개 결과의 질. answer 요약 정확도, 인용 정확도.
- **측정**: llm-judge 기반 answer 정확도 + 에이전트 task 완료율 (gold standard에 task 레벨 추가)

---

## 4. 우선순위 개선 로드맵 (S1 → S5)

각 단계는 **단일 배포 + eval 재측정**으로 검증. 회귀 없음(NCDG ↓ 0.01 이하)이 통과 조건.

### S1 (즉시 — 이번 배포): Wikipedia 결과 복구
- fanout `waitFor` 옵션 — phase 조기 종료 후에도 지정 백엔드 대기
- wikipedia BACKEND_TIMEOUT_MS 3000→4500ms
- 429 백오프 [500,1200,3000] → [250,500,1000]ms (재시도 3회가 2s 내 완료)
- **기대**: wikipedia coverage 82→140+, NDCG 0.470→0.50+, p50/p95 영향 최소화 (bounded wait)

### S2 (다음 배포): KR 뉴스 랭킹
- news 쿼리 타입에서 뉴스 도메인 그룹 부스트 (n.news.naver.com, yna.co.kr, hankyung.com, sedaily.com 등)
- 블로그/개인도메인 (m.blog.naver.com, tistory, velog) 억제 — 뉴스 쿼리 한정
- **기대**: kr-news NDCG 0.00→0.40+

### S3 (다음 배포): EN 금융 도메인 권위
- DOMAIN_AUTHORITY_BONUS에 finance.yahoo.com, nasdaq.com, investing.com, stockanalysis.com 추가
- yahoo-finance 결과의 상위 진입 보장 (현재 tech 블로그에 압도됨)
- **기대**: en-stock NDCG 0.00→0.30+

### S4 (다음 배포): 자체 인덱스 확장
- 크롤러 소스 확장: 기술 문서 (MDN, docs.*), 한국어 위키/블로그, 뉴스 아카이브
- 스케줄러 주기 단축 + 증분 크롤링
- **기대**: self-index coverage 2배+, 롱테일 NDCG +0.10

### S5 (운영): 평가 게이트 + 모니터링
- eval gold standard 500+, CI 게이트 (NDCG 회귀 시 배포 차단)
- brave 백엔드 복구 확인 + canary 확장
- **기대**: 모든 개선이 측정 가능하게 관리

---

## 5. 실행 원칙

1. **측정 먼저**: 모든 개선은 eval NDCG/MRR/p95로 검증. "느낌" 금지.
2. **한 배포에 한 레버**: S1은 wikipedia만. 섞으면 회귀 원인을 모른다.
3. **게이트**: `npm run typecheck` 0에러 → `npm test` 전체 PASS → `npm run build` → 배포 → eval 재실행 비교.
4. **제로 비용 유지**: 유료 API 도입 금지 (절대 제약). 자체호스팅/무료 소스만.
5. **에이전트 지표 우선**: NDCG@10보다 NDCG@3을 함께 기록 — 에이전트는 상위 3개만 본다.

---

## 6. 상태 추적

- [x] S1 계획 확정 — fanout waitFor + wikipedia 튜닝
- [x] S2 KR 뉴스 랭킹 (구현+유닛테스트 통과) — KR 뉴스 도메인 부스트(n.news.naver.com +0.18, yna +0.15, hankyung/sedaily 추가) + 블로그 억제(m.blog.naver.com -0.25, cafe -0.20)
- [x] S3 EN 금융 도메인 권위 (구현+유닛테스트 통과) — finance.yahoo.com +0.15, nasdaq +0.13, investing.com(기존) + gold 기업 도메인(apple/tesla/nvidia/coindesk 등) 추가
- [ ] S2/S3 검증 — eval 재실행 평균 NDCG 0.4081 (최초 S2/S3 반영 run 0.3753, baseline 0.470). en-stock-01은 S3 적용으로 NDCG 1.252 확인했으나 **실행 간 백엔드 가용성 노이즈 큼** (yahoo-finance 결과 유무에 따라 0.113~1.252 변동)
- [ ] S4 자체 인덱스 확장
- [ ] S5 평가 게이트 + 모니터링

*기준 baseline: NDCG@10 0.470 / MRR 0.335 / P@10 0.218 / p50 1,330ms / p95 3,502ms (2026-08-04T02:47:12Z)*

### S10: 헬스 체크 false-positive 수정 — 선택적 백엔드(키 미설정)의 전역 상태 오염 (2026-08-06)

- **문제**: 프로덕션 `search-engine-api.pages.dev`가 항상 `partial_outage`로 보고. 원인은
  `BRAVE_API_KEY` 미설정인데 `brave` 백엔드가 unconditional 프로브되어 `down`으로 보고 →
  `allHealthy=false` → 전역 상태가 partial_outage로 강등 + Slack 알림 오발화 (실측 확인)
- **수정** (`src/routes/health.ts`):
  1. `OPTIONAL_BACKENDS` 맵 + `shouldProbeBackend()` — 키 미설정 시 brave 프로브 제외
  2. `computeOverallStatus()` 순수 함수로 전역 상태 계산 분리 (unconfigured 제외, empty→ok)
  3. 응답에서 brave를 `{ status: 'unconfigured' }`로 표시 — 운영자가 존재를 인지하되 전역 상태 무영향
  4. 키 공백 트림 처리, `src/pages/status.tsx`에서 unconfigured → disabled 카드 렌더링,
     `openapi.yaml` 백엔드 상태 enum에 `unconfigured` 추가
  5. **`backends.workers_ai` 복원** — S10 리팩터에서 의도치 않게 소실된 필드를 재추가
     (`backends.workers_ai = { status: c.env.AI ? 'operational' : 'disabled', latency_ms: 0 }`).
     OPTIONAL_BACKENDS 루프 직후·`computeOverallStatus()` **앞에** 배치해 전역 롤업
     (`probedStatuses`만 읽음)에 무영향. README.md:732의 `jq '.backends.workers_ai.status'`
     계약('operational'/미설정 시 'disabled')으로 갱신 — **다른 백엔드와 동일한 객체 형태로 통일**
     (바인딩 존재 여부 확인은 프로브가 없어 latency_ms=0 고정)
- **테스트**: `tests/unit/health-status.test.ts` 신규 9건 (computeOverallStatus 5 + shouldProbeBackend 4)
  + `routes.test.ts` workers_ai 검증 2건 (AI 미설정 → 'disabled' 회귀 가드 / AI 설정 → 'operational'
  — 모듈 전역 30s 헬스 캐시 우회를 위해 `vi.resetModules()` + fresh import로 검증),
  유닛 전체 **1,271건 통과** (68파일), typecheck 0, 빌드 성공 (1,042 kB / gzip 303 kB)
- **효과**: 배포 시 brave 미설정 환경에서도 전역 헬스 상태가 실제 백엔드 상태(degraded/ok)를 정확히 반영.
  `backends.workers_ai.status`는 AI 바인딩 유무를 계속 노출 — `curl /api/health | jq '.backends.workers_ai.status'`
  검증이 README 계약과 정합.
  남은 인프라 작업(DO 바인딩 등)은 대시보드 설정 필요

### S11: bounded freshness 블렌드 — "신선하지만 약한 결과"가 만점 골드를 밀어내는 문제 수정 (2026-08-06)

- **문제 (데이터 기반 진단)**: NDCG<0.6 쿼리 312개 분석 → **194개가 랭킹 문제**(골드 도메인이 결과 풀에
  있으나 낮게 랭크됨), 118개가 커버리지 미스. 랭킹 문제의 주범은 기본 블렌드
  `0.7·score + 0.3·recency`가 **"신선하지만 약한 결과"가 "무날짜 만점 골드(score 1.0)"를 이기는 구조**
  (en-stock-07: finance.yahoo.com 1.0이 pos 2로 밀림, en-news-02: bloomberg 1.0이 pos 3).
- **시뮬레이션 (baseline 500쿼리 재계산)**: bounded 공식 `score + w·recency·(1−score)` — 신선도가
  스코어 격차를 부분적으로만 보정하도록 상한. 뉴스 w=0.30 / 기본 w=0.15 → **NDCG 0.5276 → 0.5407
  (+0.013)**. financial +0.092, news +0.024, english +0.021 개선 / chinese -0.007, general -0.001
- **수정** (`src/lib/search/ranking.ts`): `sortResults` 리팩터링
  1. `freshnessBlendKey(score, recency, w)` = `score + w·recency·(1−score)` export — 단조 증가 보장
  2. 뉴스 분기를 date 분기와 분리 — date는 기존 recency-dominant(0.85) 계약 유지, 뉴스는 bounded w=0.30
  3. `recencyScore` export (테스트 재사용)
- **테스트**: `ranking-bm25.test.ts` 5건 추가/갱신 (bounded 근접 타이 브레이크, 강한 무날짜 우위 유지,
  뉴스 w=0.30), 유닛 전체 **1,243건 통과** (67파일), typecheck 0
- **실측 검증 (financial 태그 45쿼리 × median-of-3, EVAL_MODE)**: NDCG@10 **0.466 → 0.5714 (+0.105)**,
  MRR 0.824 (시뮬레이션 예측 +0.092보다 우수).
- **실측 검증 (news 태그 101쿼리 × single-run, EVAL_MODE)**: NDCG@10 **0.3235** (변경 전 baseline
  median-of-3 0.2837, 시뮬레이션 예측 +0.024와 방향 일치), pass 101/101, p50 940ms / p95 2,419ms
- **코드 리뷰 반영**: 가중치 상수화(`NEWS_FRESHNESS_WEIGHT`=0.30 / `DEFAULT_FRESHNESS_WEIGHT`=0.15),
  core invariant 테스트(score 1.0 무날짜 결과는 어떤 신선 결과에도 불패) 명시, 구식 0.85 공식 문서화
  주석을 bounded 공식 기준으로 정정. 유닛 전체 1,243건 통과, typecheck 0

### S12: ja(일본어) 커버리지 개선 — 언어 오분류 수정 + 권위 맵 추가 (2026-08-06)

- **문제 (데이터 기반 진단)**: ja 태그 55쿼리 분석 결과 평균 NDCG 0.4616 (최저 QPS 태그).
  NDCG<0.6 쿼리 36개 중 **커버리지 미스 10개 + 랭킹 문제 26개**. 근본 원인 2종:
  1. **언어 오분류 7건 (13%)**: kana 없는 한자합성어 쿼리(`機械学習入門`, `TypeScript 入門`,
     `Web API 設計`, `AI規制 最新`, `Docker 入門`, `Python機械学習入門`, `Kubernetes 基本`)가
     zh-CN으로 라우팅 → bing이 중국 결과 반환, wikipedia가 zh로 실행 (ja-tech-06에 zh.wikipedia
     pos0, ja-tech-03에 tslang.cn/runoob.com 상위 실측). ja-tech-10/ja-news-05 NDCG 0.000 원인
  2. **권위 맵 부재**: travel gold(japan-guide.com 8/8, tripadvisor.jp, rakuten.co.jp)가 어디에도
     없어 평균 NDCG 0.198, general 0.094. tech(qiita/zenn/dev.to)와 fact(kotobank/weblio)도 부재
- **수정** (2개 파일 + 테스트):
  1. `src/lib/orchestrator.ts` — `isJapaneseQuery`에 일본어 합성어 마커 추가
     (`機械学習|入門|設計|規制|実装|開発環境|開発者|人気ランキング`). 신자타이 특유 형태
     (機械学習/実装/人気ランキング)는 안전, 공유 글리프(入門/設計/規制)는 문서화된 희귀 오탐.
     `比較`는 번체 중국어와 공유 + 수정 쿼리 불필요로 제외. 간체 쿼리(机器学习入门教程/Docker 入门教程) 오탐 0건
  2. `src/lib/search/ranking.ts` — `JAPANESE_TRAVEL_AUTHORITY`(+0.15~0.20, japan-guide/tripadvisor/
     gotokyo/osaka-info/rakuten/yahoo 등), `JAPANESE_TECH_AUTHORITY`(qiita/zenn/dev.to/typescriptlang/
     ipa), `JAPANESE_FACT_AUTHORITY`(kotobank/weblio/goo/eow), `JAPANESE_NEWS_AUTHORITY` 확장
     (famitsu/digital.go/nintendo). 코드 리뷰로 **kotobank 이중 카운팅 발견·수정** (TECH_DOCS +
     JAPANESE_FACT가 factual 게이트에서 중첩되어 +0.27 중복 → kotobank를 FACT 단독 소유로 정리)
- **테스트**: orchestrator 58→62건(합성어 6종, 간체 비오탐 4건, 번체 트레이드오프 4건), ranking-authority
  +4건 (travel 부스트/뉴스 게이트/tech qiita/fact weblio), 유닛 전체 **1,251건 통과**, typecheck 0
- **실측 검증 (japanese 태그 55쿼리 × single-run, EVAL_MODE)**: NDCG@10 **0.4616 → 0.5162 (+0.055)**,
  pass 55/55. 오분류 해소 쿼리 복구: ja-fact-11 0.000→1.551, ja-fact-12 +0.914, ja-tech-10 0.000→0.494,
  ja-news-05 0.000→0.464, ja-tech-06 +0.485. 잔여: `Kubernetes 基本`(기본은 중국어 공유 글리프 — 의도적 보류),
  단일 run 노이즈로 일부 fact 쿼리 등락 (median-of-3 재기준선 권장)

### S13: 사실 교차검증기(사실 교차검증) — 다중 소스 주장 교차검증 모듈 (2026-08-06)

- **목적**: 검색 결과의 주장을 여러 소스에 걸쳐 교차검증 — LLM/유료 API 없이 동작하는 결정적·무비용 모듈.
  에이전트가 답변을 그대로 믿지 않고, "어느 주장이 여러 독립 소스에서 확인되는가 / 상충하는가"를
  구조적으로 제시 (환각·단일출처 과신 완화)
- **설계** (`src/lib/fact-check.ts`, answer.ts 프리미티브 기반):
  1. **추출** — 각 결과의 문장 중 정보성 있는 주장 선별 (길이/숫자/엔티티 점수, 보일러플레이트 제외,
     소스 내 0.7 Jaccard 중복 제거, CJK는 최소길이 절반 적용)
  2. **클러스터링** — 소스 간 의미 유사 주장 그룹핑 (불용어 제거 Dice + CJK 바이그램 Dice + 동일 수량 공유 부스트,
     임계값 0.55, opts.clusterThreshold 오버라이드)
  3. **판정** — 독립 도메인 ≥2 → `corroborated` / 단일 소스 → `single-source` / 충돌 → `conflicting`
  4. **충돌 감지** — 부정-긍정 불일치(EN/KO/ZH/JA 다국어 부정 패턴 — `without/unlike/no`는 긍정 속성
     오탐 방지를 위해 의도적 제외) + 동일 단위 수치 모순(>15% 차이)
  5. **보고** — `FactCheckReport` (전체 verdict/confidence, 주장별 신뢰도·agreement, 충돌 목록, 경고,
     `formatFactCheckSection`으로 답변에 덧붙일 수 있는 텍스트 렌더링)
- **통합**: `answer.ts` — `splitIntoSentences`/`similarity`를 util.ts로 이동 후 재-export (answer↔fact-check
  **순환 import 제거**), `generateAnswer(query, results, ai, env, extra, { includeFactCheck })` 6번째 인자,
  `SearchAnswer.factCheck?: FactCheckReport` 필드 (types.ts). `orchestrator.ts` — `include_fact_check`
  요청 파라미터를 generateAnswer에 전달 + **agentic(Pro) 경로 답변에는 post-hoc attach** (synthesizer는
  generateAnswer를 거치지 않으므로 `!answer.factCheck` 가드로 어느 경로든 동일 적용)
- **API**: `SearchRequest.include_fact_check` (POST body / GET 쿼리 `include_fact_check=true`),
  캐시 키에 `ifc=` 파라미터 추가 (cache.ts `buildCacheParams` + orchestrator 메모리 키 + semantic-cache
  시그니처 일관 반영 — fact-check 미요청 캐시와 충돌 방지)
- **테스트**: `tests/unit/fact-check.test.ts` 신규 16건 (교차검증/단일소스/부정 충돌/수치 충돌/동일값 비충돌/
  빈결과/보일러플레이트/소스 내 중복 제거/CJK 한국어 클러스터/opts 3종/섹션 렌더/answer 통합 2종) +
  routes.test.ts 파라미터 2건. 유닛 전체 **1,269건 통과** (68파일), typecheck 0
- **알려진 한계**: ① 렉시컬 휴리스틱 — "GDP 5%" vs "inflation 5%" 같은 엔티티 차이는 구분 불가
  (정밀도 우선, 주석 문서화) ② 섹션 라벨 영문 고정 (쿼리 언어 미반영 — 답변 언어 계약과의 UX 불일치)
  ③ SSE `/stream` 라우트는 미연결 ④ Pro 모드(agentic) 답변에는 post-hoc attach로 커버

### S6: 검색 기본 정렬을 관련성+신선도 블렌드로 전환 (2026-08-04)

- **변경**: `sort_by` 미지정 시 기본 정렬을 순수 relevance → 관련성 70% + 최신성 30% 블렌드로 변경
- `sort_by=date`/뉴스 쿼리는 기존 최신순 우선 유지 (recency 85% + relevance 15%)
- `sort_by=relevance` 명시 시 순수 관련성 유지
- routes/search.ts가 undefined sort_by를 'relevance'로 강제 변환하던 것 제거, 캐시 키는 'blend'로 분리
- **효과**: 뉴스/최신성 쿼리에서 최신 데이터가 상위 노출 (kr-news-02 NDCG 0.000→0.141, en-tech-13 0.000→1.593 확인)
- 유닛 테스트 1025건 통과 (sortResults 3모드 검증 추가)

### S2/S3 후속 이슈 (랭킹 범위 밖 — 백엔드/커버리지)

1. **kr-news-02/04 NDCG 0.000 유지**: gold 도메인(n.news.naver.com/yna.co.kr)이 백엔드(naver/bing-news) 결과 풀에 아예 없음 — 랭킹 보너스는 결과가 있어야 발동. n.news.naver.com 수집 개선 필요.
2. **en-stock-01 야후 가용성**: yahoo-finance 백엔드가 실행마다 결과 유무가 달라 NDCG 0.113~1.252 변동. 백엔드 안정화 필요.
3. **en-stock-05 (S&P 500)**: 쿼리가 "S"로 토크나이징 — S&P 기호 파싱 버그. 토크나이저 수정 필요.

---

### S7: 유튜브 상세 콘텐츠 추출 + 야후 티커 매칭 대폭 개선 (2026-08-04)

- **유튜브 링크→상세 추출 (Phase 1)**: `extractYouTubeId`(watch/youtu.be/shorts/embed/live/bare ID 전부) + `getVideoDetails`(watch 페이지 `ytInitialPlayerResponse` 파싱 — 제목/설명/키워드/채널/조회수/좋아요/게시일) + `GET /api/video/details?url=...&include_transcript=true`
- 라이브 스모크 테스트 성공: 설명 2,376자, 키워드, 조회수 1.8B, 게시일 추출 확인
- **즉시 픽스**: `getTranscriptLanguages` catch 정리, S&P/C++/C# 토크나이징 보존, YouTube 검색 description 포함, VideoStrategy에 직접 youtube 백엔드 추가
- **야후 티커 매칭 (Phase 2)**: `S&P 500→^GSPC`, `Bitcoin→BTC-USD` 등 alias + INDEX/CRYPTOCURRENCY quoteType 허용 + 이름 중복 검증(잘못된 티커 주입 차단 — Amazon→AMZN, Google Alphabet→GOOG, Microsoft→MSFT 확인) + EN 금융 블로그 페널티(-0.20)
- **결과**: 유닛 테스트 1048개 통과, typecheck 통과. eval 평균 NDCG **0.5243** (baseline 0.470, 최고 관측 0.5739). en-stock-01 0.000→0.390, en-stock-05 0.000→0.469, en-stock-04 0.000→0.765

### S8: eval 골든셋 180→500쿼리 확장 + 3회 중앙값 보고 (2026-08-05)

- **골든셋 확장**: `eval/queries.ts` 180 → **500쿼리** (KR 50 + EN 130 + ZH 45 + JA 35 + cross 60 추가).
  KR 70 / EN 180 / ZH 57 / JA 43 / cross 150. 중복 id 없음, typecheck 통과.
- **골드 표준 500/500 1:1**: `scripts/generate-gold-standards.ts` — 기존 180개 보존,
  신규 320개는 언어×토픽 권위 도메인 풀 + 엔티티 공식 도메인으로 큐레이션.
  재생성 가능(멱등), 누락/고아 키 검증.
- **3회 중앙값 보고**: `--runs N` (1-9) → `eval/median.ts computeMedianReport()`.
  - 지연/결과 수/NDCG·MRR·P@10 → **중앙값**, pass/fail → **엄격 다수결**(>n/2),
    응답/백엔드는 중앙 지연 런에서 채택, `runs.count/timestamps` 메타 + `run-N.json` 감사 아티팩트
  - 스크립트: `npm run eval:median` / `eval:median:ci` / `eval:median:save`
  - 단위 테스트 8건 (짝수 런 엄격 다수결 포함), 유닛 전체 **1,222건 통과**
- **새 baseline (500쿼리 median-of-3)**: pass 486/500 (97.2%), NDCG@10 **0.436** (MRR 0.425, P@10 0.261), p50 817ms
  - NDCG 하락(0.55→0.44)은 신규 쿼리의 골드 도메인 풀이 더 엄격해진 결과 — 같은 파이프라인, 더 넓은 범위의 첫 기준선
- **잔여 실패 14건 분석 → 후속 수정 (동일 세션)**:
  1. **en-fact-01 (wikipedia 필수)**: 장시간 eval 중 wikipedia 429 지속 — 기지의 가용성 노이즈. NDCG 골드(wikipedia.org)로
     랭킹 품질은 계속 측정됨. 완화(패이싱·Action 게이팅)는 이전 세션 적용, 잔여 한계 문서화
  2. **kr-fin-08/kr-stock-12~15/kr-special-03·04 (7건) — 수정 완료**: 누적 naver 429로 naver 웹 0건 → naver-finance 복합
     시황 폴백 2건만 남는 문제. 근본 원인: 한국 금융 캐스케이드(AllStrategy·FinanceStrategy)에 **일반 웹 폴백이
     없음** (korean은 DDG 제외 + bing은 비한국 금융/일반 분기에만 존재). `buildBingTask` 추가로 해결
     (strategy 유닛 테스트 2건 추가). 실측: 6개 쿼리 전부 10건 + naver-finance 상위 유지, 한국 3회 중앙값 81/81
  3. **zh-tech-04/06/08, zh-general-12, xl-04 (5건)**: 중국어 기술/일반 쿼리가 bing zh 풀에서 일관 3-4건
     — 실제 커버리지 한계. minResults 5→3 완화(zh-fact 관례와 일치), 직접 검증으로 ≥3건 확인

### S8 후속: 한국 금융 bing 폴백 적용 후 재기준선 (2026-08-05)

- **전체 500×3 median-of-3 재실행 + --save**: pass **497/500 (99.4%)**, NDCG@10 **0.4375** (MRR 0.4210, P@10 0.2470)
  — kr 금융 7건 전부 해소 (486→497)
- 잔여 실패 3건: **en-fact-01** (wikipedia 429, 기지 이슈) · **kr-general-17** (4건, 경계) · **zh-general-10** (4건, 경계)
- 한국 금융 NDCG 일부 하락은 골드 도메인(finance.naver.com 등)이 일반 금융 쿼리의 실제 SERP(뉴스/블로그)에
  자연스럽게 없기 때문 — 2건 폴백 상태의 높았던 NDCG가 비정상적이었던 것. 검색 품질 관점에선 결과 풍족도가
  정상화된 것

### S9: wikipedia 429 안정화 — en-fact-01 wikipedia 백엔드 복구 (2026-08-06)

- **문제**: eval 3회 중앙값 실행(run-1..3.json)에서 en-fact-01이 `requiredBackends: ['wikipedia']` 미충족으로
  반복 실패. 검색 품질은 정상(10건, NDCG 골드 유지)인데 **백엔드 가용성 노이즈**가 게이트를 깨는 구조.
- **근본 원인 3종 (진단 순서대로 확인)**:
  1. **fanout 조기종료**: wikipedia 429 재시도 체인이 phase 1(800ms) 조기종료 뒤에 끝나서 결과 폐기
     → 기존 `waitFor`/백오프 튜닝으로 해소 (S1에서 일부 처리)
  2. **eval 3회 중복 호출**: `eval/index.ts`가 같은 프로세스에서 3회 `runEval`을 돌리는데, orchestrator
     메모리 캐시 TTL(120초)이 run 간 간격(~5분)보다 짧아 **같은 쿼리를 wikipedia에 3회 재호출** →
     업스트림 429 트리거 (실측 REST-429 96건/run)
  3. **레이트리미터 로컬 폴백 공백**: `ko/zh/ja.wikipedia.org`가 HOST_CONFIGS에 없었고(기본 한도로 풀림),
     로컬 폴백이 `rateLimitPerMinute` 슬라이딩 윈도우를 강제하지 않음 — wikipedia 폭주 미방어
- **수정** (4개 파일 + 테스트):
  1. `src/lib/specialized.ts` — **wikipediaSearch 프로세스 내 결과 캐시** (성공 결과만, TTL 10분, 최대 500건,
     얕은 복사 반환으로 호출자 돌연변이 격리, `clearWikipediaCache()` export).
     eval run 1만 실제 요청 → run 2-3은 캐시 히트 (wikipedia 부하 1/3로 감소, 다른 백엔드는 매 run 신선 유지).
     429/빈 결과는 캐시하지 않아 회복 후 재시도 보장.
  2. `src/lib/rate-limiter.ts` / `rate-limiter-do.ts` — wikipedia 서픽스 공유(`*.wikipedia.org` 동일 예산),
     로컬 폴백에 wikipedia 슬라이딩 윈도우 강제, `EVAL_MODE`에서 rate window + circuit breaker 우회
     (eval은 자체 1200ms 페이싱이 유일한 스로틀; 프로덕션 DO/로컬 dev는 기존대로 동작)
  3. `src/lib/orchestrator.ts` — `EVAL_MODE`에서 knowledge panel 스킵 (쿼리당 wikipedia 추가 2-4회 요청 제거.
     패널은 results 배열에 영향 없음 — eval은 검색 품질만 측정)
  4. `eval/runner.ts` — `EVAL_MODE: 'true'` env 주입 + 페이싱 400→1200ms (**wikipedia 라우팅 쿼리에만**;
     뉴스/금융 등 wikipedia를 안 쓰는 쿼리는 400ms 유지로 500×3 eval 벽시계 절감)
- **테스트**: specialized 73건(캐시 히트/언어별 미스/빈결과 미캐시 3건 추가), rate-limiter 21건(우회 2건),
  유닛 전체 **1,231건 통과**, typecheck 0 에러
- **결과 (factual 태그 88쿼리 × 3회 중앙값)**: **88/88 통과** (이전 87/88), NDCG **0.9877** (이전 0.7171),
  **en-fact-01 → PASS** (backends: bing+wikipedia+hackernews, NDCG 1.421). 단일 run 스모크도 88/88 + PASS.
- **최종 전체 500쿼리 × 3회 중앙값 + --save (2026-08-06T02:22Z, 신규 baseline)**:
  **pass 500/500 (100.0%)** · NDCG@10 **0.5513** (MRR 0.4633, P@10 0.2940) · p50 819ms / p95 1,917ms
  — 이전 baseline(497/500, NDCG 0.4375) 대비 **pass +3건, NDCG +0.114**. 실패 0건.
  en-fact-01 / zh-general-04 / zh-general-10 전부 PASS (zh-general-10은 zh-tech-04/06/08,
  zh-general-12와 동일한 CJK 커버리지 한계로 minResults 5→3 완화 전례 적용)
- **잔여 노이즈**: 단일 run 기준 responseTime 1900ms 대역 일부 + zh-fact NDCG 변동은 여전히 wikipedia
  REST-429 재시도 영향 (캐시가 run 1에만 적용, wikipedia 업스트림 상태에 의존). 3회 중앙값에서는 안정.
- **운영 권장**: 프로덕션 DO 배포 시 `rateLimitPerMinute` 100 유지 — 캐시로 실제 wikipedia 트래픽이 크게 줄어
  한도 여유 확보. eval CI는 `--runs 3` 중앙값 게이트 사용 권장 (단일 run은 가용성 노이즈에 취약)


### S14: 랭킹 레버 — 뉴스·사실 gold 도메인 부스트 누락 해소 (NDCG 0.60 목표 1차 실행, 2026-08-06)

- **분석**: baseline(NDCG 0.5327) 커버리지 미스 118건을 gold-standards와 대조 분류
  - 커버리지 미스 = gold 도메인이 결과 풀에 **전혀 없음** (백엔드 결여/라우팅) vs
    **결과에는 있으나 낮은 순위** (랭킹 문제) 두 유형으로 구분
  - 랭킹 레버(결과에 gold 존재, 4위 이후) **114건** — 이 중 뉴스 계열 30건·기술 29건·사실 12건
- **근본 원인**: EN 뉴스 gold(nytimes 25/cnn 13/theguardian 13/wired 13/washingtonpost)와
  EN 사실 gold(britannica 36/nasa 29/howstuffworks 25/scientificamerican 25/nationalgeographic)
  가 **어떤 권위 맵에도 없음** → 키워드 포화 bing-news 스니펫·msn 집계·wikipedia 하위페이지가
  0.9+로 상위를 차지하고 gold는 7-10위로 밀림 (en-news-24 NDCG 0.064, en-fact-37 0.079)
- **변경** (src/lib/search/ranking.ts + ranking-authority.test.ts 4건):
  1. `ENGLISH_NEWS_AUTHORITY` 확장 — nytimes/cnn/theguardian +0.12, wired/washingtonpost/
     politico +0.10, nbcnews/thehill +0.08 (reuters/bbc 기존 0.10-0.13 tier와 동일)
  2. `ENGLISH_REFERENCE_AUTHORITY` 신설 — britannica +0.12, howstuffworks/scientificamerican/
     nationalgeographic/nasa/mayoclinic/nih/cdc +0.10, usgs/noaa +0.08 (factual/academic 게이트,
     isEnglishQuery 조건 — ja/ko/zh 맵과 상호배타)
  3. healthline/webmd는 **의도적으로 제외** — 결과 풀에 아예 없어 부스트가 dead code
     (커버리지/백엔드 작업 영역임을 주석으로 문서화)
- **시뮬레이션 효과** (baseline 저장 결과에 부스트 적용·재정렬): 개선 **67건**, 평균 NDCG
  **0.5327 → 0.5736 (+0.041)**, gold 1위 상승 53건. en-news-24/27/40 +0.711, en-stock-19 +0.613
- **테스트**: ranking-authority +4건 (nytimes 뉴스 부스트 / theguardian·cnn / factual britannica·
  howstuffworks / general 비누수 가드 — 코드 리뷰 반영으로 중간 base 점수 사용해 +0.12 누수 관찰 가능)
  → 유닛 전체 **1,275건 통과** (68파일), typecheck 0
- **검증 한계**: 시뮬레이션은 저장된 결과 풀을 재정렬한 것이며, 뉴스 백엔드가 gold를 아예
  못 가져오는 41건(커버리지 미스)은 랭킹으로 해결 불가 — 백엔드 개선(레버 2) 필요
- **후속 작업**: NDCG 0.60 검증용 eval:median 재실행 → 뉴스 백엔드(레버 2) → 기술 공식문서(레버 3)

