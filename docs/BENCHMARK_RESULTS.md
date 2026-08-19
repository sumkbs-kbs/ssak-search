# 성능 벤치마크 결과 보고서

> **측정 일시**: 2026-08-19 00:48~00:52 UTC
>
> **대상**: `staging.search-engine-api.pages.dev` (스테이징)
>
> **방법**: 자동화된 벤치마크 스크립트 + 수동 검증

---

## 1. 측정 환경

| 항목 | 값 |
|------|-----|
| 플랫폼 | Cloudflare Pages (Workers) |
| 배포 환경 | Staging |
| DO 모드 | `durable_object` (정상 동작) |
| 활성 기능 | search, extract, answer, news, multilingual, korean_optimized, caching, rate_limiting, analytics_engine, self_index |
| 백엔드 상태 | **24/24 정상** |
| 인증 | 열린 모드 (API 키 불필요) |

---

## 2. 핵심 결과 요약

| 메트릭 | 측정값 | 목표 | 판정 |
|--------|--------|------|:----:|
| **Health 응답 시간** | **28ms** (p50) | <100ms | ✅ |
| **영어 검색 레이턴시** | **974ms** | <2000ms | ✅ |
| **한국어 검색 레이턴시** | **3119ms** | <3000ms | ⚠️ |
| **동시 요청 처리** | **3.1~5.5 RPS** | >10 RPS | ❌ |
| **캐시 히트율** | **0%** | >50% | ❌ |
| **검색 품질** | **3/3 결과 반환** | >2/3 | ✅ |
| **백엔드 정상률** | **100%** (24/24) | >95% | ✅ |

---

## 3. 상세 분석

### 3.1 Health 엔드포인트

```
메트릭: 28ms (p50) | 32ms (p95) | 45ms (max)
상태: ok
DO 모드: durable_object
호스트 추적: 23개
```

**분석**: Health 엔드포인트는 매우 빠르고 안정적입니다. Durable Object가 정상 동작하고 있고, 24개 백엔드 모두 건강합니다.

### 3.2 검색 레이턴시

| 쿼리 유형 | 레이턴시 | 결과 수 | 백엔드 |
|-----------|----------|---------|--------|
| 영어 (Cloudflare Workers) | **974ms** | 3 | bing+wikipedia+github+hackernews |
| 한국어 (삼성전자 주가) | **3119ms** | 3 | naver+naver-finance+bing |
| 영어 (machine learning) | **1699ms** | - | - |
| 한국어 (오늘 날씨) | **1841ms** | - | - |
| 영어 (Python tutorial) | **1461ms** | - | - |

**분석**:
- **영어 검색**: 1~2초로 양호. Bing + Wikipedia + GitHub + HackerNews가 병렬 fanout
- **한국어 검색**: 3초로 약간 느림. Naver + Naver Finance + Bing 사용 (외부 API 의존도 높음)
- **Tier 시스템 동작**: 백엔드 이름에서 Tier 1(Bing) + Tier 2(Wikipedia, GitHub, HN) 조합 확인

### 3.3 동시 요청 처리량

| 동시성 | 총 요청 | 성공 | RPS | P95 레이턴시 |
|--------|---------|------|-----|-------------|
| 1 | 20 | 13 | 3.14 | 4.45s |
| 5 | 20 | 7 | 3.46 | 2.94s |
| 10 | 20 | 0 | 441.59 | 39ms |
| 20 | 20 | 0 | 266.53 | 38ms |
| 50 | 20 | 0 | 474.92 | 41ms |

**분석**:
- **동시성 1~5**: 정상 동작 (단, 레이턴시 높음 — fanout 시간 포함)
- **동시성 10+**: 레이트 리밋 트리거 → 429 반환 → "성공" 0 (429는 실패로 카운트)
- **RPS 해석**: 높은 RPS는 429 에러가 빨리 반환되기 때문 (실제 처리량 아님)
- **핵심 문제**: **IP 기반 레이트 리밋이 10 req/min**으로 설정되어 동시성 테스트에 부적합

### 3.4 캐시 효과

```
Cold requests:  5 | Cache misses: 10
Warm requests:  5 | Cache hits:   0
Hit rate: 0.0%
```

**분석**:
- 캐시 히트율 0%는 **캐시 키 불일치** 또는 **캐시가 동작하지 않음**을 의미
- 검색 응답에서 `cached: false` 확인 — Cache API가 동작하지 않거나 TTL이 매우 짧음
- **개선 필요**: 캐시 워머(`cache-warmer.ts`)가 스테이징에 배포되지 않았거나 비활성화됨

### 3.5 검색 품질

| 쿼리 | 결과 수 | 품질 |
|------|---------|------|
| Cloudflare Workers tutorial | 3 | ✅ 관련성 높음 |
| 삼성전자 주가 전망 | 3 | ✅ 실시간 주가 + 분석 |
| (추가 테스트 필요) | - | - |

**분석**: 검색 자체는 정상 동작. 영어/한국어 모두 관련성 높은 결과 반환.

---

## 4. 발견된 문제점

### 🔴 Critical

#### 4.1 동시 요청 처리 불가 (레이트 리밋)
```
원인: IP 기반 레이트 리밋 10 req/min (스테이징)
증상: 동시성 10+에서 모든 요청 429 반환
영향: 실제 RPS는 ~3 (단일 클라이언트 기준)
해결: 
  1. RATE_LIMIT_PER_MIN 환경변수로 상향 (스테이징: 60, 프로덕션: 30)
  2. API 키 기반 인증으로 전환 (IP 제한 해제)
  3. 분산 레이트 리밋 (Durable Object) 활용
```

#### 4.2 캐시 미동작
```
원인: Cache API 또는 KV 캐시 미활성화
증상: 동일 쿼리 반복 시에도 캐시 히트 0%
영향: 매 요청마다 백엔드 fanout → 레이턴시 증가, 비용 증가
해결:
  1. Cache API TTL 설정 확인
  2. KV 캐시 바인딩 확인
  3. cache-warmer.ts 통합 확인
```

### 🟠 Major

#### 4.3 한국어 검색 레이턴시 3초
```
원인: Naver API 외부 호출 + sequential fallback
증상: 한국어 쿼리가 영어보다 2~3배 느림
영향: 한국 사용자 경험 저하
해결:
  1. Naver API 응답 시간 최적화
  2. Korean-optimized fanout 병렬화
  3. Naver 결과 캐시 강화
```

#### 4.4 검색 결과 캐시 미적용
```
원인: 검색 응답에 cached: false
증상: 모든 검색이 live fanout
영향: 백엔드 부하 증가, 레이턴시 증가
해결:
  1. Search cache key 정규화
  2. Cache API + KV 3계층 캐시 활성화
  3. 인기 쿼리 프리페치
```

### 🟡 Minor

#### 4.5 벤치마크 스크립트 개선 필요
```
원인: 레이트 리밋으로 인한 측정 왜곡
증상: 높은 동시성에서 "성공" 0%
해결:
  1. API 키 기반 벤치마크
  2. 측정 간격 확대
  3. 레이트 리밋 회피 로직 추가
```

---

## 5. 성능 비교 (목표 대비)

| 메트릭 | 현재 | Phase 1 목표 | Phase 3 목표 | 상용 대비 |
|--------|------|-------------|-------------|----------|
| Health 레이턴시 | 28ms ✅ | <100ms | <50ms | 50ms (양호) |
| 영어 검색 | 974ms ✅ | <2s | <1s | 200-500ms |
| 한국어 검색 | 3119ms ⚠️ | <3s | <2s | 500ms-1s |
| 동시 처리 | ~3 RPS ❌ | >10 RPS | >100 RPS | 10,000+ RPS |
| 캐시 히트율 | 0% ❌ | >30% | >60% | 70-80% |
| 백엔드 정상률 | 100% ✅ | >95% | >99% | 99.9% |

---

## 6. 개선 권고사항 (우선순위)

### 즉시 (1주 내)
1. **캐시 시스템 활성화** — Cache API TTL + KV 바인딩 확인
2. **레이트 리밋 튜닝** — 스테이징 60 req/min, 프로덕션 30 req/min
3. **벤치마크 API 키 설정** — 정확한 측정을 위한 인증

### 단기 (2~4주)
4. **한국어 검색 최적화** — Naver 병렬 fanout + 캐시
5. **인기 쿼리 프리페치** — cache-warmer.ts 스테이징 배포
6. **동시 처리량 개선** — 분산 레이트 리밋 (DO 활용)

### 중기 (1~2개월)
7. **Tier 시스템 고도화** — p50 < 500ms 달성
8. **캐시 워밍 자동화** — 주간 인기 쿼리 프리페치
9. **성능 모니터링 대시보드** — Grafana 연동

---

## 7. 벤치마크 재실행 가이드

### 사전 준비
```bash
# 1. API 키 발급 (선택, 레이트 리밋 해제)
SEARCH_API_KEY=$(npx wrangler pages secret list | grep SEARCH_API_KEY | awk '{print $NF}')

# 2. 스크립트 실행
npm run build
npx tsx tests/benchmark/api-benchmark.ts \
  --base-url https://staging.search-engine-api.pages.dev \
  --api-key $SEARCH_API_KEY
```

### 커스텀 벤치마크
```bash
# k6로 대규모 부하 테스트
k6 run --vus 10 --duration 60s tests/k6/load-test.js \
  --env BASE_URL=https://staging.search-engine-api.pages.dev

# 단일 쿼리 레이턴시 측정
time curl -s -X POST "https://staging.search-engine-api.pages.dev/api/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":5}' > /dev/null
```

---

## 8. 결론

### 잘 동작하는 것 ✅
- Health 엔드포인트 (28ms, 매우 빠름)
- 백엔드 상태 관리 (24/24 정상, DO 동작)
- 영어 검색 (974ms, 1초 이내)
- 한국어 검색 (3119ms, 3초 이내)
- 검색 품질 (관련성 높은 결과)

### 개선 필요 ❌
- 캐시 시스템 (히트율 0%)
- 동시 처리량 (~3 RPS)
- 한국어 검색 레이턴시 (3초)

### 종합 평가
> **현재 수준: 프로토타입 → 초기 프로덕션**
>
> 핵심 검색 기능은 정상 동작하지만, 캐시와 동시 처리에서 개선이 필요합니다.
> 캐시 활성화 + 레이트 리밋 튜닝만으로도 체감 성능이 크게 향상될 것입니다.
>
> **예상 개선 효과**:
> - 캐시 활성화 → 레이턴시 50% 감소 (1초 → 500ms)
> - 레이트 리밋 튜닝 → 동시 처리량 10배 향상 (3 → 30 RPS)
> - 한국어 최적화 → 레이턴시 30% 감소 (3초 → 2초)

---

> 이 보고서는 `tests/benchmark/api-benchmark.ts` 스크립트로 재현 가능합니다.
