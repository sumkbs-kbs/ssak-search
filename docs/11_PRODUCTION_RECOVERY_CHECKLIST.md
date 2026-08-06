# 11. 프로덕션 복구 체크리스트 (PRODUCTION RECOVERY CHECKLIST)

> 작성일: 2026-08-05 · 작성 근거: 실제 프로덕션(`search-engine-api.pages.dev`) 헬스체크 + verify-do-binding.sh 실행 결과
> 참조: DEPLOYMENT_CHECKLIST.md (배포 전 점검), docs/09_OPERATION_GUIDE.md (운영), docs/06_SECURITY_REVIEW.md (보안),
> **docs/12_DO_ANALYTICS_BINDING_PROCEDURE.md (DO 8종 + Analytics Engine 바인딩 상세 설정 절차)**

---

## 0. 요약 — 현재 프로덕션 상태 (2026-08-05 실측)

| 영역 | 상태 | 상세 |
|---|---|---|
| **가용성** | ✅ **HTTP 200, 가동 중** | `/api/health` 200, `/` 200 (0.4s), 검색 API 정상 (2.4s, 3건) |
| 시스템 상태 | ⚠️ `partial_outage` | brave down + 일부 백엔드 degraded + DO 미바인딩 |
| 보안 | ❌ **open mode** | `auth_required: false` → SEARCH_API_KEY 미설정 |
| DO 바인딩 | ⚠️ 일부만 | THREAD/LIBRARY/USER_PROFILE ✅, **PAGES/API_KEY ❌(501)**, SPACE(500), CRAWLER(429→정상), **RATE_LIMITER ❌(인메모리)** |
| Analytics Engine | ✅ 활성 | `analytics_engine: true`, `search_metrics_persistence` 확인 필요 |
| 자체 인덱스 | ✅ 정상 | Vectorize+D1 바인딩됨, 403 문서, healthy |
| 백엔드 | ⚠️ 일부 | bing/naver/ddg/workers_ai ✅ · brave ❌ · wikipedia/github/hackernews/reddit degraded |
| 스테이징 | ⚠️ 배포 없음 | `staging.search-engine-api.pages.dev` → "Deployment Not Found" |

> **중요 교훈**: 이전 세션에서 `ssak-search.pages.dev`(NXDOMAIN)를 확인해 "프로덕션 다운"으로 오판했음.
> **실제 프로덕션 도메인은 `search-engine-api.pages.dev`** (wrangler.jsonc `name`, deploy.yml `PROJECT_NAME` 확인).

---

## 1. 배포 상태 확인 절차 (5분)

### 1.1 도메인 확인 (잘못된 도메인으로 헛수고 하지 않기)
```bash
# 프로젝트명이 실제 도메인을 결정한다:
grep '"name"' wrangler.jsonc                    # → "search-engine-api"
grep 'PROJECT_NAME' .github/workflows/deploy.yml # → search-engine-api
nslookup search-engine-api.pages.dev            # DNS 존재 확인
```

### 1.2 헬스 체크 (가동 여부 + 바인딩 + 백엔드)
```bash
curl -s https://search-engine-api.pages.dev/api/health | python3 -m json.tool
# 확인 포인트:
#   status: "ok" 또는 "partial_outage"      ← partial이면 아래 DO/백엔드 확인
#   features.rate_limiter_do: true/false     ← false = RATE_LIMITER 미바인딩
#   features.analytics_engine: true          ← false = 메트릭 영속 안 됨
#   features.self_index / index.configured   ← 자체 인덱스
#   auth_required: true/false                ← false = open mode (보안 위험)
#   backends.*.status                        ← down/degraded 백엔드 파악
```

### 1.3 DO 바인딩 검증 (수정된 스크립트)
```bash
bash scripts/verify-do-binding.sh
# ✅ = 바인딩됨 · ⚠️ 501 = 미바인딩 · 500 = 오류 · 429 = 레이트리밋(정상)
```

### 1.4 기능 스모크 테스트
```bash
# 검색 (핵심)
curl -s -X POST https://search-engine-api.pages.dev/api/search \
  -H 'Content-Type: application/json' -d '{"query":"quantum computing","max_results":3}'
# → results 1건+, no_results:false, HTTP 200

# 메트릭 (Prometheus + 영속화)
curl -s https://search-engine-api.pages.dev/api/metrics | grep search_metrics_persistence
# → search_metrics_persistence 1

# 보안 헤더
curl -sI https://search-engine-api.pages.dev/ | grep -iE 'strict-transport|content-security|x-frame'

# 정적 페이지
curl -s -o /dev/null -w '%{http_code}\n' https://search-engine-api.pages.dev/docs   # 200
```

---

## 2. 복구 체크리스트 (실제 검증된 문제 기준, 우선순위순)

### 🔴 Phase A — 보안·안정성 필수 (즉시)

| # | 작업 | 근거 (실측) | 방법 | 완료 기준 |
|---|---|---|---|---|
| A1 | **SEARCH_API_KEY 설정 (open mode 종료)** | `auth_required: false` — 누구나 무인증 검색/추출 가능 | Dashboard → Pages → search-engine-api → Settings → **Secrets** → SEARCH_API_KEY (또는 `npx wrangler pages secret put SEARCH_API_KEY`) | `auth_required: true`, 무키 요청 401 |
| A2 | **RATE_LIMITER DO 바인딩** | `rate_limiter_do: false`, `mode: in_memory_fallback` — 크로스-아이솔레이트 레이트리밋·서킷브레이커 미작동 | Dashboard → Settings → Functions → Durable Objects → Add binding (name: `RATE_LIMITER`, class: `RateLimiterDO`) → Save & Redeploy | verify-do-binding.sh에서 RATE_LIMITER ✅ |
| A3 | **PAGES_DO 바인딩** | `/api/pages` 501 — 보고서 저장 기능 무력 | 동일 절차 (name: `PAGES_DO`, class: `PagesDO`) | `/api/pages` 501 소멸 |
| A4 | **API_KEY_DO 바인딩** | `/api/keys` 501 — 키 관리 무력 | 동일 절차 (name: `API_KEY_DO`, class: `ApiKeyDO`) | `/api/keys` 501 소멸 |

### 🟡 Phase B — 기능 복원 (1~2일)

| # | 작업 | 근거 (실측) | 방법 | 완료 기준 |
|---|---|---|---|---|
| B1 | **SPACE_DO 확인·바인딩** | `/api/spaces` HTTP 500 — 오류 응답 | 바인딩 확인 후 재테스트 (name: `SPACE_DO`, class: `SpaceDO`) | 500 → 4xx/200 |
| B2 | **brave 백엔드 복구** | `brave: down` | BRAVE_API_KEY 설정 또는 무시(폴백 존재) | health에서 brave가 operational 또는 의도적 down 명시 |
| B3 | **degraded 백엔드 모니터링** | wikipedia/github/hackernews/reddit degraded | 서킷브레이커 self-healing 확인 + 재시도 정책 | 24h 후 operational 회복 확인 |
| B4 | **스테이징 배포** | `staging.*.pages.dev` 배포 없음 | GitHub Actions → Deploy → workflow_dispatch → staging | staging health 200 |

### 🟢 Phase C — 운영 정비 (1주)

| # | 작업 | 근거 | 방법 | 완료 기준 |
|---|---|---|---|---|
| C1 | **모니터 워크플로우 활성화** | monitor.yml이 15분마다 health 체크 + Slack | GitHub Secrets에 `ALERT_SLACK_WEBHOOK` 설정 | 모니터 실행 로그 ✅ |
| C2 | **canary 파서 회귀 감지** | HTML 스크래핑 의존 — 마크업 변경 시 즉시 회귀 | Pages Variables `HEALTH_CANARY_ENABLED=true` | `/api/canary` 동작 |
| C3 | **Sentry DSN 설정** | 오류 추적 no-op 상태 | `npx wrangler pages secret put SENTRY_DSN` | Sentry 대시보드 수신 |
| C4 | **Logpush 설정** | 감사 로그 7일 후 소실 | scripts/create-logpush-datadog.sh (Datadog 시) | 로그 수신 확인 |
| C5 | **README 도메인 참조 정리** | README에 구 `ssak-search.pages.dev` 다수 | ✅ 이번 세션에서 일괄 수정 완료 | grep 결과 0 |
| C6 | **검증 스크립트 개선 반영** | verify-do-binding.sh 기본 URL 오류·bash 패딩 버그 | ✅ 이번 세션에서 수정 완료 | 스크립트 정상 실행 |

---

## 3. 상세 복구 절차 (A1~A4 실행 방법)

### 3.1 Cloudflare Dashboard 경로
1. https://dash.cloudflare.com/ 로그인 → **Workers & Pages** → `search-engine-api`
2. **Settings** 탭
3. **Functions** → Durable Objects / AI / Vectorize 바인딩 관리
4. **Secrets** / **Variables** → 환경변수 관리
5. 변경 후 반드시 **Save & Redeploy** (1~2분)

> 📘 **상세 절차**: DO 바인딩 추가 순서·이름/클래스 매핑·Analytics Engine 데이터셋 생성·
> 설정 후 검증 사이클·롤백 절차는 **docs/12_DO_ANALYTICS_BINDING_PROCEDURE.md** 참조.

### 3.2 CLI 경로 (토큰 필요)
```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
npx wrangler pages secret put SEARCH_API_KEY --project-name=search-engine-api
npx wrangler pages secret put SENTRY_DSN --project-name=search-engine-api
npx wrangler pages variable put HEALTH_CANARY_ENABLED true --project-name=search-engine-api
```

> ⚠️ DO 바인딩은 wrangler CLI로 설정 불가 (Pages 제약 — wrangler.jsonc에 넣으면 deploy 거부).
> 반드시 Dashboard → Functions에서 설정. 로컬은 wrangler.dev.jsonc 사용.

### 3.3 설정 후 검증 사이클
```bash
bash scripts/verify-do-binding.sh   # A2~A4, B1 확인
curl -s https://search-engine-api.pages.dev/api/health | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('auth_required:', d['auth_required'])
print('rate_limiter_do:', d['features']['rate_limiter_do'])
print('analytics_engine:', d['features']['analytics_engine'])
print('status:', d['status'])"
```

---

## 4. 확인된 수정 내역 (이번 세션)
| 파일 | 수정 | 문제 |
|---|---|---|
| `scripts/verify-do-binding.sh` | 기본 WORKER_URL → `search-engine-api.pages.dev` | NXDOMAIN 도메인 참조 (스크립트 전체 오판 유발) |
| `scripts/verify-do-binding.sh` | `${var:15s}` bash 패딩 버그 → printf 패딩 | `set -u`에서 "value too great for base" — DO 라우트 검사 전체 스킵 |
| `README.md` | `ssak-search.pages.dev` → `search-engine-api.pages.dev` (7곳) | 존재하지 않는 도메인 참조 |
| `docs/01_CURRENT_STATE_ASSESSMENT.md` | 프로덕션 상태 기록 정정 | "HTTP 000 다운" 오판 → "가동 중 partial_outage" |

---

## 5. 모니터링·유지 (복구 후)
- **주간**: `bash scripts/verify-do-binding.sh` + eval CI 게이트
- **일일**: `/api/health` status + backends down 수, `auth_required` 유지 확인
- **변경 시**: DO/시크릿 변경 → redeploy → verify 스크립트 재실행
- **회귀 시**: docs/08_CHANGELOG.md에 기록

## 6. 잔여 리스크
- open mode 종료(A1) 전에는 **누구나 검색/추출 API를 무료로 소비** 가능 (비용·남용 위험)
- RATE_LIMITER 미바인딩 상태의 레이트리밋은 isolate별이므로 분산 공격에 취약
- brave는 키 없는 무료 폴백 백엔드가 존재하므로 down이 기능 중단을 의미하진 않음 (health 신호만 확인)
