# 08 — 변경 이력 (Changelog)

> 모든 항목은 실제 실행 검증을 거친 변경만 기록.

---

## [2026-08-23] Phase 0 진단 및 P1/P2 수정

### FIX-1: `/api/health` auth_required 오판 수정 ✅
- **심각도**: High (보안/관측성)
- **수정 파일**: `src/routes/health.ts`
- **문제**: `auth_required: !!env.SEARCH_API_KEY` — API_KEY_DO 바인딩이 기본 활성화된 현재 아키텍처에서 인증이 강제되는데도 `false` 보고. 모니터링이 인증 상태를 오보고.
- **재현**: `wrangler.jsonc`에 API_KEY_DO 바인딩 + SEARCH_API_KEY 미설정 → health는 `auth_required:false`, /api/search는 401. 모순.
- **수정**: `isAuthRequired(env)` 헬퍼 추가 — auth.ts `validateApiKeyAsync`의 3원 조건(SEARCH_API_KEY ‖ TENANTS_CONFIG ‖ API_KEY_DO)과 동기화. 두 응답 경로(light/full) 모두 적용.
- **검증**: 서버 재시작 후 `auth_required: true` 확인. 무키 요청 401 유지. auth 단위 테스트 58개 통과.

### FIX-2: 로컬 표준 기동 시 DO 워커 미기동으로 전 API 500 ✅
- **심각도**: High (운영)
- **수정 파일**: `scripts/start-local.sh`
- **문제**: README/PM2 표준 기동(`wrangler pages dev dist`)은 `ssak-do-worker`가 dev registry에 없어 `Worker "ssak-do-worker" not found` → `/api/health` 500. wrangler Pages 모드는 `-c` 커스텀 설정 불가로 우회도 없음.
- **재현**: `npm run preview` → `curl localhost:8788/api/health` → 500.
- **수정**: start-local.sh에 Step 4.5 추가 — 8787 포트 점검 후 `wrangler dev -c wrangler.do.jsonc` 자동 기동(최대 20초 대기), cleanup에 DO 워커 종료 추가.
- **검증**: 스크립트 bash -n 통과. DO 워커 병행 기동 시 health 200 확인.

### FIX-3: TieredFanout 조기종료가 gold-domain 백엔드(github 등)를 드랍하는 회귀 복원 ✅
- **심각도**: High (검색 품질) — 기술/학술/뉴스/일반 영어 쿼리 전반
- **수정 파일**: `src/lib/search/tiered-fanout.ts`, `src/lib/orchestrator.ts`, `src/lib/search/backend-tiers.ts`
- **문제(근본 원인)**:
  1. orchestrator.ts 562–601행의 대규모 주석이 S75/P24/S16 waitFor 보호를 문서화하지만, 해당 구현은 **호출자가 0개인 레거시 fanout.ts에만 존재**(데드 코드). 실제 실행 경로인 TieredFanout은 minResults 충족 시 즉시 break하여 tier2(github/hackernews/wikipedia)/tier3(reddit/arxiv) 태스크가 아예 실행되지 않음.
  2. BACKEND_TIERS에 매핑 없는 태스크명(github-issues, qiita, openalex, ddg-site-reddit, yahoo-finance)은 getTier() null로 무조건 실행 누락.
- **교차 검증**: 라이브 로그 `[TieredFanout] Min results reached` + `[Orchestrator] Wikipedia mirror fallback recovered wikipedia gold (wikipedia backend missing)` — 위키는 미러로 만회되지만 github/hn/reddit/arxiv는 소실.
- **수정**:
  - TieredFanoutOptions에 `protectedBackends` 추가 — minResults 충족 후에도 보호 백엔드는 실행(draining), 나머지는 기존대로 생략. 보호 대상 없으면 완전 no-op.
  - orchestrator가 queryType별 보호 목록 도출(technical→github/github-issues(+ja qiita/+zh juejin), academic→arxiv/openalex, news→언어별 RSS/naver-news/reddit, financial→yahoo-finance, 일반 영어→reddit/ddg-site-reddit).
  - backend-tiers에 누락 매핑 추가(tier2: github-issues/qiita/yahoo-finance, tier3: openalex/ddg-site-reddit).
- **테스트**: 신규 `tests/unit/tiered-fanout-protected.test.ts` 4개 (조기종료 유지/보호 실행/no-op/보호 실패 시 부분 결과 반환). **전체 3,063/3,063 통과.**
- **실측 개선** ("react hooks guide", 로컬):
  - 수정 전: backend `self-index+bing+dbpedia`, 상위 도메인 dash.cloudflare.com/namu.wiki/cloudflare.com(무관), 4.0s
  - 수정 후: backend `self-index+bing+github+dbpedia`, 상위 도메인 **github.com×2/react.dev×3**(정확), 3.8s
- **남은 위험**: wikipedia는 tier2에서 여전히 minResults 조기종료 대상(S35 DBpedia/Wikidata 미러가 만회 — 현 구조 유지). 일반 영어 쿼리 reddit 보호로 최대 ~2s 추가 가능 — eval로 NDCG↔p95 트레이드오프 재측정 권장.

### VERIFIED-NOT-A-BUG: max_results 초과 반환 의혹 ✅
- `max_results=3` 요청 시 `results` 배열은 정확히 3개, `total_results:10`은 페이지네이션 메타데이터(README 문서화된 계약). 버그 아님.

### 기타 조치
- `.dev.vars`(gitignore됨)에 로컬 검증용 `AUTH_OPEN_MODE=1`, `SEARCH_API_KEY=local-dev-key` 추가 — 커밋 대상 아님.
- 평가 문서 작성 시작: `docs/assessment/01_CURRENT_STATE_ASSESSMENT.md`

## [2026-08-23 후속] B-1/B-2/B-3 처리 결과

### FIX-4: dash.cloudflare.com(로그인 페이지) 랭킹 강등 ✅
- **심각도**: Medium (검색 품질)
- **수정 파일**: `src/lib/search/ranking.ts`
- **문제**: EN tutorial 쿼리("cloudflare workers tutorial")에서 dash.cloudflare.com(로그인 페이지)이 스코어 0.41로 상위 유입 — TECH_DOCS_AUTHORITY의 `'cloudflare.com': +0.1`을 서브도메인 접미사 매칭으로 상속.
- **수정**: LOW_QUALITY_DOMAINS에 `'dash.cloudflare.com': -0.15` 추가(가장 긴 키 우선으로 승자). developers.cloudflare.com(문서 gold)·cloudflare.com(루트)은 보너스 유지.
- **검증**: typecheck 0에러, 랭킹 테스트 78개 통과, 재프로브에서 대시보드 도메인 소실 확인.

### EVAL-1: academic 태그 3회 실행 안정화 평가 → 학술 보호 원복 ✅
- **실행**: `npx tsx eval/index.ts --tag academic --runs 3 --summary`
- **결과**: Pass Rate 100%, p50 2429ms / p95 5106ms, Avg NDCG@10 0.2986, MRR 0.5451, P@10 0.30
- **안정화 회귀**: 지연 ~17건(보호 드레인 비용), **NDCG 붕괴 3건** en-acad-12/23/24 (0.34~0.61 → 0.000)
- **판정 근거**: (1) NDCG 붕괴 4건 = flagged-by-429 4건 정확히 일치 — arxiv 호출 압력 증가가 429 스타베이션 유발, (2) 골드는 bing 경유로 충족 가능(보호 없이 baseline 0.61 달성 경로), (3) openalex 보호는 문서화된 근거 없는 확장이었음 — 철회.
- **조치**: orchestrator.ts academic 케이스 UNPROTECTED 원복 + 재검토 조건 주석화. 기술/뉴스/일부 일반 영어/금융 보호는 유지.
- **원복 후 실측**: en-acad-24 — `self-index+bing+dbpedia`, github 골드 유지. 기술 — `self-index+bing+github`, github.com/react.dev 상위 유지.

### FINDING-1: DBpedia 미러 폴백의 무관 결과 오염 📋
- bing 부재 시 풀이 얇아지면 S35 DBpedia Lookup이 쿼리 무관 위키 문서(축구클럽 등)를 0.30+로 상위 채움.
- **권고**: 쿼리 토큰-타이틀 겹침 최소 게이트. S35 gold-복구 목적과의 상호작용 검증 선행 필요로 이번 세션은 문서화만.

## 미해결 (갱신)

| ID | 항목 | 우선순위 |
|---|---|---|
| B-4 | Workers AI 임베딩 실패 — **환경 의존으로 확정, 코드 이슈 아님**: `pplx-embed-*`는 커스텀 배포 모델(index/types.ts 레지스트리), 로컬 바인딩 대상 계정에 미배포 → warn 후 폴백(우아한 강등). 기본 ID 변경은 프로덕션 임베딩 공간 혼합 위험이 있어 유지 | ~~Low~~ 해소 |
| B-5 | self-index 표기 — **버그 아님으로 확정**: health light-mode의 total_documents=0은 하드코딩 플레이스홀더(subrequest 보호), 실제 검색은 remote D1 조회. 두 보고 소스의 의미 차이였음. fallback.ts 기록은 results>0 가드 정상 | ~~Low~~ 해소 |
| B-6 | integration/e2e 테스트 실행 확인 | Medium |
| B-7 | FINDING-1: DBpedia 미러 결과 관련성 게이트 | Medium |
| B-8 | arxiv 보호 재평가 — gold drift 점검(`npm run eval:drift`) 후 paced 학술 eval | Medium |
| B-9 | 전체 태그 eval 재실행 — **완료**, 결과는 아래 완료 테이블 참조(공식 기록·README 갱신 포함) | ~~High~~ 해소 |

### 완료 (이전 미해결에서 해소)

| ID | 항목 | 결과 |
|---|---|---|
| B-1 | README 빠른시작 DO 워커 반영 | ✅ start-local 권장 + 2-프로세스 사유 설명 추가 |
| B-2 | eval 재실행 및 보호 정책 검증 | ✅ EVAL-1 — 학술 원복, 나머지 유지 판정 |
| B-3 | 네비게이션/로그인 페이지 필터 | ✅ FIX-4 |
| B-6 | integration/e2e 테스트 실행 확인 | ✅ integration 134개 + e2e 6개 전부 통과 |
| B-8 | gold drift 점검 | ✅ Drift 0 — gold 불변 확인, EVAL-1 학술 원복 근거 유지됨 |
| B-7 | DBpedia 미러 관련성 게이트 | ✅ util.ts filterMirrorResults(토큰/CJK 바이그램 겹침) + orchestrator 소비 지점 적용, 테스트 5개 신규 통과 — bing 부재 시 무관 위키 문서 상위 유입 차단, S35 gold 복구 경로는 패스스루 보존 |
| B-9 | 전체 태그 eval 재실행(921쿼리) + README 공식 섹션 갱신 | ✅ Pass Rate 100%, NDCG@10 **0.3418→0.3567**, MRR **0.6806→0.7149**, P@10 **0.4298→0.4752** — FIX-3/4 효과 집계 실증. 지연 p50 1194→1599ms/p95 3797→4423ms는 보호 드레인의 문서화된 트레이드오프. 회귀 691건 = latency 420 + 단일실행 ndcg 노이즈 216 + resultCount 55(S67 분석상 다수가 폴-noise), 집계 지표는 전 항목 개선. update-readme-eval.ts로 README 반영 완료 |
| BL-3 | p95 vs SLO 대조 | ✅ 통과 — 실측 p50/p95/p99 1599/4423/5489ms = SLO 예산(p50<3s/p95<8s/p99<15s)의 53%/55%/37% 사용. 출시 차단에서 해제, 게이지 알림 유지 |
| O-3(일부) | 프롬프트 인젝션 방어 현황 확인 | ✅ 전담 모듈 prompt-guard.ts(274줄) 존재 — 증거 살균·탐지·고위험 격리+감사(answer.ts 연동). 심층 패턴 감사만 잔여 |

## [2026-08-23 심야] BL-1 옵션2 실험 및 학술 회귀 정황 발견

### 실험 무효 확인 (플래그 미전달)
- FREE_PLAN_CPU_GUARD=0 셸 변수가 하네스 config.env에 전달되지 않아 양팔 모두 경량 모드로 실행 → NDCG 소수점까지 동일(0.1262)한 결정론 확인만 됨. 옵션 2 실험은 runner.ts buildConfig의 env 전달 확장 후 재실행 필요.

### ⚠️ 신규 정황: 학술 단일실행 NDCG 급락 (원인 조사 중)
- 동일 코드 시점 단일실행 0.1262 vs EVAL-1 중앙값 0.2986 (~9시간 전). 혼재 변수: 단일 vs 중앙값 집계, live-API 상태(bing/arxiv/wiki 스로틀), 그리고 **본 세션 추가분인 B-7 미러 게이트**(학술 12회 복구 중 8회에서 최대 4건씩 드랍 관측).
- **조치**: 원인 규명 전 즉시 롤백 가능하도록 `MIRROR_RELEVANCE_GATE=0` 필드 롤백 스위치 추가(orchestrator.ts + types.ts, 기본값=게이트 ON 유지). typecheck 통과, 게이트 테스트 5개 회귀 없음.
- **후속**: (a) 게이트 OFF 상태 동일 태그 재실행으로 인과 분리, (b) 원인 확정 시 게이트 매칭 완화 또는 academic 컨텍스트 예외 설계, (c) 무관할 경우 live-API 상태 요인으로 문서 종결.

### 인과 분리 결과 (2026-08-23 심야): B-7 게이트 주요 원인 아님 ✅
- 동일 태그 게이트 토글 실험: ON 0.1262/MRR 0.2971 vs OFF 0.1405/0.3294 — 게이트 비용은 ΔNDCG +0.014 수준(FINDING-1 오염 차단의 문서화된 대가로 유지).
- 게이트 OFF에도 EVAL-1 중앙값(0.2986/0.5451) 대비 -0.16/-0.22 격차 잔존 → 붕괴 주원인은 외부 요인(live-API 스로틀 상태, 단일 vs 중앙값 집계 차이)으로 판정.
- 조치: 게이트 기본 ON 유지 확정, 롤백 스위치(MIRROR_RELEVANCE_GATE)는 운영 도구로 보존. 소스 복원 확인(typecheck OK).
- 잔여: 시간대별 학술 태그 재측정으로 API 상태 요인 정량화 과제.

### 결정적 재판정 (2026-08-23 심야): 학술 보호 영구 복원 ✅ (이전 원복 번복)
- 페어드 실험(같은 시간대, 케이스만 토글): ON → NDCG@10 **0.4980 / MRR 1.0000** vs OFF → 0.1405/0.3294. arxiv+openalex가 현재 학술 골드의 1위 공급자.
- 이전 "원복" 판정(EVAL-1 baseline delta 근거)은 교란된 비교였음을 인정·정정. 스로틀 카운트 가설도 반박됨(정규화 시 감소).
- 교훈 기록: 보호 정책 변경은 저장 baseline 단독 비교 금지, 반드시 같은 창의 페어드 토글로 판정.

### BL-2 해소 (2026-08-23 심야): WIP 전량 커밋 정리 ✅
- 15개 논리 커밋으로 분할 커밋 완료(git-master 스킬 프로세스 적용, SEMANTIC+한국어 스타일):
  검증 수정 6건(fix*/feat*)·페어드 신규 테스트 2건·평가 아티팩트 갱신·분석 도구 6종·선존재 WIP 통합 2건·CI·config·문서.
- 시크릿 스캔 클린(.dev.vars gitignored 확인), 커밋 전 typecheck/tests 그린 상태 그대로 스냅샷.
- 세션 중 동시 외부 커밋 2건 관측(hono CVE bump, /api/council 키 필수화) — package.json은 해당 커밋에 흡수됨.
- 최종: `git status --porcelain` = 0 (클린). main 로컬 브랜치, upstream 없음(푸시 불필요).
