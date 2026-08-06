# 07. 테스트 및 벤치마크 계획 (TEST AND BENCHMARK PLAN)

> 작성일: 2026-08-05 · 현재 인프라: vitest(unit/integration), eval harness, k6, canary

---

## 1. 현재 테스트 현황
| 계층 | 구성 | 상태 |
|---|---|---|
| 유닛 | 64개 파일 / 1,165건 (이번 세션 +7) | ✅ 통과 |
| 통합 | 7개 파일 (executeSearch, parsers, agentic, orchestrator, api, news-evidence) | ⚠️ 실행 필요 (외부 네트워크 의존) |
| eval | 180 gold 쿼리 (NDCG/MRR/P@10/BLEU/지연/QPS/캐시히트) | ✅ 실행됨 |
| 부하 | k6/load-test.js | ⚠️ 작성됨, 실측 대기 |
| 회귀 | canary (파서 스냅샷, DO) | ✅ 구현, 배포 후 실측 |
| LLM judge | eval/llm-judge.ts (인용 정확도/환각) | ⚠️ API 키 필요 시 제한 |

## 2. 단위 테스트 (보강 계획)
| 영역 | 현재 | 보강 |
|---|---|---|
| 랭킹 | ranking-bm25 25건, authority, diversity | 시나리오별 회귀셋 확장 |
| 질의 이해 | classifier/entity/decomposer 52건 | 오탈자/동의어 (구현 후) |
| 보안 | SSRF/인증/레이트리밋 | **인젝션 방어 테스트 (S3)** |
| 캐시 | cache/semantic-cache | 히트율/만료 경계 |
| 크롤러 | crawler-do/sitemap | robots 위반 시나리오 |

## 3. 통합 테스트
- 외부 백엔드 실연동 (bing/naver/wikipedia) — 스냅샷 기반으로 결정적 유지
- 실행: `npm run test:integration` (네트워크 필요, CI는 integration-tests.yml)
- 파서 변경 시: `tests/integration/parsers.test.ts` + canary 스냅샷 갱신

## 4. 검색 품질 테스트 (eval 확장)
### 4.1 데이터셋 (목표 500쿼리)
| 유형 | 현재 | 목표 | 비고 |
|---|---|---|---|
| 단순 사실 | ✅ | + | factual/en |
| 최신 뉴스 | ✅ | + | kr/en/zh/ja |
| 기술문서 | ✅ | + | tech |
| 학술 | ✅ | + | academic |
| 상품 비교 | ✅ | + | comparison |
| 지역정보 | ⚠️ | + | location 쿼리 |
| 다국어 | ✅ | + | ko/zh/ja/en |
| 모호한 질문 | ⚠️ | + | ambiguous |
| 복합 질문 | ✅ | + | multi-entity |
| 상충 정보 | ⚠️ | + | controversy |
| 출처 부족 | ⚠️ | + | rare terms |
| 악성 프롬프트 페이지 | ⚠️ | + | injection (S3) |
| 장문 조사 | ✅ | + | research |

### 4.2 지표 정의·계산·목표
| 지표 | 정의/계산 | 목표 | 테스트 |
|---|---|---|---|
| Precision@10 | 관련 도메인 비율 (Top10) | ≥0.30 | eval runner |
| Recall@K | 관련 문서 발견 비율 | ≥0.5 | gold 기준 |
| MRR | 첫 관련 결과 역순위 | ≥0.45 | eval runner |
| NDCG@10 | DCG/IDCG (이진 관련성) | ≥0.70 | eval runner |
| 검색 성공률 | minResults 충족 비율 | ≥99% | eval runner |
| 무응답률 | 0건/에러 비율 | <0.5% | eval runner |
| 중복 비율 | 동일 URL/타이틀 비율 | <3% | 전용 스크립트 |
| 출처 다양성 | Top10 고유 도메인 수 | ≥6 | 전용 스크립트 |
| 최신 문서 비율 | 날짜 있음 + 30일 내 | ≥30% | 전용 스크립트 |
| 신뢰 출처 비율 | 권위 맵 포함 비율 | ≥40% | 전용 스크립트 |
| 인용 정확도 | 인용-원문 일치 | >90% | llm-judge |
| 사실 일치율 | 주장-출처 검증 | >85% | llm-judge |
| 답변 완전성 | 요청 포인트 커버 | ≥80% | llm-judge |
| 환각률 | 근거 없는 주장 | <3% | llm-judge |
| 평균 응답 | p50/p95 | <1s/<2.5s | eval + k6 |
| 요청당 비용 | subrequests + AI | <15 | 로그/메트릭 |

### 4.3 평가 실행 정책
- **3회 실행 중앙값** 보고 (백엔드 노이즈 제거) — P1-4 완료 후
- CI 게이트: pass rate ≥95% + NDCG 회귀 −0.05 차단 (eval.yml)
- 주간 cron + 결과 latest.json 저장 + README 자동 갱신

## 5. 부하 테스트 (k6)
- 시나리오: 1) 동시 2/5/10명, 2) 5분 지속, 3) 스파이크
- 지표: p95, 오류율, 서브리퀘스트 초과율
- 목표: 동시 8명, p95 <3s, 오류 0.1% 미만
- 실행: `k6 run k6/load-test.js` (배포 후, prod 대상)

## 6. 장애 테스트 (카오스)
| 시나리오 | 기대 | 검증 |
|---|---|---|
| 백엔드 1개 차단 | 부분 결과 + 회로 open | 단위/통합 |
| 전체 백엔드 차단 | 404 + no_results (중단 없음) | 통합 |
| 캐시 만료 동시 요청 | single-flight 1회 팬아웃 | 단위 |
| DO 미바인딩 | 레이트리밋 약화(경고) + 기능 유지 | 스모크 |
| 마크업 변경 | canary 감지 → 알림 | canary |

## 7. 회귀 테스트
- `npm test` (1,165건) — 모든 수정 후 필수
- `npm run typecheck` — 0 에러 게이트
- `npm run lint:eslint:ci` — 0 경고 게이트 (CI)
- canary 스냅샷 갱신: 파서 구조 변경 시 `tests/unit/snapshots.test.ts` 갱신

## 8. 이번 세션 검증 결과
- 신규 보안 테스트 (레이트리밋 슬롯 2→1) 5건 ✅
- routes 서브리퀘스트 상한 헤더 테스트 2건 ✅
- 전체 유닛 64파일/1,165건 통과 ✅
- typecheck 0 에러 ✅
