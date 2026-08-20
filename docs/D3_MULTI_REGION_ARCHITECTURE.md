# D.3 Multi-Region Active-Active 아키텍처 설계 검토

> **작성일**: 2026-08-20 · **목표**: 99.9% SLA, 리전 장애 자동 페일오버 < 30초
> **상태**: 설계 검토 완료, 인프라 작업 대기

---

## 1. 현재 아키텍처 분석

### 1.1 단일 리전 구성

```
┌─────────────────────────────────────────────────────────────┐
│                  Cloudflare Account A (현재)                  │
│                                                              │
│  ┌──────────────────┐  ┌──────────────────┐                 │
│  │  Pages Project    │  │  DO Worker        │                 │
│  │  search-engine-   │  │  ssak-do-worker   │                 │
│  │  api              │  │  (11 DO classes)   │                 │
│  └──────────────────┘  └──────────────────┘                 │
│           │                     │                            │
│  ┌──────────────────────────────────────────┐               │
│  │            바인딩 (단일 리전)               │               │
│  ├──────────────────────────────────────────┤               │
│  │ D1: search-engine-index      (단일 DB)    │               │
│  │ Vectorize: search-engine-dense (단일 인덱스)│              │
│  │ Vectorize: semantic-cache-dense           │               │
│  │ KV: CACHE_KV                             │               │
│  │ Analytics: ssak_search                    │               │
│  │ R2: search-engine-uploads                │               │
│  │ Queue: search-index-queue                │               │
│  │ Workers AI: AI (무료 tier)               │               │
│  └──────────────────────────────────────────┘               │
└─────────────────────────────────────────────────────────────┘
```

### 1.2 현재 제약사항

| 항목 | 현재 상태 | 영향 |
|------|----------|------|
| **D1** | 단일 데이터베이스, 단일 리전 | 리전 장애 시 읽기 불가 (색인 데이터 상실) |
| **Vectorize** | 단일 인덱스 | 리전 장애 시 로컬 검색 불가 |
| **KV** | 단일 네임스페이스 | CF 글로벌이지만 리전 장애 시 캐시 소실 |
| **DO** | 단일 DO 워커 (`ssak-do-worker`) | 리전 장애 시 rate limiter/crawler 등 전부 중단 |
| **Pages** | 단일 프로젝트 | 리전 장애 시 전면 다운 (99.9% SLA 미달) |

---

## 2. 목표 아키텍처 (Active-Active)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        Cloudflare Load Balancer                         │
│                    (Geo-steering: US ↔ APAC)                           │
└──────────┬──────────────────────────────────────────────┬──────────────┘
           │                                              │
           ▼                                              ▼
┌──────────────────────────┐              ┌──────────────────────────┐
│  Account A (US/East)     │              │  Account B (APAC/Tokyo)  │
│                          │              │                          │
│  Pages: search-engine-   │   ←─── D1 ──→│  Pages: search-engine-   │
│  api                     │   Read       │  api                     │
│                          │   Replica    │                          │
│  DO: ssak-do-worker      │              │  DO: ssak-do-worker      │
│                          │              │                          │
│  D1: search-engine-index │   ←─── D1 ──→│  D1: search-engine-index │
│      (PRIMARY)           │   Replication│      (REPLICA)           │
│                          │              │                          │
│  Vectorize:              │   ←─── Sync ─→│  Vectorize:              │
│  search-engine-dense     │              │  search-engine-dense     │
│                          │              │                          │
│  KV: CACHE_KV            │   ←─── Global ─→│ KV: CACHE_KV           │
│  (CF 글로벌 동기화)       │              │  (CF 글로벌 동기화)       │
│                          │              │                          │
│  Analytics: ssak_search  │              │  Analytics: ssak_search  │
│  R2: uploads             │              │  R2: uploads             │
└──────────────────────────┘              └──────────────────────────┘
```

### 2.1 핵심 원칙

1. **Active-Active**: 양 리전이 동시에 트래픽을 처리. 핫스탠바이 아님.
2. **Geo-steering**: 사용자 위치 기반으로 가장 가까운 리전으로 라우팅
3. **D1 Read Replica**: 쓰기는 Primary(US)에서만, 읽기는 양 리전에서
4. **Vectorize 자동 복제**: Cloudflare가 인덱스를 자동으로 복제 (설정 불필요)
5. **KV 글로벌**: Cloudflare KV는 이미 글로벌 동기화 — 리전 장애 시 자동 페일오버

---

## 3. 컴포넌트별 리전 전략

### 3.1 D1 (읽기 복제)

| 항목 | 값 |
|------|-----|
| **모드** | Primary-Replica (쓰기는 US에서만) |
| **복제** | Cloudflare 자동 복제 (비동기, 지연 < 1초) |
| **영향 받는 기능** | 인덱스 DB, API Key DO, Click Log DO |
| **장애 시** | APAC에서 읽기는 가능, 쓰기는 US로 폴백 |

```sql
-- D1은 Cloudflare가 자동으로 복제하므로 별도 설정 불필요
-- Primary: Account A (US) → search-engine-index
-- Replica: Account B (APAC) → search-engine-index (자동 복제)
```

### 3.2 Vectorize

| 항목 | 값 |
|------|-----|
| **모드** | Cloudflare 자동 복제 |
| **복제** | 인덱스 생성 시 자동으로 모든 리전에 배포 |
| **영향 받는 기능** | 하이브리드 검색 (BM25 + Vector RRF), 의미 캐시 |
| **장애 시** | Vectorize 미사용 시 로컬 검색만 비활성화 |

### 3.3 KV (CACHE_KV)

| 항목 | 값 |
|------|-----|
| **모드** | 글로벌 동기화 (Cloudflare 기본) |
| **복제** | 즉시 (글로벌 분산 저장소) |
| **영향 받는 기능** | Tier-2 캐시, rate limiter 상태 |
| **장애 시** | 캐시 miss → 소스로 폴백 (기능 유지) |

### 3.4 Durable Objects

| DO 클래스 | 리전 전략 | 장애 시 |
|-----------|----------|--------|
| RateLimiterDO | 리전 로컬 (글로벌 키 공유 안 됨) | 리전별 독립 rate limit |
| CrawlerDO | 리전 로컬 | 크롤링 중단, 재시도 |
| ClickLogDO | 리전 로컬 → 주기적 병합 | LTR 학습 데이터 일시적 분리 |
| ExperimentDO | 리전 로컬 | A/B 테스트 상태 분리 |
| ApiKeyDO | D1 기반 → D1 복제 활용 | API 인증 실패 가능 |
| CanaryOrchestratorDO | 리전 로컬 | 캐나리 모니터링 중단 |

### 3.5 Analytics Engine

| 항목 | 값 |
|------|-----|
| **모드** | 리전별 독립 |
| **병합** | 수동 쿼리 시 UNION ALL |
| **영향** | 메트릭 분산 (카운트는 리전별 합산 필요) |

---

## 4. 페일오버 동작

### 4.1 장애 감지

```
1. CF Load Balancer: HTTP 헬스 체크 (/api/health) 5초 간격
2. 헬스 체크 실패 3회 연속 → 리전 장애 판정
3. 자동으로 트래픽을 건강한 리전으로 전환
4. 장애 복구 시 자동으로 트래픽 재분배
```

### 4.2 장애 시나리오

| 시나리오 | 영향 | 복구 시간 |
|----------|------|----------|
| US 리전 장애 | APAC로 페일오버, US 사용자 지연 증가 (~100ms) | 즉시 (LB 자동) |
| APAC 리전 장애 | US로 페일오버, APAC 사용자 지연 증가 (~100ms) | 즉시 (LB 자동) |
| D1 Primary 장애 | 읽기만 가능 (US), 쓰기 불가 | 수동 개입 필요 |
| DO 장애 | 해당 리전의 DO 기능 중단 | 리전 복구 시 자동 |

### 4.3 데이터 일관성

| 데이터 타입 | 일관성 모드 | 장애 시 영향 |
|-------------|-----------|------------|
| 검색 인덱스 (D1) | 비동기 복제 (< 1초 지연) | APAC에서 약간 오래된 인덱스 사용 |
| 벡터 검색 (Vectorize) | Cloudflare 자동 | 동일 |
| 캐시 (KV) | 글로벌 동기화 | 동일 |
| 레이트 리밋 | 리전 로컬 | 리전별 독립 카운트 |
| A/B 테스트 | 리전 로컬 | 리전별 독립 실험 |

---

## 5. 인프라 준비 체크리스트

### Phase 1: 사전 준비 (현재 계정)

- [ ] **Cloudflare Account B 생성** (APAC용)
  - 별도 이메일/카드로 등록
  - Workers & Pages 유료 플랜 활성화 ($5/월)
  - 도메인 추가 (`ssak-search-ap.pages.dev` 또는 커스텀 도메인)

- [ ] **D1 Read Replica 구성**
  - Account A에서 `search-engine-index` 데이터베이스 확인
  - Account B에서 동일 이름 D1 생성 → 자동 복제 설정
  - `npx wrangler d1 create search-engine-index` (Account B)
  - Account A Dashboard → D1 → Settings → Replication → 추가

- [ ] **Vectorize 인덱스 동기화 확인**
  - Account B에서 동일 이름 Vectorize 인덱스 생성
  - `npx wrangler vectorize create search-engine-dense --dimensions 768 --metric cosine`
  - 의미 캐시 인덱스도 동일하게 생성
  - **참고**: Vectorize는 자동 복제 안 됨 → 별도 인덱스 생성 + 재색인 필요

- [ ] **KV 네임스페이스 확인**
  - CF KV는 글로벌 → Account B에서 동일 ID로 바인딩만 추가
  - `CACHE_KV` ID: `1f5b3825e6a240a5b500d0f2faed15a8`

- [ ] **DO 워커 배포 (Account B)**
  - `wrangler.do.jsonc`를 Account B로 배포
  - `npx wrangler deploy --config wrangler.do.jsonc` (Account B 컨텍스트)
  - 11개 DO 클래스 동일하게 등록

### Phase 2: 배포 및 바인딩

- [ ] **Pages 프로젝트 배포 (Account B)**
  - Account B에서 `search-engine-api` Pages 프로젝트 생성
  - `npx wrangler pages deploy` (Account B)
  - 모든 바인딩을 Dashboard에서 수동 설정:
    - D1: `SEARCH_INDEX_DB` → Account B의 D1
    - Vectorize: `VECTORIZE_INDEX`, `SEMANTIC_CACHE_INDEX`
    - KV: `CACHE_KV` → Account A와 동일 ID
    - DO: `RATE_LIMITER`, `THREAD_DO` 등 11개
    - R2: `UPLOAD_BUCKET` → Account B의 R2
    - Queue: `INDEX_QUEUE` → Account B의 Queue
    - Analytics: `ANALYTICS` → Account B의 Analytics Engine
    - Workers AI: `AI` → Account B의 AI (무료 tier)

- [ ] **Health Check 엔드포인트 확인**
  - Account B에서 `GET /api/health` 정상 응답 확인
  - 모든 바인딩이 "configured" 상태인지 확인

- [ ] **검색 기능 Smoke Test**
  - Account B에서 `GET /api/search?query=test` 실행
  - 결과가 반환되는지 확인
  - 한국어 쿼리 테스트: `GET /api/search?query=삼성전자+주가`

### Phase 3: Load Balancer 설정

- [ ] **Cloudflare Load Balancer 생성**
  - Account A Dashboard → Traffic → Load Balancing → Create Load Balancer
  - Hostname: `ssak-search.pages.dev` (메인 도메인)
  - **Origin Pools**:
    - Pool 1 (US): Account A Pages URL
    - Pool 2 (APAC): Account B Pages URL
  - **Steering Policy**: Geo Steering (US → Pool 1, APAC → Pool 2)
  - **Health Checks**:
    - Endpoint: `/api/health`
    - Interval: 30초
    - Method: GET
    - Expected: HTTP 200

- [ ] **Geo-steering 규칙 확인**
  - Americas → US Pool (Account A)
  - Asia → APAC Pool (Account B)
  - Europe → US Pool (Account A) 또는 동등 가중치
  - **Fallback**: US Pool (Account A)

- [ ] **SSL/TLS 설정**
  - Load Balancer에서 SSL 종료
  - Origin → Load Balancer 간 SSL
  - 커스텀 도메인 SSL 인증서 발급

### Phase 4: 검증

- [ ] **페일오버 테스트**
  - Account A Pages 비활성화 → APAC로 자동 전환 확인
  - Account B Pages 비활성화 → US로 자동 전환 확인
  - 복구 시 자동 재전환 확인

- [ ] **지연 시간 측정**
  - US에서 요청 → US 리전 응답 (기본)
  - APAC에서 요청 → APAC 리전 응답 (기본)
  - US 리전 장애 시 APAC 응답 지연 측정

- [ ] **데이터 일관성 확인**
  - US에서 인덱싱 → APAC에서 검색 가능 확인 (< 1초)
  - 캐시 동기화 확인

- [ ] **SLO 모니터링**
  - Availability 99.9% 달성 확인
  - p95 < 3s 양 리전 확인
  - 에러율 < 0.1% 확인

### Phase 5: 모니터링 및 알림

- [ ] **양 리전 헬스 대시보드**
  - `/api/health`에서 region 필드로 리전 구분
  - 리전별 Availability/Latency 모니터링

- [ ] **페일오버 알림**
  - Slack: 리전 장애 감지 시 알림
  - PagerDuty: 페일오버 발생 시 알림

- [ ] **Analytics Engine 병합 쿼리**
  - `SELECT * FROM ssak_search WHERE blob1='bing' UNION ALL SELECT * FROM ssak_search WHERE blob1='bing'` (Account B)

---

## 6. 비용 추정

| 항목 | US (Account A) | APAC (Account B) | 합계 |
|------|----------------|------------------|------|
| Pages Workers | $0 (무료 tier) | $5 (유료) | $5 |
| D1 | $0 (무료 tier) | $0 (무료 tier) | $0 |
| Vectorize | $5 | $5 | $10 |
| KV | $0 (무료 tier) | $0 (무료 tier) | $0 |
| DO | $5 | $5 | $10 |
| Load Balancer | $5 (로드밸런서 1개) | - | $5 |
| Analytics | $5 | $5 | $10 |
| **합계** | | | **~$40/월** |

---

## 7. 리스크 및 완화

| 리스크 | 심각도 | 완화 |
|--------|--------|------|
| D1 복제 지연 (< 1초) | 낮음 | 검색 인덱스는 약간 오래된 데이터 허용 |
| DO 상태 분리 (레이트리밋) | 중간 | 리전별 독립 카운트 → 정확한 리밋은 어려움 |
| Vectorize 재색인 시간 | 중간 | 대량 인덱싱 시 양 리전 동시 실행 |
| KV 캐시 일관성 | 낮음 | CF KV는 글로벌 → 자동 동기화 |
| DO 크로스-리전 RPC | 높음 | DO는 리전 로컬 → 크로스-리전 RPC 불가 |
| 빌드/배포 복잡도 | 중간 | CI/CD에서 Account A/B 각각 배포 파이프라인 필요 |

---

## 8. 구현 순서 (권장)

1. **Account B 생성 + Pages 배포** (1일)
2. **D1/Vectorize/KV 바인딩 설정** (1일)
3. **DO 워커 배포** (1일)
4. **Load Balancer 설정** (1일)
5. **페일오버 테스트** (1일)
6. **모니터링 대시보드 구축** (1일)
7. **운영 문서 작성** (1일)

**총 소요 시간**: 약 7일 (인프라 작업, 코드 변경 불필요)

---

## 9. 코드 변경 불필요성

현재 `src/lib/deployment/global-deploy.ts`에 `GlobalDeploymentManager`가 구현되어 있으나, **실제 코드 변경은 불필요**합니다:

- Cloudflare Load Balancer가 트래픽 라우팅을 처리
- D1/Vectorize/KV는 Cloudflare가 자동으로 리전 간 동기화
- DO는 리전 로컬로 동작 (별도 설정 불필요)
- 유일한 코드 변경: `/api/health`에 리전 ID 노출 (선택 사항)
