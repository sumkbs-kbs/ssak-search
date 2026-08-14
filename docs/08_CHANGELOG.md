# 08. 변경 내역 (CHANGELOG)

> 최초 작성: 2026-08-05 · 이 세션에서 수행한 변경과 검증 결과 기록. 이전 이력은 루트 CHANGELOG.md 참조.

---

## 2026-08-05 — CTO 태스크포스 세션 (분석 + 수정)

### 작업 완료 보고

#### 작업 1: 레이트 리밋 이중 카운팅 수정 (P6)
- **작업 ID**: FIX-2026-08-05-01
- **작업명**: API 요청당 rate-limit 슬롯 1개만 소모하도록 수정
- **수정한 파일**: `src/lib/security-middleware.ts`
- **핵심 변경사항**:
  - `checkIpRateLimit()`에 `options.record` 추가 (기본 true)
  - 응답 헤더 보고용 호출(기존 146행)을 `{ record: false }`로 변경 — 슬롯 미소모
- **해결된 문제**: 기존에는 요청 전 검사 + 응답 헤더 보고가 각각 슬롯을 기록 → 10회/분 한도가 사실상 5회/분으로 반감. 무인증 경로의 실효 한도가 설계치의 절반이던 결함
- **테스트 결과**: `tests/unit/security-middleware.test.ts` 신규 5건 통과 (슬롯 정확성, peek 미소모, 한도 소진 차단, 커스텀 한도)
- **성능 변화**: 해당 없음 (상태 로직만)
- **검색 품질 변화**: 없음
- **보안 영향**: 레이트 리밋 정책이 의도대로 10회/분 복원
- **남은 위험**: DO 미바인딩 시 isolate별 폴백 (기지의 인프라 이슈 P2)
- **후속 작업**: 없음

#### 작업 2: X-Subrequests-Limit 헤더 env 반영 (P7)
- **작업 ID**: FIX-2026-08-05-02
- **작업명**: 서브리퀘스트 상한 헤더를 SUBREQUEST_QUOTA_PER_REQUEST env에서 해석
- **수정한 파일**: `src/routes/search.ts`
- **핵심 변경사항**:
  - `resolveSubrequestLimit(env)` 헬퍼 추가 — env 없으면 50 기본값
  - POST/GET/에러 응답 4곳의 하드코딩 `'50'` → env 값
  - 경고 임계값(40) → 한도의 80%로 변경 (유료 tier 1000 반영)
- **해결된 문제**: monitor.ts는 같은 env를 쓰는데 search.ts는 50 고정 → 헤더와 실제 알림 기준 불일치. 유료 tier(1000)에서 헤더가 50으로 거짓 보고되던 결함
- **테스트 결과**: `tests/unit/routes.test.ts` +2건 (env 1000 반영, 기본 50)
- **성능 변화**: 없음
- **검색 품질 변화**: 없음
- **보안 영향**: 없음
- **남은 위험**: 서브리퀘스트 실제 50 한도는 Cloudflare 정책 (paid 1000) — env 설정이 문서·알림과 정합
- **후속 작업**: P1-5 (팬아웃 subrequest 감축)는 별도

#### 작업 3: 기준선 검증 및 산출물 문서화
- **작업 ID**: DOC-2026-08-05-01
- **작업명**: Phase 0 기준선 확보 + 10개 진단 문서
- **산출물**: `docs/01`~`10` (현재 상태/검색 품질/목표 아키텍처/로드맵/체크리스트/보안/테스트 계획/변경내역/운영/출시 준비)
- **검증 결과**: typecheck 0 에러, 유닛 64파일/1,165건 통과, 빌드 성공

---

## 2026-08-07 — 재감사 세션 (CI 게이트 복구 + 버그 3건 수정)

### 검증 실측 (모두 실행 기반)
- typecheck 0 에러 · 유닛 **1,351건 / 70파일 통과** · build 1,061.78 kB (gzip 309.42 kB)
- **`npm run lint:eslint:ci` exit 0 복구** (세션 전: **38 errors + 467 warnings로 실패** — CI 레드)
- eval 최신 median-of-3 (08-06 14:52Z): NDCG@10 0.5113, pass 498/500 (실패: en-fact-01, zh-general-12)

### 수정 1: CI 린트 게이트 복구 (High)
- **작업 ID**: FIX-2026-08-07-01 / **파일**: 40+개 (주로 import/escape 정리)
- **핵심 변경사항**: no-useless-escape 35건(템플릿 페이지는 eslint 컬럼 기준 정확 제거, 실제 코드는
  node 의미 검증 후 제거 — bm25 `\]`는 제거 시 동작 변경 확인되어 유지), no-control-regex 2건
  (util.ts NUL→`\uE000` PUA 플레이스홀더), catch `err`→`_err` 44건, unused import 33건,
  중복 import 21건, no-empty 1건, non-null-asserted-optional-chain 1건, no-console 1건
  (로깅 싱크에 eslint-disable 명시)
- **게이트 정렬**: `lint:eslint`/`lint:eslint:ci` `--max-warnings=400` (잔여 353 = non-null 228 +
  any 60 + unused 65 — 설정 허용 스타일 + 수동 검토 필요분, S24 참조)
- **검증**: lint exit 0 · typecheck 0 · 테스트 전체 통과

### 수정 2: page-view.ts 브라우저 스크립트 SyntaxError (Critical — 실사용 버그)
- **작업 ID**: FIX-2026-08-07-02 / **파일**: `src/pages/page-view.ts`
- **문제**: 템플릿 리터럴의 단일 백슬래시가 도달 전 제거 → 서빙 정규식 `/[(d+)]/g`(인용 매칭 불가)
  및 `/**(.+?)**/g`(브라우저 SyntaxError) → `/page/:id` 스크립트 블록 전체 미실행, 페이지 영구 로딩
- **수정**: 이중 백슬래시(`\\[`, `\\*`) → 서빙 출력을 tsx로 검증, 인용/볼드 렌더링 복구

### 수정 3: util.ts isComparison 정규식 바이트 손상 (High — 실사용 버그)
- **작업 ID**: FIX-2026-08-07-03 / **파일**: `src/lib/util.ts`
- **문제**: `\b(?:vs|...|차이)\b`의 마지막 `\b`가 **raw backspace 바이트(0x08)**로 손상 —
  한국어 비교 쿼리가 비교 템플릿을 못 얻음
- **수정**: `\b` 복구 + 한글 접미사(대비/비교/차이)는 ASCII `\b` 미매칭 문제를 `$` 매칭으로 개선
- **테스트**: `tests/unit/util.test.ts` 신규 3건 (한국어 비교 감지 / 영문 vs / 비비교 회귀)

### eval 실패 2건 근본 원인 확정 (라이브 재현)
- en-fact-01: wikipedia 일시적 429 (라이브 재현 시 정상 5건) — 코드 버그 아님
- zh-general-12: bing mkt=zh-CN이 미국 IP에서 베트남어/일본어 오염 반환 (라이브 확인) — 상류 제약,
  교차언어 패널티로 2건만 생존. SearXNG 설정 시 완화 가능한 커버리지 갭

### 미해결 문제 (추적) — 추가
| ID | 문제 | 심각도 | 대응 |
|---|---|---|---|
| P18 | ~~no-unused-vars 65건~~ → **해결 (S25)**: lint 예산 400→0, `--max-warnings=0` 게이트 통과 | Medium | 완료 |
| P19 | ~~zh 롱테일 커버리지 갭 (考研复习计划 등) — mkt=zh-CN 미국 IP 오염~~ → **부분 해결 (S26)**: CSDN 키리스 백엔드 추가 (zh-tech+zh-general) + docs/13 SearXNG 설정 가이드 작성 | Medium | 완료 (실측 NDCG는 eval 재실행으로 확정 필요) |
| P20 | ~~wikipedia 단일 런 429 내성 — eval requiredBackends strict~~ → **해결 (S28)**: DBpedia 미러 폴백 (searchViaDbpedia — 서로 다른 인프라, EN 전용, simplifyQuery 정제 + 단순화 쿼리 기준 computeScore≥0.08 관련성 필터) + requiredBackends 어드바이저리화 (백엔드 누락 → warnings, 풀 충분하면 pass) | Low | ✅ 완료 (라이브 429 중 폴백 발동 + 관련 기사 3/3 검증, 실측 NDCG는 eval 재실행으로 확정) |
| P21 | ~~CJK 기술 쿼리 갭 ('레디스 안되') — 로마자 키워드 없는 한/중/일 문제 쿼리가 general 분류~~ → **해결 (S27)**: CJK_TECH_TERMS 76개 + isCjkTechPattern + S22 브랜치/plain technical 배선 | Medium | ✅ 완료 (오탐 가드: 開発/코드/캐시 등 동음이의어 명시 제외) |

## 2026-08-06 — 재검증 세션 (재검증 + 수정)

### 재검증 결과 (Phase 0)
- **typecheck**: 0 에러 · **빌드**: 1,041.57 kB (gzip 302.56 kB) · **유닛 테스트**: 66파일/1,230건 통과
- **eval baseline (신규)**: 500쿼리 × median-of-3 → **pass 500/500 (100%)**, NDCG@10 0.5327, MRR 0.4626, p50 840ms, p95 2,146ms
- **프로덕션**: `https://search-engine-api.pages.dev/api/health` → **HTTP 200** 가동 중 (08-05의 "HTTP 000"은 일시적 상태였음). status: partial_outage — brave 미설정 + 일부 백엔드 degraded
- **라이브 스모크**: `quantum computing` (bing+wikipedia+hackernews, 2.8s) · `삼성전자 주가` (naver+naver-finance+wikipedia, 1.0s) 정상

### 작업 완료 보고

#### 작업 4: 헬스 체크 false-positive 수정 (P11)
- **작업 ID**: FIX-2026-08-06-01
- **작업명**: 선택적 백엔드(키 미설정 brave)가 전역 헬스 상태를 partial_outage로 만드는 문제 수정
- **수정한 파일**: `src/routes/health.ts`, `tests/unit/health-status.test.ts` (신규)
- **핵심 변경사항**:
  - `OPTIONAL_BACKENDS` 맵 + `isBackendEnabled()` — 키 미설정 시 brave 프로브 제외
  - `computeOverallStatus()` 순수 함수 — probed 백엔드 상태만으로 전역 상태 계산 (unconfigured 제외)
  - 응답에서 brave를 `{ status: 'unconfigured' }`로 표시 — 운영자가 존재를 인지하되 전역 상태에는 영향 없음
- **해결된 문제**: BRAVE_API_KEY 미설정 배포에서 brave가 `down`으로 보고되어 **전역 상태가 항상 `partial_outage`로 표시**되고 Slack 알림이 불필요하게 발화되던 false-positive (프로덕션에서 실측)
- **테스트 결과**: `tests/unit/health-status.test.ts` 신규 8건 통과 (computeOverallStatus 5건: ok/empty/degraded/down/혼합, isBackendEnabled 3건) + 기존 routes.test.ts 58건 회귀 통과
- **성능 변화**: 키 미설정 시 brave 프로브 요청 1회 절약
- **검색 품질 변화**: 없음 (헬스/모니터링 전용)
- **보안 영향**: 없음
- **남은 위험**: 배포 후 `/api/health`에서 brave `unconfigured` 표시 + 전역 상태가 degraded/ok로 정상화되는지 확인 필요
- **후속 작업**: 운영 배포 시 확인

---

#### 작업 5: bounded freshness 블렌드 — 기본 정렬이 신선도로 골드 결과를 밀어내는 문제 수정 (S11)
- **작업 ID**: FIX-2026-08-06-02
- **작업명**: sortResults 기본 블렌드를 bounded freshness로 변경 (NDCG 0.53→0.60 목표 1차 레버)
- **수정한 파일**: `src/lib/search/ranking.ts`, `tests/unit/ranking-bm25.test.ts`
- **핵심 변경사항**:
  - `freshnessBlendKey(score, recency, w) = score + w·recency·(1−score)` — 신선도가 만점 결과를 이길 수 없게 상한
  - 뉴스 분기(기존 recency-dominant)를 date 분기와 분리 — date는 0.85 recency 계약 유지, 뉴스는 bounded w=0.30
  - 기본 분기 w=0.15 (기존 선형 0.7/0.3 블렌드 대체), `recencyScore` export
- **해결된 문제**: baseline 500쿼리 분석 결과 **랭킹 문제 194건의 주범** — en-stock-07(finance.yahoo.com 1.0→pos2),
  en-news-02(bloomberg 1.0→pos3) 등 "신선하지만 약한" 결과가 무날짜 만점 골드를 밀어내던 구조. bounded 공식으로
  신선도는 동점/근접 결과의 타이브레이커로만 작동
- **테스트 결과**: ranking-bm25.test.ts 5건 추가/갱신 + 유닛 전체 **1,243건 통과** (67파일), typecheck 0
- **검색 품질 변화**: **financial 태그 45쿼리 × median-of-3 실측 NDCG 0.466 → 0.5714 (+0.105)**, MRR 0.824.
  **news 태그 101쿼리 × single-run 실측 NDCG 0.3235** (변경 전 baseline 0.2837 — 시뮬레이션 예측 +0.024와 방향 일치),
  pass 101/101. baseline 시뮬레이션: 전체 NDCG 0.5276 → 0.5407 (+0.013)
- **코드 리뷰 반영**: `NEWS_FRESHNESS_WEIGHT`/`DEFAULT_FRESHNESS_WEIGHT` 상수화, core invariant 테스트 명시
  (score 1.0 무날짜 결과 불패), ranking-authority.test.ts의 구식 0.85 공식 주석을 bounded 공식으로 정정
- **보안 영향**: 없음 · **남은 위험**: news single-run이라 실행 간 백엔드 가용성 노이즈 잔존 (median-of-3로 완화),
  breaking-news UX 관점에서 bounded 뉴스 가중치가 속보성 결과를 덜 끌어올릴 수 있음 (NDCG 의도와 트레이드오프)
- **후속 작업**: 전체 500쿼리 median-of-3 재기준선 → NDCG 0.60 목표 차기 레버 (커버리지 미스 118건)

---

#### 작업 6: ja(일본어) 커버리지 개선 — 언어 오분류 수정 + 권위 맵 추가 (S12)
- **작업 ID**: FIX-2026-08-06-03
- **작업명**: ja 쿼리 언어 오분류(zh 라우팅) 수정 + JAPANESE_TRAVEL/TECH/FACT 권위 맵 추가
- **수정한 파일**: `src/lib/orchestrator.ts`, `src/lib/search/ranking.ts`, `tests/unit/orchestrator.test.ts`, `tests/unit/ranking-authority.test.ts`
- **핵심 변경사항**:
  - `isJapaneseQuery`에 kana 없는 한자합성어 마커 추가 (機械学習/入門/設計/規制/実装/開発環境/開発者/人気ランキング) — 기존에는 zh-CN으로 오분류되어 bing이 중국 결과를 반환하던 7건 중 6건 해소
  - `JAPANESE_TRAVEL_AUTHORITY`(japan-guide +0.20, tripadvisor +0.18~0.20, gotokyo/osaka-info 등), `JAPANESE_TECH_AUTHORITY`(qiita/zenn/dev.to/typescriptlang/ipa), `JAPANESE_FACT_AUTHORITY`(kotobank/weblio/goo/eow), `JAPANESE_NEWS_AUTHORITY` 확장(famitsu/digital.go/nintendo)
  - 코드 리뷰 반영: **kotobank 이중 카운팅 수정** (TECH_DOCS_AUTHORITY 게이트가 factual 포함해 JAPANESE_FACT와 중첩 → +0.27 중복. kotobank를 FACT 단독 소유로 정리)
- **해결된 문제**: ja 태그 55쿼리 NDCG 0.4616 → **0.5162 (+0.055, single-run)**. 오분류 쿼리 복구: ja-fact-11 0.000→1.551, ja-tech-10 0.000→0.494, ja-news-05 0.000→0.464, ja-tech-06 0.342→0.827. pass 55/55
- **테스트 결과**: orchestrator +4건(합성어/간체 비오탐/번체 트레이드오프), ranking-authority +4건 → 유닛 전체 **1,251건 통과**, typecheck 0
- **성능 변화**: 해당 없음 · **보안 영향**: 없음
- **남은 위험**: `Kubernetes 基本`(基本은 중국어 공유 글리프 — 의도적 보류), 단일 run 노이즈로 fact 쿼리 일부 등락, 入門/設計/規制의 번체 중국어 공유에 따른 희귀 오탐은 문서화된 트레이드오프
- **후속 작업**: 전체 500쿼리 median-of-3 재기준선에 포함

---

#### 작업 7: DO·Analytics Engine 바인딩 설정 상세 운영 절차 문서화 + 검증 스크립트 버그 수정
- **작업 ID**: DOC-2026-08-06-02
- **작업명**: docs/11 기준 DO 8종 + Analytics Engine 바인딩 설정 상세 절차 작성
- **산출물**: `docs/12_DO_ANALYTICS_BINDING_PROCEDURE.md` (신규) + `scripts/verify-analytics-binding.ts` 수정 + docs/11 링크 추가
- **핵심 내용**:
  - DO 8종(핵심) + 3종(CLICK_LOG/EXPERIMENT/CANARY — 스크립트 미커버 명시) 바인딩 이름↔클래스↔기능 매핑, Dashboard 절차, **Redeploy 필수** (Cloudflare 공식), 설정 후 검증 사이클, 롤백
  - Analytics Engine: 데이터셋 `ssak_search` (언더스코어만 허용, 하이픈 배포 거부), binding `ANALYTICS`
  - **실측 현재 상태 기록**: RATE_LIMITER/PAGES/API_KEY 미바인딩(501), SPACE 500, THREAD/LIBRARY/USER_PROFILE 바인딩됨, CRAWLER 429(동작)
- **수정한 파일**: `scripts/verify-analytics-binding.ts`
  - **버그**: `SEARCH_API_METRICS` 하드코딩 기대 → wrangler.jsonc 실제 값 `ssak_search`와 불일치해 **항상 FAIL**하던 검증 스크립트
  - **수정**: `EXPECTED_PRODUCTION_DATASET='ssak_search'` + 데이터셋 shape 검증(영숫자/언더스코어) + 하이픈 규칙을 basename 기반 dev config 예외 처리 + dev 경고 게이팅
  - **검증**: prod PASS (ssak_search), dev PASS (SEARCH_API_METRICS-dev, 경고 없음), typecheck 0
- **참고**: Pages 프로젝트 내 DO 생성 불가 (Cloudflare 공식 제약) — Dashboard 바인딩 + 재배포가 유일한 안정 경로. API(`deployment_configs`) 경로는 공식 문서 표면 제한적 → 문서에 '검증 필요'로 명시
- **후속 작업**: 운영자 대시보드에서 A2~A4(PAGES/API_KEY/RATE_LIMITER) + SPACE 바인딩 추가 후 §4 검증 사이클 실행

---

#### 작업 8: 사실 교차검증기 — 다중 소스 주장 교차검증 모듈 (S13)
- **작업 ID**: FEAT-2026-08-06-01
- **작업명**: src/lib/answer.ts 기반 다중 소스 사실 교차검증 모듈 설계·구현 + API 노출
- **신규 파일**: `src/lib/fact-check.ts`, `tests/unit/fact-check.test.ts`
- **수정한 파일**: `src/lib/answer.ts`, `src/lib/util.ts`, `src/lib/orchestrator.ts`, `src/lib/cache.ts`, `src/routes/search.ts`, `src/types.ts`, `tests/unit/routes.test.ts`, `STRATEGIC_PLAN.md`
- **핵심 변경사항**:
  - `crossCheckFacts(results, opts)` — 주장 추출(정보성 점수 + 소스 내 중복 제거 + CJK 최소길이 절반) → 소스 간 클러스터링(불용어 제거 Dice 0.55 + CJK 바이그램 + 동일 수량 부스트) → 판정(corroborated/single-source/conflicting) → 충돌 감지(부정-긍정 불일치 EN/KO/ZH/JA + 동일 단위 수치 모순 >15%)
  - `formatFactCheckSection(report)` — 답변에 덧붙일 텍스트 렌더링, `FactCheckReport` + `SearchAnswer.factCheck` 필드 (types.ts)
  - `answer.ts` — `splitIntoSentences`/`similarity`를 **util.ts로 이동 후 재-export** (answer↔fact-check 순환 import 제거), `generateAnswer` 6번째 인자 `{ includeFactCheck }`
  - `orchestrator.ts` — `include_fact_check` 파라미터 전달 + **agentic(Pro) 답변은 post-hoc attach** (`!answer.factCheck` 가드로 표준/Pro 경로 모두 커버)
  - `cache.ts`/메모리 키 — `ifc=` 캐시 파라미터 추가 (fact-check 응답이 미요청 캐시와 섞이지 않도록)
  - `routes/search.ts` — POST body / GET 쿼리 `include_fact_check` 파싱
- **해결된 문제**: 답변의 주장이 단일 소스에 의존하거나 출처 간 상충이 그대로 전달되던 문제. 여러 독립 소스에서 확인된 주장(corroborated)과 상충 주장(conflicting)을 구조적으로 제시해 환각·단일출처 과신 완화. LLM/유료 API 없이 결정적·무비용 동작
- **테스트 결과**: fact-check 16건(교차검증/단일소스/부정충돌/수치충돌/동일값 비충돌/빈결과/보일러플레이트/중복제거/CJK/opts 3종/섹션/answer 통합 2종) + routes 파라미터 2건 → 유닛 전체 **1,269건 통과** (68파일), typecheck 0
- **코드 리뷰 반영**: ① 순환 import 제거 (프리미티브 util.ts 이동) ② `without/unlike/no` 부정 오탐 제거 ③ 비효율적 adaptive threshold 제거(flat 0.55) ④ STOPWORDS 정리(내용어 보존) ⑤ opts 테스트 3종 추가 ⑥ agentic 경로 사실검증 누락 수정
- **성능 변화**: include_fact_check 미요청 시 0 오버헤드 (요청 시에만 동기 계산, O(소스×6×그룹))
- **검색 품질 변화**: 결과 랭킹에 영향 없음 (답변 메타데이터만) · **보안 영향**: 없음 (외부 호출 없음)
- **남은 위험**: ① 엔티티 차이 구분 불가 ("GDP 5%" vs "inflation 5%" — 렉시컬 휴리스틱 한계, 정밀도 우선) ② 섹션 라벨 영문 고정 ③ SSE `/stream` 미연결 ④ Pro(agentic) 답변은 post-hoc attach로 커버
- **후속 작업**: 프론트엔드에서 `include_fact_check=true` 노출 · 다국어 라벨 · LLM 기반 고급 교차검증(선택)

---

#### 작업 9: 대규모 변경 커밋 분리 — 9개 논리 커밋으로 재구성 (GIT-2026-08-06-01)
- **작업 ID**: GIT-2026-08-06-01
- **작업명**: 약 7.2만 라인 변경을 한 커밋이 아닌 논리 단위 9개 커밋으로 분리
- **배경**: 이번 세션의 기능·eval·문서 변경이 작업 트리에 미커밋 상태(63개 수정 + 29개 신규, 약 7.2만 줄)로 축적 —
  단일 커밋으로 묶으면 회귀 추적이 불가능해 논리 단위 분리를 실행
- **분리 결과** (총 106개 파일, **+148,199 / −1,344**):

  | # | 커밋 | 내용 | 파일 수 |
  |---|---|---|---|
  | 1 | `a23428c` feat(ranking) | 기본 정렬 블렌드 + 도메인 권위·bounded freshness + `SearchContext.japanese` — S2/S3/S6/S11 | 6 |
  | 2 | `8c7d4a4` feat(eval) | 500쿼리 골든셋·median-of-3·wikipedia 429 안정화 — S8/S9 | 34 |
  | 3 | `f7ff218` feat(health) | 선택적 백엔드 unconfigured 처리 — S10 | 5 |
  | 4 | `fd2bc36` fix(orchestrator) | ja 라우팅 개선 — S12 | 2 |
  | 5 | `896f47d` feat(backends) | 뉴스 RSS·유튜브 상세·야후 티커 — S7 | 31 |
  | 6 | `2af3f81` feat(security) | 프롬프트 인젝션 방어 (evidence quarantine) — 06 S3 | 8 |
  | 7 | `edfaf85` feat(answer) | 사실 교차검증기 — S13 | 10 |
  | 8 | `b01089c` chore(infra) | DO 11개 re-export + wrangler exports — DOC-03 | 3 |
  | 9 | `2c61664` docs(ops) | DO·Analytics Engine 바인딩 절차 + SUBREQUEST_QUOTA — DOC-02 | 20 |

- **분리 방식**:
  - 6개 공유 파일(orchestrator.ts / routes/search.ts / types.ts / util.ts / cache.ts / routes.test.ts 등)은
    `git diff -U1` hunk 단위로 분할 스테이징 헬퍼(`/tmp/stage_hunks.py`)로 **커밋별 정확히 분할** — 파일 전체를 한
    커밋에 몰아넣지 않고 기능 단위 hunk만 스테이징
  - **모든 중간 커밋 스냅샷 typecheck 0 에러** (git worktree 9개 생성해 개별 검증)
- **검증 중 발견·수정한 문제 2건**:
  1. `ranking-authority.test.ts`가 이후 커밋의 타입을 참조 → `git add -p`로 해결 불가능한 커밋 간 순환 의존 →
     **interactive rebase**로 S7 커밋으로 이동
  2. `ranking.ts`가 `ctx.japanese`를 읽지만 해당 필드가 커밋 4에만 존재 → `context.ts`를 커밋 1로 이동 +
     `japanese?: boolean` **optional로 완화**
- **테스트 결과**: 전체 테스트 **1,271건 / 68파일 통과**, typecheck 0 에러, 시크릿 스캔 0건
- **최종 상태**: 작업 트리 완전 클린 (커밋 후 잔여 변경 0)
- **남은 위험**: 커밋은 로컬에만 존재 (원격 push 미실시). 3커밋(eval/code-features/docs-ops) 재분할 목록은
  작성했으나 실행하지 않음 — 현재 9커밋 구성이 유효
- **후속 작업**: 커밋 후 회귀 확인을 위한 eval:median 재측정 (작업 10)

---

#### 작업 10: 커밋 후 회귀 확인 — eval:median 500쿼리 재측정 (VER-2026-08-06-01)
- **작업 ID**: VER-2026-08-06-01
- **작업명**: 9개 커밋 분리 후 NDCG 회귀 여부 확인 (`--save` 없이 baseline 보존, 2026-08-06 18:00~19:16 KST)
- **실행**: `npm run eval:median` (500쿼리 × 3회) — 데몬화(이중 포크+setsid)로 백그라운드 실행
- **결과**:

  | run | NDCG@10 | MRR | P@10 | pass | p50 |
  |---|---|---|---|---|---|
  | run-1 | 0.5033 | 0.4855 | 0.2660 | 499/500 | 987ms |
  | run-2 | 0.5289 | 0.4874 | 0.2793 | 498/500 | 856ms |
  | run-3 | 0.5456 | 0.4967 | 0.2880 | 500/500 | 862ms |
  | **median** | **0.5289** | **0.4940** | **0.2794** | **499/500** | **862ms** |

  - **baseline(04:41) 대비**: NDCG@10 0.5327 → 0.5289 (**−0.004, 노이즈 범위**) · MRR 0.4626 → 0.4940 (**+0.031 상승**)
    · pass 500/500 → 499/500
  - **실패 1건**: `en-fact-01` (wikipedia 429 — S9에서 문서화한 기지의 가용성 노이즈, NDCG 0.177/결과 10건은 정상)
  - **regressions 264건** (개별 쿼리 기준): ndcgAt10 116 · responseTimeMs 129 · resultCount 18 · passStatus 1 —
    라이브 백엔드 가용성(wikipedia 429 등) 노이즈로, **중앙값 집계에서는 평균 NDCG가 baseline과 동일 범위**
- **결론**: 커밋 분리가 검색 품질에 **실질 회귀 없음** 확인 (NDCG −0.004는 실행 간 노이즈, MRR은 상승).
  baseline(`eval/baselines/latest.json`)은 `--save` 미사용으로 **04:41 기준 유지**
- **남은 위험**: 단일 run 기준 en-fact-01 등 wikipedia 필수 쿼리는 여전히 업스트림 429에 취약 —
  median-of-3 집계로 게이트 안정화 (운영 문서화된 권장안)
- **후속 작업**: 3커밋 재분할 실행 여부 결정 · 다음 NDCG 0.60 레버(커버리지 미스) 검토

---

## 2026-08-13 — 3차 재검증 세션 (테스트 안정성 + 백엔드 재시도)

### 검증 실측 (모두 실행 기반)
- typecheck 0 에러 · build 성공 (1,113.74 kB / gzip 326.89 kB) · 유닛 **2,543건 / 129파일 통과** (세션 시작 시 1건 flaky 실패)
- 라이브 eval `--tag technical`: **158/158 통과** (avg 1,219ms · p50 824ms · p95 3,503ms · 평균 9.9건) — 백엔드 커버리지: bing 159 · hackernews 89 · stack 81 · dbpedia 71 · wikipedia 35 · naver 24 · github 43 · openalex 8 · arxiv 9 외
- 라이브 프로브: arxivSearch/openalexSearch 각 3건 정상 (재시도 래퍼 적용 후)

### 수정 1: auth.test.ts flaky 테스트 고정 (P18)
- **작업 ID**: FIX-2026-08-13-01
- **작업명**: `requireAdmin` DO mock의 비결정적 실패 제거
- **수정한 파일**: `tests/unit/auth.test.ts`
- **핵심 변경사항**:
  - 원인: `vi.doMock`(런타임 등록) + `beforeEach(vi.doUnmock)`가 `auth.ts` 내부 동적 `import('./api-key-do')`와 경합 — api-key-do.ts가 `cloudflare:workers`(node 단위 환경에서 미해석)를 import하므로, mock 미적용 시 실모듈 평가 실패 → 401 폴백 → 403 기대 테스트 실패. **3회 중 2회 실패하는 flaky 상태를 15회 반복 재현으로 확정**
  - 해결: 파일 상단 **hoisted `vi.mock`** + 가변 `mockValidateKey` 구현체 주입(try/finally로 복원)으로 전환 — 런타임 레지스트리 경합 제거. DO 관련 테스트 3건(revocation 메시지 매핑, DO 장애 시 legacy 폴백, read-scope DO 키 403)이 결정적으로 통과
  - 정적 import에서 미사용 심볼 정리
- **테스트 결과**: auth.test.ts **49건 × 15회 연속 통과** · 전체 유닛 2,543건 통과
- **성능 변화**: 없음
- **검색 품질 변화**: 없음
- **보안 영향**: 없음 (동작 변경 없음 — 테스트만)
- **남은 위험**: node 단위 환경에서 `cloudflare:workers` 의존 DO 모듈은 실모듈 로딩 불가(기지의 제약) — DO 로직 검증은 integration 풀 또는 mock 경유
- **후속 작업**: 유사 패턴(doMock+동적 import)의 다른 테스트 스캔

### 수정 2: arxiv / openalex / brave 일시 장애 재시도 구현 (P19)
- **작업 ID**: FIX-2026-08-13-02
- **작업명**: docs/16 권고(순위 1~3) 구현 — 5xx/네트워크 1회 재시도, 회로 개방·429·4xx fail-fast
- **수정한 파일**: `src/lib/util.ts`(isCircuitOpenError 추가) · `src/lib/specialized.ts`(arxiv) · `src/lib/openalex.ts` · `src/lib/brave-search.ts` · 테스트 3종 + backend-timeout-consistency.test.ts
- **핵심 변경사항**:
  - 공통: `TransientXxxError` 마커(5xx+네트워크 래핑)만 `retryable`, `delaysMs:[150]`, `maxRetries:1`, 예산 `splitRetryBudget(ceiling, 2, 150, 800)` → worst case = ceiling 정확히 (arxiv/openalex 4500, brave 2000)
  - 회로 개방 throw(`Upstream unavailable…`/`Rate limiter rejected…`)를 `retryable`에서 제외하는 `isCircuitOpenError` 공용 헬퍼 — docs/16 규칙 4
  - brave는 직접 fetch 유지(AbortController) + 마커 재시도 추가 — docs/16 §3.1 결정
  - 429/4xx는 응답 그대로 반환 → fail-fast (150ms 재시도가 같은 할당량 윈도우에 다시 걸림)
  - `backend-timeout-consistency.test.ts`: 단발 fetch 정합 → **재시도 체인 분할 예산 정합**(perAttempt=splitRetryBudget, 2×perAttempt+150===ceiling)으로 갱신
- **테스트 결과**: 신규 유닛 17건(arxiv 6, openalex 6, brave 4, 정합성 1) 포함 **2,543건 전체 통과** · typecheck 0 에러 · eslint 클린
- **성능 변화**: 5xx/네트워크 시 최대 +150ms~+925ms(분할 예산 내), 정상 경로는 무변화
- **검색 품질 변화**: arxiv 503·openalex/brave 블립 시 결과 전량 손실 → 1회 재시도로 회복. 학술 gold(arxiv.org 등) 드롭 감소 기대
- **보안 영향**: 없음 (SSRF/회로 차단기 우회 없음 — 오히려 회로 개방 재시도를 명시 차단)
- **남은 위험**: 재시도가 rateLimitPerMinute을 추가 소모(arxiv 30/min, 1회 한정으로 완화). searxng/reddit/stack-exchange는 조건부 권고로 미적용(우선순위 낮음, docs/16 §4)
- **후속 작업**: eval median-of-3로 학술 태그 NDCG 변화 실측 · 429 정책 1회 한정 여부 재검토

### 수정 3: 통합 테스트 복구 — DO 바인딩 self-referencing 전환 (P21)
- **작업 ID**: FIX-2026-08-13-03
- **작업명**: 2026-08-10 DO 분리 배포(commit 39bbfe2) 이후 깨진 통합 테스트 시작 오류 해소
- **수정한 파일**: `vitest.integration.config.ts` · `vitest.config.ts` · `tests/integration/do-bindings.ts`(신규)
- **핵심 변경사항**:
  - 원인: DO 바인딩에 `script_name: "ssak-do-worker"`가 설정되어 있었으나 miniflare가 해당 워커를 해석할 수 없음 (워커 미등록 + TS 보조 워커는 acorn JS 파서로 파싱 불가)
  - 해결: 메인 워커(src/index.tsx)가 11개 DO 클래스를 재수출하므로 `script_name` 제거 + **self-referencing 바인딩**으로 전환 — 테스트 런타임에서 DO 네임스페이스가 정상 materialize (`RATE_LIMITER: object` 프로브로 확인)
  - SQLite 마이그레이션 선언(migrations) 추가로 storage 기반 네임스페이스 생성 보장
- **테스트 결과**: `npm run test:integration` **8파일/108건 전체 통과** (세션 시작 시 시작조차 실패하던 상태 → 복구)
- **보안 영향**: 없음 (테스트 설정만 변경)
- **남은 위험**: `RATE_LIMITER binding not available` 경고는 테스트가 부분 env로 executeSearch를 직접 호출하기 때문(정상). 통합 풀에서 DO 검증은 이제 가능하나 프로덕션 DO 바인딩(P2)은 별개

### 수정 4: searxng / reddit / stack-exchange 일시 장애 재시도 구현 (P19 완결)
- **작업 ID**: FIX-2026-08-13-04
- **작업명**: docs/16 조건부 권고(§3.2/§3.6/§3.9) 구현 — 5xx/네트워크 1회 재시도, 429·4xx·회로 개방 fail-fast
- **수정한 파일**: `src/lib/searxng-search.ts` · `src/lib/specialized.ts`(reddit) · `src/lib/stack-exchange.ts` · 테스트 3종 + backend-timeout-consistency.test.ts
- **핵심 변경사항**: FIX-02와 동일 패턴(TransientXxxError 마커 + `withRetry` + `isCircuitOpenError` 차단). 예산: searxng `splitRetryBudget(3000,2,150,800)=1425`, stack-exchange `(4000,2,150,800)=1925`, reddit `(2000,2,150,800)=925` → worst case = fanout ceiling 정확히
- **테스트 결과**: 신규 유닛 10건 + 정합성 테스트 3건 갱신, **2,561건 전체 통과** · typecheck 0 에러
- **성능 변화**: 정상 경로 무변화, 장애 시 최대 +925ms(분할 예산 내, per-backend 타이머 미발화)
- **검색 품질 변화**: zh/searxng 5xx·reddit 블립·SE API 장애 시 결과 전량 손실 → 1회 재시도로 회복
- **보안 영향**: 없음
- **남은 위험**: searxng 자체 인스턴스 가용성은 설정(SEARXNG_URL) 의존. stack-exchange 429(할당량 소진)는 의도적 fail-fast 유지

### 수정 14: 백엔드별 gold 기여 리포트 (2026-08-13)
- **작업 ID**: FIX-2026-08-13-14 (분석 + 스크립트)
- **작업명**: 500쿼리 × 3회 실행에서 백엔드별 사용 빈도 vs gold 기여 집계
- **산출물**: `scripts/report-backend-coverage.ts` (gold 도메인 → 시그니처 백엔드 우선순위 체인 귀속) + `docs/02_SEARCH_QUALITY_ASSESSMENT.md` §2.5
- **핵심 결과** (1,500 query-run):
  - gold 기여율 상위: **arxiv 0.878 > yahoo-finance 0.750 > naver 0.705 > qiita 0.697 > github 0.581** (절대 기여 github 250건 1위)
  - **최대 커버리지 갭: stack-exchange (expected 162 중 사용 4건) + reddit (51 전부 미사용)** — gold 전량 bing 의존 (08-11 스냅샷, FIX-04 재시도 전 상태)
  - **openalex missUsed 22건** — 사용해도 학술 gold 미스 절반 (FIX-11 locations 수집으로 개선)
  - **wikipedia hitRate 0.249** — 429 전멸이 지배, S73으로 완화 예정
  - **일반 웹(bing) gold 히트 726건** — 뉴스/일반 gold의 최대 단일 공급원
- **검증**: 스크립트 재실행 안정 (집계 결정적)
- **후속**: FIX-04/-09/-11/-13 적용 후 재실행하여 hitRate 변화 실측 권장

### 수정 16: github.com gold flicker 해결 (S75) — waitFor + 캐시 + eval 페이싱
### 수정 17: openalex 429 cooldown 가드 (S76) + S73 wikipedia 재측정
- **작업 ID**: FIX-2026-08-13-17
- **작업명**: S73 후 en-acad/zh-fact 재측정 중 발견한 openalex 429 무방어 구조 해결 + wikipedia gold 히트율 재측정 결과 기록
- **수정한 파일**: `src/lib/openalex.ts`(cooldown 가드 5함수 + openalexSearch 연동) · `tests/unit/openalex.test.ts`
- **핵심 변경사항** (재측정 실측 기반):
  - **S73 재측정 (en-acad 17 + zh-fact 16 = 33쿼리, 라이브)**: ① **arxiv 17/17 — FIX-09 페이싱 효과 재확인** (이전 run-1에선 08~17 전부 누락) ② **zh-fact wikipedia gold 9/16** — S73 전 기준선 평균 8.67/16과 동등, run-3 최악(5/16, en 429→zh 전멸) 대비 구조적 안정화 (S73 후엔 언어별 독립이라 전멸 시나리오 불가). 단, 단일 실행이라 통계적 개선 단정은 불가 ③ **openalex 0/17 — 코드 문제 아님**: OpenAlex API가 현재 **429 + Retry-After 43,186s(≈12h)** — 익명 풀 완전 소진 (x-ratelimit-remaining: 0). 라이브 확인으로 원인 확정
  - **openalexSearch에 cooldown 가드 부재 확인** (wikipedia B1/arxiv S23과 달리) — 429 시 매 쿼리마다 hammering하며 subrequest 낭비. wikipedia/arxiv/github 패턴 그대로 구현:
    - `recordOpenalexRateLimit` — 429 시 Retry-After 준수, **1h 상한 클램프** (실측 12h 창에서 2분마다 429를 때리는 120s 상한과 달리, 1h마다 1회 프로브로 절충)
    - `isOpenalexRateLimitedShared`(local fast path + shared DO) / `mirrorOpenalexCooldown` / `resetOpenalexRateState`
    - openalexSearch 시작부 가드 — cooldown 중 fetch 없이 즉시 [] + 경고 로그
- **테스트 결과**: 신규 S76 유닛 3건(cooldown 스킵 / Retry-After 1h 클램프 / reset 복구) 포함 **2,589건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **성능 변화**: openalex 429 창에서 네트워크 체인 스킵 (subrequest 절약)
- **검색 품질 변화**: 429 창 중 연속 호출 시 즉시 빈 결과 반환 (기존과 동일 결과, hammering만 제거) — 창 회복 후 자동 재개
- **보안 영향**: 없음
- **남은 위험**: openalex 익명 풀은 **IP 단위 전역 소진 시 12h 창** (이번 실측) — 회복 전까지 openalex gold 미커버는 다른 학술 백엔드(arxiv)가 커버. mailto= 폴리트 풀 등록 시 한도 상향 가능 (현재 미설정). zh-fact 재측정은 단일 실행이라 S73 효과의 통계적 확인을 위해선 3회 반복 측정 필요

### 수정 16: github.com gold flicker 20건 원인 귀속 및 개선
- **작업 ID**: FIX-2026-08-13-16
- **작업명**: github.com gold flicker 20건 원인 귀속 및 개선
- **수정한 파일**: `src/lib/orchestrator.ts`(waitFor) · `src/lib/specialized.ts`(github 캐시) · `eval/runner.ts`(github 페이싱) · `tests/unit/fanout.test.ts` · `tests/unit/specialized.test.ts`
- **핵심 변경사항** (3회 stored runs 실측 귀속):
  - **원인 ① early-exit (20건)**: lt-10/12/13/14/17 run-3이 "bing dbpedia"만 — bing이 phase 1에서 10개를 채우면 github task 결과가 폐기. **wikipedia/arxiv/qiita/juejin은 waitFor로 보호되는데 github/github-issues만 빠져 있었음** → waitFor에 추가 (ceiling 2000ms로 바운드)
  - **원인 ② github quota (라이브 재현)**: technical 태그 100쿼리 연속 실행에서 **GitHub Search API 무인증 10 req/min 초과 → 403 → S23 cooldown → 이후 쿼리 전부 github 부재**. githubSearch+githubIssuesSearch가 같은 quota 공유 → ① **githubSearch/githubIssuesSearch 인메모리 캐시 추가** (wikipedia 패턴, 0건/403 미캐시 — 중복 호출 절약) ② **eval 페이싱에 github 6000ms 추가** (10 req/min 내, arxiv 2200ms보다 긴 구간 — technical 쿼리만 적용)
  - **원인 ③ 랭킹 아웃 (9건)**: github 결과가 top-10에서 밀림 (python.org 문서가 BM25로 압도) — github.com authority 상향은 전역 리스크라 미수정, 잔여로 문서화
- **테스트 결과**: 신규 S75 4건 (fanout github/github-issues waitFor 2 + github 캐시 2) 포함 **2,586건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **성능 변화**: github 캐시 — 반복 쿼리 API 호출 절약 (quota 보호). eval: technical 쿼리당 +6s (정확성 위해)
- **검색 품질 변화**: github.com gold (기술 gold 최대 시그니처 공급원, 250/1500 query-run) 유입 안정화
- **보안 영향**: 없음
- **남은 위험**: 랭킹 아웃 9건 (github 결과가 top-10 밖 — 평가 gold vs 검색 관련성의 균형, 별도 튜닝). github quota는 여전히 프로덕션 벌크 시 403 가능 (캐시로 완화)

### 수정 13: wikipedia 429 cooldown 언어별 분리 (S73) — zh flicker 직접 해결
- **작업 ID**: FIX-2026-08-13-13
- **작업명**: en.wikipedia 429가 모든 언어 wikipedia를 죽이던 전역 cooldown → 언어별 독립 창
- **수정한 파일**: `src/lib/specialized.ts`(전역 변수 → `wikipediaRateLimitedUntilByLang` Map + 키 `cooldown:wikipedia:${lang}`) · `src/lib/orchestrator.ts`(mirror 가드에 `effectiveWikiLang` 전달) · `tests/unit/specialized.test.ts`
- **핵심 변경사항**:
  - 실측 (3회 stored runs): wikipedia gold flicker 40건 — **wikipedia 백엔드가 backend 목록에 있는 실행 = 항상 gold 히트, 없는 실행 = 항상 미스**로 정확히 일치. 백엔드 누락의 직접 원인은 wikipedia 429 → 30s cooldown 창
  - 재현 (라이브): en wikipedia 429 ×3 → cooldown armed → **zh/ja 쿼리들이 0ms로 전멸** (en 429 하나가 언어 무관 전역 창으로 전 언어 차단)
  - 근거: wikimedia rate limit은 **per-site(per-IP, per-project)** — 실측으로 en 429 상황에서도 zh/ja REST가 200 정상 (zh "量子计算" → 量子计算机 등). zh flicker 20%(언어별 최악)는 en 429가 zh를 죽이는 이 구조가 주범
  - 수정: cooldown을 언어별 Map으로 분리 (en은 레거시 키 `cooldown:wikipedia` 유지 — 저장된 DO 상태와 호환, 나머지는 `cooldown:wikipedia:${lang}`). `isWikipediaRateLimitedShared`/`mirrorWikipediaCooldown`/`recordWikipediaRateLimit`에 language 파라미터 추가 (기본값 'en'으로 기존 호출 호환)
  - **zh mirror(wikidata)의 추가 실측**: 당시 결론("wbsearchentities가 zh 라벨 검색 불가")은 **프로브 아티팩트**로 정정됨 (FIX-15에서 재검증 — language=zh 파라미터 전달 시 정상 매칭, 함수 0건은 연속 프로브로 켜진 60s wikidata cooldown 때문). Q11016 zhwiki sitelink 오염(zh.wikipedia.org/wiki/技术)은 실재하나 검색 파이프라인이 해당 엔티티를 매칭하지 않아 우회 — S74 sitelink 제목 검증 필터로 방어 강화
- **테스트 결과**: 신규 S73 유닛 3건(단일 언어만 armed / en armed에도 zh는 네트워크 체인 / per-language shared 키) 포함 **2,580건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **성능 변화**: 정상 경로 무변화 (cooldown 체크 시 Map 조회 1회 추가)
- **검색 품질 변화**: en 429가 zh/ja wikipedia를 불필요하게 차단하던 문제 해소 — eval 벌크 실행에서 en wikipedia rate limit 후에도 zh/ja gold 유지 (zh flicker 20% 최대 레버)
- **보안 영향**: 없음
- **남은 위험**: zh/ja wikipedia 자체 429 시 gold 미커버는 wikidata mirror가 커버 (S74 필터 적용 후 6개 쿼리 라이브 검증 완료). wikidata 60s cooldown은 연속 429 시 mirror 무력화 가능. 라이브 검증: en armed 상태에서 zh가 1209ms 네트워크 체인으로 실제 fetch (수정 전 0ms 스킵)

### 수정 15: wikidata mirror sitelink 오염 방어 필터 (S74) + zh 검색 재검증
- **작업 ID**: FIX-2026-08-13-15
- **작업명**: zh wikipedia 자체 429 시 gold를 커버하는 wikidata mirror의 견고화
- **수정한 파일**: `src/lib/specialized.ts`(wikidataWikiSearch sitelink 제목 검증) · `tests/unit/specialized.test.ts` · `scripts/report-backend-coverage.ts`(타입 수정)
- **핵심 변경사항**:
  - **재검증 (라이브)**: 이전 세션의 "wbsearchentities가 zh 라벨로 검색 불가 → mirror 0건" 결론은 **프로브 아티팩트**. `language=zh` 파라미터를 넘기면 zh 라벨 매칭 정상 (Q17995793 "量子计算" → zh.wikipedia.org/wiki/量子计算). 함수 0건의 실체는 연속 프로브로 켜진 **wikidata 60s cooldown** (429 1회로 mirror 전체 무력화)
  - **S74 sitelink 오염 방어**: wikidata sitelink가 엉뚱한 문서를 가리키는 케이스(Q11016 zhwiki → zh.wikipedia.org/wiki/技术 — 엔티티 zh 라벨도 동일하게 오염)는 라벨 검증만으로는 검출 불가(둘 다 틀림). **sitelink URL 제목 ↔ cleaned 쿼리 관련성**을 추가 검증 — 라벨 검증과 OR 조건(간체/번체 변형·라벨만 일치 케이스 보존)
- **테스트 결과**: 신규 S74 유닛 2건(오염 sitelink 스킵 / 번체 변형 유지) 포함 **2,582건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **검색 품질 변화**: 라이브 검증 — zh 量子计算→2건(量子计算/量子计算机)·区块链→1건·黑洞→3건·人工智能→4건, ja 人工知能→5건·地球温暖化→1건 전부 정상 wikipedia URL
- **보안 영향**: 없음
- **남은 위험**: wikidata 60s cooldown(429 시)은 mirror 무력화 창 — Retry-After 없음이 확인돼 보수적 바운드 유지. zh 자체 429 + wikidata 429 동시 발생 시 gold 미커버 (이중 장애)

### 수정 12: gold 표준 EN_FACT 템플릿 nasa.gov 오버브레스 교정 (S72)
- **작업 ID**: FIX-2026-08-13-12
- **작업명**: P20 후속 flicker 쿼리 gold 재검증 — en-fact-16~40 공통 템플릿의 nasa.gov 제거 (14건)
- **수정한 파일**: `eval/gold-standards.json` · `scripts/generate-gold-standards.ts`
- **핵심 변경사항**:
  - 실측 (3회 stored runs 재계산): flicker 쿼리 **58건** — 도메인별 귀속 결과 **github.com 20 · en.wikipedia.org 15 · zh.wikipedia.org 14 · investing.com 8 · britannica.com 7 · baike.baidu.com 7 · arxiv.org 5** 등. 즉 flicker의 주범은 gold 오류가 아니라 **보조 백엔드(wikipedia/dbpedia/github) 가용성 변동** (이전 턴 FIX-02/-04/-09/-10 재시도·가드로 이미 완화 중)
  - gold 오류는 en-fact-16~40의 **EN_FACT 공통 템플릿에 nasa.gov가 스프레드**된 오버브레스 1종. 25개 쿼리 중 **14개(vaccines/immune system/entropy/diamonds/memory/black swan/anesthesia/periodic table/WiFi/artificial photosynthesis/CRISPR/metaverse/echolocation/nervous system)**는 ① 3회 실행 풀에서 nasa.gov 결과 **전무** ② NASA가 주제 권위가 아님 → S63/S69 선례(제로 풀 존재 + 의도 불일치 → gold 제거)로 제거
  - NASA가 권위인 **11개(black hole/fusion/northern lights/airplanes/speed of light/greenhouse/tides/Fermi/dark energy/glaciers/neutrino)는 유지** — generator의 EN_FACT 베이스에서 nasa.gov 분리 + 유지 쿼리에 명시 추가 (신규 쿼리 생성 시 오버브레스 재발 방지)
- **테스트 결과**: gold 관련 테스트 5파일 125건 · 전체 유닛 **2,577건 통과** · typecheck 0 에러
- **검색 품질 변화**: 없음 (평가 기준 교정 — 검색 코드 무변경). NDCG 실측: 14개 쿼리 평균 +0.019~0.025 (IDCG 분모 정밀화, nasa.gov가 결과에 등장한 적이 없어 순수 측정 정확성 개선), 전체 500쿼리 평균 +0.5~0.7 mNdcg
- **drift 검증 (scripts/detect-gold-drift.ts, S60)**: 저장 run-1..3 재계산 → **drift 17건 전부 양수, 음수 0건, net Δ+0.1042** — en-tech 6건(FIX-06 shift 교정 누적, Δ+0.076~0.613, gate-significant 6건) + en-fact 11건(S72 nasa.gov 제거, Δ+0.011~0.045). S58 gate gold-robust로 CI 무영향, RECORDED NDCG 이동 → **baseline refresh 권장** (`npm run eval:median:save`)
- **보안 영향**: 없음
- **남은 위험**: flicker 자체는 백엔드 가용성 문제로 gold 교정과 무관 — wikipedia/dbpedia/github 재시도 강화가 지속 레버 (08-13 S73으로 zh wikipedia 전역 차단 해소). baseline refresh 미수행 시 RECORDED NDCG가 현재 gold와 불일치

### 수정 11: openalex locations 배열 수집 — arxiv.org gold 유입 개선
- **작업 ID**: FIX-2026-08-13-11
- **작업명**: OpenAlex work의 `locations` 배열을 URL 후보에 추가 (arxiv preprint 유입)
- **수정한 파일**: `src/lib/openalex.ts`(OpenAlexWork.locations + workUrlCandidates + select) · `tests/unit/openalex.test.ts`
- **핵심 변경사항**:
  - 실측: en-acad 쿼리에서 openalex가 **doi.org만 8건 반환** (ResNet/self-attention/diffusion — arxiv 0건). OpenAlex API 원본 응답 확인 결과 **arxiv.org preprint이 `locations` 배열에 존재**하는데 primary/best_oa가 publisher 링크라서 놓치고 있었음 (Deep Residual Learning → locations에 http://arxiv.org/abs/1512.03385, primary는 IEEE doi)
  - `workUrlCandidates`에 `work.locations[].landing_page_url` 수집 추가 (primary → best_oa → **locations** → doi → pwc → s2) + `select` 파라미터에 `locations` 추가
  - 쿼리 변환은 의도적으로 하지 않음 — 실측 결과 OpenAlex는 자연어 쿼리를 잘 처리하고 simplifyQuery 적용이 오히려 악화(ResNet raw 2/5 → simp 0/5 arxiv-copy)
- **테스트 결과**: 신규 유닛 3건(locations arxiv 우선 / 후보 수집 / null·openalex.org 제외) 포함 **2,577건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **성능 변화**: 없음 (응답 필드 1개 추가 수신)
- **검색 품질 변화**: 라이브 검증 — arxiv.org 유입 증가: ResNet 0→2, self-attention 0→1, diffusion 0→1, LLM eval 2→3, transformer 3건 (기존 doi.org 위주 → arxiv gold 유입)
- **보안 영향**: 없음
- **남은 위험**: OpenAlex 데이터에 arxiv copy가 없는 work는 여전히 doi.org (데이터 의존). 쿼리 매칭이 실제 논문 대신 유사 논문을 반환하는 경우는 데이터 한계

### 수정 10: arxiv 429 cooldown 가드 (FIX-09 후속 — 프로덕션 보호)
- **작업 ID**: FIX-2026-08-13-10
- **작업명**: arxiv 429 pacing guard — wikipedia/github 패턴의 local+shared DO cooldown
- **수정한 파일**: `src/lib/specialized.ts`(가드 5함수 + arxivSearch 스킵/기록) · `tests/unit/specialized.test.ts`
- **핵심 변경사항**:
  - FIX-09는 eval 페이싱으로 평가 인프라를 보호했지만, 프로덕션 벌크 호출(다중 사용자 동시 학술 검색)은 여전히 arxiv 30/min 익명 한도를 넘길 수 있음
  - wikipedia B1/github S23과 동일 패턴: `recordArxivRateLimit`(429 시 60s 기본 cooldown, Retry-After 준수 + MAX_NETWORK_COOLDOWN_MS 클램프) · `isArxivRateLimitedShared`(local 먼저, RATE_LIMITER DO 공유 조회) · `mirrorArxivCooldown`(cross-isolate 미러) · `resetArxivRateState`(테스트 훅)
  - arxivSearch 시작부에 가드 체크: cooldown 중이면 fetch 없이 즉시 빈 결과 + 경고 로그 (429 재시도가 같은 창에 걸려 subrequest만 낭비하던 것을 차단)
  - 429 응답 시 `recordArxivRateLimit` + `mirrorArxivCooldown` 기록 (기존 fail-fast 유지 — 150ms 재시도는 같은 창)
- **테스트 결과**: 신규 유닛 4건(cooldown 스킵 / 429 기록·후속 스킵 / Retry-After / 성공 시 미발동) 포함 **2,574건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **성능 변화**: 정상 경로 무변화 (가드 체크는 로컬 변수 비교 1회 + DO 조회는 cooldown 시에만)
- **검색 품질 변화**: 429 창 동안 arxiv 결과를 포기하지만(스킵), 창이 지속되는 동안 매 쿼리마다 hammering하던 기존 동작 대비 — 창 회복 속도 향상 + 불필요한 subrequest 소모 방지
- **보안 영향**: 없음
- **남은 위험**: 가드가 429를 기록하면 해당 isolate는 60s 동안 arxiv 결과가 없음(검색 품질 일시 저하 — wikipedia 가드와 동일한 trade-off). 라이브 429 유발 프로브는 창 리셋 상태라 미재현, 동작은 단위 테스트로 검증

### 수정 9: 학술 eval의 arxiv rate-limit 페이싱 — en-acad 백엔드 누락 해소 (FIX-09)
- **작업 ID**: FIX-2026-08-13-09
- **작업명**: eval 페이싱에 arxiv 사용 쿼리 포함 (arxiv 30/min 한도 준수)
- **수정한 파일**: `eval/runner.ts`
- **핵심 변경사항**:
  - 실측: en-acad 쿼리 17개 전부 gold에 arxiv.org 포함. run-1 스냅샷에서 en-acad-08~17의 arxiv 백엔드가 전부 누락(NDCG 0.000) — 검색 코드 문제가 아니라 **eval 벌크가 arxiv 30/min 익명 한도를 초과**해 export.arxiv.org가 429 반환(Retry-After 없음, ~1분 창, 라이브 재현 2026-08-13)
  - 기존 페이싱은 `useWikipedia` 기준만 (wikipedia 1200ms = 50/min) — arxiv은 30/min이라 400ms(150/min) fast pace로는 한도를 넘김
  - `arxivPaceMs = 2200` (≈27/min) 추가 — arxiv 사용 쿼리(academic)에 적용. wikipedia 대비 더 긴 간격 필요 (strict subset: academic은 useWikipedia=true이므로 wikipedia 페이싱도 함께 적용)
  - `EVAL_QUERY_DELAY_MS=0` override 시 0으로 동작 (기존 override 계약 유지)
- **테스트 결과**: eval 관련 테스트 3파일 46건 통과 · 전체 유닛 **2,570건 통과** · typecheck 0 에러
- **성능 변화**: en-acad 17쿼리 기준 최대 +37초 (2200ms×17) — 500쿼리 전체에선 academic 쿼리 수만큼만 증가
- **검색 품질 변화**: 라이브 검증 — en-acad 17쿼리 **전부 arxiv 백엔드 포함** (이전 run-1: 08~17 전부 누락). stack-exchange 추가까지 확인
- **보안 영향**: 없음
- **남은 위험**: arxiv 30/min은 익명 한도라 프로덕션 벌크 호출 시 여전히 위험 — wikipedia식 429 cooldown 가드(shared DO)를 arxiv에도 적용하면 더 견고해짐 (후속 작업)

### 수정 8: 자연어 질문 변환을 전체 키워드 백엔드로 확장 (simplifyQuery 연동)
- **작업 ID**: FIX-2026-08-13-08
- **작업명**: naturalLanguageToKeywords를 simplifyQuery 진입점에 적용 — HN/reddit/github/dbpedia/arxiv/qiita/stack-exchange 일괄 개선
- **수정한 파일**: `src/lib/util.ts`(simplifyQuery 첫 줄에 변환 연동) · `tests/unit/util.test.ts`
- **핵심 변경사항**:
  - 실측: HN Algolia 'does gps work' 45건 vs 'gps work' 327건 (**7배 손실**) — simplifyQuery가 QUERY_NOISE_WORDS에 does/do/did가 없어 조동사를 그대로 남겨 전달했음
  - simplifyQuery가 8개 키워드 백엔드(community/dbpedia/github/stack-exchange/HN/reddit/arxiv)의 공통 전처리이므로 **진입점 1곳에 변환 연동** → 전 백엔드 일괄 적용
  - 'do'는 QUERY_NOISE_WORDS에 없어 기술 용어('do while loop', 'haskell do notation')는 무변환 보호 (테스트로 고정)
- **테스트 결과**: 신규 유닛 4건 포함 **2,570건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **성능 변화**: 없음
- **검색 품질 변화**: HN/reddit/github/dbpedia/arxiv 등 키워드 API의 자연어 질문 커버리지 개선 (실측: 'does gps work' 45→'gps work' 327건). bingSearch의 FIX-07과 동일 패턴의 일관 적용
- **보안 영향**: 없음
- **남은 위험**: reddit 라이브 프로브는 로컬 네트워크 차단으로 0건(변환 무관, eval 환경과 상이)

### 수정 7: 자연어 질문 조동사 분리 문제 해결 (en-fact-11)
- **작업 ID**: FIX-2026-08-13-07
- **작업명**: bingSearch 전 자연어 질문 → 키워드 변환 (does/do/did 제거)
- **수정한 파일**: `src/lib/util.ts`(naturalLanguageToKeywords 추가) · `src/lib/bing-search.ts`(진입점 변환) · 테스트 2종
- **핵심 변경사항**:
  - 원인: bing이 'how does GPS work'의 조동사 **does를 독립 키워드로 취급**해 영어 문법 페이지(do/does/did 활용)만 반환 — en-fact-11 gold(wikipedia.org 등) 미유입의 요인 중 하나
  - 실측(2026-08-13): 'how GPS work'(does 제거)는 GPS 결과 정상 · **'what is blockchain'은 bing이 잘 처리하지만 'what blockchain technology'(is 제거)는 qoo10/ja.wikipedia로 오히려 악화** → is/are/was/were는 의도적으로 유지하고 does/do/did만 제거하는 보수적 설계
  - `naturalLanguageToKeywords`: 질문어(how/what/why/when/where/who/which) + 조동사(does/do/did) + 뒤따르는 토큰 패턴만 변환, 대소문자 무관, 변환 후 빈/축퇴 쿼리 방지, 비질문 쿼리·site: 접두 쿼리는 무변환
  - bingSearch 진입점에서 적용 → 모든 호출 경로(메인 fanout, bing-cleaned, agentic search-tools, site:/suffix 변형)에 일관 적용
- **테스트 결과**: 신규 유닛 7건(변환 케이스 5 + is/are 유지 + 비변환 보호) 포함 **2,568건 전체 통과** · typecheck 0 에러 · 통합 108건 통과
- **성능 변화**: 없음 (문자열 변환 1회)
- **검색 품질 변화**: 라이브 검증 — 'how does GPS work'가 문법 페이지 → GPS 결과(maps.google/ko.wikipedia/en.wikipedia Global Positioning System)로 개선. 'what is X' 등 기존 정상 경로는 무변화(회귀 없음)
- **보안 영향**: 없음
- **남은 위험**: wikipedia 429는 별개 문제(이미 mirror fallback 존재). 'how does it work' 같은 무주어 질문은 주어 유실 위험이나 bing 키워드 매칭 특성상 문제 없음 확인

### 수정 6: gold 표준 shift 오류 수정 — 커버리지 미스 118건의 근본 원인 (P13)
- **작업 ID**: FIX-2026-08-13-06
- **작업명**: eval gold 표준의 쿼리-도메인 정렬 오류 7건 수정
- **수정한 파일**: `eval/gold-standards.json`
- **핵심 변경사항**:
  - 실측 분석(run-1/2/3 500쿼리): gold 도메인이 3회 모두 미유입인 쿼리 77건 중 상당수가 **gold 표준 자체의 shift 오류** — en-tech-04(PostgreSQL vs MySQL 쿼리) gold가 kubernetes.io, en-tech-05(Kubernetes) gold가 nodejs.org, en-tech-07(Docker) gold가 python.org, en-tech-08(Python) gold가 git-scm.com, en-tech-09(Git) gold가 postgresql.org, en-tech-10(CI/CD) gold가 redis.io, en-tech-11(Redis) gold가 github.com+atlassian.com — 쿼리와 한 칸씩 어긋나 있어 검색이 정상이어도 NDCG가 0에 가까웠음
  - 올바른 gold로 교정: en-tech-04→[postgresql.org, mysql.com, github.com], en-tech-05→[kubernetes.io, github.com], en-tech-07→[docker.com, github.com], en-tech-08→[python.org, github.com], en-tech-09→[git-scm.com, github.com], en-tech-10→[github.com](S52 subsumption 원칙 준수 — docs.github.com은 github.com에 흡수), en-tech-11→[redis.io, github.com]
  - en-tech-06/12/13/23 등은 정상임을 확인 (선별 수정)
- **테스트 결과**: gold 관련 테스트 4파일 105건 통과 · 전체 유닛 **2,561건 통과** · typecheck 0 에러
- **성능 변화**: 없음 (평가 기준 데이터만 변경)
- **검색 품질 변화**: 7쿼리 NDCG@10 평균 run-1 0.191→0.363, run-2 0.276→0.541, run-3 0.263→0.477 — **기존 NDCG는 gold 오류로 인한 과소평가였음**. 전체 500쿼리 평균도 0.279/0.297/0.284 → 0.281/0.300/0.287로 소폭 상승
- **보안 영향**: 없음
- **남은 위험**: en-fact-11은 bing이 'how does GPS work'를 'does' 단어로 해석해 문법 결과만 반환 + wikipedia 429가 겹친 케이스(개별 대응 필요). 뉴스 gold 미유입은 실행 시점의 뉴스 스트림에 의존하는 구조적 한계(코드 수정으로 완전 해소 불가)
- **후속 작업**: gold 표준 전수 감사(브랜드-도메인 정렬 자동 검사) · en-fact-11 자연어 질문 처리 검토

### 수정 5: P20 NDCG 노이즈 분석 + 개인정보 보존·삭제 정책 문서화 (P22)
- **작업 ID**: FIX-2026-08-13-05
- **작업명**: gold 표준 노이즈 실측 분석 + PRIVACY_POLICY.md 5.1 추가
- **수정한 파일**: `PRIVACY_POLICY.md`
- **핵심 변경사항**:
  - P20 실측(run-1/2/3 500쿼리 재계산): 평균 NDCG@10 0.279/0.297/0.284로 **평균은 안정**, 쿼리별 spread>0.3 43건(8.6%) · gold-hit flicker 63건(12.6%) · 언어별 zh 20% 최악. 메커니즘 2종: 백엔드 가용성(보조 백엔드 탈락 → gold 도메인 유입 실패, en-tech-08 run-1 NDCG 0.00) + 라이브 API 결과 비결정성(동일 백엔드 세트여도 구성 상이, zh-fact-03)
  - PRIVACY_POLICY.md: DO별 보존 기간·삭제 경로(deleteAll 코드 라인) 실측 표 추가, 로거가 쿼리 문자열을 기록하지 않음을 명시, 사용자 자가삭제 API 미구현 공개
- **테스트 결과**: 해당 없음 (분석 + 문서)
- **남은 위험**: P20의 라이브 결과 비결정성(②)은 eval을 스냅샷 캐시로 고정하지 않는 한 완전 제거 불가 — gold 표준 안정화(쿼리별 검증)와 백엔드 재시도 확대로 완화

### 수정 18: general 태그 NDCG=0 재진단 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-01 (분석 + 스크립트)
- **작업명**: 08-14 baseline에서 최대 커버리지 갭으로 부상한 general 45/91 zero의 근본 원인 재진단 (probe-p1-zero 방식)
- **산출물**: `scripts/probe-general-zero.ts` (신규, `npm run eval:general-zero`) + `docs/02_SEARCH_QUALITY_ASSESSMENT.md` §2.6 + `docs/10` 잔여 위험·섹션 6 갱신
- **방법**: probe-p1-zero (S54)와 동일 규칙 (label-suffix + computeNdcg 실시간 재계산)으로 run-1..3의 general 91쿼리만 집중 분석 + gold 도메인 레벨 갭 리포트
- **핵심 결과**:
  - 분류: **COVERAGE 40 (88.9%) · MIXED 5 (11.1%) · RANKING 0** — 랭킹 계층 정상, 원인 100% 회수(커버리지). 언어별 en 27/36 (75%) > ja 7/15 > zh 9/20 > kr 2/20
  - **gold 도메인 전무 (general 전체에서 어떤 run 풀에도 미등장)**: healthline.com 21 · webmd.com 18 · japan-guide.com 16 · quora.com 15 · wikihow.com 15 · xiaohongshu.com 15 · terms.naver.com 13 · dianping.com 11 · yahoo.co.jp 11 · tripadvisor.com 10 · mayoclinic.org 5 · qunar.com 5 · nih.gov 4 · **zh.wikipedia.org 4** · lonelyplanet.com 4
  - 거의 전무: ctrip.com 15/17 · reddit.com 15/16 · mafengwo.cn 14/18 · nytimes.com 14/15 · trip.com 12/15 · namu.wiki 10/13 · tripadvisor.jp 10/11
  - 대조: blog.naver.com 17/18 top10 (naver 전용 백엔드 커버), zhihu.com 9/11, rakuten.co.jp 6/11
  - **구조적 원인 3종**: ① 커뮤니티·헬스 gold (reddit/quora/healthline/webmd/wikihow) 전용 백엔드 미가동 (§2.5 reddit 51 전부 미사용과 일치) + bing 미회수 ② CJK 여행·커뮤니티 gold (ctrip/mafengwo/dianping/xiaohongshu/trip/qunar/yahoo.co.jp/tripadvisor.jp) 전용 백엔드 부재 ③ **zh.wikipedia.org 4/4 전무 — S73 언어별 cooldown이 zh-fact 9/16은 복원했으나 zh 일반·여행 경로는 미검증 구간**
  - 부수: bing 44/45 의존 · hackernews 25쿼리 (news.ycombinator.com 18쿼리 풀 지배 — general gold와 무관) · 사전류 오염 (wordow 5·cambridge 5·merriam 6) · MIXED 5건은 라이브 API 비결정성 + early-exit
- **검증**: typecheck 0 · eslint 0경고 · 스크립트 재실행 결정적 (저장 run 재계산)
- **후속**: ① reddit/stack-exchange 백엔드 복구·site: 보강 ② zh/ja 여행·커뮤니티 gold site: 라우팅 or 자체 인덱스 크롤러 ③ zh 일반·여행 wikipedia 유입 경로 점검 ④ general 컨텍스트 HN 가중치 하향 (KOREAN_TECH_BLOG_PANELTY 패턴)

### 수정 21: 프로덕션 partial_outage 근본 원인 — rate-limiter inflight 누수 + Vectorize topK (S105) (2026-08-14)
- **작업 ID**: FIX-2026-08-14-04 (진단 + 구현 + 테스트; 배포는 사용자 승인 대기)
- **증상**: `search-engine-api.pages.dev` partial_outage — 검색이 `backend: failed` / wikipedia 미러 쓰레기만 반환. 헬스체크상 **bing 서킷은 healthy인데 전 쿼리 0건**
- **진단 (프로덕션 로그 tail + 헬스 실측)**:
  - ① **RateLimiterDO inflight 슬롯 영구 누수 (근본 원인)**: worker isolate가 fetch 도중 종료되거나 acquire RPC가 DO-측 증분 후 실패하면 release가 오지 않아 슬롯이 누수. DO는 persist()로 상태를 저장하므로 재시작에도 유지 → `www.bing.com inflight 3/3`(maxConcurrent 3) · `html.duckduckgo.com 2/1` 영구 포화 → 모든 bing fetch가 `Upstream unavailable (circuit open or at capacity)`로 거부 → bing이 전 쿼리 0건 → partial_outage. **무료 플랜/활성 트래픽 하에서 bing은 매 쿼리 3페이지 병렬 fetch로 정확히 3/3을 소진 → 누수 1건이면 전면 차단**
  - ② **self-index 폴백 100% 실패**: `searchIndex`의 `vectorTopK = max(topK*3, 30)`이 Vectorize 상한(returnValues=true 시 topK ≤ 50) 초과 — 실측 `40025: max top K is 50, but got 54` → emergency fallback의 self-index가 항상 [] → 폴백 체인 붕괴
  - ③ (부수) 프로덕션은 25bc72c (2일 전) — S73 언어별 cooldown·S35/S36 미러·S104 등 워킹 트리 수정 미배포. wikipedia/stack-exchange 서킷 오픈은 업스트림 429 + 미배포 상태의 영향
- **수정**: ① `src/lib/rate-limiter-do.ts` — **inflight 슬롯 임대(TTL 60s) 리퍼** (`reapInflight`): canRequest/acquire/release/getAllHealth 진입점에서 만료 슬롯 지연 회수 + **레거시 persisted 상태(슬롯 기록 없는 누수 카운터) 정규화** — 배포 직후 첫 요청에서 프로덕션 누수 즉시 해소. ② `src/lib/index/pipeline.ts` — `vectorTopK = min(max(topK*3,30), 50)` 클램프 (RRF 풀 30→50 축소는 self-index 복구 대가)
- **검증**: typecheck 0 · eslint 0 · 유닛 테스트 2,619건 (신규 리퍼 4건: 포화 복구·임대 내 비리핑·FIFO 정합·레거시 마이그레이션)
- **배포 (승인 대기)**: 커밋 → push → GitHub Actions `workflow_dispatch` production (deploy.yml은 main push로는 staging만 배포 — production은 수동 디스패치)
- **S105-② bingRegion 라우팅 레버 검토 (채택 안 함 — 실측 반증)**: HKG egress 실측에서 bing plain(무 mkt)이 zh gold를 반환해 "mkt를 바꾸면 gold를 회수할 수 있는가"를 검토. 로컬 US egress 통제 실험(`scripts/probe-bing-region.ts`)에서 **mkt=en-US가 张家界/北京/上海 여행 쿼리에서 5/5 gold를 반환** (mkt=zh-CN은 오염 확인 — 기존 문서와 일치) → zh eval 전면 실험 (fresh baseline vs en-US, 65쿼리): **en-US가 전체적으로 손해** — zh-all 0.358→0.292 · zh-fact 0.580→0.414 (en Accept-Language가 영문 콘텐츠 유인) · zh-general 0.250→0.166 · zh-travel 0.136→0.102. 쿼리별 델타는 양방향 노이즈 (zh-travel-01 +0.339 ↔ zh-travel-05 -0.339) — bing zh SERP 변동성이 mkt보다 지배적. **결론: bingRegion 레버 불채택** — 단일 쿼리 5/5 gold는 우연한 스냅샷, robust한 gold 회수는 S104 DDG site: 레버가 담당. 원복 완료

### 수정 22: SearXNG(google cse) zh site: 경로 설정·검증 — DDG 202 버스트 우회 (S104 후속) (2026-08-14)
- **작업 ID**: FIX-2026-08-14-05 (설정 + 검증; 로컬 SearXNG 컨테이너 2026.7.9 실측)
- **작업명**: DDG site:의 버스트 202 윈도우(~10~30초, eval 벌크 회수 상한)를 우회하는 자체 호스팅 SearXNG 경로 설정·검증 (docs/13 가이드의 CN Baidu/Bing 엔진 가정을 실측으로 검증)
- **실측 (7개 gold 도메인 site: 배터리, scripts/probe-searxng-zh.ts)**:
  - **SearXNG 경유 bing도 site: 완전 무시** — `site:ctrip.com 张家界旅游攻略`이 mafengwo 자연 랭킹 반환 (여행 쿼리에서 mafengwo 10/10은 site: 인정이 아닌 우연), ctrip/dianping/xiaohongshu/qunar 0건. bing의 site: 무시는 모바일/데스크톱/RSS에 이어 **4번째 경로(SearXNG)에서 확정**
  - **google cse만 site: 인정** — top5 gold 5/5 (ctrip/dianping/trip/qunar/zhihu) · xiaohongshu 4/5 · mafengwo 1/5 (google 인덱스 한계 — DDG 경로가 보완, Workers egress 실측 11/11)
  - **language 퀴크**: language 파라미터를 명시하면 google cse가 **site: 쿼리에서 0건** 반환 (plain 쿼리는 무관 — A/B 3회 반복 확정) → buildZhTravelCommunityTask의 `language: 'zh-CN'` 제거가 gold 회수의 전제
  - baidu는 비CN IP에서 wappass CAPTCHA (HTTP 302, suspended 3600) — CN VPS 배치 시에만 동작, 결과만 비는 것이라 풀 오염 없음 → 설정 유지
  - **레거시 `engines=google,baidu` 파라미터는 SearXNG 2026.7.9에서 폐지** (`disabled_engines=<name>__<category>`로 대체, 소스 확인) — settings 레벨로 고정. 기존 `- name: google`은 no-op (활성 google 엔진 이름은 `google cse`)
  - **google cse도 과도한 연속 호출(~40건/수분) 시 Google bot 감지 suspension** (suspended_time=180) — DDG 202과 같은 클래스의 rate 상한, 자연 간격 호출은 정상. docs/13의 "업스트림 밴 주의" 경고가 google에도 실측 확인됨
- **수정**: ① `searxng/settings.yml` — bing/duckduckgo/brave/startpage 비활성 (site: 미인정 + 크로스랭귀지 오염), google cse·baidu 활성, no-op `name: google` 제거, 실측 주석으로 재작성 ② `src/lib/search/backend-tasks.ts` — S104 searxngSearch 호출에서 `language: 'zh-CN'` 제거 + 주석 실측 근거로 갱신 (bing site: 무시 확정, google cse만 인정, language 퀴크)
- **영향 범위**: plain SearXNG 경로(buildSearXNGTask·fallback)는 language 무관 동작 실측 (plain zh/ko + language 정상) — 설정 고정의 부수 영향 없음 확인
- **검증**: typecheck 0 · eslint 0 · 유닛 테스트 2,621건 통과 (신규 buildZhTravelCommunityTask 2건: SearXNG **language 미포함** opts·DDG 폴백) · 최종 설정 재시작 후 /config로 활성 엔진 = baidu+google cse만 확인 (bing/duckduckgo/brave/startpage/wikipedia 등 전부 비활성)
- **한계 (실측)**: 밴 이전 google-only+무언어 배터리 (ctrip/dianping/trip/qunar/zhihu top5 5/5·20/20, xiaohongshu 4/5, mafengwo 1/5)가 gold 회수 근거 — 그러나 **과도한 프로빙(~40건/수분)으로 이 US IP가 Google bot 감지에 flagged** (suspended_time=180이지만 수십 분 지속, 복구 후 첫 시도에도 재발급). 최종 설정 재시작 후 라이브 재검증은 IP flag가 풀릴 때 `npm run probe:searxng-zh`로 재실행 필요 (또는 CN VPS/Workers egress — 실제 배포 대상)
- **잔여**: google cse suspension 윈도우는 DDG 202보다 길지만 자연 간격 호출은 정상 — eval 벌크도 쿼리당 1회·간격 스케줄이면 유지. CN VPS 배치 시 baidu가 gold 커버리지 강화 (비검증 구간 — CN egress 필요)

### 수정 23: rate-limiter 이차 누수 벡터 제거 — acquire RPC 보상 rollback + release 단일화 (S105 후속) (2026-08-14)
- **작업 ID**: FIX-2026-08-14-06 (견고화 + 테스트)
- **배경**: S105 리퍼(60s TTL)가 누수 슬롯의 백스톱이지만, 클라이언트 `acquire` RPC가 DO-측 증분 *이후* 실패하면(응답 유실/DO 재시작/RPC 타임아웃) release가 호출될 수 없어 슬롯이 60초간 새는 이차 벡터가 남아 있음. 또한 `rateLimitedFetch`의 try 경로에서 release RPC가 실패하면 catch가 release를 **또** 호출해 FIFO로 다른 요청의 슬롯을 pop하는 이중 해제 버그도 발견
- **수정**: ① `rate-limiter-do.ts` — **`cancelAcquire(host)` 보상 RPC 신설**: 인플라이트 슬롯만 제거하고 서킷/통계는 건드리지 않음 (release(success=false)는 실패 카운트를 올리고, 하프오픈 프로브 단계에선 회로를 닫아버려 acquire 실패를 업스트림 실패로 오집계하면 안 됨). 빈 슬롯에서 no-op ② `rate-limiter.ts` — `acquire()`가 RPC 실패 시 `cancelAcquire`를 최선 노력으로 호출 후 오류 전파 (DO가 죽어 보상도 실패하면 리퍼가 백스톱) + `RateLimiterDOClient` 인터페이스에 `cancelAcquire` 추가 ③ `rateLimitedFetch` — acquire를 try로 격리(타이머 정리 보장), **release는 정확히 1회 시도** (RPC 실패 시 재시도 금지 — 이중 release가 FIFO로 다른 요청 슬롯을 pop하는 것을 방지, 잔여는 TTL 리퍼가 정규화)
- **검증**: typecheck 0 · eslint 0 · 유닛 테스트 **2,627건** (신규 6건: DO cancelAcquire 슬롯 pop+서킷 불변 · 빈 슬롯 no-op · 하프오픈 프로브 중 서킷 무변경 / 클라이언트 acquire 실패→cancelAcquire 1회+release 미호출 · rateLimitedFetch 전파+이중 해제 없음 · release RPC 실패 시 1회 시도 유지)
- **배포 (완료)**: 커밋 **271a8c7** → `git push github main` (9116e07..271a8c7) → GitHub Actions 디스패치 대신 **로컬 worktree 절차**로 프로덕션 3단계 배포 (DO `ssak-do-worker` v6bc90342 · Pages Production **Source=271a8c7** (8a210a4a) · cron `ssak-probe-scheduler` v1fefaf9f). GitHub Actions `CLOUDFLARE_API_TOKEN` 시크릿은 여전히 깨져 있어 CI 기반 배포는 불가 상태 (시크릿 교체 필요)
- **배포 후 실측 검증**: bing `inflight 0 · failures 0 · healthy`, duckduckgo 동일 — 라이브 검색 정상 (EN `bing+github+hackernews+dbpedia`, zh 여행 `bing` — top5 전부 mafengwo.cn gold)

### 수정 26: GitHub Actions CLOUDFLARE_API_TOKEN 교체 절차 문서화 + staging 파이프라인 검증 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-09 (문서화 + 검증)
- **배경**: 2026-08-12 이후 모든 GitHub Actions 배포가 `Authentication error [code: 10000]` → `9109`로 실패 (시크릿 만료/무효). 로컬 wrangler OAuth는 유효해 worktree 절차로 우회 중
- **문서**: `docs/17_CLOUDFLARE_TOKEN_ROTATION.md` 신설 — 증상·원인 판정 · Cloudflare 대시보드 토큰 발급(Edit Cloudflare Workers + **Pages 권한 필수** — 템플릿에 Pages가 없어 누락되면 pages deploy가 실패) · GitHub 시크릿 갱신 · 교체 후 staging 검증 절차·실패 판정표·만료 예방
- **검증 실측** (run 31798607637, head=41218df, staging 디스패치):
  - ✓ pre-deploy guard(verify-do-binding.sh) **success** — `CLOUDFLARE_API_TOKEN`이 비어있진 않음 (시크릿은 존재)
  - ✗ `Deploy do-worker (Staging)` **failure** — 로그: `Authentication error [code: 10000]` → `Max auth failures reached [code: 9109]`
  - **판정**: 시크릿은 아직 **교체 전** — docs/17 2~3단계 완료 후 재디스패치 필요 (4단계 검증 절차를 그대로 따르면 됨)
- **잔여**: 시크릿 교체는 repo 관리자 권한 필요 — 사용자 조치 후 `gh workflow run deploy.yml -f environment=staging` (또는 4-1 디스패치)으로 재검증
- **추가 실측 (2026-08-14 12:05Z, 재디스패치 run 31798754144)**: 시크릿 **미교체 확정** — GitHub API `actions/secrets` 실측 `CLOUDFLARE_API_TOKEN updated_at=2026-08-12T08:45:24Z` (그 토큰조차 무효). 재디스패치도 동일 `Authentication error [code: 10000]` → `9109`로 `Deploy do-worker (Staging)` 실패. **부수 발견 — guard 허점**: pre-deploy guard(verify-do-binding.sh)가 무효 토큰도 "auth OK"로 통과 (토큰 유효성이 아니라 `-z` 비어있음만 검사) → guard green인데 실제 배포는 10000 실패하는 혼란. docs/17 검증 절차에 토큰 유효성 확인(예: `/user/tokens/verify`) 추가 권장

### 수정 30: gold 검증 --full-eval 플래그 + 체크포인트/resume — 그리고 "배포 URL 500쿼리 eval은 wikipedia 서킷을 트립" 실측 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-13 (구현 + 실측)
- **산출물** (`scripts/verify-deployed-gold.sh` 확장):
  - `--full-eval` — eval/queries.ts 전체 497쿼리를 배포 URL에 순차 전송해 gold 회수율 집계 (스모크 6쿼리와 동일한 S49 label-suffix 판정)
  - **JSONL 체크포인트** (`GOLD_OUT_JSONL`, 기본 /tmp/gold-verify-out.jsonl) — 결과를 1건씩 즉시 저장, 중단 후 재실행 시 완료분을 건너뛰고 resume. 요청 실패만 체크포인트에서 제외해 resume 시 자동 재시도
  - **페이싱** (`GOLD_DELAY_MS`, 기본 2500ms, 50쿼리 초과 시에만 적용) + full-eval 배너 경고
- **실측 (production, 공유 DO)**: 600초 청크 × 3회 resume로 234/497 처리 완료(체크포인트/resume 검증됨) → **en/zh.wikipedia 서킷 트립 + wikidata/news.google degraded** (S73 재발). 원인: en-* 쿼리 클러스터가 wikipedia 공유 100/min 버짓을 폭주 → 429 → 서킷 트립 → B1 미러 체인(wikidata/dbpedia) 폭주 → cascading. alarm 프로브 자가회복(S73e)으로 en/zh는 약 13분 만에 닫힘 확인
- **교훈/가이드**: 배포 URL(staging/production)은 **같은 DO를 공유**하므로 500쿼리 회귀를 돌리면 운영 서킷을 트립시킨다. 전량 회귀는 **로컬 eval 하네스(eval/index.ts, EVAL_MODE + 자체 페이싱)**를 사용하고, 배포 URL full-eval은 비수요 시간에 페이싱 유지로만 제한적으로 사용할 것. 남은 263쿼리는 체크포인트가 남아 있어 서킷 회복 후 resume 가능

### 수정 31: gold 미회수 지속 시 배포 실패 처리 — GOLD_FAIL_HARD 옵션 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-14 (구현 + 단위/통합 검증)
- **배경**: deploy-local-worktree.sh 의 gold 검증은 실패해도 **경고만** 출력하고 배포를 성공 처리했다 (GOLD_OK 는 수집만 하고 exit code 미반영) — gold 미회수가 실제로 배포를 막지 못하는 허점
- **수정** (`scripts/deploy-local-worktree.sh`):
  - `GOLD_FAIL_HARD=1` — gold 미회수가 `GOLD_FAIL_HARD_RETRIES`(기본 3회) 시도 동안 지속되면 배포를 **실패 처리 (exit 1)**. 기본 0 = 기존 경고 동작
  - 재시도로 일시적 업스트림 지연과 지속 실패를 구분 (간격 `GOLD_FAIL_HARD_RETRY_WAIT`, 기본 30s) — 한 번의 일시적 미회수가 배포를 막지 않도록
  - 실패 시 최종 요약에 검증 게이트 실패 문구 + 드라이런 계획에 fail-hard 라인 추가
- **검증**: ① 제어 흐름 단위 테스트 4케이스 — fail-hard=0 실패→경고/exit 0, 일시적(2회 실패 후 성공)→통과/exit 0, 지속(3회 실패)→fail-hard/exit 1, retries=1 즉시 fail-hard ✅ ② 실제 staging 배포 통합 — `GOLD_FAIL_HARD=1 GOLD_FAIL_HARD_RETRIES=1 EQ_CHECK=0` → gold 6/6 → `✅ 전체 배포 완료` exit 0 ✅ (부수: production wikipedia 회복으로 스모크 6/6 재확인)

### 수정 32: DO 서킷 공유 분리 (방안 B) — DEPLOY_ENV 인스턴스 키로 staging/production 독립화 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-15 (구현 + 테스트 + 이중 배포 실측)
- **배경**: staging/production 이 같은 RATE_LIMITER DO 인스턴스('global')를 공유해 서킷·rate window·cooldown 이 전부 공유됐다 (대조 검증에서 source=durable 동일 상태 실측). full-eval 실측(S73 재발)에서 staging 부하가 production 서킷을 트립하는 리스크가 현실화됨
- **수정**:
  - `src/lib/deploy-env.ts` 신규 — 빌드 타임 주입 상수 `DEPLOY_ENV` (vite define `__DEPLOY_ENV__`) + `rateLimiterInstanceName()`. define 없는 컨텍스트(테스트/직접 번들)는 typeof 가드로 'global' 폴백
  - `rate-limiter.ts` getDOClient + `rate-limiter-do.ts` getRateLimiter — `idFromName('global')` → `idFromName(rateLimiterInstanceName())`
  - `vite.config.ts` — `define: { __DEPLOY_ENV__: JSON.stringify(process.env.DEPLOY_ENV || 'production') }`
  - `ci.yml` — 환경별 2개 아티팩트: worker-bundle-production(DEPLOY_ENV=production) + worker-bundle-staging(DEPLOY_ENV=staging)
  - `deploy.yml` — 각 job 이 자기 환경 아티팩트 다운로드 + 폴백 빌드에 DEPLOY_ENV 설정
  - `deploy-local-worktree.sh` — 빌드에 `DEPLOY_ENV=$ENV_NAME` 주입 + 드라이런 계획 반영
- **검증**: ① tsc 0 ② 전체 2,633건 통과 (+신규 테스트: getDOClient 가 rateLimiterInstanceName() 로 idFromName 호출, vitest 폴백='global') ③ eslint 0 ④ **번들 실측**: DEPLOY_ENV=staging 빌드 → `Ct=\`staging\`` + `idFromName(St())`, production 빌드 → `Ct=\`production\`` — 주입 확정
- **이중 배포 실측** (커밋 **63d0cca**): ① staging 배포 직후 **동시 비교로 독립성 확정** — staging(새 인스턴스)은 `non-operational: 0`(stackexchange 미호출), production(아직 구 'global')은 stackexchange down + ko/ja degraded 유지 ② production 배포 후 양쪽 모두 fresh 인스턴스로 전환 (`non-operational: 0`) ③ 라이브 검색 양쪽 동일 동작 (zh 여행 mafengwo gold + EN 실결과 10건)
- **디버깅 실측**: 첫 staging 배포가 새 인스턴스로 안 바뀐 원인 = 배포 스크립트가 **커밋의 clean 체크아웃**에서 빌드하는데 변경이 미커밋 상태였음 (vite define 없음 → 'global' 폴백) → 커밋 후 재배포로 해결. docs/17 에 경고 문구 추가
- **참고**: 구 'global' 인스턴스는 스토리지에 잔존하며 기존 stackexchange alarm 프로브만 주기 실행 (무해 — 정리하려면 reset RPC 별도 필요). ci.yml/deploy.yml 변경은 push 후 GitHub Actions 에 반영 (로컬 worktree 배포는 push 불필요)

### 수정 33: 환경 동치 대조 실패 Slack 알림 — EQ_NOTIFY (2026-08-14)
- **작업 ID**: FIX-2026-08-14-16 (구현 + 실측 검증)
- **수정** (`scripts/verify-env-equivalence.sh`):
  - 실패 항목별 플래그(커밋/헬스/검색/gold) 추적 + 검색 diff 상세 누적
  - **런타임 동치(헬스/검색/gold) 실패 시 Slack 알림** — `EQ_NOTIFY`(기본 1). 페이로드는 monitor.yml 과 동일한 Slack blocks 형식 (danger 색상, 환경 A/B URL·커밋·실패 건수·항목별 상세 포함)
  - **커밋 불일치 단독은 알림 생략** — staging 배포 직후 production 미배포는 정상 상태 (EQ_NOTIFY_COMMIT=1 로 강제 시 warning 색상)
  - Webhook 미설정(SLACK_WEBHOOK/ALERT_SLACK_WEBHOOK) 시 no-op — 코드베이스 resolveWebhookUrl 컨벤션
- **검증** (로컬 캡처 서버 실측): ① fake 환경 vs production → 헬스/검색/gold 3건 실패 → **danger 페이로드 POST 캡처 성공** (상세 블록 포함) ② webhook 미설정 → no-op 안내 + exit 1 유지 ③ 커밋 단독 분기 → 알림 생략 / EQ_NOTIFY_COMMIT=1 시 warning
- **참고**: 알림 수신에는 Pages 프로젝트의 `ALERT_SLACK_WEBHOOK`(또는 SLACK_WEBHOOK) 시크릿 설정이 필요 — 현재 미설정 상태라 로컬/배포 시 no-op (probe-slack-delivery.ts 확인)

### 수정 34: 동치 대조 헬스 의미론 갱신 + 알림 분기 검증 (방안 B 후속, 2026-08-14)
- **작업 ID**: FIX-2026-08-14-17 (구현 + 실측)
- **배경**: 방안 B(수정 32)로 DO 인스턴스가 독립되며 헬스 status 비교가 코드 동치 지표로서 부적합해짐 — staging fresh 인스턴스는 회로 0개(캐시 히트 시 백엔드 fetch 없음 → 미추적), 이후 트래픽 누적 차이로 status 가 계속 갈림. 수정 33의 알림이 **거짓 danger 알림**을 보낼 수 있는 상태
- **수정** (`scripts/verify-env-equivalence.sh`):
  - 헬스 대조 의미론: ① 한쪽만 추적 중인 호스트 → 정보성(실패 아님) ② 공통 호스트는 **한쪽만 down 일 때만 실패** ③ degraded vs operational → 정보성 (시점 차이)
  - 실질 동치 신호는 검색 top-5 + gold 회수로 명확화
- **검증 (실측)**: ① 실환경(staging/production @ 63d0cca) 4/4 통과 exit 0 — 헬스는 ℹ️ 정보성만 (미추적 호스트 + en.wikipedia degraded vs operational) ② fake 환경(한쪽만 down) + 검색/gold 실패 → **danger 알림 POST 캡처 성공** (헬스 상세에 'api.stackexchange.com: down vs operational' 포함)
- **부수 확증**: staging 캐시-미스 쿼리 1건 후 **staging 인스턴스에만 6개 회로 생성, production 9개 불변** — 방안 B 독립성의 직접 증거

### 수정 35: 동치 대조 CI 등록 — 매 staging 배포 후 자동 게이트 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-18 (구현 + 로컬 실측)
- **수정**:
  - `deploy.yml` `deploy-staging` job 에 post-deploy 게이트로 `verify-env-equivalence.sh` 등록 — **매 staging 배포 후 자동 실행**, 실패 시 job 실패 처리 + Slack 알림 (최종 시도에서만 EQ_NOTIFY=1, ALERT_SLACK_WEBHOOK 시크릿 — 미설정 no-op)
  - `SKIP_COMMIT=1`로 커밋 항목은 게이트에서 제외 (커밋 일치는 기존 verify-do-binding.sh post-deploy gate 가 검증) + 스크립트가 SKIP_COMMIT=1 시 wrangler 호출 생략
  - workflow_run 에서 production 배포 동시 진행 대비 45s 간격 1회 재시도, job 타임아웃 8→12분
- **디버깅 실측**: SKIP_COMMIT 가드 도입 시 COMMIT_A/B 가 빈 문자열이 되어 [1/4] 블록이 "파싱 실패"로 오판해 FAIL 을 세팅하는 버그 → 분기 구조 분리(SKIP_COMMIT 생략 / 파싱 실패 / 불일치)로 수정
- **검증**: YAML 파싱 OK (11단계, 타임아웃 12분), SKIP_COMMIT=1 경로 로컬 실측 — 커밋 생략 분기 정상 + **실제 신호 검출 확인**: 내 테스트 부하가 staging 인스턴스의 en.wikipedia 를 down 으로 트립 → 게이트가 "down vs operational" 실패로 정확히 잡음 (production 무영향 = 방안 B 독립성 재확인, alarm 프로브 자가회복 예정)
- **참고**: CI 종단 검증은 CLOUDFLARE_API_TOKEN 시크릿 교체(docs/17 2~3단계) 후 staging 디스패치로 가능 (현재는 사전 guard 가 무효 토큰을 BLOCK)

### 수정 36: stackexchange 서킷 상태 정직화 — 방안 A 구현 (SE 프로브 특수화) (2026-08-14)
- **작업 ID**: FIX-2026-08-14-19 (구현 + 테스트) · 설계: docs/18
- **배경**: api.stackexchange.com 서킷이 영원히 down — alarm 프로브가 robots.txt(400 JSON, API 아님)를 alive 로 인정하지 않았고, 60s 프로브가 SE egress rate-limit(502)을 갱신·연장 (docs/18 실측)
- **수정** (`src/lib/rate-limiter-do.ts`):
  - `isStackExchangeHost()` (wikipedia 특수화와 동일 패턴)
  - probeHost SE 분기 — 경로를 `https://api.stackexchange.com/2.3/info?site=stackoverflow` 로 변경, **400 + body `error_id:502`(throttle_violation, egress rate-limit)를 alive 로 인정** (서버는 정상, 일시적 제한)
  - SE 전용 프로브 최소 간격 `STACKEXCHANGE_PROBE_INTERVAL_MS = 10분` — alarm 60s 틱에서 SE 는 backoff 와 무관하게 10분 경과 후에만 프로브 (rate-limit 갱신/연장 방지)
- **테스트** (tests/unit/rate-limiter-do.test.ts, +4건): ① 400+error_id:502 → alive → 서킷 닫힘 + `/2.3/info` URL 확인 ② 400+non-502 → alive 아님 → 에스컬레이션 ③ 30s에선 스킵, 10분 후 첫 프로브 ④ 일반 호스트는 기존 60s 캐던스 유지
- **검증**: tsc 0 · 전체 2,637건 통과 · eslint 0
- **효과**: 서킷이 down → healthy 로 정직화 (health 정확성), SE egress rate-limit 리셋 후 다음 10분 틱에서 자동 회복. 실제 검색은 쿼터 가드가 계속 통제 (rate-limit 중엔 어차피 결과 없음) — 서킷 닫힘 무해

### 수정 37: stackoverflow gold 보완 판단 실측 — bing/DDG 자연 랭킹 전부 미노출 (방안 C 기각) (2026-08-14)
- **작업 ID**: FIX-2026-08-14-20 (프로브 실측 + 판단) · 설계: docs/18 방안 C
- **산출물**: `scripts/probe-bing-stackoverflow.ts` — SO gold 대표 13쿼리(en-tech/kr-tech/adv)에 대해 ① bing 자연 랭킹 ② DDG 자연 랭킹 ③ production /api/search 풀 을 대조
- **실측 결과**: **bing 0/13 · DDG 0/13 · production 풀 0/13** — stackoverflow.com 미노출 전부
- **판단**: **방안 C 기각** — bing/DDG 자연 랭킹으로 SO gold 를 충당할 수 없음. SO gold 회복은 SE API egress rate-limit 리셋을 기다리는 수밖에 없고, 방안 A(수정 36)가 서킷을 정직화해 리셋 후 자동 회복됨
- **근거 강도**: production 풀 0/13 은 Workers egress 기준 직접 실측이라 확정적. bing/DDG 직접 결과는 로컬 egress 노이즈(한국어 로컬라이즈·봇 감지)가 심해 보조 데이터로만 사용

### 수정 38: SE rate-limit 리셋 자동 회복 모니터 — monitor-se-recovery.sh (2026-08-14)
- **작업 ID**: FIX-2026-08-14-21 (구현 + 실측)
- **산출물**: `scripts/monitor-se-recovery.sh` — api.stackexchange.com egress rate-limit 리셋 시점에 서킷/검색 gold 자동 회복 추적
  - Workers egress IP 의 rate-limit 은 로컬에서 볼 수 없으므로(per-IP) **production 엔드포인트를 진실 원본으로 폴링**: ① `/api/health` 서킷 상태 ② `/api/search` SO gold 쿼리 2건 → stackoverflow.com top-10 존재
  - **상태 파일** (`SE_MONITOR_STATE`, 기본 /tmp/se-recovery-state.json)로 이력 저장 — 중단 후 재실행이 이어붙음 (세션 환경의 백그라운드 reap 에 안전)
  - **전이 감지**: 서킷 down→operational (CIRCUIT-RECOVERED) / gold 없음→있음 (GOLD-RECOVERED). 첫 폴링은 [BASELINE] 으로만 기록 (오탐 방지)
  - `--watch` 반복 모드 (POLL_INTERVAL/SE_MONITOR_MINUTES) / `--reset` 상태 초기화
- **실측**: 현재 상태 — 서킷 operational (방안 A 미배포라 프로브 판정 의미 없음 — rate-limit 리셋의 확증 아님), **gold 없음** (여전히 rate-limit 또는 전략 미회수). **gold 회복만이 리셋 확정 신호**
- **참고**: 방안 A(af28f12) 배포 후에는 서킷 신호도 유효해짐 (프로브가 /2.3/info 200 → 닫힘)

### 수정 39: 부분 배포 자동 DO 롤백 — --auto-rollback 플래그 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-22 (구현 + 실측)
- **수정** (`scripts/deploy-local-worktree.sh`):
  - `--auto-rollback` — Pages 배포 실패로 정합 불일치(DO=새 버전, Pages=이전)가 되면, 배포 전 캡처한 `PREV_DO_VERSION` 으로 DO 를 **자동 롤백** (`npx wrangler rollback <version-id> --config=wrangler.do.jsonc -m "auto-rollback: Pages deploy failed"`)
  - 롤백 조건은 `DO=1 && PAGES=0` 단독 — cron 실패(DO+Pages 일치, 롤백하면 오히려 틀림)나 DO 실패(아무것도 배포 안 됨)에서는 롤백하지 않음
  - 드라이런 계획 + 요약 문구에 auto-rollback 반영, exit 1 유지 (배포 실패는 여전히 실패)
- **검증**: ① 가짜 npx 래퍼로 Pages 실패 시나리오 실측 — `wrangler rollback 0532d4a2-…(PREV_DO_VERSION) -m "…Pages deploy failed (63d0cca → staging)"` 정확 호출 + `✅ DO 롤백 완료` + exit 1 ② 조건 시뮬레이션 4케이스 — cron 실패/DO 실패/전체 성공 → 롤백 안 함, Pages 실패 → 롤백 실행 ③ 테스트 부작용(실 DO 배포)을 실제 rollback 으로 원상 복구 (DO 코드 = 63d0cca 유지)

### 수정 40: 가짜 npx 시뮬레이션 정식화 — deploy-local-worktree.sh --self-test (2026-08-14)
- **작업 ID**: FIX-2026-08-14-23 (구현 + mutation 검증)
- **배경**: 수정 39 의 가짜 npx 래퍼 실측은 /tmp 에 임시 스크립트로 수동 실행한 1회성 검증 — 회귀 방지 장치가 없었다
- **수정** (`scripts/deploy-local-worktree.sh` + `ci.yml`):
  - `--self-test` 모드 추가 — 가짜 npx/curl 바이너리를 PATH 앞에 두고 모든 wrangler/curl 호출을 스텁 (verify-do-binding.sh --self-test 와 동일 컨벤션). 오프라인, node 불필요 (빌드 생략 — SELFTEST_TARGET_RUN=1 게이트)
  - 5개 시나리오: ① `pages_fail --auto-rollback` → **정확한 PREV_DO_VERSION(`0532d4a2-…`)으로 롤백 호출** + exit 1 ② pages_fail(플래그 없음) → 롤백 없음 ③ cron_fail → 롤백 없음 (DO+Pages 일치) ④ do_fail → 롤백 없음 (아무것도 배포 안 됨) ⑤ success → exit 0
  - ci.yml `deploy-selftest` job (신규) — push/PR 마다 자동 실행
- **검증**: ① 로컬 5/5 PASS ② **mutation 테스트** — 롤백 조건을 `PAGES=0 → PAGES=1` 로 뒤집자 `pages_fail --auto-rollback` 케이스가 정확히 FAIL (exit 1) → 테스트가 실제 회귀를 감지함을 확인 후 원복 ③ bash -n 클린

### 수정 41: 드라이런 모드 유닛 테스트화 — 테스트 프레임워크(vitest)에서 bash 스크립트 검증 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-24 (구현 + 전체 회귀)
- **배경**: 수정 40 은 `--self-test`(배포 판정/롤백 조건)를 bash 모드로 정식화했지만, **드라이런 계획 모드는 유닛 테스트가 없었다** — 계획 문구·환경별 배선·배포 미실행 보장이 회귀에 노출
- **산출물**: `tests/unit/deploy-local-worktree.test.ts` (신규) — parse-cron-health.test.ts 와 동일 패턴으로 **vitest 가 bash 스크립트를 스폰** (execFileSync + 가짜 npx 로 whoami 만 스텁, 오프라인)
- **케이스 7건**: ① 드라이런은 계획만 출력하고 **배포 명령을 실행하지 않음** — 가짜 npx 로그에 `whoami` 만 존재, `deploy/pages deploy/rollback` 없음. whoami 외 wrangler/npx 호출은 가짜 npx 가 **실패**시키므로 "드라이런이 배포 단계로 진행" 회귀는 즉시 적발 ② staging 변형 — DEPLOY_ENV=staging + `--branch=staging` + `wrangler.cron.staging.jsonc` + staging 헬스 URL ③ GOLD_FAIL_HARD=1 → fail-hard 재시도 계획 라인 ④ `--auto-rollback` → 자동 롤백 계획 라인 ⑤ 미지 옵션 → exit 1 ⑥ 미존재 커밋 → exit 1 (드라이런이어도 사전 확인 게이트) ⑦ OAuth 실패 → 드라이런도 exit 1 (읽기 전용 whoami 게이트가 계획을 막음 — 현행 동작 문서화)
- **검증**: 신규 7건 통과 · 전체 유닛 **2,644건 / 131파일 통과 (+7)** · eslint 0 · prettier clean · tsc 0. `npm test`(vitest unit project)에 자동 포함 → CI unit-tests job 에서도 실행

### 수정 42: node_modules 심링크 대신 worktree 내부 npm ci 격리 빌드 — ISOLATED_BUILD=1 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-25 (구현 + 실측)
- **배경**: 배포 스크립트는 worktree 의 node_modules 를 **main repo 심링크로 공유** — 미커밋 package.json/package-lock.json 변경이나 stale node_modules 가 있으면 대상 커밋의 의존성 상태와 달라질 수 있다는 문서화된 위험 (스크립트가 경고만 출력)
- **수정** (`scripts/deploy-local-worktree.sh`):
  - `ISOLATED_BUILD=1` — 심링크 생략 + **worktree 내부에서 `npm ci`** (대상 커밋의 package-lock.json 기준 정확 설치) 후 빌드. npm ci 실패 시 exit 1 (빌드 전 중단)
  - 기본 0 = 기존 심링크 공유 (빠름) — 하위 호환. 드라이런 계획에 격리 경로 표시, 미커밋 package*.json 경고 문구가 격리 모드에서 안내로 대체
- **검증**: ① bash -n 클린 · `--self-test` 5/5 유지 ② 유닛 테스트(수정 41 파일)에 격리 계획 케이스 +1 — `npm ci (worktree 내부 격리` 표시 + 심링크 문구 부재 ③ **실배측**: worktree 에서 심링크 없이 npm ci → build 성공 (dist/_worker.js 1,094.21 kB) → worktree 정리 ④ 전체 유닛 **2,645건 통과 (+1)** · eslint 0 · prettier clean

### 수정 43: staging↔production 배포 커밋 동치 전용 검증 스크립트 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-26 (구현 + 실측 + 유닛 테스트)
- **배경**: verify-env-equivalence.sh 의 [1/4] 커밋 동치는 검색 3쿼리 + gold 6/6 을 양쪽에 실행하는 **무거운 대조의 일부** — 검증 트래픽이 staging API rate limit(429)을 트립한 실측(이전 턴)이 있었고, production 배포에는 cross-env 커밋 확인 자체가 없었음
- **산출물**:
  - `scripts/verify-deploy-commit-sync.sh` 신규 — Pages deployment list 만 조회해 staging(브랜치) 최신 배포 vs Production 최신 배포의 **Source commit 동치만** 확인 (awk 필드 5, 기존 스크립트와 동일 파싱). `EXPECTED_COMMIT` 지정 시 양쪽 모두 그 커밋이어야 함. 불일치 시 Slack 알림 (SYNC_NOTIFY 기본 1, webhook 미설정 no-op). exit 0/1
  - `deploy-local-worktree.sh` — post-deploy 단계에 COMMIT_SYNC_CHECK(기본 1) 통합: **production 배포에서도** 커밋 동치 자동 확인 (불일치는 경고만 — production 배포 직후 staging 미배포는 정상 상태), 드라이런 계획에 반영. self-test 대상 실행은 COMMIT_SYNC_CHECK=0 으로 헤르메틱 유지
- **검증**: ① 실측 — 양쪽 1941786 → `✅ 동치` exit 0, EXPECTED_COMMIT=1941786 도 통과 ② 유닛 테스트 5건 (신규 파일: 동치 exit 0 / 불일치 exit 1 / EXPECTED 일치·불일치 / 미배포 미확인 exit 1) — 가짜 npx 로 실제 wrangler 테이블 형식 픽스처 검증 ③ `--self-test` 5/5 유지 ④ 전체 유닛 **2,650건 / 132파일 통과 (+5)** · eslint 0 · prettier clean · tsc 0

### 수정 44: staging deep probe(15분 cron) 발화 tail 검증 + 프로브 스크립트 (2026-08-14)
- **작업 ID**: VER-2026-08-14-01 (실측 + 산출물)
- **배경**: 로컬 worktree 배포(1941786) 후 staging 딥 프로브 cron 이 실제 도는지 tail 로 검증 요청. Pages 는 cron 을 못 받으므로 별도 Workers 스크립트(ssak-probe-scheduler-staging, */15)가 `/api/health?depth=full` 을 호출
- **산출물**: `scripts/probe-deep-probe-cron.sh` (신규) — staging/production scheduler + staging Pages 를 wrangler tail 로 동시 관찰 (재사용 가능). tail 연결 확인용 자체 트래픽 대조군, 직접 wrangler 바이너리(npx 병렬 시작 경합 회피)
- **실측 (15:15 UTC 틱)**:
  - staging scheduler: `[cron-probe] deep health probe triggered` 15:15:43.511Z — cron `*/15`, probe_url=staging, HTTP 200, probe_status degraded, down_backends none
  - production scheduler (대조군): 동일 틱 동시 발화 15:15:43.226Z — cron 메커니즘 정상
  - staging Pages: `GET /api/health?depth=full` **user-agent ssak-cron-probe/1.0** 수신 → `[health] deep health probe complete` (cached:false — 신규 실행, hosts_tracked 12, down_backends none)
- **디버깅**: 첫 tail 윈도우(14:45 틱) 미포착은 cron 문제가 아닌 **인라인 하네스 아티팩트**로 확정 (긴 원라이너에서 두 번째 백그라운드 명령 미기동 + pages tail 연결성은 자체 트래픽 포착으로 별도 검증) — 15:15 틱 3중 tail 포착이 결정적. 스케줄러 "배포 단 1건" 의심도 grep -m2 잘림 아티팩트였음 (실제 이력 다수 — production cron e49c3eaf 등)
- **결론**: 로컬 worktree 배포 후 staging 딥 프로브가 15분마다 정상 발화 (deploy-local-worktree.sh cron 단계 배선 검증 완료)

### 수정 29: 배포 파이프라인 자동 검증 확장 — gold 회수 + staging↔production 동치 대조 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-12 (구현 + 실측)
- **배경**: 로컬 worktree 배포 스크립트(수정 27)에 검증 단계 추가 — 배포 후 "동작하는가"를 자동 확인
- **산출물**:
  - `scripts/verify-deployed-gold.sh` 신규 — 6개 대표 gold 쿼리(kr-stock/zh-travel/en-fact/gk/en-tech/ja-news)를 배포 URL에 전송, top-10에서 gold 도메인 회수를 S49 label-suffix 규칙으로 판정 (eval/metrics.ts와 동일). 회수율 요약 + 미회수 시 exit 1. 프로덕션/staging 모두 6/6 실측
  - `scripts/verify-env-equivalence.sh` 신규 — staging↔production 4항목 대조: ① 배포 커밋(Source) ② 헬스(백엔드 status) ③ 검색 top-5 도메인 시퀀스 ④ gold 회수율
  - `deploy-local-worktree.sh` 확장 — Pages 배포 후 gold 검증(GOLD_CHECK=0 생략 가능) + staging 배포 시 동치 대조(EQ_CHECK=0 생략 가능) 자동 호출
- **디버깅 실측**: ① urllib 기본 UA가 WAF에 403 → 브라우저 UA 설정 ② SEARCH_URL에 /api/health URL을 넘겨 /api/health/api/search 404 → base URL로 수정
- **실배포 검증**: staging @ f5ef768 배포 → production을 f5ef768로 배포 → `verify-env-equivalence.sh` **4/4 동치 green** (커밋 불일치는 production 미배포 시 정상 표시되는 것도 확인)

### 수정 28: pre-deploy guard 무효 토큰 거부 — /user/tokens/verify 유효성 검사 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-11 (구현 + 테스트 + CI 실측)
- **배경**: 수정 26에서 발견한 guard 허점 — `verify-do-binding.sh`가 토큰 **비어있음(-z)**만 검사해 무효(만료) 토큰이 "auth OK"로 guard를 통과, 실제 배포 단계에서 `code:10000`으로 실패하는 혼란
- **수정** (커밋 **f5ef768**): COMMIT_CHECK_ONLY 시작 시 `verify_cf_token()` — Cloudflare `/user/tokens/verify`로 토큰이 `success:true + status:active`인지 확인, 무효면 즉시 exit 1 (빌드/배포 낭비 + 오해 제거). 로컬 OAuth 경로(토큰 없음)는 no-op
- **검증**: ① 로컬 무효 토큰 → `❌ INVALID/EXPIRED (verify HTTP 400)` + exit 1 ② 셀프테스트 PASS ③ **CI 실측 (run 31800422203, head=f5ef768)**: guard가 `verify HTTP 401`로 **즉시 BLOCK** — 이전(guard green → build → 10000 실패)과 대비, 빌드 단계도 실행 전에 중단
- **⚠️ 커밋 위생 이슈**: `git add`로 워킹 트리 전체가 스테이징되어, 이전 턴의 미커밋 WIP(verify-do-binding.sh `FAIL_ON_CAPTURE_MISS` cron-bridge 가드, 약 11줄)가 동일 커밋에 함께 포함·push됨 — 기능적으로는 완전한 상태(워킹 트리에서 이미 개발)로 무해하나, 별도 커밋으로 분리하려면 soft reset + 정밀 재커밋 + **force push**(사용자 승인 필요)
- **잔여**: 시크릿 교체(docs/17 2~3단계) 후 staging 디스패치 → `Deploy do-worker` green으로 최종 검증

### 수정 27: 로컬 worktree 배포 자동화 스크립트 — GitHub Actions 실패 우회 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-10 (구현 + 실배포 검증)
- **산출물**: `scripts/deploy-local-worktree.sh` 신규 + `npm run deploy:local` 등록 — GitHub Actions `CLOUDFLARE_API_TOKEN` 무효로 디스패치 배포가 막힌 동안 S105/S106/S73에서 반복한 수동 worktree 절차를 자동화
- **동작**: `deploy-local-worktree.sh [commit] [production|staging]` → 사전 확인(wrangler OAuth) → worktree 생성 + node_modules 심링크 → build → 3단계(DO → Pages --branch → cron 환경별 config) → Pages deployment list **Source 커밋 검증** → 헬스 HTTP 200 확인 → **trap으로 worktree 자동 정리**
- **실배포 검증** (staging @ 41218df, 3회): ① head 파이프로 일찍 종료(배포 전) ② 검증 단계 버그 발견 — `grep -oE '[0-9a-f]{7}'`가 **배포 ID 해시**(4891dff)를 커밋으로 오인 → awk 컬럼 5(Source)로 수정 ③ 수정 후 `예상 커밋: 41218df | 배포된 커밋: 41218df` ✅ · 헬스 200 ✅ · worktree 정리 ✅
- **문서**: docs/17 §5 비상 대체 경로에 `npm run deploy:local` 사용법 반영

### 수정 25: wikipedia/wikidata 서킷 자가회복 — alarm 프로브 UA 부재 403 근본 원인 해소 (S73e, 2026-08-14)
- **작업 ID**: FIX-2026-08-14-08 (진단 + 구현 + 배포 + 실측 검증)
- **배경**: 수정 24 배포 후 30분 backoff 경과에도 wikipedia 계열 서킷이 안 닫힘 — alarm이 실제 도는지(60s 주기)와 프로브 실패의 업스트림 응답을 DO tail 로그로 캡처
- **실측 확정** (DO alarm 로그, 새 진단 로그 S73d):
  - alarm 60초 주기 정상 동작 확인 — skip 로그 `elapsed < backoff(30분)` (en/ko/wikidata 20:30:32 동시 발화)
  - **프로브 실패 원인: `upstream HTTP 403 (Please set a user-agent and respect our robot policy)`** — alarm 프로브가 robots.txt를 **UA 없이** fetch → wikimedia가 403 거부 → alive 판정 실패 → 서킷 유지 루프 (zh도 동일: 429→403 아닌 200으로 리셋 후 발화)
  - 대조 실측 (별도 프로브 워커): UA 설정 시 en robots.txt 429(→alive)·zh/wikidata 200(→alive) — **UA 한 줄로 회복 가능** 확인
  - stackexchange: `upstream HTTP 403 (<html>...` — stackoverflow robots.txt가 Cloudflare bot challenge(UA 무관) → 별도 제약
- **수정** (커밋 **41218df**, 1파일): `probeHost`가 robots.txt fetch에 `User-Agent` 헤더 추가 (프로덕션 검색 UA 미러)
- **배포**: DO v 42609cb4 · Pages 2341255d · cron v f8b60507
- **배포 후 실측 검증** (DO alarm 로그):
  - `Health probe OK (HTTP 200) — circuit auto-closed for zh.wikipedia.org` (20:37)
  - `Health probe OK (HTTP 200) — circuit auto-closed for en/ko.wikipedia.org + www.wikidata.org` (21:00)
  - 헬스: **en/zh/ko/ja wikipedia + wikidata + dbpedia 전부 operational (tripped=False, failures=0)** · bing healthy · 라이브 검색 정상 (EN 실결과 + zh 여행 mafengwo gold)
  - 잔여 down: **api.stackexchange.com만** (Cloudflare challenge 403 — 서킷 유지가 정상 동작; 회복은 데일리 쿼터 리셋 + challenge 우회 별도 논의 필요)
- **정리**: 프로브 워커 s73-wiki-probe 삭제 · worktree/tail 정리

### 수정 24: S73 wikipedia 언어별 공유 cooldown + stack-exchange 429 쿼터 가드 — 서킷 오픈 근본 원인 (2026-08-14)
- **작업 ID**: FIX-2026-08-14-07 (구현 + 테스트 + 배포 + 실측 검증)
- **배경**: 프로덕션 wikipedia(계열 전부) + stack-exchange 서킷 오픈 진단 결과 (수정 23 이후 후속) — 공통 메커니즘 `success = status !== 429 && status !== 503` (rate-limiter.ts:350): **429가 서킷 실패로 집계**. wikipedia는 업스트림 429 + isolate 간 cooldown 미공유(배포본에 S73 미배포)로 집계 해머링 → 5회 트립 → DO에 failures persist → 하프오픈 프로브(30s)가 밴(60s+) 지속 중 실패 → 재트립 루프. stack-exchange는 429(키리스 쿼터 300/day 소진) 시 `quotaRemaining` 미갱신 → 가드(QUOTA_FLOOR) 영원히 안 걸림 → 매 쿼리 API 재호출 → 트립 → 하루 종일 fail-fast
- **수정** (커밋 **e1db35c**, 10파일 +1,830/−82):
  - `specialized.ts` — **S73**: `wikipediaRateLimitedUntilByLang` (언어별 429 창 — en 429가 zh/ja를 죽이던 전역 창 제거) + `isWikipediaRateLimitedShared`/`mirrorWikipediaCooldown` (RateLimiter DO cooldown RPC — S105에 배포된 setCooldown/getCooldown — 로 전 isolate가 같은 창 공유) + `MAX_NETWORK_COOLDOWN_MS`(120s, Retry-After 클램프 공유 승격) + wikipediaSearch 429 체인을 withRetry 데코레이터로 재작성 (fanout 천장 4.5s 내 REST 3000/Action 1500 예산 분할 — probe-wikipedia-budget 실측 검증)
  - `stack-exchange.ts` — **429 수신 시 `quotaRemaining = 0`** (가드 강제 발동 → 이후 쿼리 fetch 전 [] — 서킷 실패 누적 중단) + 5xx/네트워크 1회 재시도(withRetry), 429/4xx/서킷오픈 fail-fast (docs/16 §3.9)
  - 인프라: `resilience/retry.ts` 신규 (withRetry·splitRetryBudget) · fanout `backendTimeoutMs` 단일 소스 · util `DEFAULT_BACKEND_TIMEOUT_MS` (fetchWithTimeout 기본 15000→4000, fanout 천장 정합)
  - S74(wikidata sitelink)·S75(github 캐시)·HN/reddit/arxiv 리팩터·금융 등 동일 파일 내 타 WIP는 **hunk 단위 제외** (격리 worktree 1,912건 테스트로 커밋 트리 검증)
- **배포**: `git push github main` (271a8c7..e1db35c) → 로컬 worktree 절차 3단계 (DO v aadf1ece · Pages Production **Source=e1db35c** (c918159f) · cron v7a1a4d4c)
- **배포 후 실측 검증**:
  - ✓ S73 신규 코드 경로 라이브 확인 (로그: `Wikipedia REST search failed (no response)`, `Wikipedia Action API fallback failed`, `[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing)` — dbpedia 미러가 wikipedia gold 회수)
  - ✓ **stack-exchange 실패 누적 중단**: failures **5 고정** (배포 전에도 5, 45초 간격 비교에서 totalFailures 52 · tripCount 2 불변 — 이전엔 매 쿼리 429 재시도로 계속 증가)
  - ✓ **429→quotaRemaining=0 가드 라이브 재검증 (bf126c5 배포 후)**: 기술 쿼리 3건(`how to sort a list in python`/`merge sort algorithm complexity`/`react useEffect dependency array`) 연속 전송 전부 HTTP 200 반환에도 failures 5 · totalFailures 52 · tripCount 2 · rateLimitedCount 0 **45초 간격 2회 모두 완전 불변** — 가드가 fetch/acquire 이전에 [] 반환해 서킷 실패 누적이 0건. 라우팅된 기술 쿼리가 있어도 API에 도달하지 않음이 카운터로 증명
  - ✓ wikipedia 계열 failures/totalFailures/tripCount 전부 불변 — isolate 해머링 제거 확인
  - ✓ 무회귀: bing/duckduckgo healthy · 라이브 검색 정상 (EN/zh 여행 gold 포함)
- **회복 경로 (정직한 한계)**: 서킷은 현재 **하프오픈 프로브가 업스트림 차단에 걸려 재트립 루프** — 로컬 IP에서 wikipedia REST는 200(업스트림 정상)이지만 **Workers egress IP의 wikimedia 블록이 지속 중**, backoffMs=1,800,000(30분). S73 수정은 자가증폭(해머링)을 제거해 블록이 풀리는 즉시 다음 프로브가 성공해 서킷이 닫히는 **수동 회복** 상태로 전환 — 배포 직후 즉시 닫히지 않는 것은 업스트림 블록이 실재하기 때문. stack-exchange는 데일리 쿼터(300/day) 리셋 + 신규 isolate(모듈 상태 쿼터 300 초기화)의 첫 성공 프로브가 필요
- **잔여**: ① GitHub Actions `CLOUDFLARE_API_TOKEN` 시크릿 여전히 깨짐 ② EmbeddingService pplx-embed 스키마 오류(5006) + D1 semantic_cache 테이블 부재 — 별도 항목

### 수정 20: CJK 여행·커뮤니티 gold site:-라우팅 레버 (S104 — P24 레버 ②) (2026-08-14)
- **작업 ID**: FIX-2026-08-14-03 (진단 + 구현 + 테스트)
- **작업명**: zh 여행·커뮤니티 gold (ctrip/mafengwo/dianping/xiaohongshu/trip/qunar/zhihu — zh 15쿼리 전무 다수, run-3 7/15 NDCG 0.000)를 위한 site: 라우팅 레버 진단·구현
- **진단 (스크립트 실측)**: **bing은 `site:` 연산자를 무시** — `scripts/probe-bing-site.ts`(모바일 HTML)·`probe-bing-site-raw.ts`(데스크톱 HTML)·`probe-bing-rss-site.ts`(RSS `format=rss`) 3개 엔드포인트 모두 `site:mafengwo.cn 张家界旅游攻略`이 plain 검색과 동일 결과 반환, 일부 쿼리는 site:가 키워드로 오염 (크로스랭귀지 쓰레기). 부수 발견: 기존 video 전략 `bing-youtube`(site:youtube.com)도 무시되어 쓰레기 반환 — 후속 점검 대상. `probe-ddg-zh.ts`: 로컬 IP DDG 전량 202 챌린지 (0건 — 인덱스 부재 아님, docs/15 IP 지속 가정과 일치)
- **레버 재설계**: site:를 인정하는 엔진으로 라우팅 (P24 ddg-site-reddit 선례) — `isZhTravelCommunityIntent` 의도 게이트 (15쿼리 중 13개 스케줄, 考研复习计划/手游排行榜는 의도적 제외 — S26 CSDN 전담) + `pickZhTravelCommunityDomain` 쿼리당 ONE gold 도메인 결정적 선택 (FNV-1a 회전, 7개 도메인 분산) + `buildZhTravelCommunityTask` 부가형 `site:<gold> <query>` 태스크 (SEARXNG_URL 설정 시 SearXNG site: 라우팅, 미설정 시 DDG site:)
- **구현**: `src/lib/specialized.ts` (게이트) + `src/lib/search/backend-tasks.ts` (도메인/피커/빌더) + `src/lib/search/strategies/all.ts` (zh 일반 브랜치 배선) + `src/lib/search/fanout.ts` (`ddg-site-zh-travel` 2000ms·`searxng-site-zh-travel` 3000ms 등록) + `src/lib/orchestrator.ts` (waitFor 추가)
- **검증**: typecheck 0 · 유닛 테스트 2,615건 통과 (신규: 게이트 15쿼리 커버리지·도메인 결정성·태스크 구성·SearXNG 분기)
- **Workers egress 실측 검증 (후속, `scripts/probe-egress-worker.ts` → 신규 격리 프로젝트 배포 후 삭제)**:
  - DDG site: **7개 gold 도메인 전부 100% 회수** — mafengwo.cn 11/11 · ctrip.com 12/12 · dianping.com 10/10 · trip.com 12/12 · qunar.com 10/10 · zhihu.com 10/10 · xiaohongshu.com 9/9 (재시도). "DDG가 zh gold 미인덱싱" 우려 반증
  - **DDG 버스트 202이 유일 상한**: 연속 2~4회 후 전 쿼리 ~10~30초 202 (docs/15 IP-지속 가정 확인) — 생산 단일 사용자 트래픽은 정상, eval 벌크는 윈도우당 소수 쿼리만
  - **bing site: 무시를 Workers egress에서도 확정**: site:·plain 완전 동일 결과 (HKG colo는 plain이 이미 gold 반환 — 지역 랭킹 우연)
  - **부수**: 프로덕션 `search-engine-api.pages.dev` partial_outage에서 검색 backend:failed (bing 서킷 healthy인데 실패 — 별도 점검 항목)
- **잔여 (구조적, 실측)**: ① eval 벌크 버스트 202 한계 (생산 정상) ② zh wikipedia 유입 경로 (S73 후 미검증) ③ general HN 가중치 하향 ④ 프로덕션 partial_outage 점검

### 수정 19: general reddit/stack-exchange 백엔드 복구 (P24 레버 ①) (2026-08-14)
- **작업 ID**: FIX-2026-08-14-02 (구현 + 테스트 + 실측)
- **작업명**: 커뮤니티 gold (reddit 15/16 전무)의 근본 원인 — general에서 reddit/stack-exchange 미가동 — 진단 및 복구
- **산출물**: `src/lib/specialized.ts` (redditSearch .rss 폴백·cooldown 가드·isProgrammingIntent/isCommunityAdviceIntent, general useReddit=true) + `src/lib/search/strategies/all.ts` (ddg-site-reddit 태스크, SE 프로그래밍 의도 확장) + `src/lib/search/fanout.ts`/`src/lib/orchestrator.ts` (waitFor 등록) + `tests/unit/specialized.test.ts`·`strategies.test.ts`·`orchestrator-fallback.test.ts`
- **방법**: ① `useReddit:false` 구조적 게이트 확인 ② 라이브 프로브 — `www.reddit.com/search.json` **403 Blocked** (데이터센터 IP), `search.rss` **200 OK** 확정 ③ DDG `site:reddit.com` 실측 10/10 reddit gold (bing은 site: 무시) ④ `detectQueryType`가 how-to를 technical/financial/factual로 오분류 → queryType 게이트가 reddit-gold 15/16 놓침 확정, **의도 게이트로 전환** (커버리지 16/16)
- **핵심 결과**:
  - 게이트 수정: `isCommunityAdviceIntent` (how-to/리스트형/커뮤니티 조언 형태)가 reddit-gold **16/16 전 쿼리 스케줄** (기존 1/16 수준) — DDG 16/16 + SE 1/16 (adv-11 stackoverflow.com)
  - 라이브 단일 run (01:32:56Z, 91쿼리): general NDCG@10 **0.1420 → 0.1553**, zero **45/91 → 43/91 (47.3%)**, 커뮤니티 gold 회수 **4/16** (런마다 rate-limit 윈도우 위치로 회수 쿼리 교체)
  - **잔여 구조적 제약**: DDG html 202 버스트 윈도우 ~10~30초 (연속 호출 시 전멸, 격리 호출 10/10) · reddit RSS ~1/15~60초 cooldown — eval 벌크에서 회수 상한. 생산 단일 사용자 트래픽은 자연 간격으로 정상 동작
  - **지연 trade-off**: waitFor (reddit/ddg-site-reddit 2000ms) — general 평균 1,945ms (p95 4,255ms), 커뮤니티 gold 회수 대가
- **검증**: 유닛 테스트 2,601건 통과 (신규 .rss 폴백·RSS 파서·isProgrammingIntent 15케이스·P24 게이팅) · typecheck 0 · eslint 0경고
- **후속**: ② zh/ja 여행·커뮤니티 gold site: 라우팅 or 크롤러 ③ zh wikipedia 유입 경로 ④ general HN 가중치 하향

---

## 미해결 문제 (추적)
| ID | 문제 | 심각도 | 계획 |
|---|---|---|---|
| P1 | 프로덕션 가동 중이나 **partial_outage** — DO 바인딩·brave 미설정 등 인프라 | High | Dashboard 설정 (11_PRODUCTION_RECOVERY) |
| P2 | DO 8종 프로덕션 바인딩 미설정 | High | P1-2 (Dashboard 수동) |
| P3 | ~~eval NDCG 노이즈~~ → S8/S9 해소 (wikipedia 캐시 + median-of-3) | Medium | ✅ 완료 |
| P4 | ~~zh 일반 쿼리 커버리지~~ → S8 해소 (minResults 완화 + bing 폴백) | Medium | ✅ 완료 |
| P5 | 서브리퀘스트 50/요청 한도 (동시성 제약, 기본 depth ~8 소모) | High | 설계 제약 (env 조절) |
| P9 | 멀티리전 미구현 | Medium | Phase 5 |
| P10 | 개인정보 보존·삭제 정책 미문서화 | Medium | Phase 5 |
| P11 | ~~헬스 체크 false-positive~~ → 이번 세션 수정 | Medium | ✅ 완료 |
| P12 | ~~랭킹: 신선도 블렌드가 골드 만점 결과를 밀어냄~~ → S11 bounded 공식으로 수정 | Medium | ✅ 완료 |
| P13 | ~~NDCG<0.6 쿼리 중 커버리지 미스 118건~~ → 08-13 실측 분석: gold 표준 **shift 오류 7건**(en-tech-04/05/07/08/09/10/11 — 쿼리와 gold 도메인이 한 칸씩 어긋남, en-tech-04(PostgreSQL) gold가 kubernetes.io 등) 수정 → 해당 7쿼리 NDCG 0.19~0.28 → 0.36~0.54로 개선 (검색 코드 무변경, 평가 기준 오류 과소평가 해소) | High | ✅ 완료 (FIX-2026-08-13-06) — 잔여: en-fact-11(bing 'does' 분리 + wikipedia 429 이중 요인), 뉴스 gold 미유입(실행 시점 뉴스 스트림 의존, 구조적) |
| P14 | ~~ja 언어 오분류 (kana 없는 합성어 → zh 라우팅)~~ → S12 해소 (6/7건, 基本은 보류) | High | ✅ 완료 |
| P15 | 사실 교차검증기 한계 — 엔티티 차이 구분 불가 + 섹션 라벨 영문 고정 + SSE 미연결 | Low | S13 후속 (문서화된 한계) |
| P16 | 커밋 분리(9개) 후 eval median NDCG 0.5289 — baseline(0.5327) 대비 −0.004는 노이즈 범위로 확인, 잔여 en-fact-01 wikipedia 429 1건 | Low | median-of-3 게이트 유지 (S9 권장안) |
| P17 | 9커밋 구성이 로컬 전용 — 원격 push 미실시 + 3커밋 재분할 목록은 작성만 함 | Medium | 사용자 결정 후 push/재분할 |
| P18 | ~~auth.test.ts flaky (DO mock 레지스트리 경합)~~ → 08-13 hoisted vi.mock으로 고정 | Medium | ✅ 완료 |
| P19 | ~~arxiv/openalex/brave 일시 장애 0건 처리~~ → 08-13 5xx/네트워크 1회 재시도 구현 (arxiv/openalex/brave + searxng/reddit/stack-exchange 전체 적용) | High | ✅ 완료 (FIX-2026-08-13-02/-04) |
| P20 | 기술 태그 eval 단일 run 기준 NDCG@10 0.306·regression 87건 — gold 표준 노이즈가 지배적 (베이스라인 0.4+ vs 현재 0.31) | High | 08-13 실측: 평균 NDCG는 안정(0.279/0.297/0.284) · 쿼리별 flicker 58/500(11.6%, 도메인 귀속: github 20·en-wiki 15·zh-wiki 14·investing 8·britannica 7·baike 7 — 전부 보조 백엔드 가용성) · zh 20% > en 13.1% > ja 9.8% > ko 6.3%. gold 오류는 EN_FACT nasa.gov 오버브레스 14건만 확인 → S72 교정(FIX-12). zh flicker의 직접 원인은 en 429가 전 언어 wikipedia를 죽이던 전역 cooldown → **S73 언어별 분리(FIX-13)**로 해소. 백엔드 재시도(FIX-02/-04) + arxiv 페이싱·가드(FIX-09/-10)로 ① 완화, 라이브 결과 비결정성(②)은 스냅샷 캐시 없이는 완전 제거 불가 |
| P23 | ~~학술 gold 커버리지 갭 (en-acad-08~17 arxiv 백엔드 누락)~~ → 08-13 원인: eval 벌크가 arxiv 30/min 초과 → 429. eval 페이싱 2200ms(FIX-09) + 프로덕션 cooldown 가드(FIX-10)로 해소 | High | ✅ 완료 |
| P21 | ~~통합 테스트 시작 실패 (DO 분리 배포 후 script_name 바인딩 미해석)~~ → 08-13 self-referencing 바인딩으로 복구, 108건 통과 | High | ✅ 완료 (FIX-2026-08-13-03) |
| P22 | ~~개인정보 보존·삭제 정책 미문서화~~ → 08-13 PRIVACY_POLICY.md 5.1 실측 보강 (DO별 보존 기간·삭제 경로·미구현 사항 공개) | Medium | ✅ 완료 (FIX-2026-08-13-05) — 사용자 자가삭제 API는 여전히 미구현(상용화 전 필수) |
| P24 | **general 태그 커버리지 갭 — zero 45/91 (49.5%, 전체 zero의 45%)** → 08-14 재진단: COVERAGE 40 · MIXED 5 · RANKING 0. gold 전무 healthline 21·webmd 18·japan-guide 16·quora/wikihow/xiaohongshu 15·terms.naver 13·dianping/yahoo.co.jp 11·tripadvisor.com 10·zh.wikipedia.org 4/4·ctrip 15/17·reddit 15/16. 원인: 커뮤니티·헬스 gold 전용 백엔드(reddit/stack-exchange) 미가동 + CJK 여행·커뮤니티 gold 부재 + zh 일반·여행 wikipedia 미검증 구간 + bing 단일 의존 | High | 🔶 **레버 ① (reddit/SE) 실행 완료 (FIX-2026-08-14-02)**: .rss 폴백 (json 403) · DDG site:reddit · SE 프로그래밍 의도 · 의도 게이트 16/16 → 실측 general 0.1420→0.1553 · zero 45→43 · 커뮤니티 회수 4/16 (버스트 rate-limit 상한, 생산 단일 호출은 정상). 🔶 **레버 ② (S104, FIX-2026-08-14-03) 실행 완료**: zh 여행·커뮤니티 gold site: 라우팅 — 실측상 bing은 site: 무시 (모바일/데스크톱/RSS 3엔드포인트) → DDG/SearXNG site: 라우팅 태스크 (의도 게이트 13/15 + FNV 도메인 회전), 유닛 테스트 2,615건. 잔여: ③ zh 위키 경로 ④ general HN 패널티 + DDG zh site: Workers egress 재검증 |
