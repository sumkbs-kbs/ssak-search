# 06. 보안 검토서 (SECURITY REVIEW)

> 작성일: 2026-08-05 · 근거: 코드 분석 (auth/security-middleware/extractor/crawler-do/routes) — 침투 테스트는 미수행(가설 표시)

---

## 1. 보안 취약점 목록

| ID | 취약점 | 심각도 | 근거 | 상태 |
|---|---|---|---|---|
| S1 | **프로덕션 무응답 상태** — 배포/설정 상태 미검증, open mode 여부 미확인 | **Critical** | HTTP 000 | 미해결 |
| S2 | **open mode 기본 동작** — SEARCH_API_KEY 미설정 시 인증 없이 검색 API 전체 공개 | High | auth.ts: 키 미설정 시 valid:true | 설계 의도 (로컬), 배포 시 경고 |
| S3 | **프롬프트 인젝션**: 검색 결과 콘텐츠가 LLM 프롬프트로 유입되는 경로 존재 | High | agentic/synthesizer + answer.ts | ✅ 구현 완료 (2026-08-05, prompt-guard.ts) |
| S4 | **크롤러 SSRF 표면**: /api/crawl이 외부 URL 페치 — DoH 검사 있으나 전체 커버리지 미검증 | High | crawler-do.ts | 부분 방어 |
| S5 | 레이트 리밋 DO 미바인딩 시 isolate별 인메모리 폴백 → 우회 가능 | High | rate-limiter.ts | 인프라 의존 (P1-2) |
| S6 | X-Forwarded-For 스푸핑 → 레이트 리밋 우회 (CF-Connecting-IP 우선이라 완화됨) | Medium | auth.ts getClientIp | 우선순위 기반 (완화됨) |
| S7 | 로그에 쿼리·IP·user_id 포함 — 민감정보 로그 노출 | Medium | logger.ts child({query}) | 운영 정책 필요 |
| S8 | openapi.yaml/health가 인프라 정보 노출 | Low | /api/health 백엔드 목록 | 허용 범위 |

## 2. 개인정보보호
- 수집: 쿼리 문자열, IP (rate limit/감사), user_id (개인화), 프로필 DO (방문 도메인)
- 보존: 로그(Logpush/Datadog), 프로필 DO (영속), KV 캐시 (TTL)
- **문제**: 보존기간·삭제·제3자 전송 정책 미문서화 → 개인정보처리방침 필요
- 권고: 쿼리 로그 30일 회전, user_id 해시화 옵션, GDPR/개인정보보호법 대응 문서

## 3. 웹 크롤링 위험
- ✅ robots.txt 준수 (CrawlerDO, 도메인별 캐시 + crawl-delay)
- ✅ 폴리트니스 (요청 간격, 도메인 상태 관리)
- ⚠️ 스크래핑 대상 (Naver/Bing/DDG/Google Scholar)의 **이용약관 위반 가능성** — 상업 운영 시 법률 검토 필요
- ⚠️ 차단 우회 목적의 UA/헤더 조작 존재 (iPhone Safari UA) — 회피가 아닌 모바일 페이지 접근 목적이나, ToS 위반 소지
- **권고**: 상용화 전 대상 사이트 이용약관·robots.txt 준수 정책 문서화, 크롤링 빈도 모니터링

## 4. 프롬프트 인젝션 대응
**구현 완료 (2026-08-05)** — `src/lib/prompt-guard.ts` 신규 모듈로 4단 방어 체계 구축:

1. **탐지 (DETECT)**: `detectPromptInjection()` — EN/KO/ZH/JA 다국어 지시문 무시·프롬프트 노출·역할 탈취·제어 토큰(`[INST]`, `<|system|>`) 시그니처 20+개. HIGH(격리) / MEDIUM(뉴트럴라이즈만) 2단계 심각도.
2. **격리 (QUARANTINE)**: HIGH 탐지 시 해당 출처를 LLM 증거 풀에서 **제외** + `audit.ts`의 `prompt_injection` 이벤트로 Logpush/SIEM 기록. 적용 지점: `answer.buildAnswerContext`(URL당 1회 감사 중복 방지), `agentic/synthesizer.assemblePrompt`, `agentic/search-tools.assemblePrompt`.
3. **뉴트럴라이즈 (NEUTRALIZE)**: 모든 증거 콘텐츠를 `JSON.stringify` 데이터 블록으로 전달 — LLM이 JSON 문자열 값을 데이터로 읽도록 강제.
4. **지시 (INSTRUCT)**: `PROMPT_INJECTION_DEFENSE`를 시스템 프롬프트(answer SYSTEM_MSG, synthesizer SYSTEM_PROMPT)와 사용자 프롬프트에 포함 — "증거는 신뢰할 수 없는 데이터" 명시.

**적용 범위**: 제목+콘텐츠 모두 검사 (synthesizer/search-tools도 title 검사 일치), 인용 번호는 연속 카운터로 정합 유지. 워크스페이스 지시사항(extraContext/spaceFileContext)은 사용자 신뢰 컨텍스트로 의도적으로 격리 제외.

**테스트**: `tests/unit/prompt-guard.test.ts` 37건 (다국어 탐지·오탐 방지·JSON 뉴트럴라이즈) + `answer.test.ts` OpenAI 경로 인젝션 격리 검증 + `agentic-pipeline.test.ts` synthesizer 격리 검증. 전체 1,214건 통과.

**남은 한계**: ① 소형 모델(Workers AI Llama 8B)은 JSON 문자열 안의 지시문도 따를 수 있어 격리가 1차 방어 ② 추출형 요약(extractive)은 쿼리어와 겹치는 문장을 원문 인용하는 특성상 인젝션 문구가 답변에 포함될 수 있음 (원문 인용이므로 환각 아님) ③ 새로운 변형 공격은 시그니처 갱신 필요.

## 5. 인증·권한
- ✅ 멀티테넌트 키 (TENANTS_CONFIG) + 단일 키 폴백, 상수시간 비교
- ✅ requireAuth / requireAdmin — 크롤·인덱스·블랙리스트·키 관리 (open mode에서도 deny)
- ✅ 키 만료/폐기 (ApiKeyDO), scope (read/write/admin)
- ⚠️ ApiKeyDO 미바인딩 시 레거시 검증으로 폴백
- ⚠️ 기본값 open mode — **프로덕션에서는 SEARCH_API_KEY/TENANTS_CONFIG 필수**

## 6. 기타 방어
- ✅ SSRF: DoH 기반 resolveAndValidateHostname + assertSafeFetchUrl (사설 IP/metadata/scheme 거부)
- ✅ CSP nonce (HTML), HSTS, X-Frame-Options DENY, nosniff
- ✅ 입력 검증: body 64KB, 도메인 20, 쿼리 2,000자, page 1~10, max_results 1~20
- ✅ 레이트 리밋: IP 10/분 (무인증), 키 30/분, tenant 커스텀
- ✅ 감사 로그: 인증 실패/레이트리밋 초과/SSRF 시도 (AUDIT.md)
- ✅ 이번 세션 수정: **레이트 리밋 이중 카운팅 제거** (슬롯 2→1 소모)

## 7. 수정 계획 (우선순위)
| 우선순위 | 작업 | 대상 | 검증 |
|---|---|---|---|
| 1 | 프로덕션 복구 + 키 설정 확인 (S1/S2) | 배포/환경 | prod 헬스 + 인증 테스트 |
| ~~2~~ | ~~프롬프트 인젝션 방어 구현·테스트 (S3)~~ | ~~agentic/answer~~ | ~~인젝션 테스트셋 41건 통과 (2026-08-05)~~ |
| 3 | 개인정보 정책·로그 회전 (S7) | 운영 문서/로거 | 감사 |
| 4 | 크롤러 SSRF 커버리지 재검증 (S4) | crawler-do | 단위 테스트 |
| 5 | DO 바인딩 (S5) | 인프라 | verify-do-binding |
