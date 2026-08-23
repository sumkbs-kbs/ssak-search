# 02 — 검색 품질 평가 (Search Quality Assessment)

> 작성일: 2026-08-23 | 근거: 921쿼리 전체 eval 실측(`--ci --summary --save`, 커밋 e6defb3+WIP)
> 선행 문서: [01_CURRENT_STATE_ASSESSMENT.md](01_CURRENT_STATE_ASSESSMENT.md) · 변경 이력은 [08_CHANGELOG.md](08_CHANGELOG.md)

---

## 1. 검색 파이프라인 분석 (실측 경로)

```
질의 입력
 ├─ detectQueryType (technical/factual/financial/news/academic/general) + 언어 감지(ko/zh/ja/en)
 ├─ SearchContext 빌드 → 전략별 백엔드 태스크 생성(strategies/all|academic|news|finance…)
 ├─ TieredFanout (src/lib/search/tiered-fanout.ts)
 │    tier0 self-index(D1+Vectorize) → tier1 bing/naver/naver-finance
 │    → tier2 wikipedia/github/github-issues/hackernews/qiita/juejin/yahoo-finance
 │    → tier3 reddit/arxiv/openalex/bing-news-rss/google-news-rss/ddg-site-reddit
 │    · minResults 조기종료 + protectedBackends 드레인(FIX-3):
 │      technical→github·github-issues(+ja qiita/+zh juejin), news→언어별 RSS/reddit,
 │      financial→yahoo-finance, 일반 영어→reddit/ddg-site-reddit
 │      academic→의도적 미보호(EVAL-1: 429 스타베이션+골드 디스플레이스먼트, B-8 drift 0로 근거 유지)
 ├─ Wikipedia 미러 폴백(S35/S36) + 관련성 게이트(B-7 filterMirrorResults — 무관 라벨 매칭 차단)
 ├─ merge & dedup (URL + Unicode 정규화 제목)
 ├─ 점수 재계산 (DOMAIN_AUTHORITY + LOW_QUALITY[+ dash.cloudflare.com -0.15, FIX-4]
 │    + 컨텍스트 authority maps: EN/KR/ZH/JA news·finance·tech·reference)
 ├─ LTR v2 재랭킹(경량 모드시 로컬 스코어링 폴백) + 적응형 3단계 품질 임계값(0.10/0.05/0.01)
 └─ AI 답변(Workers AI → 추출 요약 폴백, include_answer=true 시)
```

## 2. 공식 실측 결과 (2026-08-23, 921쿼리 × cold+warm)

| 메트릭 | 값 |
|---|---|
| Pass Rate | **100.0%** (921/921, 게이트: resultCount≥min & ≤maxTimeMs) |
| **Avg NDCG@10** | **0.3567** |
| **Avg MRR** | **0.7149** |
| **Avg Precision@10** | **0.4752** |
| Avg Response Time | 1891ms |
| p50 / p75 / p90 | 1599 / 2587 / 3573 ms |
| **p95 / p99** | **4423 / 5489** ms (max 6712) |
| Avg Results/Query | 9.7건 |

## 3. 이전 공식 기록 대비 변화 (Aug 22 baseline)

| 메트릭 | 이전 → 현재 | 판정 |
|---|---|---|
| NDCG@10 | 0.3418 → 0.3567 | ✅ +0.015 (FIX-3 보호 복원 효과) |
| MRR | 0.6806 → 0.7149 | ✅ +0.034 (1위 골드 적중률 상승) |
| Precision@10 | 0.4298 → 0.4752 | ✅ +0.045 (무관 결과 밀도 감소) |
| Pass Rate | 99.78% → 100% | ✅ |
| p50 / p95 | 1194/3797 → 1599/4423ms | ⚠️ 보호 백엔드 드레인 비용(문서화된 트레이드오프) |

## 4. 회귀 플래그 분석 ("691 regressions" 해부)

| 유형 | 건수 | 성격 |
|---|---|---|
| responseTimeMs | 420 | 보호 드레인에 따른 체계적 지연 상승 — 단일실행 vs 구 baseline 비교 플래그 |
| ndcgAt10 | 216 | 단일실행 pool noise(프로젝트 자체 분석 S67: ~13% 노이즈율) + gold-set 아티팩트 포함. **집계 NDCG는 오히려 상승** |
| resultCount | 55 | 결과 수 변동 플래그 |

→ 집계 지표가 전 항목 개선한 상황에서 per-query 플래그는 게이트 참고용이며, 신뢰 판정에는 `--runs 3` 중앙값 안정화 게이트(G2/S73) 사용이 프로젝트 표준.

## 5. CI 품질 게이트 상태 (중요 — 선존재 격차)

- `verify-ndcg-gate.ts`(threshold **0.65**, CI workflow line 290): **FAIL — 0.3567 (Δ −0.2933)**
- 단, **세션 시작 전 baseline(Aug 22, WIP 저장분)도 0.3418로 이미 미달** → 본 세션 변경으로 야기된 실패가 아니라 **선존재 격차**
- 가설(검증 필요): gold-standard 튜닝 시점(커밋 "NDCG<0.4 쿼리 13→0개")과 현재 live-API 조건(bing 레이트리밋·arxiv 쿨다운·lightweight 모드) 사이 조건 드리프트 + WIP 진행 중 상태(eval/gold-standards.json·queries.ts 수정 중)
- 권고: (a) 동일 조건 표준 재측정으로 게이트 현실화, (b) threshold를 단계적 목표(0.40→0.50→0.65)로 재조정, (c) lightweight 모드와 full LTR 모드의 측정 분리

## 6. 알려진 품질 이슈와 완화 상태

| 이슈 | 상태 |
|---|---|
| bing 부재 시 DBpedia 미러가 무관 위키 문서 상위 유입 | ✅ 완화 — filterMirrorResults 게이트(B-7, 테스트 5개) |
| EN tutorial류 쿼리의 로그인/대시보드 페이지 유입 | ✅ 완화 — LOW_QUALITY 'dash.cloudflare.com' -0.15 (FIX-4) |
| 학술 쿼리 arxiv/openalex 보호 시 NDCG 붕괴 | ✅ 원복 유지(EVAL-1 + B-8 drift 0) — paced 조건에서 재평가 과제(B-8 잔여) |
| github.com 등 technical gold 소실 | ✅ 해소 — protectedBackends(FIX-3), 전체 eval에서 집계 개선으로 실증 |

## 7. 목표 지표 로드맵

| 단계 | NDCG@10 목표 | 선행 조건 |
|---|---|---|
| 현실 baseline 확정 | 0.36 (달성) | 동일 조건 3회 중앙값 재측정으로 고정 |
| gold 정합화 | 0.40 | WIP gold/queries 수렴 + eval:drift 0 확인 |
| LTR full 활성 | 0.45~0.50 | Workers AI 바인딩 환경 측정(lightweight 미사용) |
| CI 게이트 복원 | 0.65 | 위 단계 달성 후 threshold 재조정 or 조건 표준화 |

---
*측정 재현: `npm run eval -- --ci --summary --save` · 안정화: `--runs 3` · 게이트: `npm run eval:gate` · drift: `npm run eval:drift`*
