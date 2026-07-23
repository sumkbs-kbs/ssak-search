# 상용 수준 검색엔지 개선 계획

> 목표: 현재 프로토타입을 상용 검색 API 수준으로 향상
> 기준: Tavily / Brave Search API / SerpAPI 기능 및 품질 대비

---

## Phase 1: 즉시 개선 (1주)

### 1.1 에러 핸들링 강화 🔴
**문제**: 62개 빈 `catch {}` 블록 → 에러 무시, 디버깅 불가
**목표**: 모든 에러를 구조화되고 로깅되도록 수정

**작업:**
- [ ] `src/lib/util.ts`: `fetchWithTimeout` 에러 핸들링 개선
- [ ] `src/lib/bing-search.ts`: 빈 catch 블록 처리
- [ ] `src/lib/duckduckgo.ts`: 빈 catch 블록 처리
- [ ] `src/lib/naver-search.ts`: 빈 catch 블록 처리
- [ ] `src/lib/specialized.ts`: 빈 catch 블록 처리 (7개)
- [ ] `src/lib/orchestrator.ts`: 빈 catch 블록 처리 (4개)
- [ ] `src/lib/html-rewriter.ts`: 빈 catch 블록 처리
- [ ] `src/lib/extractor.ts`: 에러 핸들링 개선
- [ ] `src/routes/*.ts`: 라우트 레벨 에러 핸들링 표준화

**기준:**
- 빈 `catch {}` 블록: 62개 → 0개
- 모든 에러: `console.warn/error` + 구조화된 로깅
- 에러 타입별 분류 (네트워크, 파싱, 타임아웃 등)

**검증:**
- `grep -r "catch\s*{" src/ --include="*.ts" | wc -l` → 0

---

### 1.2 타입 안전성 강화 🔴
**문제**: 28개 `as any` 사용 → 런타임 에러 위험
**목표**: 제네릭 타입 도입으로 타입 안전성 확보

**작업:**
- [ ] `src/lib/agentic/index.ts`: `as any` 10개 제거
- [ ] `src/lib/agentic/classifier.ts`: 타입 가드 추가
- [ ] `src/lib/agentic/executor.ts`: 제네릭 타입 적용
- [ ] `src/lib/agentic/planner.ts`: 타입 안전성 강화
- [ ] `src/lib/agentic/synthesizer.ts`: 타입 검증
- [ ] `src/types.ts`: 공통 제네릭 타입 정의
- [ ] `tsconfig.json`: strict 모드 확인

**기준:**
- `as any` 사용: 28개 → 0개
- `@ts-ignore/expect-error`: 0개 유지
- TypeScript strict 모드 통과

**검증:**
- `grep -r "as any" src/ --include="*.ts" | wc -l` → 0
- `npm run typecheck` → 0 에러

---

### 1.3 테스트 커버리지 확대 🟡
**문제**: 149개 테스트 → 핵심 기능 커버리지 부족
**목표**: 핵심 기능 테스트 커버리지 80% 이상

**작업:**
- [ ] `tests/unit/bing-search.test.ts`: Bing 검색 테스트 추가
- [ ] `tests/unit/naver-search.test.ts`: Naver 검색 테스트 추가
- [ ] `tests/unit/specialized.test.ts`: 전문 소스 테스트 추가
- [ ] `tests/unit/orchestrator.test.ts`: 오케스트레이터 테스트 추가
- [ ] `tests/unit/extractor.test.ts`: 추출기 테스트 추가
- [ ] `tests/unit/images.test.ts`: 이미지 검색 테스트 추가
- [ ] `tests/unit/news.test.ts`: 뉴스 검색 테스트 추가
- [ ] `tests/unit/products.test.ts`: 상품 검색 테스트 추가
- [ ] `tests/integration/api.test.ts`: 통합 테스트 추가

**기준:**
- 단위 테스트: 149개 → 300개 이상
- 통합 테스트: API 엔드포인트별 1개 이상
- 테스트 커버리지: 80% 이상

**검증:**
- `npm test` → all pass
- `npm run test:integration` → all pass

---

## Phase 2: 안정성 강화 (2주)

### 2.1 캐싱 시스템 강화 🟡
**문제**: 인메모리 캐싱 → 콜드스타트 시 리셋
**목표**: KV/D1 기반 영속적 캐싱

**작업:**
- [ ] `src/lib/cache.ts`: KV 캐싱 구현
- [ ] `src/lib/cache.ts`: TTL 정책 (news=5min, general=30min, factoid=24h)
- [ ] `src/lib/cache.ts`: LRU eviction 로직
- [ ] `src/lib/cache.ts`: 캐시 적중률 측정
- [ ] `wrangler.jsonc`: KV namespace 바인딩 설정
- [ ] `src/routes/health.ts`: 캐시 상태 엔드포인트 추가

**기준:**
- KV 캐싱: 완전 구현
- TTL 정책: 3단계 적용
- 캐시 적중률: 50% 이상

**검증:**
- KV 바인딩 테스트
- 캐시 TTL 동작 확인
- 적중률 메트릭 확인

---

### 2.2 Rate Limiting 고도화 🟡
**문제**: 기본적 per-IP rate limiting → 정교한 티어 기반 미적용
**목표**: DO 기반 cross-isolate rate limiting

**작업:**
- [ ] `wrangler.jsonc`: Durable Object 바인딩 활성화
- [ ] `src/lib/rate-limiter-do.ts`: DO 기반 rate limiting 구현
- [ ] `src/lib/auth.ts`: 티어별 rate limit 적용
- [ ] `src/routes/health.ts`: rate limit 상태 확인
- [ ] `README.md`: DO 설정 가이드 추가

**기준:**
- DO 기반 rate limiting: 완전 구현
- 티어별 rate limit: 적용
- cross-isolate 동작: 확인

**검증:**
- DO 바인딩 테스트
- 30요청/분 제한 확인
- 티어별 차등 적용 확인

---

### 2.3 로깅/모니터링 강화 🟡
**문제**: 기본 로깅만 → 실시간 모니터링 부족
**목표**: 구조화된 로깅 + Prometheus 메트릭

**작업:**
- [ ] `src/lib/logger.ts`: 구조화된 로깅 개선
- [ ] `src/lib/metrics.ts`: 상세 메트릭 추가
- [ ] `src/routes/health.ts`: 상세 헬스 체크
- [ ] `src/routes/metrics.ts`: Prometheus 메트릭 확장
- [ ] `.github/workflows/monitor.yml`: 모니터링 워크플로우 개선

**기준:**
- 구조화된 로깅: 모든 요청/응답
- Prometheus 메트릭: 10개 이상
- 모니터링 워크플로우: 15분 간격

**검증:**
- 로그 출력 확인
- `/api/metrics` 엔드포인트 동작
- 모니터링 워크플로우 실행 확인

---

## Phase 3: 품질 강화 (3주)

### 3.1 API 문서 완성 🟡
**문제**: OpenAPI spec 미완성 → 개발자 경험 저하
**목표**: 완전한 API 문서 + 예제

**작업:**
- [ ] `openapi.yaml`: 모든 엔드포인트 문서화
- [ ] `openapi.yaml`: 요청/응답 예제 추가
- [ ] `openapi.yaml`: 에러 코드 문서화
- [ ] `src/pages/docs.ts`: 문서 페이지 개선
- [ ] `README.md`: API 사용법 상세 추가

**기준:**
- OpenAPI spec: 100% 완성
- 요청/응답 예제: 모든 엔드포인트
- 에러 코드: 50개 이상

**검증:**
- Swagger UI 동작 확인
- 예제 코드 실행 테스트
- 에러 코드 동작 확인

---

### 3.2 에러 핸들링 표준화 🟡
**문제**: 에러 형식 비일관 → 개발자 경험 저하
**목표**: 일관된 에러 응답 형식

**작업:**
- [ ] `src/types.ts`: 공통 에러 타입 정의
- [ ] `src/routes/*.ts`: 에러 응답 표준화
- [ ] `src/lib/errors.ts`: 에러 클래스 정의
- [ ] `src/lib/errors.ts`: 에러 코드 분류
- [ ] `openapi.yaml`: 에러 코드 문서화

**기준:**
- 에러 응답 형식: 일관성
- 에러 코드: 체계적 분류
- 에러 메시지: 명확성

**검증:**
- 모든 에러 응답 형식 확인
- 에러 코드 동작 확인
- 문서화 확인

---

### 3.3 성능 최적화 🟡
**문제**: 응답 시간 편차 → 일관된 성능
**목표**: p95 응답 시간 3초 이내

**작업:**
- [ ] `src/lib/orchestrator.ts`: 병렬 실행 최적화
- [ ] `src/lib/util.ts`: fetchWithTimeout 최적화
- [ ] `src/lib/cache.ts`: 캐싱 전략 최적화
- [ ] `src/routes/search.ts`: 검색 파이프라인 최적화
- [ ] `src/routes/images.ts`: 이미지 검색 최적화

**기준:**
- p95 응답 시간: 3초 이내
- 캐시 히트 시: 1초 이내
- 에러율: 1% 이내

**검증:**
- 성능 테스트 실행
- 모니터링 대시보드 확인
- 부하 테스트

---

## Phase 4: 운영 강화 (4주)

### 4.1 SLA 구현 🔴
**문제**: SLA 없음 → 신뢰성 부족
**목표**: 99.9% SLA 달성

**작업:**
- [ ] `SLO.md`: SLA 정의
- [ ] `src/routes/health.ts`: 헬스 체크 강화
- [ ] `src/lib/circuit-breaker.ts`: 회로 차단기 구현
- [ ] `.github/workflows/monitor.yml`: 알림 시스템
- [ ] `README.md`: SLA 문서화

**기준:**
- SLA: 99.9%
- 가용성: 99.9%
- 응답 시간: p95 3초 이내

**검증:**
- 헬스 체크 동작 확인
- 회로 차단기 동작 확인
- 알림 시스템 동작 확인

---

### 4.2 로그 관리 강화 🔴
**문제**: 7일 Live Tail만 → 장기 로그 보관 부족
**목표**: 구조화된 로깅 + 장기 보관

**작업:**
- [ ] `src/lib/logger.ts`: 구조화된 로깅 구현
- [ ] `src/lib/audit.ts`: 감사 로깅 구현
- [ ] `wrangler.jsonc`: Logpush 설정
- [ ] `AUDIT.md`: 감사 로그 가이드
- [ ] `SLO.md`: 로그 보관 정책

**기준:**
- 구조화된 로깅: 모든 요청/응답
- 감사 로깅: 보안 이벤트
- Logpush: R2/Datadog/Splunk

**검증:**
- 로그 출력 확인
- Logpush 동작 확인
- 장기 보관 확인

---

### 4.3 백업/복구 시스템 🔴
**문제**: 백업 없음 → 데이터 유실 위험
**목표**: 자동 백업 + 복구 시스템

**작업:**
- [ ] `wrangler.jsonc`: KV/D1 백업 설정
- [ ] `.github/workflows/backup.yml`: 자동 백업 워크플로우
- [ ] `src/routes/health.ts`: 복구 테스트
- [ ] `README.md`: 백업/복구 가이드

**기준:**
- 자동 백업: 매일 1회
- 복구 테스트: 월 1회
- 백업 보관: 30일

**검증:**
- 백업 워크플로우 실행 확인
- 복구 테스트 실행
- 백업 파일 확인

---

## 실행 우선순위

| 우선순위 | 항목 | 예상 노력 | 영향도 |
|---------|------|----------|--------|
| P0 | 에러 핸들링 강화 | 2-3일 | 높음 (안정성) |
| P0 | 타입 안전성 강화 | 2-3일 | 높음 (품질) |
| P0 | 테스트 커버리지 확대 | 3-4일 | 높음 (품질) |
| P1 | 캐싱 시스템 강화 | 3-4일 | 중간 (성능) |
| P1 | Rate Limiting 고도화 | 2-3일 | 중간 (안정성) |
| P1 | 로깅/모니터링 강화 | 2-3일 | 중간 (운영) |
| P2 | API 문서 완성 | 3-4일 | 중간 (개발자 경험) |
| P2 | 에러 핸들링 표준화 | 2-3일 | 중간 (개발자 경험) |
| P2 | 성능 최적화 | 3-4일 | 중간 (성능) |
| P3 | SLA 구현 | 4-5일 | 높음 (운영) |
| P3 | 로그 관리 강화 | 3-4일 | 높음 (운영) |
| P3 | 백업/복구 시스템 | 3-4일 | 높음 (운영) |

---

## 검증 전략

### 각 Phase별 검증
- **Phase 1**: `npm run typecheck` (0 에러), `npm test` (300+ 통과)
- **Phase 2**: 캐싱/Rate Limiting 동작 확인, 모니터링 대시보드
- **Phase 3**: API 문서 동작 확인, 성능 테스트 통과
- **Phase 4**: SLA 99.9% 달성, 로그/백업 동작 확인

### 최종 검증
- `npm run build` → 성공
- `npm test` → 300+ 통과
- `npm run typecheck` → 0 에러
- 성능 테스트 → p95 3초 이내
- 보안 테스트 → 취약점 0개

---

## 성공 기준

| 항목 | 현재 | 목표 |
|------|------|------|
| 빈 catch 블록 | 62개 | 0개 |
| as any | 28개 | 0개 |
| 테스트 | 149개 | 300개+ |
| 테스트 커버리지 | ~60% | 80%+ |
| p95 응답 시간 | ~5초 | 3초 이내 |
| SLA | 없음 | 99.9% |
| 에러율 | ~5% | 1% 이내 |

---

*최종 업데이트: 2026-07-20*
