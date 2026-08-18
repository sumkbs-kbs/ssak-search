# 개인정보처리방침 (Privacy Policy)

> 작성일: 2026-08-10 · 갱신: 2026-08-13 (보존·삭제 정책 실측 보강, FIX-2026-08-13-03)
> 상태: 초안 (DRAFT) — 상용 출시 전 법률 전문가 검토 필수
> 근거: 실제 코드의 데이터 흐름 기준 (src/lib/logger.ts, src/lib/auth.ts,
> src/lib/security-middleware.ts, src/lib/metrics.ts, src/lib/cache.ts,
> src/lib/api-key-do.ts, src/lib/rate-limiter-do.ts, src/lib/crawler-do.ts,
> src/lib/thread-do.ts, src/lib/space-do.ts)

## 1. 수집하는 정보

### 1.1 자동 수집 (요청 시)
| 정보 | 수집 근거 | 보존 기간 | 비고 |
|---|---|---|---|
| **IP 주소** (`cf-connecting-ip`) | 구조화 로그 (logger.ts), rate limiting | **로그: 1일 내외** (wrangler 로그 TTL) · rate-limit 맵: **최대 2분** (메모리 전용, 5,000건 상한) | Cloudflare 에지가 요청마다 전달. 별도 저장소에 영구 보존하지 않음 |
| **검색어 (쿼리)** | 요청 처리 | **영구 보존 안 함** — 캐시 TTL(뉴스 5분/일반 30분, cache.ts) 후 자동 삭제 | 캐시는 쿼리→결과 매핑이며 개인 식별과 분리. **구조화 로그에 쿼리 문자열을 기록하지 않음** (logger.ts — 요청 로그는 statusCode/latencyMs만 기록) |
| **요청 메타데이터** (경로, 상태코드, 지연, subrequest 수) | 메트릭 (metrics.ts → Analytics Engine) | Analytics Engine 보존 정책(계정 설정) | 개인 식별 정보 미포함 |
| **User-Agent / Referer** | 구조화 로그 | 로그 보존 정책 | 필요 시 로그에서 마스킹 가능 |

### 1.2 사용자 제공 정보
- **API 키 발급 시**: 이메일(선택), 결제 정보(유료 플랜 도입 시) — 별도 처리방침 수립 필요
- **채팅/스페이스 저장 기능 사용 시**: 사용자가 입력한 내용 (ThreadDO/SpaceDO — DO storage, 계정 삭제 시 함께 삭제)

## 2. 개인정보의 이용 목적
1. **서비스 제공** — 검색 요청 처리, 결과 반환
2. **남용 방지** — rate limiting, 회로차단기 (IP 기반, 메모리 전용)
3. **서비스 개선** — 익명 집계 메트릭(요청 수, 지연, 오류율)
4. **장애 대응** — 로그 기반 문제 진단

**개인정보를 마케팅 목적으로 이용하거나 제3자에게 판매하지 않습니다.**

## 3. 개인정보의 보관

| 항목 | 저장 위치 | 기간 |
|---|---|---|
| IP (rate-limit) | **isolate 메모리** (Map) / RateLimiterDO storage | 최대 2분 (활성 없으면 즉시 퇴거, 5,000건 상한) — DO 배포 시 storage 기반, `deleteAll()`로 초기화 가능 |
| IP (로그) | Cloudflare Workers 로그 | 플랫폼 보존 정책 (일반적으로 수일) |
| 쿼리-결과 캐시 | KV / isolate 메모리 | 뉴스 5분 · 일반 1시간 (TTL) |
| 사용자 콘텐츠 (채팅/스페이스) | DO storage | 계정 존속 기간, 삭제 요청 시 즉시 삭제 |
| 메트릭 | Analytics Engine | 계정 설정 (기본 90일, 재설정 가능) |

## 4. 제3자 제공 및 위탁
- **인프라 제공자**: Cloudflare (Workers/Pages/KV/D1/Analytics Engine) — [Cloudflare 개인정보처리방침](https://www.cloudflare.com/privacypolicy/) 적용
- **검색 백엔드**: 요청 쿼리가 검색 결과 조회를 위해 외부 검색 API(Bing/Naver/DDG 등)에 전송됩니다. 각 서비스의 처리방침이 적용됩니다. 결과는 개인 식별 정보 없이 전송됩니다.
- **그 외 제3자 제공 없음**

## 5. 정보주체의 권리 (GDPR/KPIPA 준수 노력)
- **열람/정정/삭제**: `privacy@ssak-search.example` 로 요청 (운영 이메일 확정 전 임시 주소)
- **수집 거부**: 로그/메트릭 수집에 동의하지 않으면 API 사용을 중단할 수 있습니다
- 사용자 생성 콘텐츠(채팅/스페이스)는 요청 시 **즉시 삭제**합니다

## 5.1 데이터 보존·삭제 정책 (2026-08-13 실측 기준)

| 저장소 | 데이터 | 보존 기간 | 삭제 방법 | 코드 근거 |
|---|---|---|---|---|
| 캐시 (KV/isolate 메모리) | 쿼리→결과 매핑 | 일반 30분 · 뉴스/금융 5분 (CACHE_TTL_* 로 조정) | TTL 자동 만료 + `cache.delete()` 명시 삭제 | src/lib/cache.ts |
| ApiKeyDO | API 키 메타데이터, 마지막 사용 시각 | 계정 존속 기간 | `deleteAll()` (관리자 호출 필요 — **사용자 호출 API 라우트 미구현**, Phase 5 과제) | src/lib/api-key-do.ts:335 |
| RateLimiterDO | IP 기반 레이트리밋 상태 | 최대 2분 (활성 없으면 퇴거) | `deleteAll()` | src/lib/rate-limiter-do.ts:492 |
| CrawlerDO | 크롤링 상태/알람 | 크롤링 완료 후 | `deleteAll()` + `deleteAlarm()` | src/lib/crawler-do.ts:284 |
| ThreadDO / SpaceDO | 사용자 채팅·스페이스 | 계정 존속 기간 | 계정 삭제 시 일괄 삭제 (스페이스 삭제 API: space-do.ts:131) | src/lib/space-do.ts |
| 구조화 로그 | 요청 메타데이터 (쿼리 문자열 제외) | Cloudflare 플랫폼 보존 정책 | 플랫폼 정책 준수 | src/lib/logger.ts |
| Analytics Engine | 익명 집계 메트릭 | 계정 설정 (기본 90일) | 계정 설정에서 재설정 | src/lib/metrics.ts |

**삭제 요청 처리 절차 (운영 매뉴얼 참조):**
1. 삭제 요청 접수 → 대상 데이터 범위 확인 (IP/쿼리/계정)
2. DO별 `deleteAll()` / 캐시 삭제 / 로그 필터링 실행
3. 삭제 완료 기록을 요청자에게 통지
4. **미구현 사항 (공개)** : 사용자 자가삭제 API, DO 데이터 백업/복구 절차 — 상용화 전 필수

## 6. 보안 조치
- 전송 구간 암호화 (TLS, Cloudflare 에지)
- API 키 암호화 저장 (Cloudflare Secrets)
- IP 기반 rate limiting + 회로차단기로 남용 방지
- SSRF/인젝션 방어 (security-middleware)

## 7. 쿠키 및 로컬 저장소
- 본 서비스는 API 중심 서비스로 **쿠키를 사용하지 않습니다** (웹 UI는 선택적 세션 관리 시 재검토)

## 8. 아동 정보
- 만 14세 미만 아동의 개인정보를 고의로 수집하지 않습니다

## 9. 처리방침 변경
- 변경 시 본 문서 상단의 작성일 갱신 및 중요 변경은 별도 공지

## 10. 문의
- 이메일: privacy@ssak-search.example *(실제 운영 주소로 교체 필요)*

---

### ⚠️ 상용 출시 전 체크리스트 (법률 검토 필수)
- [ ] 운영 이메일 주소 확정 (privacy@)
- [ ] 대한민국 개인정보보호법(KPIPA) 준수 검토 — 개인정보처리방침 신고 의무
- [ ] GDPR 대상(유럽 사용자) 시 EU 대리인 지정 검토
- [ ] 검색 쿼리의 로그 마스킹 (선택 사항, 기본 해시 처리 권장)
- [ ] 웹 UI(chat/spaces) 도입 시 별도 동의 절차 수립
