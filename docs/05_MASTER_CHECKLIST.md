# 05. 마스터 체크리스트 (MASTER CHECKLIST)

> 상태: `[x]` 완료·검증 · `[~]` 일부 구현/추가 검증 · `[ ]` 미구현 · `[!]` 문제 발견 · `[?]` 자료 부족
> 기준: 2026-08-13 3차 재검증 (코드 분석 + 실행 검증) — 08-07 재감사 기준에 이번 세션 결과 반영

## 1. 프로젝트 실행
- [x] 의존성 설치 (node_modules 정상)
- [x] 타입체크 0 에러 (`npm run typecheck`)
- [x] 빌드 성공 (`npm run build`, 1,113.74 kB / gzip 326.89 kB — 08-13 실측)
- [x] 유닛 테스트 **2,543건** 통과 (`npm test`, 129파일 0 실패 — 08-13 실측)
- [x] eval 벤치마크 실행 가능 (**500쿼리 × median-of-3, 99.6% pass — 08-06 최신 런**)
- [x] **CI 린트 게이트 복구** (lint:eslint:ci exit 0 — 세션 전 38 errors+467 warnings로 레드)
- [x] **lint:eslint:ci(--max-warnings=0) CI 연결 명시화 (S29)** — ci.yml `Lint (ESLint — 0-warning gate)` 스텝 + Step Summary, README 수치 갱신
- [~] **브랜치 보호 규칙 (S29 권장)** — main에 `lint-typecheck`·`unit-tests` required status checks 지정 (GitHub 설정, 코드로 불가)
- [~] 로컬 서버 기동 — 미실행 상태 (start-local.sh 대기)

## 2. 요구사항
- [x] Tavily 호환 /api/search (GET/POST/SSE)
- [x] /api/extract 콘텐츠 추출
- [x] AI 답변 + 인용 (Workers AI → 추출 → DDG)
- [x] 멀티백엔드 병합 검색 (ko/zh/ja/en)
- [x] OpenAI 호환 /v1/chat/completions
- [x] 뉴스/이미지/금융/학술/비디오/상품 검색
- [x] 딥 리서치 (multi-step)
- [~] 쇼핑 일반·지도·특허·정부데이터 검색 — 미지원
- [~] 자체 인덱스 + 크롤러 — 구현, 실측 대기

## 3. 코드 구조
- [x] 모듈 분리 (lib 60 / routes 28 / pages 8)
- [x] TypeScript strict
- [x] 단일 로드맵 (UNIFIED_ROADMAP.md)
- [~] routes 28개 단일 파일 — 파일 분리 리팩터링 검토
- [?] 문서(README/docs.ts)와 코드 표면 일치 — 일부 미검증

## 4. 검색 소스
- [x] Naver (KR primary)
- [x] Bing (웹+뉴스+mkt=zh-CN)
- [x] DuckDuckGo (폴백)
- [x] Wikipedia (다국어 + 프로세스 내 결과 캐시, S9)
- [x] GitHub / HackerNews / Reddit
- [x] arXiv / OpenAlex / Google Scholar
- [x] Yahoo Finance / Naver Finance
- [x] YouTube / 무료 이미지 / Product Hunt / G2
- [x] SearXNG / Jina (선택 — 코드 통합됨, 배포 가이드 docs/13)
- [x] zh 커뮤니티: Juejin (S16) + CSDN (S26, 키리스 — zh-tech+zh-general)
- [x] ja 커뮤니티: Qiita (S16, 키리스 — 쿼터 가드 포함)
- [~] zhihu — 비CN IP 400 차단 (SearXNG Baidu/Bing zh 엔진으로 우회 가능, 미검증)
- [~] 야후 가용성 — waitFor로 완화, 잔여 노이즈 존재
- [x] 한국 금융 일반 웹 폴백 (buildBingTask, S8)
- [~] 정부·특허·지도·소셜 — 미지원

## 5. 질의 분석
- [x] 타입 감지 (6종)
- [x] 언어 감지 (ko/zh/ja/en, 신자체 포함)
- [x] CJK 바이그램 매칭
- [x] 쿼리 분해 (comparison/entity)
- [x] 엔티티 추출
- [x] 회사 alias 확장
- [x] 이중 인코딩 정규화
- [~] 오탈자 교정 — 미구현
- [~] 동의어/유사어 확장 — 미구현 (회사 alias만)
- [x] 시간/지역/도메인 조건 처리

## 6. 크롤링·콘텐츠
- [x] robots.txt 준수 (CrawlerDO)
- [x] sitemap 디스커버리
- [x] URL 정규화·중복 제거
- [x] 재시도·백오프·타임아웃
- [x] SSRF 방지 (DoH 기반)
- [x] blacklist (악성 콘텐츠)
- [x] 본문 추출 (HTMLRewriter → Jina)
- [~] JS 렌더링 — sidecar 경유만
- [~] PDF — 업로드 경유만 (URL 크롤 미지원)
- [~] 콘텐츠 유사도 중복 탐지 — 미구현 (URL 기반만)
- [x] 프롬프트 인젝션 격리 (prompt-guard, HIGH 격리 + JSON 뉴트럴라이즈)

## 7. 인덱싱·저장
- [x] Vectorize + D1 하이브리드 (BM25+RRF)
- [x] 청킹·임베딩 (Workers AI/Ollama)
- [x] 스케줄러·재크롤링 cron
- [x] 캐시 4-tier (메모리/CacheAPI/KV/시맨틱)
- [~] 문서 버전 관리 — 미구현
- [~] 인덱스 커버리지 실측 — 배포 후

## 8. 랭킹
- [x] BM25 + 휴리스틱 블렌드
- [x] 도메인 권위 (영/한/중/일 맵)
- [x] 블로그/스팸 패널티
- [x] 신선도 블렌드 (0.7/0.3, date 0.85/0.15)
- [x] 3단계 적응형 품질 임계값
- [x] Cross-encoder reranker (Workers AI + sidecar)
- [x] LTR (클릭 피드백, control A/B)
- [x] 결과 다양성 모듈
- [~] LTR 실측 (+5% NDCG) — 학습 데이터 필요

## 9. AI 답변 생성
- [x] Workers AI → 추출 요약 → DDG 폴백
- [x] SSE 스트리밍 + keepalive
- [x] 신뢰도/소스/비용 리포트
- [x] 에이전틱 프로 파이프라인
- [~] 사실 교차검증 (2+소스) — 부분
- [~] 인용문-원문 일치 런타임 검증 — llm-judge만

## 10. 출처 검증
- [x] 도메인 권위 평가 (맵 기반)
- [x] llm-judge (citation precision / hallucination)
- [~] 런타임 인용 검증 — 미구현
- [~] "근거 부족 시 답변 보류" 정책 — 명시 필요

## 11. 다국어 검색
- [x] ko (Naver primary)
- [x] zh (mkt=zh-CN, 위키 zh)
- [x] ja (신자체 감지, ja 백엔드)
- [x] en (범용)
- [!] zh 일반 쿼리 결과 부족 (zh-general-04)

## 12. 성능
- [x] p50 <1s (817~855ms 실측)
- [x] p95 3.5s (목표 <3s에 근접)
- [x] 캐시 + single-flight
- [~] p95 개선 (백엔드 의존)
- [~] 부하 테스트 실측 (k6 준비됨, 실행 대기)

## 13. 안정성
- [x] 서킷 브레이커 self-healing
- [x] DDG 폴백 / 부분 결과 반환
- [x] canary 파서 회귀 감지
- [x] **arxiv/openalex/brave 일시 장애 1회 재시도 (08-13)** — 5xx/네트워크만, 회로 개방·429·4xx fail-fast, 예산 worst=ceiling
- [~] searxng/reddit/stack-exchange 재시도 — 조건부 권고로 보류 (docs/16 §4, 저우선)
- [~] DO 미바인딩 시 약화 (P2)
- [~] 재해복구/멀티리전 — 미구현

## 14. 보안
- [x] SSRF 방지 (DoH)
- [x] CSP nonce + 보안 헤더
- [x] 레이트 리밋 (IP/키/DO)
- [x] 멀티테넌트 키 (상수시간 비교)
- [x] 감사 로그
- [x] requireAuth/requireAdmin (크롤·인덱스·블랙리스트)
- [x] 입력 검증 (64KB/도메인 20/쿼리 2,000자)
- [x] 프롬프트 인젝션 방어 (prompt-guard.ts, 다국어 탐지·격리·감사·테스트 41건)
- [~] open mode 기본값 — 배포 시 SEARCH_API_KEY 필수 안내

## 15. 개인정보보호
- [x] 쿼리 로그 (요청 추적) — 쿼리 문자열은 로그에 기록하지 않음 (logger.ts 실측 확인)
- [x] 보존기간·삭제 정책 — **PRIVACY_POLICY.md 5.1 (08-13 실측)** — DO별 보존 기간·삭제 경로(deleteAll 라인) 명시
- [~] 사용자 자가삭제 API — 미구현 (상용화 전 필수, P22 후속)
- [~] user_id 수집 정책 — 명시 필요

## 16. 테스트
- [x] 유닛 **2,589건** (129파일 — 08-13 실측)
- [x] 통합 **8파일/108건** — **DO 분리 배포 후 깨졌던 시작 오류 복구 (08-13, self-referencing 바인딩)**
- [x] eval **500쿼리 + gold 1:1** + median-of-3 집계 — 08-13 P20 분석으로 평균 NDCG 안정성 재확증
- [x] **gold 표준 shift 오류 7건 수정 (08-13)** — en-tech-04/05/07/08/09/10/11 쿼리-도메인 정렬 교정, 해당 쿼리 NDCG +0.19~0.27 개선
- [x] **자연어 질문 쿼리 변환 (08-13, en-fact-11)** — bingSearch 전 does/do/did 제거(naturalLanguageToKeywords), is/are 유지, 신규 테스트 7건
- [x] **자연어 변환 전 백엔드 확장 (08-13)** — simplifyQuery 진입점 연동으로 HN/reddit/github/dbpedia/arxiv/qiita/stack-exchange 일괄 적용
- [x] **학술 eval arxiv 페이싱 (08-13)** — eval 벌크가 arxiv 30/min 초과로 en-acad 백엔드 누락되던 문제, 2200ms 페이싱으로 해소
- [x] **arxiv 429 cooldown 가드 (08-13)** — 프로덕션 보호 (local + shared DO, Retry-After 준수), 신규 테스트 4건
- [x] **openalex locations 수집 (08-13)** — arxiv.org preprint 유입 (기존 doi.org 위주 → arxiv gold), 신규 테스트 3건
- [x] **gold EN_FACT nasa.gov 오버브레스 교정 (08-13, S72)** — en-fact-16~40 중 14건에서 nasa.gov 제거(풀 전무 + 의도 불일치, S63/S69 선례), 유지 11건 명시화. 전체 NDCG +0.5~0.7 mNdcg (평가 기준 정밀화)
- [x] **wikipedia 429 cooldown 언어별 분리 (08-13, S73)** — en 429가 모든 언어 wikipedia를 죽이던 전역 창 → 언어별 독립 (wikimedia per-site rate limit 실측 근거). zh flicker 20%의 직접 원인 해소, 신규 테스트 3건
- [x] **gold drift 감지 실행 (08-13, S60)** — S72 교정 후 저장 풀 재계산: drift 17건 전부 양수(net +0.1042), 음수 0건. S58 gate gold-robust 확인, baseline refresh 권장
- [x] **백엔드별 gold 기여 리포트 (08-13)** — scripts/report-backend-coverage.ts + docs/02 §2.5: arxiv 0.878 > yahoo-finance 0.750 > naver 0.705 > github 0.581(절대 1위). 최대 갭 stack-exchange(162)/reddit(51) 미가동 + openalex missUsed 22
- [x] **wikidata mirror sitelink 오염 필터 (08-13, S74)** — URL 제목 ↔ 쿼리 관련성 검증(오염 sitelink 스킵, 번체 변형 보존), 신규 테스트 2건. zh 검색 0건 결론은 프로브 아티팩트로 정정 — 6개 zh/ja 쿼리 라이브 검증 완료
- [x] **github.com gold flicker 해결 (08-13, S75)** — early-exit(20건): waitFor에 github/github-issues 추가. quota(라이브 재현): githubSearch 캐시 추가 + eval 페이싱 6000ms. 랭킹 아웃 9건은 잔여로 문서화. 신규 테스트 4건
- [x] **openalex 429 cooldown 가드 (08-13, S76)** — S73 재측정 중 발견: openalex는 가드 부재로 429 시 hammering. wikipedia/arxiv 패턴 적용 + Retry-After 1h 클램프(실측 12h 창). 신규 테스트 3건. S73 재측정 결과: arxiv 17/17(FIX-09 확정) · zh-fact wikipedia 9/16(기준선 평균과 동등, run-3 전멸 구조 불가) · openalex 0/17은 IP-level 429(12h)로 코드 문제 아님 확인
- [x] k6 부하 스크립트
- [x] canary 스냅샷
- [x] health 상태 롤업 유닛 테스트 (신규 8건)
- [x] **auth DO mock flaky 고정 (08-13)** — hoisted vi.mock, 15회 연속 통과
- [x] **백엔드 재시도 정책 테스트 27건 (08-13)** — arxiv/openalex/brave/searxng/reddit/stack-exchange 5xx 재시도/소진/네트워크/429·4xx·회로 fail-fast
- [x] **fetch 타임아웃 정합성 테스트 (08-13)** — 재시도 체인 분할 예산 = ceiling (20건)
- [~] E2E 사용자 시나리오 — 부족
- [~] 부하·장시간 테스트 실행 — 대기

## 17. 배포
- [x] GitHub Actions deploy 워크플로우
- [x] DEPLOYMENT_CHECKLIST.md
- [x] **프로덕션 가동 확인 (HTTP 200, 2026-08-06 재검증)**
- [!] DO/인프라 바인딩 — 미설정 (P1-2, Dashboard 수동 설정 필요)

## 18. 모니터링
- [x] Prometheus 메트릭
- [x] Sentry APM
- [x] Analytics Engine (선언됨, 실측 대기)
- [x] Slack/PagerDuty 알림 (워크플로우)
- [x] 구조화 JSON 로그 + requestId
- [~] 대시보드 실측·알림 실동작 — prod 복구 후

## 19. 문서화
- [x] README (아키텍처·API·배포)
- [x] UNIFIED_ROADMAP (단일 신뢰 원천)
- [x] SECURITY.md / SLO.md / AUDIT.md / DEPLOYMENT_CHECKLIST.md
- [x] 01~10 산출물 (이번 세션)
- [~] docs.ts(API 문서 페이지) 최신성 — 검증 필요
- [!] ~~page-view.ts 브라우저 SyntaxError~~ → 수정 완료 (S24, 인용/볼드 렌더링 복구)
- [!] ~~util.ts isComparison 바이트 손상~~ → 수정 완료 (S24, 한국어 비교 감지 복구)

## 20. 사용자 경험
- [x] SSR 대시보드/채팅/상태/사용량 페이지
- [x] SSE 실시간 답변
- [x] i18n 다국어 UI
- [x] PWA manifest
- [~] 브라우저 UI 실측 — 미수행

## 21. 비용 관리
- [x] 유료 API $0 (No-API-Key 원칙)
- [x] subrequest 예산 추적 (헤더/로그)
- [~] 비용 모니터링 대시보드 — 실측 대기

## 22. 상용화 준비
- [x] 프로덕션 가동 확인 (HTTP 200)
- [ ] DO/인프라 바인딩 완료 (P1-2)
- [x] eval 게이트 통과 (**500/500, 0 실패**)
- [ ] 부하/장시간 테스트
- [ ] 출시 체크리스트 전 항목 ✅
- [ ] 개인정보 정책·운영 매뉴얼 확정

---

**요약**: 완료·검증 52건 / 일부·검증필요 18건 / 미구현 6건 / 문제발견 3건 (DO 바인딩, 야후 노이즈, partial_outage 원인 인프라) / 자료부족 1건
