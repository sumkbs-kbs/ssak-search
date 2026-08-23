# 07 — 테스트·벤치마크 계획 (Test & Benchmark Plan)

> 작성일: 2026-08-23 | 현재 운영 중인 테스트 자산의 전수 확인 결과와 보강 계획.

## 1. 현재 테스트 자산 (전부 실측 통과 — 2026-08-23)

| 레이어 | 규모 | 명령 | 소요 |
|---|---|---|---|
| Unit | **3,063 tests / 153 files** | `npm test` | ~49s |
| Integration | **134 tests / 10 files** | `npm run test:integration` | 12s |
| E2E | **6 tests / 1 file** | `npm run test:e2e` | 2s |
| Type gate | strict 0에러 | `npm run typecheck` | — |
| Lint | eslint max-warnings=0 | `npm run lint:eslint` | CI |

## 2. 검색 품질 벤치마크 (eval 하네스)

- **데이터셋**: 921 쿼리(eval/queries.ts) × gold standards(relevantDomains) — 태그: en 389/tech 243/general 240/news 184/ja 181/ko 179/zh 172/factual 160/financial 69/comparison 48/academic 34
- **지표**: Pass Rate(resultCount·latency 게이트), NDCG@10, MRR, Precision@10, p50~p99, Cache Hit Rate, QPS
- **명령**:
  - 전체 공식: `npm run eval -- --ci --summary --save`
  - 안정화 판정: `--runs 3`(중앙값 + G2/S73 동의 게이트)
  - 태그 부분: `--tag academic` 등 · 게이트: `npm run eval:gate` · drift: `npm run eval:drift`

### 최신 공식 기록 (2026-08-23)
Pass Rate 100% · NDCG@10 0.3567 · MRR 0.7149 · P@10 0.4752 · p95 4423ms — 상세는 [02 문서](02_SEARCH_QUALITY_ASSESSMENT.md)

## 3. 회귀 방지 규칙

- 랭킹 변경 시: `tests/unit/ranking-*` + `tiered-fanout-protected` + `mirror-relevance` 실행 후 전체 unit
- 품질 변경 시: 태그 eval → 전체 eval 순. 단일실행 플래그는 노이즈 존재(S67 ~13%) — 중앙값으로만 판정
- baseline 갱신은 개선 확인 후 `--save`(CI와 동일 순서: eval → gate → update-readme-eval)

## 4. 보강 계획 (미실시 → 예정)

| 항목 | 도구/방법 | 우선순위 |
|---|---|---|
| 부하 테스트 | k6/wrk로 /api/search p95·subrequest 소수 측정(무료플랜 한계 검증) | Medium |
| 장시간 안정성 | 24h 카나리+monitor 워크플로 실가동, 메모리/브레이커 누적 관찰 | Medium |
| 의존성 CVE 게이트 | npm audit CI 스텝 | Medium |
| UX 회귀 | Playwright 대시보드 시나리오(검색→결과→답변) | Medium |
| 카나리 기본 활성 | HEALTH_CANARY_ENABLED=true + 알림 연동 | Low |
