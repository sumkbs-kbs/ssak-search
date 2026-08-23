# 01 — 현재 상태 평가 (Current State Assessment)

> 작성일: 2026-08-23 | 기준 커밋: `e6defb3` (로컬 미커밋 WIP 54개 파일 존재)
> 모든 항목은 실제 실행 결과에 근거. 추정 항목은 명시적으로 표시.

---

## 1. 프로젝트 개요

| 항목 | 확인된 사실 |
|---|---|
| 프로그램 목적 | API 키·유료 의존 없는 자체 호스팅 검색엔진 (Tavily 호환 API, Hermes Agent용) |
| 런타임 | Cloudflare Pages/Workers (Hono v4 + TypeScript strict) |
| 빌드 | Vite → `dist/_worker.js` 1,160 KB (gzip 341 KB) |
| DO 아키텍처 | `ssak-do-worker`(별도 Workers 배포, `wrangler.do.jsonc`)가 15개 DO 클래스 소유, Pages가 `script_name`으로 바인딩 |
| 저장소 | D1(코퍼스) + Vectorize(dense/semantic-cache) + KV + Analytics Engine |
| AI | Workers AI(답변/임베딩), Ollama(로컬 임베딩 폴백), OpenRouter(.dev.vars) |
| 백엔드 | Naver(한국어 PRIMARY), Bing 스크래핑, DDG 폴백, Wikipedia/DBpedia/Wikidata, GitHub, HackerNews, Reddit, arXiv, SearXNG 등 |
| 테스트 | Vitest unit 152파일 **3,059개 전부 통과** (57초) + integration/e2e 구성 존재 |

## 2. Phase 0 실행 검증 결과 (2026-08-23 실측)

| 게이트 | 결과 | 비고 |
|---|---|---|
| `npm run typecheck` | ✅ exit 0 (에러 0) | |
| `npm run build` | ✅ 성공 101ms~153ms | |
| `npm test` (unit) | ✅ **3,059/3,059 통과** | |
| 서버 기동 (README 방식 그대로) | ❌ `/api/health` **500** | 원인: `Worker "ssak-do-worker" not found` |
| 서버 기동 (DO 워커 병행 기동 시) | ✅ status ok | 2-프로세스 필요 |
| KR 금융 검색 ("삼성전자 주가") | ✅ 우수 | `bing+naver+naver-finance`, 네이버 증권 카드 상위 노출, 1.4초 |
| EN 검색 ("cloudflare workers tutorial") | ⚠️ 동작하나 정밀도 낮음 | 대시보드 로그인 페이지·마케팅 홈페이지 유입, 4.0초 |
| EN technical ("react hooks guide") | ⚠️ github/hackernews 미기동 | 아래 P2 참조 |
| 로컬 인덱스 | ⚠️ empty (total_documents=0) | 그런데 `self-index`가 사용 백엔드로 기록됨 → 모순 (P3) |
| README eval 수치 (NDCG@10 0.2839) | ? 재측정 필요 | 최근 커밋은 NDCG 게이트 0.60 달성을 시사 — README 데이터(08-09)가 코드보다 낡았을 가능성 (가설) |

## 3. 완성도 평가 (100점 만점)

| 평가 항목 | 점수 | 판단 근거 | 주요 문제 | 개선 우선순위 |
|---|---|---|---|---|
| 요구사항 충족도 | 75 | 핵심 파이프라인 실호 확인(KR/EN 검색, 인증, 캐시, 메트릭) | README가 약속하는 "open 모드"가 DO 바인딩 기본값과 충돌 | High |
| 검색 범위 | 70 | 10+ 백엔드 실기동 확인 | technical 쿼리에서 GitHub/HN 드랍, 일부 소스(zh/ko 위키 엔드포인트 다운 — 코드 코멘트) | High |
| 검색 결과 정확도 | 55 | EN tutorial 쿼리에 로그인 페이지·홈페이지 유입 실측 | 랭킹이 도메인 권위 중심으로 상업/네비게이션 페이지 필터 부족 | High |
| 검색 결과 최신성 | 검증 필요 | published_date 대부분 null 관찰 | 실측 데이터 부족 | Medium |
| 출처 신뢰성 | 65 | gold-domain 체계(S75/P24 waitFor) 존재 | dash.cloudflare.com 같은 네비게이션 도메인 필터 없음 | Medium |
| 결과 다양성 | 검증 필요 | 도메인 편중 방지 코드 존재 확인 | 정량 실측 미실시 | Low |
| 중복 제거 성능 | 70 | URL+정규화 제목 이중 dedup, Unicode 버그 수정 이력 | 실측 미실시 | Low |
| 검색 속도 | 45 | p50 5.9초 / p95 10초 (README eval), 실측 1.4~4.0초 | 목표 대비 느림, 무료플랜 subrequest 한계 문서화됨 | High |
| 시스템 안정성 | 70 | 서킷브레이커+티어드 팬아웃+미러 폴백 구조 확인 | 로컬 기동 절차 취약(P1) | High |
| 확장성 | 65 | DO 기반 크로스 아이솔레이트 조정 | 단일 리전 편중 구조 실측 없음 | Medium |
| 유지보수성 | 60 | 모듈 경계 명확, ADR성 코멘트 풍부 | 루트 문서 20+ 파일 중 상당수 낡음/모순(archive 이력) | Medium |
| 코드 품질 | 72 | TS strict 0에러, ESLint max-warnings=0 CI | 거대 오케스트레이터(600줄+) 함수 | Medium |
| 테스트 수준 | 85 | 3,059 단위 테스트 전통과, eval 하네스(NDCG/MRR 게이트) | health 라우트 자체 테스트 부재 | Low |
| 보안 수준 | 68 | SSRF 가드, 감사로그(AUDIT_SECURITY 실측), 레이트리밋 DO | auth 상태 보고 불일치(수정함), Bing/Naver UA 위장 스크래핑의 ToS 회색지대 | High |
| 개인정보보호 | 70 | PRIVACY_POLICY.md, IP 기반 레이트리밋 최소수집 | 클릭로그 DO 데이터 보존기간 실측 안 함 | Medium |
| 장애 대응 능력 | 65 | 서킷브레이커/재시도/SLO.md/런북 존재 | 로컬 기동 실패 시 에러 메시지가 원인을 직관적으로 알려주지 않음 | Medium |
| 모니터링/관측성 | 78 | Prometheus /api/metrics, Analytics Engine, Slack/PagerDuty 워크플로 | canary 기본 off | Low |
| 사용자 경험 | 검증 필요 | SSR 대시보드/i18n/PWA 존재 | 브라우저 실사용 검증 미실시 | Medium |
| 배포/운영 준비도 | 60 | CI 워크플로 다수, 배포 문서 풍부 | README 빠른시작이 현재 아키텍처와 불일치(P1) | High |
| 비용 효율성 | 65 | 무료 API 원칙 고수, CPU 예산 추적(cpu_budget) | 요청당 ~27 subrequest = 무료 플랜 동시 2명 한계 (문서화됨) | Medium |
| **종합** | **≈66/100** | | **베타서비스 수준** (핵심 기능 실작동 + 운영 인프라 상당 부분 구축, 그러나 정밀도·속도·문서 정합성이 상용 기준 미달) | |

**수준 판정: 베타서비스 수준** — 상용까지는 "검색 정확도/속도 목표치 준수 + 문서-코드 정합성 + 부하/장애 실증"이 남음.

## 4. 발견된 문제 (검증된 것만)

| ID | 문제 | 심각도 | 유형 | 근거(재현) | 영향 | 원인 | 수정 방안 | 상태 |
|---|---|---|---|---|---|---|---|---|
| P1-1 | README/PM2 표준 기동으로 `/api/health` 500 | High | 운영/문서화 | `npm run preview` → `Worker "ssak-do-worker" not found` | 신규 개발자 온보딩 실패, 헬스체크 기반 CI/모니터링 오타동 | wrangler.jsonc가 DO를 script_name 참조하는데 로컬 기동 절차가 1-프로세스 | start-local.sh에 DO 워커 자동 기동 추가 (**완료**), README 갱신 필요 | ✅ 부분 수정 |
| P1-2 | `/api/health` `auth_required` 오판 | High | 보안/관측성 | API_KEY_DO 바인딩 존재 + 키 강제 상태에서 `auth_required:false` 보고 | 모니터링이 인증 상태를 오보고 → 보안 알람 누락 | health.ts가 SEARCH_API_KEY만 검사 (auth.ts는 3원 체크) | isAuthRequired() 헬퍼로 3원 반영 (**완료**, auth 테스트 58개 통과) | ✅ 수정 |
| P2-1 | EN technical 쿼리에서 GitHub/HackerNews 결과 소실 | Medium | 검색 품질 | "react hooks guide" → backend `self-index+bing+dbpedia`, 로그 `[TieredFanout] Min results reached` | 기술 질의 gold domain(github.com) 손실 → NDCG 저하 | self-index+bing이 min-results 조기충족 → github 태스크 완료 전 종료 (S75 waitFor와의 상호작용 추가 확인 필요) | 조기종료 판정에서 protected 백엔드 미완료 시 tier 진행 유지 | 🔍 분석중 |
| P2-2 | `max_results` 초과 반환 | Medium | 기능 오류 | `max_results:3` 요청 → total_results 11 반환 | API 계약 위반, 응답 크기 증가 | 페이지네이션(total_results=전체) vs results 배열 크기 구조 확인 필요 | results 배열이 max_results로 잘리는지 확인 후 수정 | 🔍 분석중 |
| P3-1 | 빈 인덱스인데 `self-index` 백엔드 기록 | Low | 데이터/관측성 | total_documents=0 + backend에 self-index 포함 | 메트릭 오해, 빈 결과로 팬아웃 조기판정 왜곡 가능 | hash-fallback 경로가 결과 없이도 백엔드명 기록하는 추정 (가설) | self-index 기록 조건에 result_count>0 추가 | 🔍 분석중 |
| P3-2 | Workers AI 임베딩 실패 (로컬) ×3 | Low | AI/LLM | 로그 `[EmbeddingService] Workers AI failed for pplx-embed-v1-0.6b:` | 로컬 semantic cache/임베딩 기능 저하 (프로덕션 영향 미확인) | 원격 AI 바인딩 + 모델명 불일치 추정 (가설) | 모델 ID 및 바인딩 검증 | 🔍 분석중 |
| P4-1 | README eval 섹션 낡음 가능성 | Low | 문서화 | README NDCG 0.2839(08-09) vs 최근 커밋 "NDCG 게이트 0.60" | 품질 현황 오판 | eval 재실행 안 됨 | `npm run eval -- --cache --json` 재실행으로 갱신 | 📋 대기 |
| P4-2 | 미커밋 WIP 54파일 (+185K/-42K) | Low | 운영 | git status | 롤백/블레임 불가, 충돌 위험 | 진행 중 세션 작업 | 커밋 단위 정리 (본 진단은 WIP 보호 — 수정은 additive만) | 📋 보호중 |

## 5. 아직 확인되지 않은 내용 (검증 필요)

- 프로덕션 배포 상태 (search-engine-api.pages.dev 실측 안 함)
- eval 재실행을 통한 현재 NDCG/MRR/p95 실측
- integration/e2e 테스트 통과 여부 (unit만 실행)
- 브라우저 UX 실사용 검증
- 프롬프트 인젝션 방어(answer 생성 시 웹 콘텐츠 처리) 코드 레벨 검증

---
*다음 문서: 02_SEARCH_QUALITY_ASSESSMENT.md (eval 재실행 후 작성 예정)*
