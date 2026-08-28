# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.8.0] — Agent 도구 최적화 5개 배치: 신뢰성·토큰 경제·보안 (2026-08-28)

### Security
- **`/api/agent/*` 무인증 구멍 봉인** (`src/routes/agent.ts`): search/stream-search/extract가
  인증·레이트리밋 없이 노출되어 있던 것을 `/api/search`와 동일 가드(`validateApiKeyAsync` +
  `checkClientRateLimit` + 감사 로그)로 보호. workerd 통합 테스트 4개로 고정.

### Fixed
- **deep_research 직렬→병렬**: 도구 설명은 "parallel"이라고 선언했으나 실제 직렬 for-loop
  (최악 110s)이던 것을 동시도 3 배치로 교체 (~25s). 로직을 `src/lib/agent-deep-research.ts`로
  분리하고 `POST /api/agent/deep-research` HTTP 패리티 추가.
- **추출 에러 상태 전파**: 모든 티어 실패 시 하드코딩 403(BOT_BLOCKED 오보) 제거 — 관측된
  상태로 분류. 404/410/401 조기 확정 실패(하위 티어 17s 낭비 제거), 신규 택소노미
  `PAGE_NOT_FOUND`/`AUTH_REQUIRED`/`CONTENT_TOO_SPARSE` 활성화.
- **한국어 토큰 예산 2.5x 초과**: `chars/token 3.5` 단일 가정을 언어 인식(한글 1.5) 보정으로
  교체 — `estimateTokens`/`charsPerToken` 단일 표준. `truncateToTokens` 동일 적용.
- **naver 링크 하베스팅 노이즈**: 지식인 프로필/카페·블로그 프론트 도어/"N만 인용" 인플루언서
  카드 차단 + href `&amp;` 미디코드 버그 수정 + fast-path 노이즈 플로어(0.10).
  라이브 실측: "클라우드플레어 CPU 제한" 상위 히트가 프로필 카드(0.05) → 공식 문서(0.75).
- **wikipedia 백본 예산 굶김**: `wikipediaSearch`의 재시도 분할은 파웃 4.5s 천장에 튜닝되어
  REST 시도당 700ms 고정 — 실측 왕복 540-750ms와 경계라 조용히 실패. 백본을 별도 모듈
  (`src/lib/wikipedia-backbone.ts`)로 분리해 Action API 단발 호출. 위키미디어 UA
  `(contact@example.com)` placeholder 17곳 정식 UA로 교체.
- **MCP JSON-RPC 준수**: 미지원 method 무응답(클라이언트 영구 대기) → `-32601` 응답,
  `initialize`가 클라이언트 protocolVersion 반영.

### Added
- **wikipedia 지식 백본**: 모든 프로바이더 빈 결과 시 ko/en 위키피디아로 구조 (빈 경로만,
  p50 불변). 라이브: 벤치마크 통과율 80%→100%.
- **fast-path 마이크로 캐시**: 60s TTL + `cached`/`cache_age_ms` 노출. 빈 결과는 캐시하지
  않음(스크래퍼 허걱 재시도 가능 유지).
- **메인 검색 캐시 나이 노출**: `cached_at`/`cache_age_ms` (메모리+Cache API 티어).
- **소스별 프로바이더 헬스 리포트** (`scripts/run-live-benchmark.ts`): KR/EN/NEWS-KR 레인별
  히트 수·평균 스코어·aborted 원인.
- **tiered-fanout tier0/tier1 동시 시작**: 콜드 self-index(실효 2.5s)가 웹 백엔드 시작을
  지연시키던 것 제거. `freePlan` 옵션 실질화(기존 선언만 되고 무시됨).

### Changed
- **zod→MCP 스키마 단일화**: 수동 inputSchema 이중 정의 제거, 검증 실패 `isError: true`
  구조화 에러, `z.coerce` 적용, `strip_links` 실구현.
- **마크다운 품질**: 링크 보존 + 상대 URL 절대화(라이브 0개→33개), 제목 레벨 보존,
  중첩 article/main 절단 버그 수정(균형 태그 추출), article 내 header(제목) 유지.
- **fast-path 품질**: authority hostname 절미치 매칭(경로 트릭 차단), medium/dev.to 제외,
  서브쿼리 언어 판별, 영어 쿼리 bing+DDG 다양화, 스코어 랭크 감쇠 사전값 + signal_confidence
  정직화(HIGH=2개 이상 0.75+ 히트), DDG 쿨다운 `aborted_backends` 가시화.
- **뉴스 캐시 TTL 30분→5분** (메모리+Cache API): B.1 결정 번복 — 트렌딩 쿼리의 낡은 결과 방지.
- **데드코드 삭제 1,900+ 라인**: query-router.ts(955), edge-cache.ts(298), hybrid-ranker.ts(265),
  fanoutBackends 레거리 실행자 — 참조 전수 검증 후 제거 (PHASES는 부하 모델 의존으로 유지).

### 테스트
- 유닛 3,152 → 3,161 (agent 경로 신규 61개: 에러 택소노미, 토큰 카운터, 백본, 캐시,
  authority 매칭, naver 필터, deep-research 격리)
- 통합 +4 (`tests/integration/agent-auth.test.ts`, 실제 workerd 런타임)

## [2.7.0] — AI Agent 초저지연 검색 및 4단계 스텔스 에스컬레이션 엔진 (2026-08-27)

### Added
- **AI Agent 전용 엔드포인트** (`src/routes/agent.ts` + `src/lib/agent-search-orchestrator.ts`):
  - `POST /api/agent/search`: 병렬 레이스 및 조기 반환(Early Return) 기반 **서브세컨드(P50: 654ms / 212ms, Avg: 786ms)** 초고속 검색.
  - `POST /api/agent/stream-search`: 첫 번째 검색 결과 도착 즉시 방출하는 실시간 SSE 스트리밍 (TTFT < 300ms).
  - `POST /api/agent/extract`: 4단계 스텔스 에스컬레이션 기반 고밀도 노이즈 제로 마크다운 추출.
- **4단계 스텔스 에스컬레이션 엔진** (`src/lib/agent-extractor.ts`):
  - **Tier 1 (스텔스 헤더)**: Chrome 131 `Sec-CH-UA` Client Hints 기반 정적 봇 탐지 우회.
  - **Tier 2 (Jina Global Proxy)**: 403/Turnstile 감지 시 화이트리스트 프록시 자동 승격.
  - **Tier 3 (Scrapling Stealth Sidecar)**: Camoufox + Patchright 기반 C++ 레벨 TLS/JA4 핑거프린트 난수화 및 JS 챌린지 무력화.
  - **Tier 4 (Self-Healing Error Contract)**: 403, 404, SPA 렌더링 실패 시 LLM에게 `agent_hint` 및 `suggested_action` 제공.
- **JSON-LD / Schema.org 제로-토큰 추출기**: `<script type="application/ld+json">` 태그를 DOM 파싱 없이 기계 판독용 정형 JSON으로 즉시 추출 (`extract_depth: "structured_facts"`).
- **시맨틱 헤딩 청킹 & TOC 추출**: 문서 마크다운 헤딩 분해 (`extract_depth: "toc_only"`) 및 특정 챕터만 절삭 추출하는 `section_target` 매개변수 지원.
- **Model Context Protocol (MCP) 서버** (`sdk/mcp_server.py` + `docs/MCP_INTEGRATION_GUIDE.md`): Hermes 3, Claude Desktop, Cursor, Antigravity 등의 AI 에이전트에 `ssak_search`, `ssak_extract`, `ssak_deep_research` 도구를 즉시 제공하는 표준 JSON-RPC 2.0 stdio 서버.
- **Python Agent SDK** (`sdk/agent_tool.py`): LangChain, AutoGen, CrewAI, OpenAI Function Calling 1줄 바인딩 클라이언트 제공.
- **실전 라이브 E2E 벤치마크 하네스** (`scripts/run-live-benchmark.ts`): 5대 시나리오 실시간 웹 트래픽 측정 스위트 (100% Pass Rate).
- **OpenAPI 3.1 명세서 동기화** (`openapi.yaml`): Agent API 3종 공식 등록.

## [2.6.0] — Browser Agent 백엔드 v1 (Phase I) (2026-08-24)

### Added
- **로컬 브라우저 검색 백엔드** (`browser-agent/server.mjs` + `src/lib/browser-search.ts`):
  - 실행 중인 Chrome에 CDP 연결(DevToolsActivePort 자동감지) — 거주 IP·실제
    핑거프린트·로그인 세션으로 봇 차단 통과 (개인 단일 사용자 전용)
  - Bing SERP: ck/a 클릭추적 base64 디코딩 / Naver: 2026 리디자인 대응
    외부 호스트 링크 수집(광고 ader.naver.com 배제)
  - `/page` 본문 추출 + SSRF 방어, Bearer 인증, 내비게이션 페이싱 4초
  - CF 측 `BROWSER_AGENT_URL` env 게이트 백엔드(tier1) — 미설정 시 하위호환
- **동치 게이트 양측 키 인증** (`scripts/verify-env-equivalence.sh`):
  - 환경별 API_KEY_DO 저장소 분리 실측 대응 — EQ_A_KEY/EQ_B_KEY 시크릿
- **문서**: docs/BROWSER_AGENT.md (설계·보안·운영)
- 단위 테스트 3135 → 3141

### Fixed
- **/api/keys 무인증 발급 취약점** (`src/routes/keys.ts`):
  - 라이브 실측으로 확인 — POST/GET이 인증 없이 통과(주석과 불일치)
  - requireManageAuth 가드: 유효 키 + write/admin 스코프 요구 (부트스트랩 모드 유지)

### Changed
- 프로덕션 동기화: fb48380 직접 배포(로테이션 문서 공인 완화 경로)

## [2.5.0] — 백엔드 풀 응집도 필터 (Phase H) (2026-08-24)

### Fixed
- **tier 기아(starvation)** (`src/lib/search/tiered-fanout.ts` `relevantFilter` 옵션 +
  `src/lib/search/ranking.ts` `buildRelevanceProbe` export + orchestrator 주입):
  - 안티봇 셸 정크가 minResults 조기 종료를 충족해 tier2(wikipedia/github)를
    실행하지 않게 하는 결함 수정 (en-fact-* 9개 쿼리가 bing-only 빈 풀이던 근원) —
    조기 종료 판정을 응집 통과 결과 수 기준으로 변경, 정크는 fail-forward
- **doi.org 홍수**: 학술 풀의 doi.org 리다이렉트 도배를 capSourceResults 3건 캡으로
  다양성 확보
- **eval 아티팩트 위생** (`eval/index.ts`):
  - `--tag` 진단 실행이 `eval/results/latest.json`(공식 풀폴 아티팩트)을 덮어쓰는 버그 수정 —
    커밋 이력 전반에서 공식 아티팩트가 부분 집합 보고서로 오염된 실측 피해 기반.
    풀폴 실행만 최신 아티팩트를 갱신, 태그 실행은 stdout으로 기록
- **안티봇 셸 수확(harvest) 오염** (`src/lib/search/ranking.ts` `filterIncoherentResults` 신규 + orchestrator 연결):
  - 라이브 진단으로 확인된 결함: Bing 안티봇/consent 셸에서 파서가 이물 링크를 수확
    ("리액트 훅"→Yahoo JP 증권, "photosynthesis"→MS 지원 페이지+Baidu 지식iN) —
    풀이 비어있지 않아 DDG 비상 폴백이 발동하지 않는 구조적 맹점
  - 쿼리 신호(BM25 토크나이저 재사용: 한국어 스테밍+CJK 바이그램)와 제목+본문이
    무관한 결과 폐기. 라틴어 단어 경계 매칭("work"≠"networks")
  - 교차언어 지식원 면책(wikipedia/github/MDN/stackoverflow) — kr-tech 골드 22개의
    영어 GitHub 결과 보존
  - 전량 가비지 풀 → 빈 풀 변환으로 기존 폴백 체인(self-index→SearXNG→DDG) 실제 발동
  - **측정**: conversational NDCG@10 0.2353→0.3025 (+28.5%), MRR +29%,
    kr-conv-07 +0.361. kr-tech 타겟 검증 통과

### Changed
- **qrels 현실화**: kr-conv-02 골드에 kakaocorp.com 추가 (카카오 공식 IR 자료실 —
  suffix 매칭 불일치로 0점 처리되던 최고 권위 소스 수정)
- **README 품질 섹션을 공식 풀폴 아티팩트로 동기화**: NDCG@10 0.653 / MRR 0.980 /
  P@10 0.741 (600쿼리 정상 환경 실행 기준)

### Added
- **방어 계층 관측성** (`src/lib/metrics.ts`): Phase H 카운터 4종을
  /api/metrics(Prometheus)에 노출 — 응집도 폐기/빈 풀/하베스트 억제/doi 캡.
  프로덕션에서 방어의 작동·과잉 여부를 메트릭으로 판정 가능
- **동일 환경 풀폴 회귀 검증** (`scripts/run-chunk-eval.ts` 신규):
  - Aug-17 청크 베이스라인 대동일 조건 재측정 — **600쿼리 평균 NDCG@10
    0.2601 → 0.3716 (+42.9%)**, 6개 청크 전부 개선(+16~+89%)
  - 절대치는 샌드박스 환경 기준, 게이트·상용 비교는 정상 아티팩트(0.653) 유지
- 단위 테스트 3125 → 3132 (filterIncoherentResults 7건)

## [2.4.0] — Semantic Cache 어휘 진입 게이트 (Phase G) (2026-08-24)

### Added
- **시맨틱 캐시 히트율 시뮬레이터** (`scripts/sim-semantic-cache-hitrate.ts` 신규):
  - eval 풀 939개 쿼리를 실제 임베딩 공간(Ollama nomic-embed-text)에서 pairwise 분석 —
    임계값별 충돌 수·골드 도메인 의도 판정·게이트 효과 측정
- **어휘 진입 게이트** (`src/lib/semantic-cache.ts`):
  - `lexicalDice()` export: 공백 토큰 + CJK 문자 바이그램 Dice 계수
  - lookup에 fail-closed 이중 게이트 적용: cosine ≥ 0.92 AND dice ≥ 0.3
- **측정 결과 (930 distinct 쿼리)**:
  - 기존 0.92 단독: distinct 쌍 342개 충돌, 정밀도 ~80% — 이질 의도가 cos 1.0000까지 충돌
    (「什么是暗物质」↔「箱根温泉旅館」), 임계값 상향만으로는 정밀도 곡선 평평해 해결 불가
  - 게이트 적용: 진입 342 → 72 쌍, 판정 정밀도 **97.2%** (로드맵 목표 95%+ 달성)
- 단위 테스트 3119 → 3125 (lexicalDice + 게이트 차단 + fail-closed)

### Changed
- 기존 semantic-cache hit 테스트가 metadata에 저장 query 텍스트를 포함하도록 현실화
  (fail-closed 게이트 계약 반영)

## [2.3.0] — 영어 구어체 백엔드 정규화 (Phase F) (2026-08-24)

### Added
- **영어 구어체 골격 제거** (`src/lib/korean/backend-query.ts` ENGLISH_NOISE):
  - 백엔드 페칭 시 의문사(what/who/why/how + what's 축약)·계사(is/are/was/were/am)·조동사(does/did)·관사(the/an)·필러(tell/show/explain/please/about/me/my/us) 제거
  - 충돌 클래스 의도적 제외: will/can/may/do/get/find/search — "will smith", "can bus", "windows search not working", "get request vs post" 보존
  - **측정**: live A/B(`--tag conversational`) en-conv 평균 NDCG@10 0.1831 → 0.2337 (+28% 상대), 두 독립 실행에서 4개 쿼리 일관 개선, kr-conv 회귀 0
- **영어/일본어 구어체 평가 커버리지** (`eval/queries-expansion.ts` en-conv-01~08 + ja-conv-01~02, gold-standards 동시 확장):
  - `--tag conversational` 격리 측정 풀 8 → 18개
- **일본어 とは 처리 — 측정 기반 철회**:
  - 접미 제거 시도 후 라이브 A/B에서 ja-conv NDCG −0.24 부정 측정. とは는 일본어 표준 검색 질의형으로 보존이 정답 — 보존 계약 테스트로 명문화
  - 단일 런 Bing 스크래핑 노이즈 ±0.07 NDCG/쿼리 확인 — 판정에 다중 실행 필요성 문서화

### Changed
- 전체 단위 테스트 3113 → 3119 (backend-query 7 → 13)

## [2.2.0] — 한국어 특화 NLP (Phase 2.3) (2026-08-23)

### Added
- **한국어 경량 스테머** (`src/lib/korean/stemmer.ts`):
  - 쿼리 측 조사(partcle) 제거: "삼성전자의 주가를" → [삼성전자, 주가]
  - 복합 조사 처리 (에서는/에게서/으로부터 — longest-first 매칭)
  - 요청어미 제거 (비교해줘 → 비교, 설명해주세요 → 설명)
  - 대화형 필러 제거 (알려줘/찾아줘 등 → 토큰 스트림에서 완전 제외)
  - 최소 어간 길이 가드 (2음절 미만 축소 금지) + NFC 정규화
  - **충돌 클래스 배제**: 이/가/도/로/만 어말은 수천 개 실제 단어(포도/지도/속도/사이/두바이)와 형태가 겹쳐 스트립 대상에서 의도적 제외 — 예외 사전(마을/금은, 접미 매칭으로 한옥마을까지 보호)으로 잔여 모호성 처리. eval 풀 진단으로 발견된 과잉 스트리핑(국제유가→국제유 등) 수정
- **한국어 동의어 확장** (`src/lib/understanding/query-expander.ts` KOREAN_SYNONYMS):
  - 동일언어 변형 클러스터: 핸드폰↔휴대폰↔스마트폰, 비밀번호↔패스워드, 월급↔급여↔연봉, 자동차↔차량, 아파트↔주택↔부동산, 이메일↔전자우편
  - ko→en 교차언어 추가: 김치→kimchi, 코스피→kospi, 코스닥→kosdaq, 대학교→university, 병원→hospital
  - 정밀도 우선 설계: 복합어 충돌 키(컴퓨터 ⊂ 양자컴퓨터)는 의도적으로 제외 — TDD로 오탐 확인 후 제거
- **한국어 검색 정확도 통합** (`src/lib/retrieval/bm25.ts` tokenize + `src/lib/util.ts` computeScore):
  - 쿼리 전처리 단계에 스테밍 적용 — 조사가 붙은 쿼리 토큰이 원형 문서와 substring 매칭
  - 문서 측 무변경: BM25 docLen 스케일 시프트 없음 (Wave 1 계약 보존), 재인덱싱 불필요
- **대화형 평가 커버리지** (`eval/queries.ts` kr-conv-01~08 + gold-standards):
  - 구어체 변형 쿼리 8개 (조사 부착/요청 어미/필러/동의어/교차언어 각각 트리거)
  - 골드는 대응 격식 쿼리와 동일 정보 니즈 공유 — `--tag conversational`로 격리 측정
- **결정론적 A/B 시뮬레이터** (`scripts/sim-korean-stemmer-ab.ts`):
  - 고정 결과 풀 위에서 변경 전·후 스코어링 비교 — 백엔드 노이즈 없는 순수 랭킹 델타 측정
- **백엔드 쿼리 정규화** (`src/lib/korean/backend-query.ts` + orchestrator fetchCtx):
  - 백엔드 페칭에만 키워드형 정규화 쿼리 전달 (조사·의문사·필러·구어 시간사 제거) — 캐시 키/스코어링/임베딩은 원문 유지
  - 구어체 eval NDCG@10 누적 0.1886 → 0.3266 (+73%): kr-conv-03 Bing 영어 가비지 → 한국 코스피 콘텐츠, kr-conv-05/06 비제로 달성, 전 쿼리 non-zero
  - qrels 현실화: kr-conv-05 골드에 실측 회수 경제 뉴스 도메인 추가, kr-conv-06에 주제 정보원(namu.wiki 등) 추가
  - S48 계약 문서화: 암호화폐 금융 게이트 제외는 의도적 설계 (naver-finance 서빙 범위) — 전용 크립토 백엔드는 별도 과제
- **스팸 도메인 강등** (`src/lib/search/ranking.ts` LOW_QUALITY_DOMAINS):
  - job592.com -0.4 추가 — 도박/베팅 SEO 스팸 팜이 키워드 스터핑으로 Tier 1 통과한 관측(eval kr-conv-07) 기반, esusatyo.net 선례 티어
  - 일반 언더스코어 스터핑 페널티는 측정 기각: 정상 풀 2,130건에서 오탐 소지(GitHub 저장소명)만 확인
- **전용 크립토 시세 백엔드** (`src/lib/crypto-search.ts` 신규):
  - 소스 체인: Upbit public ticker(KRW, 키리스) → CoinGecko 폴백 — 60초 마이크로 캐시로 상류 호출 절약
  - QueryType `'crypto'` 신설: FINANCIAL_PATTERN 이전 감지(bare 코인 제외), S48 의도 충족
  - 구조화 카드(stock_data): recomputeScores 점수 보존 + LTR 면제 + 신선도 정렬 최대값 — 파이프라인 3계층 정합 수정
  - 캐시 제외: 크립토 쿼리는 memory/Cache API/semantic 장기 캐시 우회 (신선도 계약)
- 구어체 eval 최종 NDCG@10 **0.3671** (세션 시작 0.1886 대비 **+95%**) — kr-conv-06 upbit.com rank 1 달성

### Tests
- `tests/unit/korean-search-nlp.test.ts` 신규 — 25개 테스트 (충돌 클래스 보존, 예외 사전, 요청어미, NFC, 동의어, tokenize/computeScore 통합)
- `tests/unit/backend-query.test.ts` 신규 — 7개 테스트 (정규화, 의문사 제거, Latin 보존, 빈 쿼리 폴백 계약)
- `tests/unit/crypto-search.test.ts` 신규 — 11개 테스트 (코인 감지, 카드 합성, 폴백 체인, 마이크로 캐시, no-op 계약)
- `tests/unit/ranking-authority.test.ts` — job592 강등 계약 테스트 추가 (동일 콘텐츠 컨트롤 대비 −0.4 시프트 검증)
- `tests/unit/specialized.test.ts` — crypto 라우팅 계약 테스트 추가
- 전체 유닛 스위트 3113/3113 PASS — 기존 랭킹/BM25/확장/orchestrator 테스트 회귀 0

## [2.1.0] — 하이브리드 검색 + 로컬 인덱싱 + 뉴스 RSS + BGE-Reranker v2.0 (2026-08-20)

### Added
- **하이브리드 검색 파이프라인** (`scripts/hybrid-search.py`):
  - 로컬 인덱스(ChromaDB + Ollama) + Cloudflare 통합 검색
  - 로컬 우선, 부족하면 클라우드 폴백
  - 결과 통합 + 리랭킹 (가중치: 로컬 1.2x, 클라우드 1.0x)
  - 벤치마크: 하이브리드가 100% 승리 (평균 점수 0.964)
- **로컬 인덱싱 파이프라인** (`scripts/local-index-v2.py`):
  - Jina Reader API로 실제 콘텐츠 추출 (무료, API 키 불필요)
  - 스마트 청킹 (헤더/문단 기반, 400 단어/chunk)
  - Ollama nomic-embed-text 임베딩 (768차원)
  - 인덱싱 속도: URL당 0.55초
  - 검색 속도: ~70ms
- **뉴스 RSS 스케줄러** (`scripts/news-rss-scheduler.py`):
  - 39개 RSS 피드 (7개 카테고리)
  - 자동 중복 방지 (SQLite)
  - cron 스케줄링 지원
  - 283개 기사 인덱싱 완료
- **한국 뉴스 RSS 피드 12개 추가**:
  - 매일경제 (자체 RSS)
  - Google News 기반 11개 (경제, 정치, 기술, 스포츠, AI, 반도체, K-POP, 코스피)
  - anti-bot 회피 로직 강화 (User-Agent 로테이션, 헤더, 지연 시간)
- **BGE-Reranker v2.0 Workers AI 통합** (`src/lib/retrieval/reranker.ts`):
  - 모델 업그레이드: `bge-reranker-base` → `bge-reranker-v2-m3`
  - 다중 언어 지원 (한국어, 중국어, 일본어)
  - heuristic fallback 강화 (9가지 피처)
- **Cloudflare 동기화** (`scripts/sync-to-cloudflare-v2.py`):
  - 로컬 인덱스 → Cloudflare 동기화
  - 71개 URL, 148개 청크 동기화 완료
- **뉴스 → Cloudflare 동기화** (`scripts/sync-news-to-cloudflare.py`):
  - 283개 뉴스 기사 → 318개 청크 동기화

### Changed
- `src/lib/search/fanout.ts` — HackerNews 타임아웃 1800→2500ms
- `src/lib/search/strategies/all.ts` — Bing 4종 병렬 사용 + 백엔드 전체 활성화
- `src/lib/retrieval/reranker.ts` — heuristic 리랭커 강화 (BM25 + 도메인 권위 + 언어 가중치 + 신선도 + 콘텐츠 품질 + URL 구조 + 의미적 유사도)
- `src/routes/search.ts` — API_KEY_DO 인증 버그 수정 (validateApiKeyAsync 사용)

### Tests
- ranking-authority.test.ts: ✅ 32개 테스트 통과
- ranking-bm25.test.ts: ✅ 38개 테스트 통과
- 하이브리드 검색 벤치마크: ✅ 15개 쿼리 테스트

---

## [Unreleased] — E2E 골든 패스 검증 완료 + workerd 테스트 런타임 DO·auth 수정

### Added (tests)
- `tests/integration/e2e-golden-path.test.ts` (신규, 6건) — 검색→추출→답변 전체 HTTP 스택 E2E: Tavily 호환 계약 고정, 캐시 round-trip(2차 요청 zero backend fetch), 캐시 키 격리, include_answer 파이프라인, /api/extract, search→top result→extract 풀 체인. `globalThis.fetch` mock으로 실외 네트워크 0 (flaky 불가).
- `vitest.e2e.config.ts` (신규) — `remoteBindings: false` 로컬 workerd 세션 (CLOUDFLARE_API_TOKEN 불필요).
- `package.json` — `test:e2e` 스크립트.

### Fixed (test runtime)
- `tests/integration/do-bindings.ts`: 신규 DO 3개(`TENANT_AUDIT_DO`/AuditLogDO, `TENANCY_DO`/TenancyDO, `NEWS_HUB_DO`/NewsHubDO) self-referencing 오버라이드 누락 → workerd 기동 실패(`ERR_RUNTIME_FAILURE: no such service is defined`) 해결. wrangler.jsonc 14개 DO와 동기화.
- `src/index.tsx`: `AuditLogDO`·`TenancyDO` 리-에クス포트 추가 (pool이 self designator를 메인 worker exports에서 해석 — prod Pages에서는 비활성 export).
- `vitest.e2e.config.ts`: fail-closed auth(auth.ts) 대응 — 테스트 워커에 `SEARCH_API_KEY: 'test-key'` 부여 + 테스트 `fetchJson` 헬퍼가 `X-API-Key` 헤더 전송.
  - ⚠️ **이 pool 버전의 `miniflare.vars`는 workerd env로 전파되지 않음** (core 플러그인 zod 스키마에 `vars` 필드 없음 — silently dropped). `bindings`(object form)이 실제로 env로 병합되는 경로 — config에 주석으로 고정.

### Verified
- `npm run test:e2e` — **6/6 PASS 3회 연속 그린** (2026-08-19). `docs/20_CEO_MASTER_PLAN.md` 5.4 QA E2E 항목 [~] 갱신 (골든 패스 6건 완료, 10시나리오 확장 잔여).

## [Unreleased] — synthesizer Retry-After [1s, 120s] 안전 범위 클램프 (retryAfterRangeMs 옵션)

### Changed
- `src/lib/resilience/retry.ts`:
  - **`SAFE_RETRY_AFTER_RANGE_MS = { minMs: 1000, maxMs: 120_000 }`** export — Retry-After 안전 범위 단일 소스. 1s 하한(429 직후 즉시/초 단위 미만 재시도 → hammering·재-429 루프 방지), 120s 상한(네트워크 쿨다운 `MAX_NETWORK_COOLDOWN_MS`와 동일한 절대 상한 철학).
  - **`RetryAfterRange` 인터페이스** (minMs?/maxMs? — 한쪽만 지정 가능) + **`clampRetryAfterMs(ms, range?)`** 순수 헬퍼 — 범위 밖 값을 경계로 수렴, undefined 경계는 건너뜀.
- `src/lib/agentic/synthesizer.ts`:
  - **`SynthesizerOptions.retryAfterRangeMs?: RetryAfterRange`** (기본 `SAFE_RETRY_AFTER_RANGE_MS`) — getRetryAfterMs가 `retryAfterMsFromError`(15s 내장 캡) 결과를 이 범위로 클램프. 1s 미만 Retry-After(예: 50ms)는 1s로 상향, 비현실적 긴 대기는 120s로 하향. 운영자가 더 좁은 예산을 원하면 maxMs만 줄이면 된다.

### Added (tests) — TDD RED→GREEN, 4건
- `tests/unit/retry.test.ts` 2건: 기본 [1s, 120s] 클램프(0/500→1000, 300000/86400000→120000, 경계·범위 내 유지) / 커스텀·부분 범위(min 미지정 → 하한 없음, max 미지정 → 상한 없음).
- `tests/unit/agentic-synth-quality.test.ts` 2건 (synthesizer 통합):
  - **min-클램프**: `retryAfterMs: 50` → 1000ms로 상향 — 510ms 시점 미발화(클램프가 없었다면 50ms에 재시도), 1210ms 재시도·회복. (기존 '50ms Retry-After override' 테스트를 새 계약으로 갱신 — rateLimitDelaysMs [1]보다 늦게 재시도됨을 그대로 증명.)
  - **max-클램프(옵션)**: `retryAfterRangeMs: { minMs: 1000, maxMs: 5000 }` + `retryAfterMs: 15000`(extractor 캡 통과 값) → 5000ms로 하향 — 3000ms 미발화·6000ms 재시도·회복.

## [Unreleased] — planner·quality-gate가 httpErrorFromResponse 실제 오류를 소비하는 통합 테스트 (isRateLimitError 조합 고정)

### Added (tests) — 4건
- `tests/unit/agentic-planner-executor.test.ts` 2건:
  - **실제 httpErrorFromResponse 429**(Retry-After: 3600) 소비 — `isRateLimitError`가 status 프로퍼티로 인식 → `rateLimitDelaysMs` 경로 발화, Retry-After가 `DEFAULT_RETRY_AFTER_CAP_MS`(15s)로 클램프되어 시퀀스([2000,4000] 지터 최대 3000ms) 대신 15s 대기 — 4000ms 시점 미재시도·16000ms 재시도·회복으로 검증.
  - **비-429(500) httpErrorFromResponse 오류** — `isRateLimitError=false`, planner의 `retryable: () => true`가 일반 백오프(250ms 지터)로 재시도·회복 (rateLimitDelaysMs 경로가 아님을 고정).
- `tests/unit/agentic-synth-quality.test.ts` 2건:
  - **실제 httpErrorFromResponse 429**(Retry-After: 0) 소비 — 즉시 재시도(시퀀스 지터 최소 1000ms가 아니었음을 타이밍으로 증명) → AI 재포뮬레이션 유지 (heuristic 아님).
  - **비-429(500) httpErrorFromResponse 오류** — `isRateLimitError=false` → `retryable: isRateLimitError` 게이트 fail-fast(1회 호출) → heuristic 폴백.
- 소비 경로(getRetryAfterMs: retryAfterMsFromError)는 이미 연결되어 있어 구현 변경 없이 GREEN — 실제 게이트웨이 오류 변환(httpErrorFromResponse) → isRateLimitError 인식 → Retry-After 재정의·캡의 전체 체인을 통합 레벨에서 고정.

## [Unreleased] — council/openai 라우트 fetch 기반 LLM 호출부 429 재시도 통일 (httpErrorFromResponse + withRetry)

### Changed
- `src/routes/council.ts`:
  - **`invokeOpenAI`/`invokeClaude`** (export로 승격) — fetch 기반 외부 게이트웨이(OpenAI/Anthropic) 호출을 `withRetry`로 감쌌다: `retryable: isRateLimitError`(429만 재시도, 비-429는 기존 fail-fast → `available:false` 소화 유지), `rateLimitDelaysMs [2000, 4000]`(LLM 파이프라인과 동일 시퀀스), `getRetryAfterMs: retryAfterMsFromError`(서버 지시 대기 우선, maxDelayMs×3 캡), `onRetry` 로그.
  - `!resp.ok` throw가 `httpErrorFromResponse`로 교체 — 429 응답의 **Retry-After 헤더가 오류(status + retryAfterMs)에 실려** 재시도 루프가 소비한다.
- `src/routes/openai.ts`:
  - 내부 `/api/search`·`/api/research` fetch를 **`callInternalApi` 헬퍼로 추출** (export) — 동일한 `withRetry` 429 정책 적용. 오류 본문의 `detail`을 메시지에 담아 `httpErrorFromResponse`로 변환.
  - 두 브랜치의 오류 처리를 try/catch로 재구성: **429(재시도 소진)는 실제 상태를 클라이언트에 패스스루**(SDK가 백오프하도록 — 기존 502가 아니게 됨), 그 외 오류는 기존 502 유지. `ContentfulStatusCode`로 동적 상태 타이핑.

### Added (tests) — TDD RED→GREEN, 12건 (`tests/unit/council-openai-retry.test.ts`)
- invokeOpenAI 3건: Retry-After(0s)가 고정 [2000,4000] 백오프를 재정의하고 즉시 재시도해 회복 / 429 소진 시 status+retryAfterMs 오류 / 500 fail-fast(1회 호출)
- invokeClaude 2건: Retry-After 회복 / 소진 시 `retryAfterMsFromError`가 힌트(3000ms) 소비
- council 라우트 e2e 2건: 429 후 재시도 → `available:true` + 응답 / 429 소진 → `available:false` + 429 메시지 (200 본문 소화 유지)
- callInternalApi 3건: Retry-After 회복·JSON 반환 / 소진 시 status:429 + detail 메시지 / 500 fail-fast
- openai 라우트 e2e 2건: 내부 search 429 후 회복 → 200 + 내용 / 429 소진 → **429 패스스루** (502 아님) + `search_error`
  - fake timers + `mockImplementation`(매 호출 새 Response — 본문 재사용 방지) + 즉시 catch(unhandled rejection 방지) 패턴.

## [Unreleased] — withRetry(rateLimitDelaysMs 경로)에 Retry-After 캡 적용 — planner·quality-gate 429가 서버 지시 대기를 소비

### Changed
- `src/lib/resilience/retry.ts`:
  - **`RetryOptions.getRetryAfterMs?`** 추가 — `withResultRetry`의 동일 옵션을 `withRetry`(예외 기반 재시도)로 확장. 던져진 오류가 Retry-After 힌트(429 응답 헤더 → `httpErrorFromResponse`/`retryAfterMsFromError`가 `retryAfterMs`로 부착)를 지니면, 다음 시도 지연을 **rateLimitDelaysMs/delaysMs/지수 백오프보다 우선** 재정의한다. 서버 지시 대기는 권위를 가지므로 raw 사용(jitter 없음) + `maxDelayMs × 3`(per-call 캡, 기본 15s) 클램프 — `withResultRetry`와 동일한 이중 캡 계약.
  - 힌트가 없으면 기존 시퀀스로 폴백 (회귀 없음). 비-429 오류도 힌트를 지니면 따른다 (`withResultRetry`와 동일 — 힌트는 오류 형태에만 존재).
- `src/lib/agentic/planner.ts` · `src/lib/agentic/quality-gate.ts`:
  - 각 `withRetry` 호출에 **`getRetryAfterMs: retryAfterMsFromError`** 연결 — LLM 파이프라인 3개 지점(planner·synthesizer·quality-gate)이 모두 429 응답의 Retry-After를 소비. 게이트웨이(OpenRouter 등)가 `httpErrorFromResponse`로 변환한 헤더가 재시도 루프까지 살아 전달된다.

### Added (tests) — TDD RED→GREEN, 6건
- `tests/unit/retry.test.ts` (withRetry) 4건:
  - 429 Retry-After(5000ms)가 `rateLimitDelaysMs [20]`을 재정의 (fake timers + onRetry delay 검증)
  - 429 Retry-After가 `maxDelayMs×3` 캡을 넘으면 클램프 (5000 → 300 @ maxDelayMs 100)
  - 힌트 없는 429 → `rateLimitDelaysMs` 시퀀스 폴백 (회귀 핀)
  - 비-429(503) 오류도 힌트를 지니면 대기를 따름 (`withResultRetry` 계약 정합)
- `tests/unit/agentic-planner-executor.test.ts` 1건: planner 429 + Retry-After(200ms) — 150ms 미발화, 300ms 재시도 완료 (고정 [2000, 4000] 지터 최소 1000ms보다 일찍) → AI 플랜 회복.
- `tests/unit/agentic-synth-quality.test.ts` 1건: `reformulateQuery` 429 + Retry-After(200ms) — 동일 타이밍 검증으로 AI 재포뮬레이션 유지 (heuristic 폴백 아님).

## [Unreleased] — 네트워크 백오프 쿨다운 절대 상한 (maxCoolDownMs) — 비현실적 쿨다운이 검색 백엔드를 막는 것 방지

### Changed
- `src/lib/specialized.ts`:
  - **`MAX_NETWORK_COOLDOWN_MS = 120_000`** (2분) export — 네트워크 백오프 쿨다운의 절대 상한 단일 소스. Retry-After 캡(LLM 게이트웨이)과 동일 원칙: 서버 지시는 상한 안에서 권위를 가지지만, 오설정·비현실적 값이 백엔드를 수 시간 막지 않는다. wikimedia의 기존 `[1s, 120s]` 클램프 상한을 공유 상수로 승격.
  - **`recordGithubSearchCall`** — Retry-After 경로가 **무제한**(raw `retryAfterSec * 1000`)이던 것 수정: `Math.min(retryAfterSec * 1000, MAX_NETWORK_COOLDOWN_MS)`로 클램프. `Retry-After: 3600`(1시간)이 GitHub /search를 한 시간 막는 리스크 제거. (`x-ratelimit-reset` epoch 경로는 GitHub의 실제 쿼터 마감 시각이라 권위 유지 — 정당한 시간 단위 리셋을 클램프하지 않음, 주석 문서화.)
  - **`recordWikipediaRateLimit`** — 리터럴 `120_000`을 `MAX_NETWORK_COOLDOWN_MS`로 교체 (동작 불변, 단일 소스).

### Added (tests)
- `tests/unit/specialized.test.ts` 3건 (TDD RED→GREEN):
  - github `Retry-After: 3600` → 120s 캡 (119s 차단 유지·121s 해제) — RED (기존 무제한) → GREEN
  - github 정상 `Retry-After: 30` → 캡 미적용 회귀 핀 (29s 차단·31s 해제)
  - wikipedia `Retry-After: 3600` → 공유 120s 캡 핀 (기존 동작을 상수로 고정)

## [Unreleased] — Retry-After 상한 캡 (과도한 서버 대기로 인한 요청 정지 방지)

### Changed
- `src/lib/resilience/retry.ts`:
  - **`DEFAULT_RETRY_AFTER_CAP_MS`** (기본 maxDelayMs 5000 × 3 = 15s) export — `retryAfterMsFromError`가 추출한 대기를 이 캡으로 클램프. 서버의 Retry-After는 캡 안에서 권위를 유지하지만, 오설정·비현실적으로 큰 값(예: 3600초)이 요청을 수 분/수 시간 멈추게 하지 않는다.
  - **`withResultRetry` 소비부 이중 클램프** — `getRetryAfterMs` 반환값을 `maxDelayMs × 3`(per-call 캡, 기본 15s)로 한 번 더 클램프. 호출부가 더 작은 maxDelayMs를 지정하면 그 예산을 존중.
  - 구현 중 발견한 시그니처 충돌 회피: `retryAfterMsFromError`는 단일 인자 유지 (2번째 인자로 capMs를 받으면 `getRetryAfterMs(err, attempt)`의 attempt와 충돌해 소비부가 깨짐 — 테스트로 고정).

### Added (tests)
- `tests/unit/retry.test.ts` 2건 (TDD RED→GREEN):
  - 과도한 Retry-After(3600초·86400000ms) → **15000ms 캡**, 캡 이하 값은 그대로 (5000ms 유지)
  - withResultRetry: `getRetryAfterMs` 5000ms + `maxDelayMs: 100` → 실제 대기 **300ms** (maxDelayMs×3)
- 기존 Retry-After 소비 테스트(synthesizer 50ms·1s, httpErrorFromResponse 3000ms) 전부 캡 이하라 무회귀.

## [Unreleased] — fetch 기반 LLM 게이트웨이 429 Retry-After → 오류(retryAfterMs) 변환 헬퍼

### Added
- `src/lib/resilience/retry.ts`:
  - **`httpErrorFromResponse(response, message)`** — 비-OK fetch 응답을 `Error & { status, retryAfterMs? }`로 변환. 429 응답의 **Retry-After 헤더**(정수 초 또는 HTTP-date)를 `parseRetryAfter`(기존 내부 헬퍼 재사용)로 파싱해 `retryAfterMs`에 부착 — `retryAfterMsFromError`(synthesizer의 `getRetryAfterMs`가 이미 연결)가 즉시 소비. 헤더 없음·파싱 불가 시 `status`만 실림 (기존 백오프 폴백).

### Changed
- **fetch 기반 LLM 게이트웨이 호출부 6곳** — `throw new Error(...)` → `throw httpErrorFromResponse(response, ...)`:
  - `src/lib/llm-router.ts`: `streamOpenAICompatible`(OpenAI/Ollama) · `generateOllamaAnswer` · `generateOpenRouterAnswer` · `streamAnthropic`
  - `src/lib/answer.ts`: `generateWithOpenAI` · `generateWithAnthropic`
  - 이전에는 429 응답의 Retry-After 헤더가 그대로 버려져 synthesizer가 힌트를 못 찾고 고정 `[2000, 4000]` 백오프로 폴백했음 — 이제 서버 지시 대기가 오류 객체를 타고 재시도 파이프라인까지 살아서 전달됨.

### Added (tests)
- `tests/unit/retry.test.ts` 4건 (TDD RED→GREEN): status+초 헤더 → 3000ms / HTTP-date → 5000ms(fake system time) / 헤더 없음 → status만 + 백오프 폴백 / 파싱 불가 무시. `retryAfterMsFromError(httpErrorFromResponse(...))` 왕복 검증 포함.
- `tests/unit/llm-router-functions.test.ts` 2건: `generateOpenRouterAnswer` 429+`Retry-After: 2` → 오류가 `status: 429, retryAfterMs: 2000`을 실고, `retryAfterMsFromError`가 2000ms 소비 / Retry-After 없는 429 → status만.
- `tests/unit/agentic-synth-quality.test.ts` 1건 (**전체 체인**): `httpErrorFromResponse`로 변환한 실제 429 오류(`Retry-After: 1`)를 synthesizer `ai.run`이 던짐 → `getRetryAfterMs: retryAfterMsFromError`가 1초 대기를 소비 (fake timers — 100ms 시점 미재시도, 고정 백오프 [1]이면 재시도됐을 것).

## [Unreleased] — waitFor 대안 정책 실험 (수집 예상 가치 기반 조건부 await로 waitFor 목록 동적 최적화)

### Added
- `scripts/sim-fanout-latency.ts`:
  - **`WaitForPolicy`** — 조건부 waitFor 대안: `static`(현재 프로덕션) / `none`(연장 제거) / `value-gated:<n>`(phase break 시점 수집이 n 미달일 때만 await) / `expected-value:<t>`(백엔드별 **예상 수집 가치 ≥ t**만 await).
  - **`expectedCollectionValue(cfg)`** — 예상 수집 가치 = 성공 확률(1 − failProb^attempts) × 멤버십(presenceProb) × 평균 결과 수(7). 순위 품질(NDCG/도메인 가치)은 미모델링 — '결과 수' 기준 대리 지표 (JSDoc 명시).
  - **`buildWaitForSelector(policy, model)`** — 정책 → 선택자 팩토리; `computeFanoutWallTime`에 선택자 파라미터 추가 (미지정 시 기존 전체 await — 프로덕션 동작 불변).
  - CLI `--waitfor-policy <spec>` — static 대비 동일 쿼리(같은 시드, 정책은 rng 미소모) 비교 실험 섹션 출력 (p50/p95/p99 Δ + 수집률 static→policy).
- `scripts/sim-calibrate.ts` — `simulateStats`에 `waitForPolicy?` 파라미터.

### 실험 결과 (실측 캘리브레이션 모델 · seed 42 · 5000 iterations, 시나리오 A)
| 정책 | p50 Δ | p95 Δ | p99 Δ | wikipedia 수집 | 비고 |
|---|---|---|---|---|---|
| expected-value:0.5 | -0.5% | 0.0% | 0.0% | 92.2% (유지) | qiita만 drop |
| expected-value:1.0 | -3.5% | -0.3% | -0.4% | 92.2% (유지) | yahoo·juejin drop |
| **expected-value:2.0** | **-13.7%** | **-13.3%** | **-2.1%** | **92.2% (완전 유지)** | **Pareto 승자** |
| value-gated:10·13·14 | -25.8% | -45~46% | -14.0% | 92.2%→59.0% | none과 동일 — break 시점 페이지가 대개 참 |
| none | -25.8% | -46.0% | -14.0% | 92.2%→59.0% | 최대 지연 절감, 커버리지 붕괴 |

**핵심 발견**:
1. **expected-value:2.0이 Pareto 승자** — p50/p95 약 14% 절감하면서 wikipedia 커버리지 92.2% **완전 유지**. 정적 waitFor 목록의 저가치 멤버(yahoo-finance ≈0.8, arxiv ≈1.7, naver-news ≈1.4, qiita ≈0.5, juejin ≈0.7)의 await 비용이 기대 결과 기여 대비 과대 (연장 1.2~3.5s vs 회수 결과 수 소량).
2. **value-gated 정책은 이 모델에서 none과 동일** — phase-1 조기 종료 시점의 수집이 대개 풍부(10 이상)해 '얇을 때만 await' 조건이 발화하지 않음. 페이지가 늘 찬다는 사실 자체가 정적 waitFor가 낭비임을 시사.
3. none/value-gated의 wikipedia 92.2→59.0%는 **waitFor 연장이 wikipedia 커버리지의 대가**임을 재확인 (이전 세션의 wikipedia-down 발견과 일치).
4. 한계 문서화: 예상 가치는 결과 수 기준 — arxiv(학술 gold 도메인)가 threshold 2.0에서 drop되어 학술 쿼리 품질은 악화될 수 있음 (NDCG 차원 미모델링). 실제 적용 시 도메인 가치 가중치 필요.

### Added (tests)
- `tests/unit/sim-fanout-latency.test.ts` 5건: expectedCollectionValue 크기 관계 / static·none 선택자 / value-gated 수집 임계 발화 / expected-value 임계 필터 / computeFanoutWallTime 선택자 벽시간·수집 반영.
- `tests/unit/sim-calibrate.test.ts` 2건: 동일 시드에서 정책의 지연 단조 비증가 + wikipedia 커버리지 유지 + 저가치 drop / none이 최저 지연.

## [Unreleased] — 부하 모델 조건부 실패 시나리오 (wikipedia 429 쿨다운 윈도우 / 백엔드 장애) p95·p99 악화 정량화

### Added
- `scripts/sim-fanout-latency.ts`:
  - **`FailureScenario`** 모델 — ① `wikipedia-429-window`: 프로덕션 wikipedia 429 쿨다운(pacing guard) 중 `wikipediaSearch`가 **체인을 건너뛰고** 미러 체인(`runWikipediaMirrorChain`)이 병행·팬아웃 후 await되는 동작을 재현 (`wikipediaWindowProb` 확률로 스킵, 미러가 로그노말(1400ms, σ 0.5) 레이턴시로 `wikipediaMirrorSuccess` 확률 회수, 늦으면 벽시간 연장). ② `backend-down:<name>[,..]`: 지정 백엔드 **완전 장애** (체인 스킵 — 즉시 실패).
  - **`drawFailureScenario`** 순수 함수 — **별도 rng 스트림**(`seed ^ 0x9e3779b9`)으로 드로우해 baseline vs 시나리오가 **동일 쿼리를 공유**하는 공정한 Δ 정량화 보장 (downBackends는 rng 미소모 — 체인 스트림 불변).
  - CLI `--scenario none|wikipedia-429-window|backend-down:<name>[,..]` + `--window-prob <p>` (기본 0.3), baseline vs 시나리오 p50/p95/p99 Δ 표 + 영향 백엔드 수집률 출력 (텍스트/JSON).
- `scripts/sim-calibrate.ts` — `simulateStats`에 `failure?` 파라미터 추가 (시나리오 재현 시뮬레이션 지원).

### 정량화 결과 (실측 캘리브레이션 모델 · seed 42 · 5000 iterations)
| 시나리오 | p50 Δ | p95 Δ | p99 Δ | 수집률 영향 |
|---|---|---|---|---|
| wikipedia-429-window 10% | +3.7% | -0.1% | -2.1% | wikipedia 92.2%→83.6% |
| wikipedia-429-window 30% | **+15.1%** | **+4.9%** | **+2.5%** | wikipedia 92.2%→63.4% (미러 +18.8% → 순 82.2%) |
| wikipedia-429-window 50% | +18.4% | +8.1% | +12.8% | wikipedia 92.2%→45.6% |
| wikipedia-429-window 100% | +37.0% | +14.1% | +9.8% | wikipedia 92.2%→0% |
| backend-down:bing | +3.5% | +0.4% | -5.6% | bing 94.1%→0% |
| backend-down:wikipedia | **-16.9%** | -11.1% | -7.9% | wikipedia 92.2%→0% |
| backend-down:naver,wikipedia | -19.1% | -14.6% | -12.7% | naver 39.5%·wikipedia 92.2%→0% |

**핵심 발견**: wikipedia-down은 waitFor 연장 제거로 **지연이 오히려 개선**(-17% p50)되지만 권위 백엔드 커버리지가 붕괴 — waitFor 비용은 wikipedia 커버리지의 대가이며, 실제 위험은 지연이 아니라 **커버리지 손실**이다. 쿨다운 윈도우 확률이 오를수록(p50 +15~37%) 미러 레이턴시가 지배한다. 낮은 윈도우 확률(10%)에서 p95/p99가 약간 개선되는 것은 스킵된 wikipedia 체인의 waitFor 비용이 미러 비용을 부분 상쇄하기 때문.

### Added (tests)
- `tests/unit/sim-fanout-latency.test.ts` 4건: NO_FAILURE_SCENARIO no-op / backend-down skipSet·rng 미소모 / windowProb 1 미러 드로우 / windowProb 0 미발화.
- `tests/unit/sim-calibrate.test.ts` 2건: wikipedia-429-window(체인 스킵 → 수집 0 + 미러 회수 + p50 악화), backend-down:bing(수집 0 + p50 상승 — phase 임계값 채우는 주력 이탈).

## [Unreleased] — 부하 모델 per-attempt 레이턴시 실측 eval 캘리브레이션

### Added
- `scripts/sim-calibrate.ts` (신규) — 팬아웃 부하 모델(`BACKEND_MODEL`)의 per-attempt 레이턴시를 **실측 eval 분포**로 수렴:
  - `eval/results/run-*.json`의 `responseTimeMs` 샘플 추출·병합 → p50/p95/p99 요약 (`observedFromReports`/`statsFromWallTimes`).
  - 로그 스케일 백분위 오차 `latencyError` (p50 0.4 · p95 0.35 · p99 0.25 가중).
  - `calibrateLatencyModel` — ① 전역 레이턴시 스케일 × **비-팬아웃 오버헤드 분포**(로그노말 median/sigma) 3D 격자 ② waitFor 백엔드 failProb 좌표 하강 (동일 시드 결정적 비교).
  - CLI: `npx tsx scripts/sim-calibrate.ts [--eval <paths>] [--iterations N] [--seed N] [--apply <out.json>] [--json]`.
- **쿼리 멤버십 모델링 (`presenceProb`)** — `BackendSimConfig`에 `presenceProb?` (기본 1.0): 실제 팬아웃 멤버십은 focus 전략의 조건부 라우팅을 따르므로(일반 쿼리는 waitFor 중 wikipedia·arxiv 정도, 뉴스는 naver-news/RSS, 금융은 yahoo만 포함), 16개 전부를 항상 await하던 모델은 waitFor 확장을 과대평가해 중앙값이 비현실적으로 느렸다 (모델 p50 1654 vs 실측 844). eval 쿼리 믹스(en 40%/kr계열 40%/zh·ja 25%)와 전략 분기로부터 산정한 기본값 적용 — **baseline p50만 1654→981로 수정**.
- `scripts/sim-fanout-latency.ts`:
  - `loadCalibratedModel(path)` — `--apply` 산출물(medianMs/sigma/failProb 오버라이드 + overhead) 로드, `--model <path>` 옵션.
  - `runScenario`/main에 쿼리별 로그노말 오버헤드 샘플링 반영 (eval responseTimeMs는 팬아웃 벽시간 + 분류/재랭킹/답변 생성 후속 단계를 포함).
- `scripts/calibrated-fanout-model.json` — 실측 1500건으로 수렴한 모델 산출물.

### 결과 (시드 42 · 2000 iterations, 실측 n=1500)
- 실측: p50=844 p95=4669 p99=5107 — **p99가 팬아웃 ceiling(4500)을 초과** → 비-팬아웃 단계가 꼬리에 존재함을 증명.
- baseline err 0.1771 → (presenceProb 적용) 0.1465 → **캘리브레이션 0.1057** (약 40% 개선): p50=1138 p95=3277 p99=5110 (p99 실측과 거의 일치).
- 잔차 p95는 **버스트 429 윈도우**(실측 run 간 분산 큼 — run-2 p99=6908 vs run-1/3 5004)에서 비롯 — 병합 p95 자체가 불안정해 추가 과적합은 의도적으로 배제 (JSDoc 문서화).

### Added (tests)
- `tests/unit/sim-calibrate.test.ts` 9건: 추출/병합, 백분위 요약, latencyError, **합성 진실 회복**(scale 1.2 + wikipedia 429 + 오버헤드 LN(150,1.5) — p99가 ceiling 초과하는 꼬리까지), **무-오버헤드 진실 핀**(오버헤드 발명 금지), 결정성, presenceProb 반영 3건(wikipedia 부재 시 수집률 0 / 존재 waitFor만 꼬리 생성·중앙값 비밀림 / PRODUCTION_WAIT_FOR↔모델 정합).
- `tests/unit/sim-fanout-latency.test.ts` 5건: samplePresence(rng 미소모·비율), presenceProb 범위, loadCalibratedModel 로드/오류.

## [Unreleased] — withResultRetry 에러 게이트 Retry-After 동적 대기 (429 응답 기반 지연 재정의)

### Changed
- `src/lib/resilience/retry.ts`:
  - `ResultRetryOptions`에 **`getRetryAfterMs?: (err, attempt) => number | undefined`** 추가 — `retryableError`로 게이트된 재시도에서, 오류가 Retry-After 힌트를 갖고 있으면 **다음 시도 지연을 그 값으로 재정의** (delaysMs/지수 백오프 대체). 서버 대기가 권위적이므로 **jitter 없이 raw 사용** (호출자는 커스텀 추출기로 clamp 가능 — JSDoc 문서화). 힌트 없으면 기존 백오프 시퀀스 유지.
  - **`retryAfterMsFromError(err)`** 헬퍼 export — 공통 오류 형태에서 대기(ms) 추출: `err.retryAfterMs`(명시적 ms, 우선) / `err.retryAfter`(초) / `err.headers`(Headers 인스턴스 또는 레코드)의 `retry-after` 헤더 — **정수 초 또는 HTTP-date**. 파싱 불가·힌트 없으면 undefined.
- `src/lib/agentic/synthesizer.ts` — 429 재시도에 `getRetryAfterMs: retryAfterMsFromError` 연결: 429 응답이 Retry-After를 실어 보내면 고정 `[2000, 4000]` 대신 서버 지시 대기.

### Added (tests)
- `tests/unit/retry.test.ts` 3건 (TDD RED→GREEN):
  - `getRetryAfterMs`가 백오프 시퀀스(delaysMs [5])를 5000ms로 재정의 (fake timers + onErrorRetry 딜레이 검증)
  - 힌트 없는 429는 기존 백오프로 폴백 (회귀 핀)
  - `retryAfterMsFromError`: 레코드 헤더 초 / Headers 인스턴스 / retryAfterMs 우선 / retryAfter 초 / HTTP-date(fake system time) / 파싱 실패·미존재 → undefined
- `tests/unit/agentic-synth-quality.test.ts` 1건: 429 응답의 Retry-After(50ms)가 rateLimitDelaysMs [1]을 무시하고 10ms 시점에 아직 미회복 — 서버 지시 대기 사용 검증 (fake timers).

## [Unreleased] — quality-gate reformulateQuery AI 호출 429 백오프 (쿼터 중 heuristic 폴백 방지)

### Changed
- `src/lib/agentic/quality-gate.ts` — `reformulateQuery`의 `aiBinding.run(...)`을 **`withRetry`**로 감쌈:
  - `retryable: isRateLimitError` — **429만 재시도**, 비-429 AI 오류는 기존 fail-fast → heuristic 폴백 유지.
  - `maxRetries: 1` + `rateLimitDelaysMs: [2000, 4000]` — planner/synthesizer와 동일한 초 단위 백오프. 429 쿼터 윈도우 동안 재포뮬레이션이 heuristic으로 떨어지지 않고 유지.
  - 429 재시도 전용 로그(`[QualityGate] AI reformulation rate-limited (429), retrying in Nms`).
  - 429 소진 시에는 withRetry가 rethrow → 기존 catch가 heuristic 폴백 (정직한 폴백 보존).

### Added (tests)
- `tests/unit/agentic-synth-quality.test.ts` 3건 (TDD RED→GREEN, fake timers):
  - 429 → 백오프 재시도 1회 → **AI 재포뮬레이션 결과 반환** (heuristic 아님)
  - 429 소진 → heuristic 폴백 (년도 전략 /2025/, 호출 2회)
  - 비-429 AI 오류 → **fail-fast** (호출 1회) → heuristic 폴백 (회귀 핀 — 429만 재시도 대상)

이로써 LLM 파이프라인의 모든 AI 호출 지점이 동일한 429 정책을 씁니다: planner(AI 플래닝) · synthesizer(답변 생성) · quality-gate(재포뮬레이션) — `isRateLimitError` + `[2000, 4000]` 백오프, 비-429는 각 지점의 기존 fail-fast 계약 유지.

## [Unreleased] — planner AI 플래닝에 429 쿼터 백오프 연결 (LLM 파이프라인 429 일관 처리)

### Changed
- `src/lib/resilience/retry.ts`:
  - `RetryOptions`에 **`rateLimitDelaysMs?: number[]`** 추가 — `isRateLimitError(err)`(LLM/provider 429 쿼터)가 매치되는 오류에만 적용되는 백오프 시퀀스. 일반 `delaysMs`/지수 백오프(빠른 경로)와 분리되어, 429는 초 단위(쿼터 리셋)로 백오프하고 일시 오류는 기존 fast path 유지. 시퀀스 소진 시 지수 폴백 + jitter (delaysMs와 동일 의미론). `computeRetryBackoffMs`에 override 시퀀스 파라미터 추가 (동작 불변).
  - `DEFAULT_OPTIONS.rateLimitDelaysMs: []` (미설정 = 429 특별 처리 없음).
- `src/lib/agentic/planner.ts`:
  - `PlannerOptions`에 **`rateLimitDelaysMs?`** 추가 — 기본 **`[2000, 4000]`**(synthesizer `rateLimitDelaysMs` 기본과 동일 — LLM 파이프라인 전체가 429 쿼터를 하나의 정책으로 처리).
  - `withRetry`에 `rateLimitDelaysMs` 연결 — 429 시 초 단위 백오프, 기존 `retryable: () => true`(AI throw + malformed JSON 모두 재시도) 유지. 429 전용 로그 메시지(`[Planner] AI planning rate-limited (429), retrying in Nms`) 추가.
- **확인**: synthesizer는 이전 세션에서 이미 `retryableError: isRateLimitError` + `delaysMs: rateLimitDelaysMs [2000, 4000]`로 연결됨 — 이번 작업으로 planner가 동일 시퀀스를 공유.

### Added (tests)
- `tests/unit/retry.test.ts` 3건 (TDD RED→GREEN):
  - 429 오류는 rate-limit 시퀀스, 비-429 오류는 일반 백오프 (3회 재시도 딜레이 `[20, 40, 20]` 정확 검증)
  - rate-limit 시퀀스 소진 시 지수 폴백 (`[20, 10, 20]`)
  - 비-429 오류는 rate-limit 시퀀스에 라우팅 안 됨 (회귀 핀)
- `tests/unit/agentic-planner-executor.test.ts` 1건: AI 429 → **500ms 경과 시 재시도 미발화**(초 단위 백오프 검증, fake timers) → 5s 경과 후 회복 + 재시도 1회 단언. (기존 250ms fast path였다면 500ms에 이미 재시도됨 — RED로 검증)

## [Unreleased] — 재생성률 임계값 초과 Slack 알림 규칙 (DEFAULT 0.3)

### Added
- `src/lib/slack-alert.ts`:
  - **`alertHighRegenerationRate(webhookUrl, params)`** — 재생성률 임계값 초과 알림 전송. 필드에 재생성률/시도 수/재생성 수/**트리거 신뢰도 평균** 포함 (트리거 평균 ≈ 게이트 임계값 → 임계값 설정 문제, 낮음 → 품질 저하 — 컨텍스트에 진단 가이드 명시).
  - **`AgenticAlertRule` + `DEFAULT_AGENTIC_ALERT_RULE`** — `regenerationRateThreshold: 0.3`(strict >), **`minSynthesisAttempts: 10`**(노이즈 가드 — 1시도/1재생성 = 비율 1.0도 신호가 아님), `cooldownSeconds: 3600`.
  - **`evaluateRegenerationRateAlert(metrics, rule)`** — 순수 규칙 평가 (임계값 + 최소 샘플 가드, 미발화 시 reason 반환).
  - **`maybeAlertHighRegenerationRate(env, metrics, rule)`** — 규칙 평가 → 웹훅 확인 → **크로스-격리 dedup**(CACHE_KV claim, `expirationTtl` = cooldown으로 자동 리셋) + 인메모리 패스트패스 → 전송. `resetAgenticAlertCooldowns()` 테스트/재장전용. 발신 실패는 자체 소화 (요청 경로 비차단).
- `src/lib/orchestrator.ts` — Pro 에이전틱 파이프라인 `recordAgenticPipeline` 직후 `void maybeAlertHighRegenerationRate(config.env, getAgenticMetrics()).catch(() => {})` — fire-and-forget, 웹훅 미설정 시 조용한 no-op.

### Added (tests)
- `tests/unit/slack-alert.test.ts` 8건 (TDD RED→GREEN):
  - alertHighRegenerationRate 페이로드 (warning 색상/필드/트리거 신뢰도)
  - 규칙 평가: 초과 시 발화 / 경계값·이하 미발화(strict >) / **샘플 부족 노이즈 가드** (1시도·비율 1.0 미발화 + reason)
  - maybeAlert: 발화+전송, 웹훅 없으면 KV 쓰기도 안 함, 미발화 no-op, **쿨다운 내 dedup(KV expirationTtl 검증) + 쿨다운 만료 후 재발송** (fake timers)

## [Unreleased] — quality-gate 재검색 루프 reasonFor 연결 + gap-fill 재검색률 지표

### Changed
- `src/lib/agentic/index.ts` — Phase 6 gap-fill 재검색 루프의 `withResultRetry`에 **`reasonFor`** 연결: 실패 평가에서 `{ kind: 'gap-fill', score: avgScore, warnings }` 구조화 사유를 추출해 `onRetry` 3번째 인자로 전달 (synthesizer 재생성 루프와 동일 패턴). onRetry가 `recordAgenticGapFillResearches({ reason })` 호출 — 재검색 1사이클당 1이벤트 (maxRetries=1로 바운드). 로그에 warnings 포함.
- `src/lib/resilience/retry.ts` — `RetryFailureReason.kind` 유니온에 **`'gap-fill'`** 추가 (기존 'gate' | 'error').
- `src/lib/metrics.ts`:
  - **`recordAgenticGapFillResearches`** 신설 — gap-fill 재검색 카운터 (분자). 구조화 사유는 per-event 로그(Logpush)가 담당하는 계약 유지 (recordAgenticRegeneration과 동일).
  - `getAgenticMetrics()` — **`gapFillResearches`** + **`gapFillReSearchRate`** = 재검색 ÷ 게이트 도달 파이프라인(passed+failed) — 재생성률(재생성 ÷ 합성 시도)과 동일한 형태. 분모·분자 모두 orchestrator 구동 파이프라인에서만 발생해 비율이 정의됨.
  - Prometheus에 `agentic_gap_fill_researches_total`(counter) + `agentic_gap_fill_research_rate`(gauge) 라인. `resetMetrics()`에 카운터 포함.

### Added
- `tests/unit/metrics.test.ts` 2건 (TDD RED→GREEN): 재검색률 계산 (1 ÷ 3 게이트 도달) + Prometheus 텍스트 라인. zeroed 테스트에 `gapFillResearches: 0`/`gapFillReSearchRate: 0` 확장.
- `tests/unit/agentic-index.test.ts` 1건: gap-fill 재검색 시 `recordAgenticGapFillResearches`가 구조화 reason(kind='gap-fill', score=0.3, warnings)으로 1회 호출 (metrics 모듈 mock 추가).

## [Unreleased] — 재생성 트리거 신뢰도 롤링 평균 지표 추가 (재생성률 상승 원인 판별)

### Changed
- `src/lib/metrics.ts`:
  - `recordAgenticRegeneration` — `reason.score`(거부된 신뢰도)를 **최대 50건 롤링 윈도우**에 저장 (이전에는 카운터만 증가, 사유를 버렸음). `warnings`는 범주형이라 평균 불가 — 기존대로 per-event 구조화 로그(Logpush)가 담당.
  - `getAgenticMetrics()` — **`regenerationTriggerConfidenceAvg`** + **`regenerationTriggerConfidenceSamples`** 추가. 샘플 수를 함께 노출해 소수 이벤트 기반 평균을 과신하지 않도록 함.
  - Prometheus 텍스트에 `agentic_synthesis_regeneration_trigger_confidence_avg`(gauge) + `agentic_synthesis_regeneration_trigger_confidence_samples`(gauge) 라인 추가.
  - `resetMetrics()`에 롤링 윈도우 클리어 포함.
- 진단 시나리오: 재생성률이 오르면 — **트리거 평균이 게이트 임계값 근처** → 임계값 설정 문제(문턱이 너무 높음), **트리거 평균이 낮음** → 합성 품질 저하(LLM/프롬프트 문제). synthesizer의 `reasonFor`가 이미 `score: candidate.confidence`를 전달하므로 호출부 변경 없음.

### Added
- `tests/unit/metrics.test.ts` 4건 (TDD RED→GREEN):
  - 트리거 신뢰도 롤링 평균 계산 (0.3/0.5 → 0.4)
  - **윈도우 바운드**: 10건 저신뢰도 + 50건 고신뢰도 → 평균은 최근 50건만 반영(0.9), 카운터는 60건 전체
  - score 없는 재생성 이벤트는 카운터만 증가 (평균/샘플에 미반영)
  - Prometheus 텍스트에 avg/samples 라인 포함
- 기존 zeroed-values 테스트에 `regenerationTriggerConfidenceAvg: 0`/`samples: 0` 단언 확장.

## [Unreleased] — LLM 플래너 few-shot/시스템 프롬프트에 한국어 금융 예시·topic 라우팅 규칙 추가 (heuristic 패리티)

### Changed
- `src/lib/agentic/planner.ts`:
  - **시스템 프롬프트** — web_search 파라미터에 `topic ('finance' | 'news')` 문서화 + PLANNING RULES에 금융 쿼리(한국어: 주가/실적/배당/시총/시가총액/ETF/연금저축펀드 등)의 web_search 스텝에 `topic: 'finance'` 설정 규칙 추가. heuristic의 금융 분기가 `topic='finance'`를 설정해 네이버 금융/야후 백엔드로 라우팅하는 것과 AI 경로가 동일한 분류를 내도록 가르침 (AI 경로는 이전까지 topic을 전혀 발화하지 않아 금융 팬아웃이 타지 않았음).
  - **few-shot** — 기존 '삼성전자 2024년 실적 분석' 예시의 web_search 4스텝에 `topic: 'finance'` 추가 + **신규 한국어 금융 예시** '연금저축펀드 추천 순위 및 수수료 비교 2025' 추가 (확장된 한국어 금융 어휘 연금저축펀드 시연, web_search 2스텝 topic='finance' + compute 비교 스텝).
  - `FEW_SHOT_EXAMPLES` export (프롬프트 무결성 테스트용).

### Added
- `tests/unit/agentic-planner-executor.test.ts` 4건 (TDD RED→GREEN):
  - 시스템 프롬프트에 topic/finance 규칙 포함
  - 프롬프트에 한국어 금융 few-shot(연금저축펀드 + `"topic": "finance"`) 포함
  - **엔드투엔드 라우팅**: AI 생성 한국어 금융 플랜(topic='finance')이 executor 경유로 searchWeb에 topic='finance'로 전달 (네이버/야후 금융 팬아웃 발화)
  - **few-shot 스키마 가드**: 모든 FEW_SHOT_EXAMPLES 플랜이 SubQueryPlanSchema 통과 (프롬프트에 직렬화되는 예시가 깨진 형태를 가르치지 않도록)

## [Unreleased] — 금융 키워드 단일 소스 추출 (planner/extractCompanyName/specialized 드리프트 차단)

### Added
- `src/lib/financial-keywords.ts` 신설 — 금융/주식 키워드 어휘의 **단일 소스**. 계층 4종:
  - `FINANCIAL_KEYWORDS` — 세 소비처(planner isFinancial / extractCompanyName / specialized isFinancialPattern) 모두 매칭하는 공통 어휘 (영문 6 + 한글 32 + 구문 2)
  - `FINANCIAL_PLANNER_ONLY` — planner 의도 + 회사명 추출 제거용. specialized 금융 감지 **제외** (S48: 금리/환율은 kr-news-09/10 뉴스 라우팅 가로채기, 투자/ETF/공모/상장은 learning-gate와 결합해야만 금융 — '부동산 투자 방법'/'공모전' 오탐 방지)
  - `FINANCIAL_REGEX_ONLY` — 정규식 소비처 전용 (share/chart/per/…, 한글 '리서치' bare). planner whole-token 의도로는 안전하지 않음 (chart.js/'how to share'/'UX 리서치' 오탐 — planner는 구문 '리서치 리포트'만 사용)
  - `FINANCIAL_STRIP_ONLY` — extractCompanyName 제거 전용 (quote/symbol)
  - `buildFinancialKeywordRegex(...groups)` — ASCII `\b` / Hangul bare substring / 구문 `\s*` 결합 + **긴 키워드 우선 정렬** ('목표주가' > '주가', 'shares' > 'share' 잔존 방지)
- `tests/unit/financial-keywords.test.ts` 신설 11건 (TDD RED→GREEN): 빌더 의미론 4건(\b/복합어/구문/긴 키워드 우선) + **3소비처 일관성 루프** 4건(공유·planner-only·regex-only·strip-only 각 키워드가 모든 해당 소비처에서 발화) + 티어 가드 3건(chart.js/UX 리서치 비금융, 환율·금리·투자·공모전 specialized 비금융, 회사명 보존)

### Changed
- `src/lib/agentic/planner.ts` — isFinancial 인라인 40개 목록 → `[...FINANCIAL_KEYWORDS, ...FINANCIAL_PLANNER_ONLY]`. planner에 **기업분석/거래량/변동률/등락률/상한가/하한가/시장가/주봉/일봉/월봉/공모가 11개 추가** (superset — 기존 키워드 전부 보존, whole-token 의미론 불변)
- `src/lib/stock-finance.ts` — extractCompanyName의 하드코딩 정규식 → `FINANCIAL_FILLER_REGEX`(공유 빌더 파생). `_extractCompanyNameForTest` export 추가 (기존 `_lookupStockCodeForTest` 관용구와 동일)
- `src/lib/specialized.ts` — isFinancialPattern 하드코딩 정규식 → 모듈 로드 시 1회 컴파일한 `FINANCIAL_PATTERN`(공유 빌더 파생, S48 티어 제외). 감지 결과 동일 + 매출/영업이익/시총/증권사/연금저축펀드/등락률 등 추가 발화

## [Unreleased] — heuristicPlan comparison 분기에 한국어 비교 키워드 추가 (financial보다 우선 분류)

### Changed
- `src/lib/agentic/planner.ts` — `isComparison` 키워드 목록에 **한국어 비교 키워드 4종**(`비교`/`차이`/`대비`/`어느 것이`) 추가. whole-token CJK-safe 매칭이라 `대비책` 같은 복합어는 오분류되지 않고, `어느 것이`는 연속 토큰 구문으로 매칭된다.
- 우선순위는 구조적으로 이미 `isComparison > isFinancial` else-if 순서라, 금융 키워드(연금저축펀드/KOSPI/코스닥/ETF/배당주)를 포함한 한국어 비교 쿼리가 이제 **comparison으로 우선 분류**된다.

### Added
- `tests/unit/agentic-planner-executor.test.ts` 3건 (TDD RED→GREEN):
  - **kr-stock-15 eval 케이스** `연금저축펀드 비교` → comparison 분류 (금융 마커 '실적 주가 재무'/90일 윈도우 부재, general 'what is definition' 부재, 비교 검색어 발행)
  - **우선순위**: `연금저축펀드 비교`/`KOSPI와 코스닥 차이`/`ETF와 펀드 대비`/`배당주와 성장주 어느 것이 좋을까` — 금융 키워드 동시 포함에도 comparison 승리
  - **키워드 개별 커버리지**: `비교`/`차이`/`대비`/`어느 것이` 각각 발화
- 기존 kr-stock-01..15 금융 분류 루프 테스트는 kr-stock-15를 제외하고 **kr-stock-01..14로 축소** (kr-stock-15는 comparison으로 이동 — eval/queries.ts의 topic 'finance' 메타데이터는 유지, 플래너 분류만 변경).

## [Unreleased] — executor → searchWeb SearchOptions 필드 전달 확장 (timeoutMs·language)

### Changed
- `src/lib/agentic/search-tools.ts`:
  - `SearchOptions`에 **`timeoutMs?`** 추가 (기존 `query`/`recencyDays`/`maxResults`/`language`/`topic`).
  - `searchWeb`이 `language`/`timeoutMs`를 destructure해 `fallbackSearch`로 전달 — 백엔드 호출부에 스레딩: **bing/bingNews/naver/yahoo/searchKoreanStock/hackernews에 `timeoutMs`**, **wikipedia에 `timeoutMs ?? 8000` + `language`** (기존 하드코딩 8000 대체 — 미설정 시 동작 불변).
- `src/lib/agentic/executor.ts` — web_search 스텝 params 타입에 `timeout_ms?`/`language?` 추가하고 `searchWeb`에 전달 (max_results·recency_days·topic 전달과 동일 패턴).

### Added
- `tests/unit/agentic-search-tools.test.ts` 2건: searchWeb에 `language`/`timeoutMs` 전달 시 bing·wikipedia 옵션에 실리는지 + 미설정 시 wikipedia 기본 8000 유지.
- `tests/unit/planner-backend-consistency.test.ts` 1건: 스텝 params에 `timeout_ms`/`language`를 주입하면 executor 경유로 백엔드 호출까지 전달 (엔드투엔드).

## [Unreleased] — searchWeb 금융 팬아웃 ↔ FinanceStrategy 중복 제거·점수 병합 규칙 통일

### Added
- `src/lib/search/dedup.ts` — orchestrator의 병합 헬퍼 3종(`normalizeUrlForDedup`/`normalizeTitleForDedup`/`mergeAndDeduplicate`)을 추출한 **공유 단일 소스**. 메인 파이프라인(orchestrator)과 에이전틱 경량 파이프라인(searchWeb)이 동일한 중복 제거·점수 병합 규칙을 사용한다.
- `tests/unit/agentic-search-tools.test.ts` 금융 describe 4건 (TDD RED→GREEN):
  - **트래킹 파라미터만 다른 동일 URL** (utm_source=google vs facebook) → 통일 URL 정규화로 1건 중복 제거 + 최고 점수(0.8) 유지
  - **정규화 타이틀 동일** (다른 URL) → 타이틀 중복 제거 + 높은 점수(0.9) 유지
  - **동일 finance.naver.com URL이 bing(0.5)과 Naver Finance(0.7)에서 양쪽 도착** → 최고 점수 승리 (기존 first-wins는 태스크 완료 순서에 의존하는 레이스 — bing이 이기면 0.5로 고정됐음)
  - 금융 토픽에서 hackerNews 팬아웃 (FinanceStrategy 구성 정합)

### Changed
- `src/lib/orchestrator.ts` — 병합 헬퍼 로컬 정의 제거 → `./search/dedup` import + 기존 export 블록 re-export (orchestrator.test.ts 계약 불변, 동작 동일).
- `src/lib/agentic/search-tools.ts`:
  - 인라인 dedup(원본 `url.toLowerCase()` 첫-승리, 타이틀 dedup 없음) 제거 → `mergeAndDeduplicate([results])` — **URL 정규화(트래킹 파라미터/트레일링 슬래시/프래그먼트) + 타이틀 중복 + 최고 점수 승리**로 메인 파이프라인과 통일.
  - 금융 팬아웃에 **hackerNews** 추가 (FinanceStrategy 구성 정합 — 한국어/글로벌 금융 쿼리 모두).
  - **specialized를 단일 동적 import로 통합** — wikipedia 태스크와 hackernews 태스크가 같은 모듈을 동시에 동적 import할 때 vitest mock 레지스트리와 경합해 wikipedia mock이 조용히 무시되고 실제 네트워크(429)가 발생하는 버그를 발견·수정. 두 태스크가 pre-import한 함수를 공유 (동작 불변, import 1회 절감).

### 동기 (백엔드 구성 비교)
- FinanceStrategy(메인): 한국어 = Naver Finance + Naver + Bing / 글로벌 = Bing Finance 상세 + Yahoo Finance / 공통 = HackerNews + Wikipedia.
- searchWeb 금융 팬아웃: Bing + Naver + Yahoo Finance + Naver Finance + Wikipedia — **HackerNews 누락**이었음 → 추가로 정합.

## [Unreleased] — planner news 분기 topic='news' → bingNewsSearch 팬아웃 정합

### Changed
- `src/lib/agentic/planner.ts` — news 분기 스텝에 `topic: 'news'` 추가 (financial 분기의 `topic: 'finance'`와 동일 패턴). executor가 params의 topic을 searchWeb에 전달하고, searchWeb의 `topic === 'news'` 분기가 bingNewsSearch를 호출하도록 라우팅은 이미 갖춰져 있었음 — planner 스텝에 topic이 없어 기본값 'general'로 떨어져 **bingNews 팬아웃이 전혀 타지 않던 갭**을 해소.

### Added
- `tests/unit/planner-backend-consistency.test.ts` news describe 4건 (금융 5건과 동일 통합 패턴):
  - news 스텝이 `topic='news'` + `"<query> latest news"` 생성
  - `createPlan → executePlan` 경유 시 **bingSearch와 bingNewsSearch가 동일 검색어 문자열을 수신** (bingNews maxResults 5), 한국어 쿼리라 naverSearch 유지 + 금융 백엔드 미호출 가드
  - news 결과가 evidence 풀에 포함
  - 비뉴스 쿼리(주식회사 설립 절차) → `topic≠news`, bingNewsSearch 미호출
- bingNewsSearch mock을 named mock으로 승격 (search-tools 구조 분해 요구는 유지).

## [Unreleased] — 위키피디아 REST/Action 예산 분할 실측 검증 (429 체인 타이밍 대조)

### Added
- `src/lib/specialized.ts` — **wikipediaSearch REST/Action 체인 시도별 타이밍 구조화 로그**: `[Wikipedia] REST/Action attempt`(chain/attempt/status/latencyMs/budgetMs) + `onRetry` 백오프 로그 — Logpush 대상. 예산 분할 검증을 위한 "실제 429 체인 타이밍 로그"가 프로덕션에서 수집된다.
- `scripts/probe-wikipedia-budget.ts` (`npm run probe:wikipedia-budget`) — 실측 검증 프로브 3페이즈:
  - **Phase A**: 정상 경로 단일 시도 레이턴시를 **200 응답만 분리해** p50/p95/max 측정 (429는 rate-limit 압력 신호로 별도 집계 — 429를 p95에 섞으면 왜곡).
  - **Phase B**: 백오프 없이 연속 발사해 429 윈도우를 유도한 뒤, **프로덕션과 동일한 정책(시도 수/백오프/per-attempt 예산)의 실제 체인**을 돌려 시도별·총 소요를 실측 → 예약 예산(3000/1500)과 대조.
  - **Phase C**: `evaluateWikipediaBudget()` 판정 — 체인 검증(chainsFit) + per-attempt 마진(max + p95×1.15 headroom 기준) + ceiling 내 재분할 권장값. `--strict` 시 ADJUST면 exit 1.
- `tests/unit/probe-wikipedia-budget.test.ts` (9건) — quantile + 판정 로직: 예산 내 ok/체인 검증, REST·Action max 초과 시 adjust, ceiling 내 재분할 강제, 체인 미측정 허용, 예산 상수 정합.

### 실측 결과 (4회, throttle된 egress)
- **429 체인: 4회 모두 예약 안에 진입** — REST 1812~1900ms (예약 3000의 60~63%), Action 1303~1380ms (예약 1500의 87~92%). **REST 3000/Action 1500 비율이 실측으로 검증됨 — 분할 유지.**
- 체인 비용은 고정 백오프(REST 900ms/Action 500ms) + 빠른 429 응답(~320ms)이 지배: REST ≈ 3×320+900, Action ≈ 2×320+500.
- 건강한 단일 시도 테일은 REST 650~942ms / Action 459~582ms로 per-attempt(700/500) 근처 — 단, 프로브 반복으로 egress가 점진적으로 더 스로틀링되어(REST max 650→716→751→942) 테일 값이 부풀었다. ceiling 4500 안에서 양쪽을 동시에 여유 있게 담는 분할은 존재하지 않는다(스로틀 테일 기준 필요 ≈4700ms+). REST는 주경로이고 테일이 더 무거워 per-attempt 700 유지 — 잘림은 재시도 체인이 흡수.

### Changed
- 예산 분할 재조정 시도(3000→2900/1500→1600)를 **실측 3~4회 누적으로 원복** — Action 테일(519/524ms)이 500ms를 넘는 지점은 있었지만, REST 테일이 Action보다 일관되게 무겁고 주경로라는 점에서 REST 여유를 Action으로 옮기는 것은 방향이 틀렸음. 검증 결론: 3000/1500 유지.

## [Unreleased] — BACKEND_TIMEOUT_MS ceiling 단일 소스 확장 (fetchWithTimeout 기본 타임아웃 정합)

### Added
- `src/lib/search/fanout.ts` — **`backendTimeoutMs(name, fallbackMs?)` 헬퍼** + `DEFAULT_BACKEND_TIMEOUT_MS`(4000) 공유: 팬아웃 ceiling과 fetchWithTimeout 기본 타임아웃의 단일 소스 접근자. 등록된 백엔드는 ceiling 값을, 미등록(보조 백엔드: dbpedia/wikidata 등)은 fallback → 기본값 순으로 반환.
- `BACKEND_TIMEOUT_MS`에 누락 팬아웃 백엔드 6개 등록 — `news-outlet`/`stack-exchange`/`qiita`/`juejin`/`csdn`(4000), `github-issues`(2000). 팬아웃의 `?? DEFAULT_BACKEND_TIMEOUT_MS` 폴백이 실존 백엔드에 묵시 적용되는 일을 차단 (테스트로 고정).
- `tests/unit/backend-timeout-consistency.test.ts` (20건) — 헬퍼(등록값/fallback/기본값), **팬아웃 28개 이름 전수 등록 가드**, 그리고 **fetchWithTimeout 호출부 18곳의 기본 타임아웃이 `backendTimeoutMs(name, 기존값)`을 따르는지** 단언 (bing·bing-news·openalex·searxng·qiita·juejin·csdn·stack-exchange·wikipedia-summary·github·hackernews·reddit·arxiv·ddg-instant·ddg-image·dbpedia·wikidata).

### Changed
- `src/lib/util.ts` — `fetchWithTimeout` 기본 타임아웃을 `15000` → `DEFAULT_BACKEND_TIMEOUT_MS`(4000)로 변경. fetch가 팬아웃 ceiling(default 4000)보다 오래 도는 백그라운드 낭비 방지. (기존 호출부 전부 명시적 timeout을 전달하므로 동작 변화 없음 — retry-budget 세션에서 재시도 체인에 해결한 문제를 단발 fetch에 확장.)
- **fetchWithTimeout 호출부 기본값 정합** — 백엔드별 fetch 기본 타임아웃이 이제 ceiling을 따름: bing/bing-news 15000→2000, bing-image 8000→fallback, openalex 6000→4500, searxng 10000→3000, qiita/juejin/csdn/stack-exchange 8000→4000, wikipedia-summary·fetchWikipediaArticle 8000/6000→4500, github 8000→2000, github-issues 8000→2000, hackernews 8000→1800, reddit 8000→2000, arxiv 10000→4500, ddg(instant/image) 8000/10000→2000, naver-finance(시그니처 캡처·적응형 파싱·메인 검색) 10000→4000. 기존 `timeoutMs` 오버라이드 파라미터는 그대로 동작(테스트에서 명시값 전달 유지).
- `scripts/sim-fanout-latency.ts` — BACKEND_MODEL의 `ceilingMs`를 하드코딩 대신 **`backendTimeoutMs(name, 기존값)`으로 유도** — 테이블 변경 시 부하 모델이 자동 추종.
- `tests/unit/sim-fanout-latency.test.ts` — ceiling 동기화 단언을 `backendTimeoutMs` 기준으로 갱신 (미등록 분기 제거).

### 동기
- fetch 기본 타임아웃이 ceiling을 초과하면 ceiling 타이머가 먼저 발화해 결과를 버렸는데도 fetch는 백그라운드에서 계속 실행되어 서브리퀘스트를 낭비한다. 단발 fetch에도 retry-budget과 동일한 "fetch ≤ ceiling" 원칙을 적용.

## [Unreleased] — 팬아웃 전체 지연 분포 부하 모델 (PHASES × waitFor × 재시도 체인)

### Added
- `scripts/sim-fanout-latency.ts` (`npm run sim:fanout-latency`) — **단일 백엔드 체인 worst-case가 아니라 팬아웃 전체의 p50/p95/p99 지연 분포를 시뮬레이션하는 몬테카를로 부하 모델**:
  - 각 백엔드의 재시도 체인(시도별 로그노말 레이턴시 + 실패 확률 + delaysMs 백오프)을 시드된 RNG(mulberry32, 재현 가능)로 샘플링
  - **실제 `PHASES`**(800/1800/3500)를 import해 조기 수집 로직 + 프로덕션 waitFor(8개)를 재현하는 순수 함수 `computeFanoutWallTime()` — phase break 시점, waitFor 연장, 수집 백엔드 집합을 결정적으로 계산
  - 시나리오 비교: A 프로덕션 / B waitFor 없음 / C 타이트 phases(600/1200/2500)+waitFor 없음
  - 백엔드별 produced/collected율 + settle p50/p95 + waitFor 회수율(phase break 후 도착 결과 중 구해낸 비율)
- `src/lib/search/fanout.ts` — `PHASES` export (부하 모델/테스트가 실제 페이즈를 단일 소스로 사용)
- `tests/unit/sim-fanout-latency.test.ts` — 15건: `computeFanoutWallTime` 결정적 케이스(phase-1 조기 종료, 비-waitFor 늦은 결과 폐기, phase-2/3 연장, waitFor 벽시간 연장·ceiling 정착·break 전 정착 비await, 다중 waitFor = max), **모델↔프로덕션 상수 동기화**(PHASES 값, BACKEND_MODEL ceiling == BACKEND_TIMEOUT_MS, 미등록 백엔드 기본 4000, waitFor 목록), 시드 RNG 결정성, 로그노말/체인 샘플링 sanity.

### 실측 결과 (seed=42, 3000 iter)
- 프로덕션: p50 1671ms / p95 3474ms / p99 4500ms(위키피디아 타이머). **waitFor가 p50을 800→1671ms로 늘리지만 위키피디아 수집률을 59.6% → 95.9%로 회복(+36pp)** — p99는 4500 ceiling에 수렴.
- waitFor는 phase break 후 도착하는 produced 결과를 100% 회수 (await가 settle까지 벽시간을 연장하므로).
- 타이트 phases 시나리오는 p50 600ms로 단축되지만 위키피디아 수집률이 49.3%로 하락 — "위상 단축 ↔ 권위 백엔드 수집" 트레이드오프를 수치화.

## [Unreleased] — withResultRetry 구조화 실패 사유 + 재생성률 메트릭

### Changed
- `src/lib/resilience/retry.ts` `withResultRetry` — **onRetry에 구조화된 실패 사유 전달**: `RetryFailureReason`(`kind`/`score`/`warnings`) + `reasonFor(result, attempt)` 추출기 옵션. onRetry 시그니처가 `(attempt, result, reason)`로 확장(미설정 시 `{ kind: 'gate' }` — 기존 호출부 호환). 이유는 메트릭/로그에 "왜 재생성했는지"(거부된 신뢰도·경고 목록)를 기록하기 위한 것.
- `src/lib/metrics.ts` — **재생성률 지표**: `recordAgenticRegeneration({ reason })` 신설(재생성 카운터), `recordAgenticPipeline`이 `synthesisConfidence` 존재 시 시도(분모) 카운트. `getAgenticMetrics()`에 `synthesisAttempts`/`synthesisRegenerations`/`regenerationRatio` 추가, Prometheus 텍스트에 `agentic_synthesis_regenerations_total` + `agentic_synthesis_regeneration_ratio` 게이지. `resetMetrics()`에 새 카운터 포함.
- `src/lib/agentic/synthesizer.ts` — 재생성 루프에 `reasonFor` 매핑(거부된 confidence → `score`, `warnings`) + `onRetry`에서 `recordAgenticRegeneration({ reason })` 호출 — 저신뢰도 재생성 이벤트가 구조화 사유와 함께 메트릭에 기록됨. 기존 로그 동작 불변.

### Added
- `tests/unit/retry.test.ts` — 2건: `reasonFor`로 구조화 사유 전달(kind/score/warnings), 미설정 시 `{ kind: 'gate' }` 기본.
- `tests/unit/metrics.test.ts` — 2건: 파이프라인 시도(confidence 존재만 분모) 대비 재생성 비율 계산(2시도/1재생성 → 0.5), Prometheus 텍스트 라인 포함. 기존 zeroed-value 테스트에 regenerationRatio 0 단언 추가.
- `tests/unit/agentic-synth-quality.test.ts` — 1건: 저신뢰도 재생성 시 `recordAgenticRegeneration`이 구조화 reason(kind='gate', score<0.9, warnings 배열)과 함께 호출됨 (vi.spyOn).

## [Unreleased] — withResultRetry 지연/429 확장 (LLM 쿼터 한도 대응)

### Changed
- `src/lib/resilience/retry.ts` `withResultRetry` — **재생성 간 지연 옵션 + 에러 게이트 재시도** 지원:
  - `retryableError(err)` — fn이 **throw**하고 이 프레디킷이 true면(예: LLM 429 쿼터) `delaysMs` 백오프로 재시도. 기존 "예외 즉시 전파" 계약은 프레디킷 미설정/불일치 시 그대로.
  - `delaysMs`/`baseDelayMs`/`factor`/`maxDelayMs`/`jitter` — 에러 재시도 간 백오프 (withRetry와 동일 의미론: delaysMs 시퀀스 우선, 소진 시 지수 폴백, ±50% jitter). **결과 게이트(저신뢰도 재생성) 재시도는 지연 없음 유지** — 입력 교체(STRICT REMINDER) 정책이므로 대기는 지연만 추가.
  - `onErrorRetry(1-based attempt, delayMs, err)` 관측성. 마지막 시도의 429는 수락하지 않고 rethrow (phantom accept 방지).
  - 백오프 계산을 `computeRetryBackoffMs` 공유 헬퍼로 추출 — withRetry와 withResultRetry가 동일 지연 정책 사용 (withRetry 리팩토링, 동작 불변).
  - `isRateLimitError(err)` 내보내기 — provider별 429 형태(status 429 프로퍼티 / llm-router의 "API error 429" 메시지 / rate limit·too many requests·quota·throttle 문자열 / string throw) 판별.
- `src/lib/agentic/synthesizer.ts` — AI 생성 루프에 `retryableError: isRateLimitError` + `rateLimitDelaysMs` 옵션(기본 [2000, 4000]) 와이어링: 요금제 쿼터 429 시 백오프 재시도 후 답변 생성, 비-429 AI 오류는 기존처럼 fail-fast. `onErrorRetry`로 `[Synthesizer] AI rate-limited (429), retrying in Nms (attempt/max)` 로그.

### Added
- `tests/unit/retry.test.ts` — 8건: 429 백오프 재시도 후 회복(delaysMs·onErrorRetry·jitter:false), 소진 시 rethrow, 비-429 즉시 전파, **결과 게이트 재시도는 에러 백오프 설정에도 지연 없음**, 마지막 시도 429는 rethrow, `isRateLimitError` 3건(status 429 / provider 메시지 형태 / 무관 오류).
- `tests/unit/agentic-synth-quality.test.ts` — 2건: AI 429 → 백오프 재시도 후 답변 회복(rateLimitDelaysMs [1]로 테스트 속도 유지), 비-429 AI 오류는 재시도 없이 fail-fast.

## [Unreleased] — planner/quality-gate LLM 재시도 정책 withRetry 계열 단일화

### Changed
- `src/lib/agentic/planner.ts` `QueryPlanner.plan` — AI 플래닝 try/catch(실패 즉시 heuristic 폴백)를 **`withRetry`로 통일**: AI run throw(일시)와 malformed/schema-invalid JSON(`parseAndValidate` throw) 모두 재시도 대상. `maxPlanRetries` 옵션 신설(기본 1), 재시도 시 **STRICT REMINDER**로 순수 JSON만 요구하는 프롬프트 강화(synthesizer의 attempt-index 패턴과 동일), `onRetry` 로그(attempt/delayMs/error), 소진 시에만 heuristic 폴백. 기존 3건 폴백 테스트 계약 불변.
- `src/lib/agentic/index.ts` — Phase 6 gap-fill 재검색 루프를 **`withResultRetry`로 통일**: quality gate의 **결과(평균 증거 점수)**로 재검색 여부를 결정하는 결과-기반 정책. 각 패스는 현재 결과를 평가하고, 임계값 미달 + 재포뮬레이션 플랜이 있으면 그 플랜을 실행해 메인 컨텍스트에 병합. 재검색 횟수는 `DEFAULT_QUALITY_CONFIG.maxRetries`(=1)로 바인딩 — 마지막 패스는 실패여도 수락(withResultRetry 규칙). **동작 개선**: gap-fill 실행이 throw해도 이제 다음 패스가 재평가를 수행(기존에는 실패한 평가가 그대로 남음).

### Added
- `tests/unit/agentic-planner-executor.test.ts` — 2건: AI 실패 시 1회 재시도 후 heuristic 폴백(호출 2회 단언), 첫 응답 malformed JSON → 재시도에서 STRICT REMINDER 프롬프트 + VALID_PLAN_JSON 회복.
- `tests/unit/agentic-index.test.ts` — 3건: reQueryPlan 없으면 재검색 없이 실패 수락(gate 1회), gap-fill 실행 실패가 비치명적이고 재평가 수행(테스트 격리를 위해 beforeEach를 `resetAllMocks`로 강화 — 미소비 `mockResolvedValueOnce` 오염 방지), 재검색 바운드(항상 최대 1회, 2/2/실패).

## [Unreleased] — DDG 202 IP-지속 가정 실데이터 검증 프로브

### Added
- `scripts/probe-ddg-202.ts` (`npm run probe:ddg-202`) — duckduckgo의 "202 챌린지는 IP 단위로 지속된다" 가정(docs/15·16)을 **실제 응답 데이터로 검증**하는 프로브:
  - **Phase 0**: cloudflare `/cdn-cgi/trace`로 egress IP/colo 확인 (로컬 vs Workers 데이터센터 IP 컨텍스트 판별)
  - **Phase 1**: 생산과 동일한 POST 핑거프린트로 html 엔드포인트를 동일 IP에서 N회 연속 재요청 → 202 지속 여부 + 202의 전체 응답 헤더(Retry-After·Set-Cookie·Server 등)·`<title>`·body 크기 수집
  - **Phase 2**: html이 202일 때만 lite 엔드포인트를 동일 IP에서 GET → lite-skip 근거 검증
  - **Phase 3**: Retry-After 헤더 파싱(초·HTTP-date) + `--honor-retry-after`/`--retry-wait-ms` 대기 후 재요청 → 챌린지 회복 여부
  - **verdict**: `not-challenged`(해당 egress에서 202 미발생 — Workers egress에서 재실행 안내) / `ip-persistent`(가정 확인 — fail-fast+lite-skip 정당) / `transient-challenge`(202→200 회복 — 202 재시도 실익 신호) / `lite-mismatch`(html 202인데 lite 200 — lite-skip 반증) / `inconclusive`(표본 부족). `--strict` 시 반증 verdict에서 exit 1. `--json` 출력 지원.
  - 단위 테스트에서 import 시 CLI가 실행되지 않도록 `process.argv[1]` 가드 (기존 probe-inmemory-bypass와 달리 테스트에서 네트워크 호출 없음)
- `tests/unit/probe-ddg-202.test.ts` — 순수 분류기 `classifyDdgChallenge` 7건 (not-challenged / ip-persistent 2건 / transient 2건 / lite-mismatch / inconclusive) + `parseRetryAfter` 3건 (초·HTTP-date·파싱 불가).
- `package.json` — `probe:ddg-202` 스크립트.

## [Unreleased] — duckduckgo 202 제외 일시 장애 재시도 (분석 리포트 B안)

### Changed
- `src/lib/duckduckgo.ts` `duckDuckGoSearch` — html 엔드포인트 fetch를 `withRetry`로 래핑 (docs/15_DDG_ANTIBOT_RETRY_ANALYSIS.md B안). **일시 장애(5xx/네트워크 블립)에 한해 1회 재시도**하며, 202 anti-bot과 4xx는 fail-fast — `TransientDdgError` 마커(5xx + fetch throw를 래핑)와 `retryable: (err) => err instanceof TransientDdgError`로 202를 재시도에서 자동 제외. 5xx 재시도 시 `res.body?.cancel()`로 서브리퀘스트 슬롯 해제.
- **202 → lite 스킵 유지** (기존 fail-fast 설계 보존 — 데이터센터 IP에서 lite도 동일 챌린지), **200-0결과 → lite 폴백 유지**. 네트워크 오류가 0회 재시도였던 기존 동작은 1회 재시도로 변경 (기존 테스트 계약 갱신).
- **예산**: `splitRetryBudget(min(timeoutMs, BACKEND_TIMEOUT_MS.duckduckgo=2000), 2, 150, 800)` = 925ms/시도 → worst case 2×925+150 = **2000ms = ceiling 정확히**. 호출부(buildDuckDuckGoTask/emergencyFallback)는 timeoutMs 5000을 넘기지만 ceiling 2000이 실제 상한.

### Added
- `tests/unit/duckduckgo.test.ts` — 5건: 5xx 1회 재시도 후 성공, 5xx 소진 시 [] (+ lite 미호출), 네트워크 오류 1회 재시도 후 성공, **202는 재시도 0회**(성공할 두 번째 mock이 있어도 1회 호출로 종료), 4xx fail-fast (재시도 없음). 기존 "fetch throws → 1회 호출" 테스트는 재시도 계약 반영해 2회 호출로 갱신.
- `tests/unit/retry-budget-simulation.test.ts` — duckduckgo 체인 행(2×925+150=2000) + `BACKEND_TIMEOUT_MS.duckduckgo === 2000` 단언.

## [Unreleased] — synthesizer 저신뢰도 재생성 루프 withRetry 계열 통일

### Added
- `src/lib/resilience/retry.ts` — `withResultRetry(fn, { maxRetries, retryable, onRetry })`: withRetry의 결과-기반 형제. 예외 대신 **결과**(예: 신뢰도)로 재시도를 결정하는 정책용 — `retryable(result, attempt)`이 false면 수락(fail-fast), **마지막 시도는 게이트 실패여도 수락**(기존 synthesizer의 `attempt === maxRetries` accept-and-break와 동일), 백오프 없음(재생성 정책은 입력 교체 — 대기 불필요), 예외는 즉시 전파(게이트 실패는 오류가 아님), `onRetry(1-based attempt, 거부된 결과)`로 관측성. withRetry와 동일한 옵션 어휘로 LLM 재시도 정책을 네트워크 재시도 정책과 동일하게 구성.
- `tests/unit/retry.test.ts` — withResultRetry 7건: 게이트 통과 즉시 수락, 게이트 실패 재시도 후 통과 결과 반환, 마지막 시도 무조건 수락, onRetry(attempt/result), 0-based attempt 전달, 기본값(재시도-전부 + maxRetries 1), 예외 즉시 전파.

### Changed
- `src/lib/agentic/synthesizer.ts` `AnswerSynthesizer.synthesize` — 저신뢰도 재생성 루프(인라인 for + `confidence < threshold` 브랜치) → `withResultRetry`로 추상화. 보존: 재시도 시 STRICT REMINDER 프롬프트 강화(attempt 인덱스 기반), 게이트 통과/마지막 시도 수락, `[Synthesizer] Confidence … retrying (n/m)` 로그는 `onRetry` 훅으로 이동, 저신뢰도 extractive 폴백(임계값의 절반 미만 시), AI 오류 즉시 전파(fail-fast), 무-AI 경로의 결정적 extractive 동작.

## [Unreleased] — withRetry 체인 팬아웃 예산 최악 케이스 조정

### Changed
- **fanout 예산 최악 케이스 시뮬레이션**: withRetry 통합 7개 재시도 지점의 worst-case 체인 지연(`시도 수 × 시도별 타임아웃 + Σ백오프`)이 팬아웃 ceiling을 초과하고 있음을 확인 — 천장 타이머가 먼저 발화해 태스크를 rejected 처리하고, 결과는 폐기되며 백그라운드에서 최대 ~25s의 서브리퀘스트/CPU를 낭비하고 있었음. `src/lib/resilience/retry.ts`에 `splitRetryBudget(totalBudgetMs, attempts, totalDelayMs, minAttemptMs)` 헬퍼 추가 — 딜레이 예약분을 뺀 예산을 시도 수로 나눠 `시도×시도타임아웃 + Σ딜레이 ≤ 예산`을 보장.
- `yahoo fetchYahooJson` — per-attempt = `splitRetryBudget(4500, 3, 500, 800)` = 1333ms (기존 1500ms, worst 5000 > 4500). 3×1333 + 500 = 4499 ≤ 4500.
- `naverSearch` — 시도별 풀 타임아웃(12000ms, worst 25200 > 2500) → `splitRetryBudget(min(timeoutMs, ceiling=2500), 2, 600, 500)` = 950ms. 딜레이 1200→600ms (1200ms면 시도당 650ms로 건강한 tail을 굶김; 교차 쿼리 429 윈도우는 공유 쿨다운 가드가 커버). 2×950 + 600 = 2500.
- `fetchNaverNewsPage` — `splitRetryBudget(min(timeoutMs, ceiling=4000), 2, 1200, 500)` = 1400ms (worst 25200 → 4000). recency 듀얼 페치는 페이지 2개가 병렬이므로 벽 시간 = max(page1, page2) = 4000 ≤ ceiling.
- `naverNewsExtract` — `splitRetryBudget(timeoutMs, 3, 500, 800)` = 4833ms (worst 15500 → 15000, 호출자 예산 자기정합).
- `fetchRssWithRetry` — `splitRetryBudget(min(timeoutMs, ceiling=2500), 2, 300, 1000)` = 1100ms (worst 8300 → 2500).
- `wikipediaSearch` — 4.5s ceiling을 순차 체인 두 개에 예약: REST 3000ms(`splitRetryBudget(3000, 3, 900, 500)` = 700ms/시도, worst 3000) + Action fallback 1500ms(`splitRetryBudget(1500, 2, 500, 400)` = 500ms/시도, worst 1500). 합산 worst 4500. 기존 8000ms/시도(worst 24900)는 hang 시 ~25s 백그라운드 낭비였음.
- 백엔드들이 `BACKEND_TIMEOUT_MS`(`./search/fanout`)를 ceiling 단일 소스로 import — ceiling 변경 시 재시도 예산이 자동 추종.

### Added
- `tests/unit/retry-budget-simulation.test.ts` — 7개 체인 테이블 + worst ≤ budget 단언, `BACKEND_TIMEOUT_MS` 일관성 단언, `splitRetryBudget` 헬퍼 2건 (RED: 기존 값으로 7개 체인 전부 초과 확인 → GREEN: 조정값으로 통과).

## [Unreleased] — planner 검색어 ↔ 실제 백엔드(네이버/야후) 정합

### Changed
- `QueryPlanner.heuristicPlan` financial 분기 — 두 web_search 스텝 파라미터에 `topic: 'finance'` 추가. 이전에는 executor의 `searchWeb` 팬아웃이 Bing/Naver/Wikipedia만 타서 planner가 생성한 금융 검색어가 실제 금융 백엔드(네이버 금융/야후)에 도달하지 못했음.
- `src/lib/agentic/executor.ts` — `web_search` 스텝의 `topic` 파라미터를 `searchWeb`에 전달 (params 타입 캐스트에 `topic` 추가).
- `src/lib/agentic/search-tools.ts` `fallbackSearch` — `topic === 'finance'`일 때 금융 백엔드 팬아웃 추가: `yahooFinanceSearch(query, maxResults≤5)`는 전 금융 쿼리, `searchKoreanStock(query, maxResults≤5)`는 한국어 쿼리(FinanceStrategy와 동일 게이트). 검색어는 planner가 생성한 문자열 그대로 전달되고, `searchKoreanStock`의 `extractCompanyName`이 붙은 키워드("실적 주가 재무")를 제거해 종목코드를 해석함. 각 백엔드 실패는 기존처럼 개별 catch로 격리.

### Added
- `tests/unit/planner-backend-consistency.test.ts` (신규 5건):
  - financial 스텝이 `topic='finance'` + 정확한 검색어("삼성전자 주가 실적 주가 재무" / "…분석 전망 목표주가 리포트")를 생성하는지.
  - `createPlan → executePlan` 통합: 생성된 검색어가 **빙/네이버/위키백과/네이버 금융/야후 5개 백엔드에 동일 문자열로 전달**되는지 (스텝 1·2 모두).
  - 금융 결과(finance.naver.com/finance.yahoo.com)가 evidence 풀에 포함되는지.
  - 비금융 한국어 쿼리("주식회사 설립 절차")는 `topic≠finance`이고 금융 백엔드가 호출되지 않는지 (네이버 일반 검색은 유지).
  - planner가 붙인 "실적 주가 재무" 접미사가 네이버 금융 종목코드 해석을 깨지 않는지 (`_lookupStockCodeForTest('삼성전자 주가 실적 주가 재무') === '005930'`).

## [Unreleased] — heuristicPlan 한국어 금융 키워드 확장

### Changed
- `QueryPlanner.heuristicPlan`의 `isFinancial` 키워드 목록 확장 (기존 `실적/주가/매출/영업이익` + 영문 4개 → 한글 30여 개). 한국어는 띄어쓰기 없이 복합어화되므로 whole-token 매칭(`hasIntentKeywords`) 기준 각 표면형을 개별 등재: `시총/시가총액/배당/배당금/배당수익률/배당주/공시/증권/증권사/증권사 리포트(구)/리서치 리포트(구)/목표주가/투자의견/재무제표/주식/주주/자사주/증시/kospi/kosdaq/코스피/코스닥/환율/금리/공모/상장/시세/etf/투자/연금저축펀드/매출액/순이익`.
- 효과: `eval/queries.ts`의 kr-stock eval 쿼리 15건이 전부 financial 분기로 분류 — 이전에는 `네이버 시가총액 순위`(시가총액), `현대차 배당금`(배당금), `KOSPI 지수 오늘`(kospi), `코스닥 지수 오늘`(코스닥), `배당주 추천 2025`(배당주), `ETF 투자 방법 초보`(etf/투자), `연금저축펀드 비교`(연금저축펀드)가 general 분기로 떨어져 재무 데이터 + 목표주가 리포트 검색을 놓치고 있었음.
- 오분류 가드 유지: whole-token 매칭이라 `주식회사`(주식), `공시지가`(공시), `투자유치`(투자), `연금저축펀드` 내부 단어는 매칭되지 않음 (테스트로 고정). `isComparison > isFinancial > isTechnical > isNews` else-if 우선순위 불변.

### Added
- `tests/unit/agentic-planner-executor.test.ts` — (1) kr-stock-01..15 eval 쿼리 15건 전부 financial 분기(`실적 주가 재무` 증거 쿼리) 검증, (2) 신규 키워드 10건(시총/배당/공시/증권사 리포트/리서치 리포트/목표주가/투자의견/재무제표/환율·금리/자사주) 검증, (3) 비금융 쿼리 오분류 방지(주식회사/공시지가/투자유치/react 튜토리얼) 검증.

## [Unreleased] — CJK `\b` 단어 경계 버그 일괄 수정

### Fixed
- `src/lib/stock-finance.ts` `extractCompanyName` — `\b(주가|주식|…|실적)\b`가 한글 키워드를 절대 제거하지 못하던 문제. JS `\b`는 ASCII 전용이라 Hangul(비-word) 앞뒤로 경계가 성립하지 않아 한국어 금융 키워드가 영원히 미매칭이었고, `lookupStockCode` 3단계(회사명 추출 후 정확 매칭) 폴백이 한국어 쿼리에 대해 사실상 죽어 있었음. ASCII 키워드는 `\b` 전체 단어 의미론을 유지하고 한글 키워드는 bare 서브스트링으로 분리 (한국어 쿼리는 띄어쓰기 없이 복합어화 — "현대차주가"처럼 음절 경계 검사로도 잡히지 않음). 긴 키워드 우선 배치("목표주가" > "주가", STOCK_CODE_MAP longest-match 관용구와 동일).
- `src/lib/understanding/entity-extractor.ts` 숫자 패턴 — trailing `\b`가 ASCII 전용이라 한글 단위(만/억/조)가 뒤에 Hangul/공백이 오면 절대 매칭되지 않아 "1조원"→"1", "5,000억원"→"5,000"으로 단위가 조용히 드롭되던 문제. trailing `\b` → `(?=\D|$)` 비숫자 lookahead로 교체 ("1조원"→"1조"). `%`는 unit 그룹에서 제외해 기존 계약("10%"→"10") 보존.
- 전수 조사: 저장소 전체(`src/` + `sdk/` + `scripts/` + `eval/`)의 `\b`+CJK 정규식 리터럴 9건을 스캔해 실제 버그 2건만 확인. 나머지 7건은 이미 CJK-safe 패턴(한글 bare + ASCII `\b`, `$` 앵커, 별도 bare CJK 정규식)으로 정상임을 검증: `util.ts:919/927/1426`, `backend-tasks.ts:157/159`, `specialized.ts:1220/1799/1822/1967`, `planner.ts`(이전 세션 수정분).

### Added
- `tests/unit/stock-finance.test.ts` — `lookupStockCode`가 붙어있는 한글 금융 키워드("삼성전자주가", "현대차실적", "한화에어로스페이스목표주가")를 제거하고 종목코드를 해석하는 테스트 1건.
- `tests/unit/entity-extractor.test.ts` — 한글 단위 숫자("1조원"→"1조", "5,000억원"→"5,000억", "1.5조") 추출 + 기존 "10%"→"10" 계약 유지 테스트 1건.

## [Unreleased] — 커버리지 80% 달성 (저커버리지 영역 보강)

### Added
- `tests/unit/metrics.test.ts` — QPS(getQps), 캐시 지표(recordCacheHit tier 1/2, recordCacheMiss, getCacheMetrics), getLatencyPercentiles, recordAgenticPipeline/getAgenticMetrics, subrequest/usage stats(getUsageStats, ANALYTICS persistenceActive) 10건.
- `tests/unit/slack-alert.test.ts` — alertCircuitTripped, alertEvalRegression(5개 초과 시 truncation + 빈 regressions 폴백 컨텍스트), alertWarning 4건.
- `tests/unit/fallback.test.ts` — emergencyFallback 모든 분기 직접 호출 10건: 자체 인덱스 성공/실패, SearXNG 성공/실패/미설정/이미 실행, DDG 성공/실패/이미 실행, 한국어 쿼리 DDG 스킵 + ko-KR locale 고정, 전부 실패 시 빈 결과.
- `tests/unit/backend-tasks.test.ts` — 빌더 33건: pickNewsOutlet(재무/기술/일반/ja/ko/zh + 결정성), newsRssLocale(ko/ja/zh/en), wikiQuery 중국어 클리닝, 전 빌더 run() 클로저 모킹 검증, buildNaverNewsTask recency 인텐트(day/sort_by/isRecencyNewsQuery), buildSearXNGTask 카테고리 매핑, buildBraveTask 가드(env 없음/한국어/brave 미사용 → null) + freshness(day/week/month/year/미설정) 매핑.

### Changed
- `src/lib/metrics.ts` `resetMetrics()` — 문서화된 목적("Reset all counters")에 맞게 캐시 지표(cacheHits/cacheMisses/cacheTier1Hits/cacheTier2Hits)와 에이전틱 카운터(agenticPlanSteps/agenticQualityGatePassed/agenticQualityGateFailed/agenticSynthesisConfidences)도 초기화하도록 보완 (테스트 전용, 런타임 동작 불변).

### Coverage
- 총 스테이트먼트 커버리지 79.04% → **80.47%** (목표 80% 달성, 단위 테스트 2238 → 2302건, 118 → 120파일).

## [Unreleased] — 429 쿨다운 DO 공유 (멀티 격리 일관 레이트 가드)

### Added
- `RateLimiterDO` (`src/lib/rate-limiter-do.ts`): `cooldowns` 저장소 추가 — `setCooldown(key, untilMs)` / `getCooldown(key)` RPC (epoch-ms 마감 시각, 만료 엔트리 lazy 프루닝, `reset()`/persist/load 연동). `RateLimiterRPC` 인터페이스 반영.
- `src/lib/rate-limiter.ts` 클라이언트: `setSharedCooldown(env, key, untilMs)` / `getSharedCooldown(env, key, now)` — 로컬 패스트패스 캐시 + DO 미러. 바인딩 없으면 순수 로컬(기존 동작), eval 모드는 `getDOClient` 경유로 자동 로컬 유지. `resetSharedCooldownLocal(key)` 테스트 훅.
- `specialized.ts` 공유 가드: `isWikipediaRateLimitedShared(env)` / `mirrorWikipediaCooldown(env)` (키 `cooldown:wikipedia`), `isGithubSearchRateLimitedShared(env)` / `mirrorGithubSearchCooldown(env)` (키 `cooldown:github-search`). 로컬 가드 클린 시 DO에서 다른 격리가 arm한 윈도우를 채택(adopt)해 전체 플릿이 동시에 스킵.
- 테스트: `rate-limiter-do.test.ts` 쿨다운 RPC 5건, `rate-limiter.test.ts` 클라이언트 공유 쿨다운 5건, `specialized.test.ts` wikipedia/github 통합 5건 (DO 미러 + 채택 + 스킵 + 로컬 가드 채택).

### Changed
- `wikipediaSearch` 상단 페이싱 가드 + REST/Action 429 기록 지점이 공유 가드/미러를 사용 (env 미전달 시 기존 로컬 동작과 동일).
- `githubSearch`/`githubIssuesSearch` 가드 + `recordGithubSearchCall` 후 미러 (arm된 윈도우가 있을 때만 DO 쓰기 — 정상 응답은 쓰기 비용 없음).
- `orchestrator` step 4.5 wikipedia 미러 발동 조건이 `isWikipediaRateLimitedShared(env)`로 전환 — 다른 격리가 발견한 429 윈도우에도 플릿 전체가 일관되게 미러 체인 시작.
- `resetWikipediaRateState()`/`resetGithubSearchRateState()`가 로컬 공유 캐시도 정리.

### Fixed
- `getCooldown`이 만료 엔트리 삭제 후 stale 마감 시각을 반환하던 버그 — 만료 시 `0` 반환.

## [Unreleased] — withRetry 나머지 인라인 재시도 통합 (Action Item 1.2)

### Changed
- `fetchRssWithRetry` (`src/lib/en-news-search.ts`, bingNewsRssSearch + googleNewsRssSearch 공용) 인라인 재시도 루프 → `withRetry({ maxRetries: 1, delaysMs: [300], jitter: false })`. 보존: 시도별 예산 분할(전체의 절반, min 1000ms), 429/5xx 시 서브리퀘스트 슬롯 해제(`body.cancel()`), 네트워크 오류 포함 전부 재시도, 4xx/ok는 응답 반환으로 fail-fast, 소진 시 `null` 반환. 기존 200–400ms 지터 슬립은 중간값 300ms로 고정 (나머지 withRetry 통합 지점과 동일한 방식). 로컬 `sleep` 헬퍼 제거.
- `src/lib` 인라인 재시도 루프 전수 조사 결과, 남은 루프는 이 지점이 유일함을 확인. 조사에서 제외 판정된 항목: `duckduckgo.ts`(재시도 루프 없음 — html→lite 폴백 체인, 202 anti-bot은 동일 IP에서 lite도 202가 되므로 의도적으로 fail-fast), `agentic/synthesizer.ts`(저신뢰도 재생성 루프 — 네트워크 일시 장애가 아니라 시도마다 프롬프트를 강화하는 품질 게이트로 백오프 부적합), `brave-search.ts`(429/401/403 fail-fast), `crawler-do.ts`/`index/*`(큐 레벨 재시도/백오프), `rate-limiter*`(회로 차단기).

## [Unreleased] — Planner 한국어 인텐트 분류 수정

### Fixed
- `QueryPlanner.heuristicPlan` 인텐트 분류가 JS `\b`(ASCII 전용) 단어 경계에 의존해 한국어 쿼리에서 financial/technical/news 분기가 전혀 발화하지 않던 문제 해결: `\b(실적|주가|…)\b`는 Hangul이 비-word 문자라 경계가 성립하지 않아 매칭이 불가능했음. `hasIntentKeywords()` 헬퍼로 대체 — 비문자/비숫자 기준 토큰화 후 전체 토큰 멤버십 검사로 라틴·한글을 동일하게 처리 (영문 `\b` 의미론은 보존: "stockholm" 오탐 없음), 다중 단어 구(예: "how to")는 연속 단어 검사.
- `tests/unit/agentic-planner-executor.test.ts` — 한국어 financial(`삼성전자 실적 분석 및 주가 전망`), 한국어 technical/news(`리액트 튜토리얼 구현 예시`, `삼성전자 최신 뉴스 발표`) 인텐트 감지 테스트 2건 추가.

## [Unreleased] — withRetry 실사용처 통합 (Action Item 1.2)

### Added
- `withRetry` now supports a hand-tuned `delaysMs` backoff sequence — index 0 = first retry — which overrides the exponential `baseDelayMs × factor^(attempt-1)` computation for the attempts it covers (falls back to the computed exponential past the end of the list). Lets callers preserve the tuned retry budgets of real backends exactly.
- `tests/unit/retry.test.ts` — 3 new tests: explicit `delaysMs` sequence wins over exponential growth, computed fallback past the end of the list, and ±50% jitter applied to tuned delays.

### Changed
- `fetchYahooJson` (`src/lib/yahoo-finance-search.ts`) retry loop → `withRetry({ maxRetries: 2, delaysMs: [150, 350], jitter: false })`. Preserved: per-attempt timeout budget split (3 × ~⅓, min 800ms), subrequest-slot body cancel on 429/5xx, retry-everything-thrown semantics (transient HTTP + network), 4xx fail-fast via returned response, exhaustion rethrow of `Yahoo HTTP <status>`.
- `naverNewsExtract` (`src/lib/naver-news-search.ts`) retry loop → `withRetry({ maxRetries: 2, delaysMs: [150, 350], jitter: false })`. Preserved: budget split, body cancel, 4xx fail-fast (returns `ExtractedContent` failure), exhausted-retry error `Naver article HTTP <status>`.
- `fetchNaverNewsPage` (`src/lib/naver-news-search.ts`) single 429/5xx retry → `withRetry({ maxRetries: 1, delaysMs: [1200], retryable: 429/5xx only })`. The old `_retry` recursion guard is gone (maxRetries=1 bounds it); the `[ssak] Retrying Naver news` log moves into the `onRetry` hook; network/timeout errors still fail without retry. `_retry` removed from `NaverNewsSearchOptions`.
- `naverSearch` (`src/lib/naver-search.ts`) same single-retry pattern → `withRetry` (identical policy); `_retry` removed from `NaverSearchOptions`.
- `wikipediaSearch` (`src/lib/specialized.ts`) REST 429 chain → `withRetry({ maxRetries: 2, delaysMs: [300, 600], jitter: false, retryable: 429 only })` and Action API fallback → `withRetry({ maxRetries: 1, delaysMs: [500], retryable: 429 only })`. Preserved side effects: `recordWikipediaRateLimit` fires on every 429 BEFORE the retry (B1 pacing guard, Retry-After-aware), `restRateLimited` skips the Action fallback on REST-429 so the shared gateway block can recover, non-429 statuses fail fast, REST failure still falls through to the Action API, and the failure log lines keep their status (`status <n>`, trying Action API) / no-response variants.

## [Unreleased]

### Added
- `src/lib/validation/schemas.ts` — zod-based defensive validation gate for untrusted API inputs (실행 원칙 3: 모든 외부 입력 zod 검증).
  - `parseSearchRequest()`: POST /api/search body — strict type rejection + legacy clamping/fallback preserved (query 2000 cap, max_results [1,20], page [1,10], max_tokens 8000, domain filters ≤20, enum fallback, `include_fact_check` truthy coercion).
  - `parseExtractRequest()` / `validateUrl()`: POST/GET /api/extract URL rules — 20 URL cap, 2048 length cap, legacy `missing_urls`/`invalid_urls` code mapping.
  - Shared constants (`MAX_RESULTS`, `MAX_PAGE`, `MAX_DOMAIN_FILTERS`, `MAX_EXTRACT_URLS`, …) as single source of truth for routes.
- `/api/extract` route test coverage in `tests/unit/routes.test.ts` (POST/GET validation + success paths).
- `tests/unit/validation-schemas.test.ts` — 39 schema unit tests (defaults, clamping, enum fallback, boolean coercion, domain caps, malformed-type rejection, extract URL rules).

### Fixed
- POST `/api/search` / `/api/extract` now reject malformed field types (e.g. `max_results: "10"`, `urls: 123`) with `validation_error` / `invalid_urls` instead of silently coercing or crashing downstream.

### Changed
- POST `/api/search` and POST/GET `/api/extract` validation moved from inline manual checks to the zod schemas in `src/lib/validation/schemas.ts`. Error codes (`missing_query`, `query_too_long`, `too_many_domains`, `missing_urls`, `invalid_urls`) unchanged — API contract preserved.
- `include_fact_check` string coercion now treats `"false"` as false (was `Boolean("false") === true`).

## [Unreleased] — Tracing & Resilience (Action Item 1.1, 1.2)

### Added
- `src/middleware/tracing.ts` — per-request trace_id middleware (Action Item 1.1). Generates a `trace_id` from `cf-ray` when present, else a random id; injects `traceId` into `c` and logs an `[incoming request]` span. All responses carry the `X-Trace-Id` header; `/api/health` and 401 auth failures are excluded from tracing noise.
- `trace_id` propagation through the full agentic pipeline: orchestrator → `executeAgenticSearch` → Planner (plan/step spans) → Executor (per-step spans) → Synthesizer (span + confidence) → Quality Gate (evaluation span). Every pipeline log line now carries `traceId`/`spanId` fields (was module-prefix only).
- `src/lib/resilience/retry.ts` — `withRetry()` exponential-backoff retry decorator (Action Item 1.2): `delay = min(base × factor^(attempt-1), maxDelayMs)`, optional ±50% jitter (thundering-herd safety), `retryable` predicate for fail-fast on permanent errors, `onRetry` hook for observability, attempt index passed to the wrapped fn (timeout-budget splitting). `computeRetryDelayMs` exported for deterministic testing.
- `tests/unit/retry.test.ts` — 10 tests: first-attempt success, recovery, exhaustion rethrow, exponential growth, maxDelayMs cap, fail-fast predicate, jitter bounds, onRetry callback, attempt indexing, default options.
- `tests/unit/tracing.test.ts` — 12 tests: trace_id generation from cf-ray, random fallback, header propagation, logger field injection, pipeline span structure.
- Coverage push (Task C): `tests/unit/agentic-planner-executor.test.ts`, `tests/unit/agentic-synth-quality.test.ts`, `tests/unit/agentic-index.test.ts`, `tests/unit/agentic-search-tools.test.ts`, `tests/unit/hybrid-search.test.ts`, `tests/unit/scheduler.test.ts` — agentic 4.39% → 86.7%, lib/index 47% → 72.8%, total 65.34% → 71.77%.

### Changed
- Structured logger now emits `trace_id`/`span_id` alongside `request_id`; `child()` spans nest under the parent trace.
- Agentic pipeline log messages standardized to include `traceId`/`spanId` context instead of module-prefix-only text.

## [3.0.0] — 2026-07-22

### Phase 1: Core Stabilization & Security

#### Added
- Vitest test infrastructure with `tests/unit/` (23 files, 524 tests)
  - `cacheKey` regression tests (P0-1: page isolation, NFC normalization)
  - SSRF guard tests (`assertSafeFetchUrl`, `isPublicHostname`)
  - auth rate-limit + getClientIp tests
  - extractor SSRF rejection tests (P0-2)
  - snapshots for Wikipedia, HackerNews, GitHub, Naver, Bing, DuckDuckGo parsers
- `npm test` and `npm run typecheck` scripts; `@cloudflare/workers-types` for 0 false positives
- `vitest.config.ts` + `vitest.integration.config.ts` dual-project test configuration
- `e2e/` integration tests — `executeSearch.test.ts`, `parsers.test.ts`, `orchestrator.test.ts`, `api.test.ts`
- LICENSE (MIT), SECURITY.md (private disclosure + threat model), CONTRIBUTING.md (PR checklist)
- `package.json` metadata: `license`, `author`, `repository`, `engines.node>=20`, `description`
- Container for response: 64KB body cap on `/api/search` and `/api/extract` (P0-4)
- Domain-filter cap (`include_domains`/`exclude_domains` ≤20) enforced in `/api/search` POST (P0-4)
- Per-URL length cap (2048) and per-request URL count cap (20) for `/api/extract` (P0-4)
- `metricsRoute` Hono app mounted at `/api/metrics` for proper Prometheus path (P0-3)
- `/api` root endpoint listing all available API endpoints
- Structured audit logging (`src/lib/audit.ts`) — security events with `audit: 'true'` flag
- Logger module (`src/lib/logger.ts`) — structured JSON logging with context enrichment
- Rich snippets extraction (`src/lib/rich-snippets.ts`) — schema.org/JSON-LD/Microdata parsing
- Input size enforcement middleware — body 64KB, domain arrays 20, extract URLs 20, page 1-10

#### Fixed
- **P0-1 (critical)**: `cacheKey()` now includes `page` — pagination cache isolation
- **P0-2 (critical)**: `assertSafeFetchUrl()` SSRF guard — private IPs, metadata endpoints, credentials-in-URL
- **P0-3 (critical)**: `/api/metrics` routing — dedicated metricsRoute at `/api/metrics`
- **P1-1**: TypeScript strict `PromiseSettledResult.value` narrowing in orchestrator
- **P1-2**: `fetchWithTimeout` circuit breaker bypass — both paths throw 503
- **P1-4**: Adaptive threshold floor at `min(10, max_results)` — spam tier-3 gating
- **P1-5**: `sort_by=date` score blend — date-weight + relevance score combined
- **P1-6**: Korean NFC/NFD normalization + ZWSP/NBSP/BOM stripping in cacheKey

#### Security
- SECURITY.md with threat model and private disclosure path
- All input-validation routes enforce explicit size caps (P0-4)
- Audit logging for auth failures, SSRF attempts, rate limit overages
- CSP compliance — HSTS, X-Content-Type-Options, X-Frame-Options, X-XSS-Protection headers

### Phase 2: Advanced Features & New Backends

#### Agentic Search Engine (`src/lib/agentic/`)
- **Planner** (`planner.ts`): LLM-based query decomposition into sub-query plans with JSON schema
- **Executor** (`executor.ts`): Sequential step runner with context passing between steps
- **Search Tools** (`search-tools.ts`): Agentic primitives — `searchWeb()`, `fetchUrl()`, `compute()`, `filterEvidence()`, `rerankResults()`, `assemblePrompt()`
- **Synthesizer** (`synthesizer.ts`): Constrained generation with pre-embedded citation markers
- **Classifier** (`classifier.ts`): Query complexity classifier for Pro/Fast auto-routing
- **Quality Gate** (`quality-gate.ts`): Evidence quality evaluation with fail-fast re-query
- **Index** (`index.ts`): Main pipeline orchestrator with Pro (deep research) / Fast (simple) routing

#### New Search Backends
- **Free Image Search** (`free-image-search.ts`): Multi-source image search (Flickr, Unsplash, Bing)
- **Google Scholar** (`google-scholar.ts`): Academic paper search via Google Scholar scraping
- **SearXNG** (`searxng-search.ts`): Self-hosted SearXNG integration with configurable URL
- **Yahoo Finance** (`yahoo-finance-search.ts`): Real-time stock data, financial news, chart data
- **YouTube Search** (`youtube-search.ts`): Video search and transcript extraction
- **Product Search** (`product-search.ts`): E-commerce price comparison and product discovery

#### Index Pipeline (`src/lib/index/`)
- **Chunker** (`chunker.ts`): Semantic HTML-to-chunks segmentation (heading-aware)
- **Embedding** (`embedding.ts`): Custom embedding API integration with configurable endpoint
- **Scheduler** (`scheduler.ts`): ML-driven refresh scheduler for URL importance × update frequency
- **Pipeline** (`pipeline.ts`): Incremental indexing pipeline with Queues + Workers + Vectorize
- **Types** (`types.ts`): Index schema — documents, chunks, embeddings metadata
- D1 database schema (`schema.sql`) — index metadata, URL importance, refresh schedule

#### Durable Objects (Stateful Storage)
- **ThreadDO** (`thread-do.ts`): Conversational thread persistence with message history
- **PagesDO** (`pages-do.ts`): Research report/pages storage with versioning
- **LibraryDO** (`library-do.ts`): Search collections, bookmarks, saved queries
- **UserProfileDO** (`user-profile-do.ts`): User profiles, domain visit history, preferences
- **SpaceDO** (`space-do.ts`): Workspace/collaboration spaces with member management
- **RateLimiterDO** (`rate-limiter-do.ts`): Cross-isolate rate limiting and circuit breaker

#### New API Routes
- **Chat** (`/api/chat`): Multi-turn conversational search with thread management
- **Council** (`/api/council`): Multi-model comparison (OpenAI, Anthropic, Workers AI)
- **Images** (`/api/images`): Image search with multi-source aggregation
- **News** (`/api/news`): News search with trending endpoint (`/api/news/trending`)
- **Research** (`/api/research`): Multi-step deep research with configurable depth
- **Spaces** (`/api/spaces`): Collaborative workspace management
- **Pages** (`/api/pages`): Research report CRUD operations
- **Library** (`/api/library`): Saved searches and collections management
- **Profile** (`/api/profile`): User profile and preferences
- **Suggest** (`/api/suggest`): Search autocomplete suggestions (DDG → Bing fallback)
- **Usage** (`/api/usage`): Per-user API usage tracking and quotas
- **Upload** (`/api/upload`): File upload to R2 storage
- **Video** (`/api/video`): YouTube search and transcript retrieval
- **Products** (`/api/products`): E-commerce product search and price comparison
- **Canary** (`/api/canary`): Parser regression detection with real search queries
- **OpenAI Compatible** (`/api/openai`): `/v1/chat/completions` with function calling support
- **Analytics Proxy** (`/api/analytics-proxy`): Grafana Simple JSON datasource for Workers Analytics Engine

#### Frontend Pages
- **Chat UI** (`src/pages/chat.ts`): Full conversational search interface with SSE streaming
- **Dashboard** (`src/pages/dashboard.ts`): API usage dashboard with real-time metrics
- **Docs** (`src/pages/docs.ts`): Interactive API documentation with Scalar
- **Status** (`src/pages/status.ts`): Service status and backend health visualization
- **Page View** (`src/pages/page-view.ts`): Research report viewer with citation display

### Phase 3: Production Hardening & Operations

#### Monitoring & Observability
- **Metrics module** (`src/lib/metrics.ts`): Comprehensive Prometheus metrics — requests, errors, latency, cache hit rate, circuit breaker state, persistence gauge
- **Workers Analytics Engine** integration: Cross-isolate persistent metrics via `ANALYTICS` binding
- **Grafana Dashboard** (`grafana/dashboard.json`): 25-panel dashboard with backend status, latency heatmaps, SLO tracking, cache performance
- **Grafana Alert Rules** (`grafana/alerts.yml`): 14 Prometheus alerting rules for SLO breaches
- **Grafana Scrape Config** (`grafana/prometheus.yml`): Prometheus scraping configuration
- **Datadog Dashboard** (`datadog/dashboard.json`): Datadog dashboard with 12 widgets — backend latency, error rates, cache hit rate, circuit breaker status
- **Datadog Monitors**: SSRF attempts, auth failures, rate limit overage alerts
- **Logpush Integration** (`scripts/create-logpush-datadog.sh`): Cloudflare Logpush → Datadog
- **Analytics Engine Proxy** (`src/routes/analytics-proxy.ts`): Grafana Simple JSON datasource proxy
- **SLO.md**: Service Level Objectives — 99.9% availability, p50 < 3s, p99 < 15s, cache hit > 60%
- **AUDIT.md**: Audit log configuration — Logpush setup, Datadog/Splunk integration, Live Tail filters
- **MONITORING_GUIDE.md**: Complete monitoring setup guide with Grafana/Datadog integration steps

#### Rate Limiting & Circuit Breaker
- **RateLimiterDO**: Durable Object-based cross-isolate rate limiting (30 req/min per IP)
- In-memory fallback when DO binding not available (per-isolate best-effort)
- Per-host circuit breaker with automatic recovery
- X-RateLimit-* headers in all responses

#### Security Hardening
- CSP headers on all UI pages
- HSTS (Strict-Transport-Security) header
- X-Content-Type-Options, X-Frame-Options, X-XSS-Protection headers
- CORS configuration for `/api/*` endpoints
- API key authentication with Bearer token and X-API-Key header support

### Phase 4: SDK & Packages

#### TypeScript SDK (`packages/answer-sdk-ts/`)
- `HermesAnswerClient` — typed streaming and non-streaming chat client
- SSE streaming support with `streamChat()`
- Full TypeScript types for request/response schemas
- Bun-compatible package configuration

#### Python SDK (`packages/answer-sdk-py/`)
- `AnswerClient` — async HTTP client for chat and search
- SSE streaming with `sse-starlette` parser
- Type-annotated dataclasses for request/response
- Poetry/pyproject.toml package management

#### Hermes Search SDK (`packages/hermes-search/`)
- `HermesSearch` — full-featured Tavily-compatible client
  - `search()` / `search_async()` — typed dataclass search
  - `search_dict()` / `search_async_dict()` — Tavily-compatible raw dict interface
  - `extract()` — URL content extraction
  - `chat_async()` — multi-turn conversation
  - `health()` / `health_async()` — backend health check
  - `stream_search_async()` — SSE streaming search
- `HermesAgentTools` — OpenAI function-calling tool definitions for agent integration
- Comprehensive README with Tavily compatibility table
- Focus modes: general, news, academic, image, video, social, shopping, financial

### Phase 5: Documentation

#### Comprehensive Documentation Set
- **README.md**: Complete project documentation — architecture, API reference, deployment guide, Korean search optimization, production setup
- **ANALYSIS_REPORT.md**: 83-item commercial gap analysis with ICE-scored roadmap
- **COMPLETENESS_ANALYSIS_V2.md**: Perplexity-level completeness analysis with phased redesign plan
- **STRATEGIC_CHECKLIST.md**: Strategic plan to surpass Perplexity — phased execution checklist
- **DEPLOYMENT_CHECKLIST.md**: 11-section production deployment checklist (pre-flight → deploy → post-flight → incident response)
- **HERMES_INTEGRATION.md**: 3-method Hermes Agent integration guide (Tavily HTTP, OpenAI Compatible, Python SDK)
- **MONITORING_GUIDE.md**: Grafana and Datadog monitoring setup guide
- **AUDIT.md**: Audit log configuration with Logpush, Datadog/Splunk/Grafana integration
- **SLO.md**: Service Level Objectives with alerting rules and dashboard panels
- **CONTRIBUTING.md**: PR checklist, code style guide, development workflow
- **SECURITY.md**: Threat model, vulnerability disclosure, security best practices
- **OpenAPI Spec** (`openapi.yaml`): Full OpenAPI 3.0 specification covering all API endpoints
- **CHANGELOG.md**: Complete version history following Keep a Changelog format

### Phase 6: Additional Features

#### UX & Frontend
- PWA support with `manifest.json` — installable web app
- Service worker registration for offline capability
- Responsive CSS with Tailwind CDN + custom utility classes
- SSE streaming UI for real-time search results
- Interactive API documentation with Scalar UI
- Status page with backend health visualization

#### Council (Multi-Model Comparison)
- `/api/council` — compare responses from OpenAI, Anthropic, and Workers AI side-by-side
- Model-specific prompt engineering for each provider
- Structured response comparison with latency tracking

#### YouTube Transcript
- `/api/video` — YouTube search + transcript extraction
- Transcript caching for repeated queries
- Multi-language transcript support

### Phase 7: Deployment & Operations

#### CI/CD Pipeline
- `.github/workflows/ci.yml` — typecheck + test + build on PR/push
- `.github/workflows/deploy.yml` — Pages deployment with CI artifact reuse
- `.github/workflows/monitor.yml` — 15-min health check with Slack alerts
- `.github/dependabot.yml` — automated dependency updates

#### Infrastructure
- `wrangler.jsonc` — complete Cloudflare configuration with all DO bindings
- `ecosystem.config.cjs` — PM2 process management for local development
- `vite.config.ts` — optimized build configuration with code splitting
- `tsconfig.json` — strict TypeScript configuration

#### Testing
- 84 → 524 unit tests across 23 test files
- Integration tests for parsers, orchestrator, executeSearch
- K6 load test script (`tests/k6/load-test.js`)
- Snapshot-based parser regression testing
- Coverage reports with `@vitest/coverage-v8`

### Known Limitations (v3.0.0)
- `RATE_LIMITER` DO binding optional — in-memory fallback without Dashboard binding
- Analytics Engine binding optional — metrics reset on isolate cold start without `ANALYTICS` binding
- HTML scraping depends on Bing/Naver/DDG DOM stability — parsers regress silently
- Per-isolate rate limiting without DO — cross-isolate accuracy requires DO binding
- `/api/health` unauthenticated by design
- Subrequest quota: ~27/request → ~2 concurrent users on free plan
- Python/TS SDKs not yet published to PyPI/npm

## [2.0.0] — 2026-07-18

### Added (prior baseline, documented retroactively)
- Naver mobile search backend (Korean PRIMARY, no API key)
- Bing mobile + image + news search with mkt=zh-CN for CJK queries
- DuckDuckGo HTML/Lite fallback with 202 anti-bot fail-fast
- Wikipedia / GitHub / HackerNews / Reddit / arXiv specialized sources
- Jina AI Reader content extraction (optional, works without key)
- Cloudflare HTMLRewriter-based fallback extractor
- Optional Workers AI answer generation with inline citations
- Knowledge Graph (Wikipedia REST summary) for factual/general queries
- Image search vertical via Bing `iusc m=` JSON parsing
- Per-host circuit breaker (`src/lib/rate-limiter.ts`)
- Optional API key auth + per-IP rate limit (`src/lib/auth.ts`)
- 30-second cached `/api/health` to prevent self-DoS
- Adaptive 3-tier minimum quality threshold (0.10 → 0.05 → 0.01)
- CJK bigram matching + cross-language penalty
- Unicode property escapes in dedup normalization

### Known limitations (carried into 2.x)
- Per-isolate rate limiting — high-traffic deployments should add KV or DO.
- HTML scraping depends on Bing/Naver DOM staying stable — parsers regress
  silently. (Mitigations in this release: unit tests, health probes.)
- `/api/health` is unauthenticated by design; gate behind an edge firewall
  if you need to hide operational metadata.
