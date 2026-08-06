# 12. DO·Analytics Engine 바인딩 설정 상세 운영 절차

> 작성일: 2026-08-06 · 근거: docs/11_PRODUCTION_RECOVERY_CHECKLIST + 프로덕션 실측(verify-do-binding.sh) + Cloudflare 공식 문서
> 대상: `search-engine-api` Pages 프로젝트 (프로덕션)
> ⚠️ **Pages 프로젝트 내에서 Durable Object를 생성/배포할 수 없음** (Cloudflare 공식 제약).
> DO는 별도 Workers로 배포된 후 Pages 프로젝트에 **바인딩**으로 연결해야 하며,
> 본 프로젝트는 DO 클래스를 `_worker.js`에 export하여 단일 배포로 동작 → Dashboard 바인딩만 필요.

---

## 0. 요약 — 목표 상태와 현재 상태

| 항목 | 현재 (2026-08-06 실측) | 목표 |
|---|---|---|
| RATE_LIMITER / RateLimiterDO | ❌ in-memory fallback | ✅ 바인딩 (`/api/health` → `rate_limiter_do: true`) |
| THREAD_DO / ThreadDO | ✅ 바인딩됨 (404) | ✅ 유지 |
| PAGES_DO / PagesDO | ❌ `/api/pages` 501 | ✅ 바인딩 → 4xx/200 |
| LIBRARY_DO / LibraryDO | ✅ 바인딩됨 (404) | ✅ 유지 |
| USER_PROFILE_DO / UserProfileDO | ✅ 바인딩됨 (404) | ✅ 유지 |
| SPACE_DO / SpaceDO | ⚠️ `/api/spaces` 500 | ✅ 바인딩 + 오류 해소 |
| API_KEY_DO / ApiKeyDO | ❌ `/api/keys` 501 | ✅ 바인딩 |
| CRAWLER_DO / CrawlerDO | ⚠️ 429 (동작 중, 레이트리밋) | ✅ 유지 |
| CLICK_LOG_DO / ClickLogDO | ❌ 미확인 | ✅ 바인딩 (LTR) |
| EXPERIMENT_DO / ExperimentDO | ❌ 미확인 | ✅ 바인딩 (A/B) |
| CANARY_DO / CanaryOrchestratorDO | ❌ 미확인 | ✅ 바인딩 (canary) |
| ANALYTICS / Analytics Engine | ✅ `analytics_engine: true` | ✅ 유지 (데이터셋 이름 검증 필요) |

> **완료 기준**: `bash scripts/verify-do-binding.sh` → `RATE_LIMITER DO: ACTIVE` + `Route checks: 8 bound / 0 missing` (이 스크립트는 8종 기준)
> + `npx tsx scripts/verify-analytics-binding.ts` → PASS + `curl /api/metrics | grep search_metrics_persistence` → `1`
> ⚠️ **CLICK_LOG_DO / EXPERIMENT_DO / CANARY_DO (3종)은 자동 검증 스크립트에 미포함** —
> `/api/ltr`, `/api/experiments`, `/api/canary`를 수동 스모크하여 501 소멸을 확인할 것 (§4 참고)

---

## 1. 사전 준비 (5분)

### 1.1 필요한 권한·정보
- Cloudflare 계정에서 **Pages 편집 권한** (Dashboard 접근) 또는 **Pages Write API 토큰**
- 프로젝트명: `search-engine-api` (wrangler.jsonc `name`와 일치)
- DO 바인딩 이름·클래스는 **반드시 아래 표와 정확히 일치** (대소문자 포함)

### 1.2 바인딩 이름 ↔ 클래스 ↔ 기능 매핑 (단일 소스)

| # | Binding name | Class name | 기능 (미바인딩 시) | 우선순위 |
|---|---|---|---|---|
| 1 | `RATE_LIMITER` | `RateLimiterDO` | 크로스-아이솔레이트 레이트리밋·서킷브레이커 → isolate별 fallback | 🔴 최우선 |
| 2 | `PAGES_DO` | `PagesDO` | `/api/pages` 리포트 저장 → **501** | 🔴 |
| 3 | `API_KEY_DO` | `ApiKeyDO` | `/api/keys` 키 관리 → **501** | 🔴 |
| 4 | `SPACE_DO` | `SpaceDO` | `/api/spaces` 워크스페이스 → **500** | 🟡 |
| 5 | `THREAD_DO` | `ThreadDO` | `/api/chat` 대화 스레드 | 🟡 (이미 ✅) |
| 6 | `LIBRARY_DO` | `LibraryDO` | `/api/library` 컬렉션 | 🟢 (이미 ✅) |
| 7 | `USER_PROFILE_DO` | `UserProfileDO` | `/api/profile` 개인화 | 🟢 (이미 ✅) |
| 8 | `CRAWLER_DO` | `CrawlerDO` | `/api/crawl` URL 수집 | 🟢 (동작 중) |
| 9 | `CLICK_LOG_DO` | `ClickLogDO` | `/api/ltr` 클릭·노출 로깅 | 🟢 |
| 10 | `EXPERIMENT_DO` | `ExperimentDO` | `/api/experiments` A/B 테스트 | 🟢 |
| 11 | `CANARY_DO` | `CanaryOrchestratorDO` | `/api/canary` 파서 회귀 감지 | 🟢 |

> 코드 export 확인: `src/index.tsx` 하단 `export { RateLimiterDO, ThreadDO, PagesDO, LibraryDO, UserProfileDO, SpaceDO, ApiKeyDO, CrawlerDO, ClickLogDO, ExperimentDO, CanaryOrchestratorDO }` (11개 전부)

### 1.3 현 상태 스냅샷 (변경 전 기록)
```bash
bash scripts/verify-do-binding.sh > /tmp/do-before.txt
curl -s https://search-engine-api.pages.dev/api/health > /tmp/health-before.json
```

---

## 2. DO 8종 바인딩 설정 절차

> Cloudflare 공식 문서: "To bind your Durable Object to your Pages Function, configure via the Cloudflare dashboard or your Pages project's Wrangler configuration file. You cannot create and deploy a Durable Object within a Pages project."

### 2.1 Dashboard 경로 (권장 — 최초 설정)

**Step 1. 프로젝트 진입**
1. https://dash.cloudflare.com/ 로그인
2. 좌측 **Workers & Pages** → **Pages** → `search-engine-api` 클릭

**Step 2. 바인딩 추가 (8개 반복)**
1. **Settings** 탭 → **Functions** (또는 일부 UI는 **Settings → Bindings**) 
2. **Durable Objects** 섹션 → **Add binding**
3. 입력:
   - **Variable name**: 아래 표의 `Binding name` (예: `RATE_LIMITER`)
   - **Durable Object namespace / Class name**: 아래 표의 `Class name` (예: `RateLimiterDO`)
4. **Save** → 이어서 다음 바인딩 추가

| 순서 | Variable name | Class name |
|---|---|---|
| 1 | `RATE_LIMITER` | `RateLimiterDO` |
| 2 | `PAGES_DO` | `PagesDO` |
| 3 | `API_KEY_DO` | `ApiKeyDO` |
| 4 | `SPACE_DO` | `SpaceDO` |
| 5 | `THREAD_DO` | `ThreadDO` (있으면 스킵) |
| 6 | `LIBRARY_DO` | `LibraryDO` (있으면 스킵) |
| 7 | `USER_PROFILE_DO` | `UserProfileDO` (있으면 스킵) |
| 8 | `CRAWLER_DO` | `CrawlerDO` (있으면 스킵) |

**Step 3. 재배포 (필수!)**
> ⚠️ Cloudflare 공식: "Redeploy your project for the binding to take effect." 바인딩 저장만으로는 적용되지 않음.
1. **Deployments** 탭으로 이동
2. **Create deployment** (또는 **Retry deployment**) → 최신 커밋 재배포
3. 배포 완료(1~2분)까지 대기

### 2.2 CLI/API 경로 (반복 배포·CI 자동화용)

> Pages DO 바인딩은 `wrangler pages deploy`의 wrangler.jsonc `durable_objects`로 **선언할 수 없음**
> (Pages 제약 — `wrangler pages deploy`가 `durable_objects` binding을 거부, 2026-08-04 wrangler 4.112.0 실측).
> 로컬 dev는 `wrangler.dev.jsonc`가 전부 선언하므로 `wrangler pages dev`에서만 동작.

**방법 A — Pages 프로젝트 API (PUT):**
```bash
# project 바인딩 조회 (현 상태)
curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/pages/projects/search-engine-api" \
  | python3 -c "import sys,json; d=json.load(sys.stdin); p=d.get('result',{}); print('deployment_configs:', json.dumps(p.get('deployment_configs',{}), indent=2)[:2000])"
```

**방법 B — Dashboard (권장)**: 바인딩 추가는 Dashboard가 가장 안전. CI에서는 변경 후
기존 워크플로우(`.github/workflows/deploy.yml`)로 재배포:
```bash
# 재배포 (GitHub Actions workflow_dispatch → production) 또는 로컬에서:
npx wrangler pages deploy dist/ --project-name=search-engine-api --branch=main
```

> ⚠️ 실무 권장: **DO 바인딩 변경은 Dashboard에서 1회 수행** → 이후 바인딩은 배포에
> 유지되므로 재설정 불필요. Pages 프로젝트 API(`deployment_configs`)를 통한 DO 바인딩
> 설정은 공식 문서 표면이 제한적이라 **검증 필요** — 안정적 경로는 Dashboard UI.
> CI 자동화가 필요하면 바인딩은 Dashboard에서 1회 설정 후, 재배포만 워크플로우로 수행.

### 2.3 클래스 이름 오류 시 (트러블슈팅)

| 증상 | 원인 | 조치 |
|---|---|---|
| 저장 시 "Durable Object namespace not found" | Class name 불일치 또는 DO 미배포 | `src/index.tsx` export 이름과 대조 후 재시도 |
| 바인딩 저장 후에도 501 | Redeploy 누락 | **Deployments → Retry deployment** |
| `/api/health`의 `features.rate_limiter_do`가 여전히 false | 재배포 후 30초 캐시 | 30초 후 재조회 (`?cache-bust` 불필요, TTL 30s) |
| `/api/spaces`가 500 유지 | SPACE_DO는 바인딩되어도 내부 오류 가능 | 로그(Live Tail) 확인 → SpaceDO 코드 결함 분리 |

---

## 3. Analytics Engine 바인딩 설정 절차

> 현재 `analytics_engine: true` 확인됨. **데이터셋 이름 정합성 검증이 핵심.**

### 3.1 데이터셋 이름 규칙 (중요)

| 항목 | 값 |
|---|---|
| Binding name | `ANALYTICS` (src/lib/metrics.ts가 `env.ANALYTICS.writeDataPoint()` 호출) |
| wrangler.jsonc 실제 선언 | `"analytics_engine_datasets": [{ "binding": "ANALYTICS", "dataset": "ssak_search" }]` |
| 데이터셋 이름 규칙 | **언더스코어(`_`)만 허용** — 하이픈(`-`)은 배포 시 "Invalid dataset name" 거부 (2026-08-04 실측) |
| ⚠️ 기존 스크립트 불일치 | `scripts/verify-analytics-binding.ts`가 `SEARCH_API_METRICS`를 하드코딩 기대 → **수정됨** (이 문서 세션, §4) |

### 3.2 데이터셋 생성 (최초 1회)
1. Dashboard → **Workers & Pages** → **Analytics** → **Analytics Engine**
2. **Create dataset** → 이름: `ssak_search` (하이픈 금지)
3. 생성 완료 후 데이터셋 ID 복사 (조회용)

### 3.3 Pages에 바인딩 연결
1. Dashboard → **Workers & Pages** → **Pages** → `search-engine-api`
2. **Settings → Functions** (Bindings)
3. **Workers Analytics Engine Datasets** → **Add binding**
4. **Variable name**: `ANALYTICS` (정확히)
5. **Dataset**: `ssak_search` 선택
6. **Save & Redeploy** ⚠️ (재배포 필수)

### 3.4 데이터셋 조회 (SQL API, 선택)
```bash
curl -s -H "Authorization: Bearer $ANALYTICS_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/accounts/$ACCOUNT_ID/analytics_engine/sql" \
  -d "SELECT timestamp, blob1 AS endpoint, double1 AS latency_ms
       FROM ssak_search ORDER BY timestamp DESC LIMIT 10"
```
> 참조: scripts/analytics-queries.sql

---

## 4. 설정 후 검증 사이클 (완료 기준)

```bash
# 1) 구조 검증 — wrangler.jsonc 선언 (Analytics)
npx tsx scripts/verify-analytics-binding.ts
# ✅ PASS: Analytics Engine binding declared correctly (dataset: ssak_search)

# 2) 런타임 검증 — DO 8종 + 헬스
bash scripts/verify-do-binding.sh
# ✅ RATE_LIMITER is ACTIVE (mode: durable_object)
# ✅ Route checks: 8 bound / 0 missing / 0 skipped (of 8 DOs)

# 3) 런타임 검증 — 메트릭 영속화
npx tsx scripts/verify-metrics-persistence.ts https://search-engine-api.pages.dev
# ✅ PASS: Metrics persistence ACTIVE (search_metrics_persistence = 1)

# 4) 헬스 필드 확인
curl -s https://search-engine-api.pages.dev/api/health | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('status:', d['status'])
print('rate_limiter_do:', d['features']['rate_limiter_do'])
print('analytics_engine:', d['features']['analytics_engine'])
print('rate_limiter mode:', d['rate_limiter']['mode'])
print('auth_required:', d['auth_required'])
print('workers_ai:', d['backends']['workers_ai'])"
# 기대: AI 바인딩 설정 시 {"status": "operational", "latency_ms": 0}, 미설정 시 {"status": "disabled", "latency_ms": 0}

> ℹ️ **`backends.workers_ai` 복원 내역 (2026-08-06)**: S10 선택적 백엔드 리팩터에서 이 필드가 의도치
> 않게 소실됐던 것을 복원함 (`src/routes/health.ts` — `c.env.AI` 유무 → `{ status: 'operational'|'disabled',
> latency_ms: 0 }`, OPTIONAL_BACKENDS 루프 직후·`computeOverallStatus()` 앞에 배치 — 전역 상태 롤업에
> 무영향). 이후 **전체 backends 항목과 동일한 객체 형태로 통일**되었고, README.md:732의
> `jq '.backends.workers_ai.status'` 검증 계약과 정합. AI 바인딩은 Workers AI 답변 생성(Pro 모드)·임베딩·
> reranking에 사용되므로, 위 필드로 활성화 여부를 확인하면 됩니다. (회귀 가드: routes.test.ts workers_ai
> 검증 2건 — AI 미설정 {status:'disabled'} / 설정 {status:'operational'})

# 5) 기능 스모크 — 501 소멸 확인
for r in chat pages library profile spaces keys crawl ltr experiments canary; do
  echo -n "/api/$r -> "; curl -s -o /dev/null -w '%{http_code}\n' "https://search-engine-api.pages.dev/api/$r"
done
# 기대: pages/keys 501 소멸, spaces 500 소멸 (4xx/200로 정상화)
# ltr/experiments/canary: 스크립트 미커버 3종 — 501 소멸을 수동 확인
```

**완료 선언 조건 (전부 충족):**
- [ ] `verify-do-binding.sh` → RATE_LIMITER ACTIVE + 8/8 bound
- [ ] `verify-analytics-binding.ts` → PASS
- [ ] `verify-metrics-persistence.ts` → PASS (search_metrics_persistence=1)
- [ ] `/api/pages`, `/api/keys` 501 소멸
- [ ] `/api/spaces` 500 소멸
- [ ] `auth_required: true` (A1 병행 시)
- [ ] `/api/health`의 `backends.workers_ai.status` — AI 바인딩 설정 환경에서 `'operational'` (미설정은 `'disabled'`)

---

## 5. 모니터링·유지 (복구 후)

| 주기 | 작업 |
|---|---|
| 주간 | `bash scripts/verify-do-binding.sh` + `npx tsx scripts/verify-analytics-binding.ts` |
| 일일 | `/api/health` status + `features.rate_limiter_do` + `auth_required` 확인 |
| 변경 시 | DO/바인딩 변경 → **재배포** → 위 검증 1~5 재실행 |
| 회귀 시 | docs/08_CHANGELOG.md에 기록 + STRATEGIC_PLAN 상태 갱신 |

---

## 6. 롤백 절차

| 상황 | 절차 |
|---|---|
| 바인딩 추가 후 기능 악화 | Dashboard → 해당 바인딩 **Remove** → **Retry deployment** (이전 코드는 그대로 유지되므로 롤백은 바인딩 제거만으로 충분) |
| 배포 자체 회귀 | Deployments → 이전 성공 배포 → **Rollback to this deployment** |
| 바인딩 조회 | 위 §2.2 방법 A의 GET 요청으로 현재 deployment_configs 확인 |

---

## 7. 참조
- docs/11_PRODUCTION_RECOVERY_CHECKLIST.md (복구 체크리스트)
- CLOUDFLARE_BINDINGS_GUIDE.md (전체 바인딩 가이드 — 프로젝트명 `ssak-search` 기준, `search-engine-api`로 치환 필요)
- Cloudflare: https://developers.cloudflare.com/pages/functions/bindings/ (Pages 바인딩 + Redeploy 필수)
- Cloudflare: https://developers.cloudflare.com/pages/configuration/api/ (Pages REST API)
- scripts/verify-do-binding.sh · verify-do-binding.ts · verify-analytics-binding.ts · verify-metrics-persistence.ts
