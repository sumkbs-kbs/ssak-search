# 06 — 보안 리뷰 (Security Review)

> 작성일: 2026-08-23 | 실측·코드 검토 기반. 침투 테스트는 아님.
> 관련: [SECURITY.md](../../SECURITY.md)(위협모델·신고경로) · [AUDIT.md](../../AUDIT.md)(로그 송출)

---

## 1. 발견·조치된 사항

| ID | 항목 | 심각도 | 상태 |
|---|---|---|---|
| S-1 | `/api/health`의 `auth_required` 오판 — API_KEY_DO 바인딩 활성 상태에서 false 보고(모니터링 오인 유발) | Medium(High→수정됨) | ✅ FIX-1: auth.ts 강제 조건(SEARCH_API_KEY‖TENANTS_CONFIG‖API_KEY_DO)과 동기화 |
| S-2 | 로컬 표준 기동 실패가 보안 점검(CI 헬스게이트)을 무력화 | Medium | ✅ FIX-2: DO 워커 자동 기동 |
| S-3 | 무키 요청 401 + 감사로그(`AUDIT_SECURITY: auth_failure`, severity high) | 정보 | ✅ 라이브 실측 정상 동작 |

## 2. 검증된 방어 메커니즘 (실측 또는 테스트 근거)

- **SSRF**: `/api/extract`의 `assertSafeFetchUrl` — 사설 IP/메타데이터/비-http(s)/credentials-in-URL 거부(v2.0 도입, 단위 테스트 존재)
- **레이트 리밋**: DO 기반 크로스 아이솔레이트(health `rate_limiter.mode: durable_object` 실측)
- **입력 제한**: body 64KB, domain arrays 20개, extract URLs 20개, page 1-10
- **감사 로그**: 구조화 JSON(audit:true) — Logpush/Datadog 연계 가이드 존재
- **보안 헤더/CSP**: security-headers.ts + security-middleware.ts (Phase 3.2)
- **인증**: Bearer/X-API-Key, ApiKeyDO 만료·폐기·스코어 검증 경로 존재(auth.ts 테스트 58개 통과)

## 3. 웹 크롤링 관련 위험

- **[~] ToS/robots 회색지대**: Bing/Naver/DDG를 iPhone Safari UA 위장으로 스크래핑 — 무료 원칙의 구조적 선택이나 법적 검토 권고. 차단 시 circuit breaker로 흡수되는 건 실측됨
- **[ ] robots.txt 준수**: 스크래핑 경로에 미구현 — 공개 서비스화 전 법무 검토 및 준수 로직 권장
- **[x] 프롬프트 인젝션 방어 모듈 확인(2026-08-23)**: 전담 모듈 `prompt-guard.ts`(274줄, export 10개) 존재 — `sanitizeEvidenceContent`·`detectPromptInjection`·`PROMPT_INJECTION_DEFENSE`를 answer.ts가 사용하며, 증거 청크를 신뢰불가 데이터로 취급하고 고위험 주입은 격리(quarantine)+감사 처리(answer.ts:652-664). 남은 과제: 탐지 패턴 커버리지·정책 파라미터 심층 감사(O-3 잔여)

## 4. 개인정보보호

- 수집 최소화: IP는 레이트리밋 목적으로만 사용, 감사로그에 actor IP 포함(Logpush 송출 시 관할 검토)
- [~] 클릭로그(ClickLogDO)·프로파일(UserProfileDO) 보존기간·삭제 경로의 실측 확인 미실시 — PRIVACY_POLICY.md와 대조 감사 권장
- [x] 오픈 모드(AUTH_OPEN_MODE)는 명시적 환경변수 필요 — 기본 closed 확인(auth.ts)

## 5. 수정 계획 (우선순위)

1. 프롬프트 인젝션 감사: answer 합성 시 웹 콘텐츠 격리 지시문·신뢰도 게이트 코드 리뷰 (Medium-High)
2. robots.txt/ToS 준수 전략 문서화 — 공개 서비스화 전 필수 (High, 사업 판단 포함)
3. 클릭로그/프로파일 데이터 수명주기 감사 (Medium)
4. 의존성 취약점 스캔 CI 추가(npm audit/advisories 게이트) (Medium)
5. SEARCH_API_KEY 운영 키의 시크릿 저장 확인(Pages Secrets) — 배포 체크리스트 연동 (Low)

---
*본 리뷰는 정적 검토+런타임 실측 기반이며, 침투 테스트/의존성 CVE 스캔은 별도 수행 권장.*
