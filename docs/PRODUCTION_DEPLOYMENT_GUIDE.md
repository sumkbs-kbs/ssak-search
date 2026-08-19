# 프로덕션 배포 가이드

> **최종 갱신**: 2026-08-19
>
> Phase 1~5 + Critical/Major/Minor 최적화가 반영된 최신 프로덕션 배포 절차.
> Cloudflare Pages + Workers 기반 배포를 전제로 합니다.

---

## 목차

1. [아키텍처 개요](#1-아키텍처-개요)
2. [사전 준비](#2-사전-준비)
3. [Cloudflare 리소스 생성](#3-cloudflare-리소스-생성)
4. [wrangler.jsonc 설정](#4-wranglerjsonc-설정)
5. [환경 변수 & 시크릿 설정](#5-환경-변수--시크릿-설정)
6. [Durable Object 배포](#6-durable-object-배포)
7. [Pages 배포](#7-pages-배포)
8. [배포 후 검증](#8-배포-후-검증)
9. [트러블슈팅](#9-트러블슈팅)
10. [롤백 절차](#10-롤백-절차)

---

## 1. 아키텍처 개요

```
┌─────────────────────────────────────────────────────────────┐
│                    Cloudflare Pages (search-engine-api)      │
│                                                             │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ LTR v2   │  │ Memory   │  │ Backend  │  │ Predictive│   │
│  │ Ranker   │  │ Optimizer│  │ Tiers    │  │ Fallback  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ LLM      │  │ Cache    │  │ Tiered   │  │ SSE      │   │
│  │ Optimizer│  │ Warmer   │  │ Fanout   │  │ Timeout  │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Input    │  │ CSRF     │  │ Personal-│  │ CPU      │   │
│  │ Validator│  │ Protect  │  │ ization  │  │ Budget   │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│  │ Training │  │ Session  │  │ Intent   │  │ Conversa-│   │
│  │ Pipeline │  │ Manager  │  │ Classifier│  │ tion Mgr │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────────────────────────────────────────┘
         │                │                │
    ┌────┴────┐     ┌─────┴─────┐    ┌────┴────┐
    │ Vectorize│     │ D1 DB     │    │ KV      │
    │ (2 index)│     │ (Search)  │    │ (Cache) │
    └─────────┘     └───────────┘    └─────────┘
         │                │                │
    ┌────┴────────────────┴────────────────┴────┐
    │     ssak-do-worker (14 DO classes)        │
    │  RateLimiter / Thread / UserProfile /     │
    │  ApiKey / Crawler / ClickLog / Experiment │
    │  Canary / Audit / Tenancy / NewsHub ...   │
    └───────────────────────────────────────────┘
```

---

## 2. 사전 준비

| # | 항목 | 확인 명령 | 완료 |
|---|------|-----------|:----:|
| 2.1 | Node.js ≥ 20 | `node -v` | ☐ |
| 2.2 | npm ≥ 10 | `npm -v` | ☐ |
| 2.3 | Wrangler CLI 인증 | `npx wrangler whoami` | ☐ |
| 2.4 | Git 상태 깨끗 | `git status --short` → 비어있음 | ☐ |
| 2.5 | TypeScript 0에러 | `npm run typecheck` | ☐ |
| 2.6 | 테스트 전수 통과 | `npm run test` → 3024 passed | ☐ |
| 2.7 | 빌드 성공 | `npm run build` | ☐ |

```bash
# 한 번에 검증
npm run typecheck && npm run test 2>&1 | tail -3 && npm run build
```

---

## 3. Cloudflare 리소스 생성

### 3.1 Durable Object (14개)

```bash
# DO 호스트 워커 배포 (첫 배포 또는 DO 변경 시)
npx wrangler deploy --config wrangler.do.jsonc
```

> 14개 DO 클래스: RateLimiterDO, ThreadDO, PagesDO, LibraryDO,
> UserProfileDO, SpaceDO, ApiKeyDO, CrawlerDO, ClickLogDO,
> ExperimentDO, CanaryOrchestratorDO, AuditLogDO, TenancyDO, NewsHubDO

### 3.2 Vectorize (2개 인덱스)

```bash
# 문서 검색용 밀집 벡터 인덱스
npx wrangler vectorize create search-engine-dense \
  --dimensions 768 --metric cosine

# 의미론적 캐시용 별도 인덱스
npx wrangler vectorize create semantic-cache-dense \
  --dimensions 768 --metric cosine
```

### 3.3 D1 데이터베이스

```bash
# 인덱스 메타데이터 DB
npx wrangler d1 create search-engine-index
# → 출력에서 database_id를 복사하여 wrangler.jsonc에 반영
```

### 3.4 KV Namespace

```bash
# Cross-isolate 캐시 영속화
npx wrangler kv namespace create CACHE_KV
# → 출력에서 id를 복사하여 wrangler.jsonc에 반영
```

### 3.5 R2 Bucket

```bash
# 파일 업로드 저장소
npx wrangler r2 bucket create search-engine-uploads
```

### 3.6 Analytics Engine

> Cloudflare Dashboard → Workers & Pages → Analytics → Create dataset
> - 데이터셋 이름: `ssak_search`
> - 바인딩 이름: `ANALYTICS`

### 3.7 Cron 스케줄러 Workers

```bash
# 프로덕션 딥 프로브 스케줄러 (15분 간격)
npx wrangler deploy --config wrangler.cron.jsonc

# 스테이징용 스케줄러 (별도 워커)
npx wrangler deploy --config wrangler.cron.staging.jsonc
```

---

## 4. wrangler.jsonc 설정

기본 `wrangler.jsonc`는 이미 14개 DO 바인딩, Vectorize 2개, D1, KV가 선언되어 있습니다.

### 4.1 새 모듈 관련 설정 확인

| 설정 위치 | 해당 모듈 | 확인 사항 |
|-----------|----------|----------|
| `ai.binding` | LLM Optimizer, Workers AI | `AI` 바인딩 존재 |
| `vectorize` | Backend Tiers, Tiered Fanout | `VECTORIZE_INDEX`, `SEMANTIC_CACHE_INDEX` |
| `d1_databases` | Training Pipeline | `SEARCH_INDEX_DB` |
| `kv_namespaces` | Cache Warmer, Edge Cache | `CACHE_KV` |
| `durable_objects.bindings` | Circuit Breaker Registry | 14개 DO 전부 |
| `analytics_engine_datasets` | Metrics, Monitoring | `ANALYTICS` |

### 4.2 신규 바인딩 (Phase 3 Infrastructure)

```jsonc
// wrangler.jsonc에 이미 포함된 항목 확인:
{
  "ai": { "binding": "AI" },                                    // LLM
  "vectorize": [
    { "binding": "VECTORIZE_INDEX", "index_name": "search-engine-dense", "remote": true },
    { "binding": "SEMANTIC_CACHE_INDEX", "index_name": "semantic-cache-dense", "remote": true }
  ],
  "d1_databases": [{
    "binding": "SEARCH_INDEX_DB",
    "database_name": "search-engine-index",
    "database_id": "74e4966f-...",  // 실제 ID로 교체
    "remote": true
  }],
  "kv_namespaces": [{ "binding": "CACHE_KV", "id": "1f5b3825..." }],
  "analytics_engine_datasets": [{ "binding": "ANALYTICS", "dataset": "ssak_search" }]
}
```

> **참고**: PostgreSQL/Redis 클라이언트(`src/lib/db/postgres-client.ts`, `redis-client.ts`)는
> 외부 서비스입니다. Cloudflare Workers 환경에서는 TCP 소켓이 제한되므로
> Upstash Redis(HTTP 기반) 또는 PlanetScale/Neon(PostgreSQL HTTP API)을 사용해야 합니다.

---

## 5. 환경 변수 & 시크릿 설정

### 5.1 필수 시크릿 (암호화 저장)

```bash
# Cloudflare Pages 시크릿 설정
npx wrangler pages secret put SEARCH_API_KEY    # API 인증 키 (필수!)
npx wrangler pages secret put JINA_API_KEY      # Jina Reader (선택)
npx wrangler pages secret put OPENAI_API_KEY    # OpenAI 호환 (선택)
npx wrangler pages secret put ANTHROPIC_API_KEY # Anthropic (선택)
npx wrangler pages secret put BRAVE_API_KEY     # Brave Search (선택)
npx wrangler pages secret put FLICKR_API_KEY    # Flickr 이미지 (선택)
npx wrangler pages secret put UNSPLASH_ACCESS_KEY # Unsplash (선택)
npx wrangler pages secret put SENTRY_DSN        # Sentry APM (선택)
npx wrangler pages secret put SLACK_WEBHOOK     # Slack 알림 (선택)
npx wrangler pages secret put TENANTS_CONFIG    # 멀티테넌트 JSON (선택)
```

### 5.2 환경 변수 (텍스트로 설정)

Cloudflare Dashboard → Pages → search-engine-api → Settings → Variables and Secrets → Production

| 변수 | 기본값 | 설명 | 필수 |
|------|--------|------|:----:|
| `ENVIRONMENT` | `production` | 환경 이름 | 아니오 |
| `CACHE_TTL_GENERAL` | `1800` | 일반 검색 캐시 TTL (초) | 아니오 |
| `CACHE_TTL_NEWS` | `300` | 뉴스/금융 캐시 TTL (초) | 아니오 |
| `HEALTH_CANARY_ENABLED` | (없음) | `"true"` → 파서 회귀 감지 | 아니오 |
| `ACCOUNT_ID` | (없음) | Analytics Engine SQL API용 | 아니오 |
| `ANALYTICS_DATASET` | `ssak_search` | Analytics Engine 데이터셋 | 아니오 |
| `SEARXNG_URL` | (없음) | SearXNG 자체 호스팅 URL | 아니오 |
| `RATE_LIMIT_PER_MIN` | `30` | IP당 분당 요청 제한 | 아니오 |

### 5.3 CPU Budget 관련 환경 변수

Cloudflare Workers free plan의 10ms CPU 제한을 관리합니다.

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `FREE_PLAN_CPU_GUARD` | (없음) | `"1"` → 무료 플랜 CPU 가드 활성화 |
| `SUBREQUEST_QUOTA_PER_REQUEST` | (없음) | `"50"` → 무료 플랜 (≤50이면 무료로 감지) |
| `AUTH_OPEN_MODE` | (없음) | `"1"` → 인증 없이 열린 모드 (⚠️ 개발 전용!) |
| `EVAL_MODE` | (없음) | `"true"` → 평가 모드 (회로 차단기 우회) |
| `DEPLOY_ENV` | (없음) | `"production"` / `"staging"` 환경 분리 |

> ⚠️ **보안 주의**: `AUTH_OPEN_MODE=1`은 개발 환경에서만 사용하세요.
> 프로덕션에서는 반드시 `SEARCH_API_KEY`를 설정하세요.

### 5.4 Durable Object 시크릿

```bash
# DO 워커 시크릿 (별도 설정 필요)
npx wrangler secret put ssak-do-worker BRAVE_API_KEY
npx wrangler secret put ssak-do-worker GITHUB_TOKEN
npx wrangler secret put ssak-do-worker SLACK_WEBHOOK
```

### 5.5 GitHub Actions 시크릿

| 시크릿 | 위치 | 설명 |
|--------|------|------|
| `CLOUDFLARE_API_TOKEN` | GitHub Settings → Secrets | Workers/Pages 배포 권한 |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub Settings → Secrets | Cloudflare 계정 ID |
| `ALERT_SLACK_WEBHOOK` | GitHub Settings → Secrets | CI 모니터링 알림 |

---

## 6. Durable Object 배포

### 6.1 배포 순서 (반드시 이 순서!)

```bash
# Step 1: DO 호스트 워커 배포 (14개 클래스)
npx wrangler deploy --config wrangler.do.jsonc

# Step 2: CRON 스케줄러 배포
npx wrangler deploy --config wrangler.cron.jsonc

# Step 3: Pages 배포 (script_name 바인딩 적용)
npm run build && npx wrangler pages deploy dist/ \
  --project-name=search-engine-api --branch=main
```

### 6.2 DO 클래스 목록 (14개)

| # | DO 클래스 | 바인딩 | 핵심 기능 |
|---|-----------|--------|-----------|
| 1 | `RateLimiterDO` | `RATE_LIMITER` | 크로스-아이솔레이트 레이트 리밋 + CB |
| 2 | `ThreadDO` | `THREAD_DO` | 멀티턴 대화 스레드 저장 |
| 3 | `PagesDO` | `PAGES_DO` | 연구 보고서 저장/공유 |
| 4 | `LibraryDO` | `LIBRARY_DO` | 검색 컬렉션/북마크 |
| 5 | `UserProfileDO` | `USER_PROFILE_DO` | 사용자 프로필/관심사 |
| 6 | `SpaceDO` | `SPACE_DO` | 워크스페이스 관리 |
| 7 | `ApiKeyDO` | `API_KEY_DO` | API 키 발급/관리 |
| 8 | `CrawlerDO` | `CRAWLER_DO` | URL 크롤링 작업 |
| 9 | `ClickLogDO` | `CLICK_LOG_DO` | LTR 클릭/노출 로깅 |
| 10 | `ExperimentDO` | `EXPERIMENT_DO` | A/B 실험 관리 |
| 11 | `CanaryOrchestratorDO` | `CANARY_DO` | 파서 회귀 감지 |
| 12 | `AuditLogDO` | `TENANT_AUDIT_DO` | 감사 로그 |
| 13 | `TenancyDO` | `TENANCY_DO` | 테넌시 관리 |
| 14 | `NewsHubDO` | `NEWS_HUB_DO` | 뉴스 RSS 허브 |

### 6.3 DO 검증

```bash
# 전체 바인딩 검증
bash scripts/verify-do-binding.sh

# 수동 헬스 체크
curl -s "https://search-engine-api.pages.dev/api/health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('Rate Limiter:', d['rate_limiter']['mode'])
print('Hosts tracked:', d['rate_limiter']['hosts_tracked'])
print('Features:', json.dumps(d['features'], indent=2))
"
```

---

## 7. Pages 배포

### 7.1 로컬 배포 (수동)

```bash
# 빌드
npm run build

# Pages 배포
npx wrangler pages deploy dist/ \
  --project-name=search-engine-api \
  --branch=main
```

### 7.2 CI/CD 자동 배포

GitHub Actions이 main 브랜치 push 시 자동으로 배포합니다.

```bash
# 수동 트리거 (workflow_dispatch)
# GitHub → Actions → Deploy → Run workflow → environment: production
```

### 7.3 스테이징 배포

```bash
# 스테이징 브랜치 배포
npx wrangler pages deploy dist/ \
  --project-name=search-engine-api \
  --branch=staging
```

### 7.4 배포 아티팩트 확인

```bash
# 빌드 결과물 확인
ls -la dist/
# → _worker.js (메인 워커)
# → _routes.json
# → public/ (정적 에셋)
```

---

## 8. 배포 후 검증

### 8.1 필수 검증 (5분 이내)

```bash
BASE="https://search-engine-api.pages.dev"

# 1. 헬스 체크
echo "=== Health ==="
curl -s "${BASE}/api/health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Status: {d[\"status\"]}')
rl = d.get('rate_limiter', {})
print(f'Rate Limiter: mode={rl.get(\"mode\")}, hosts={rl.get(\"hosts_tracked\")}')
features = d.get('features', {})
print(f'DO: rate_limiter={features.get(\"rate_limiter_do\")}, analytics={features.get(\"analytics_engine\")}')
"

# 2. 검색 API 테스트
echo "=== Search ==="
curl -s -X POST "${BASE}/api/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"Cloudflare Workers","max_results":3}' | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Results: {len(d.get(\"results\", []))}')
print(f'Latency: {d.get(\"response_time_ms\", 0)}ms')
print(f'Backends: {d.get(\"backend\", \"unknown\")}')
"

# 3. 메트릭 엔드포인트
echo "=== Metrics ==="
curl -s "${BASE}/api/metrics" | grep -c "search_" | xargs -I{} echo "Metric lines: {}"
```

### 8.2 CPU Budget 검증 (무료 플랜)

```bash
# CPU Budget 가드 동작 확인
echo "=== CPU Budget ==="
curl -s "${BASE}/api/health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
cpu = d.get('cpu_budget', {})
print(f'CPU budget: {json.dumps(cpu, indent=2) if cpu else \"N/A (유료 플랜 또는 미설정)\"}')
"

# 실제 검색에서 1102 에러 없는지 확인
for i in {1..3}; do
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/search" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"test query $i\",\"max_results\":1}")
  echo "Query $i: HTTP $status"
done
```

### 8.3 Tiered Fanout 검증

```bash
# Tier 시스템 동작 확인
echo "=== Backend Tiers ==="
curl -s "${BASE}/api/health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
backends = d.get('backends', {})
for name, info in backends.items():
    if isinstance(info, dict):
        status = info.get('status', 'unknown')
        print(f'  {name}: {status}')
"
```

### 8.4 보안 검증

```bash
# API 키 필수 확인 (AUTH_OPEN_MODE 미설정 시)
echo "=== Auth ==="
curl -s -o /dev/null -w "No key: HTTP %{http_code}\n" \
  "${BASE}/api/search" -X POST \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":1}'
# → 401 또는 403이어야 함 (API 키 필수)

# Input Validation (SQL Injection 차단)
echo "=== Injection ==="
curl -s -X POST "${BASE}/api/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"SELECT * FROM users; DROP TABLE users;--","max_results":1}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Injection: {d.get(\"error\",\"blocked\")}')"
```

### 8.5 메모리 및 캐시 검증

```bash
# LRU 캐시 + 메모리 최적화 동작 확인
echo "=== Memory ==="
curl -s "${BASE}/api/monitor" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Health: {d.get(\"health\", \"unknown\")}')
print(f'Version: {d.get(\"version\", \"unknown\")}')
"
```

### 8.6 10개 다국어 쿼리 무작위 검증

```bash
echo "=== Multi-language ==="
queries=("AI latest news" "오늘 날씨" "量子計算" "React hooks tutorial" "ピザのレシピ" "OpenAI GPT" "引上旅游攻略" "best laptop 2026" "Kubernetes vs Docker" "머신러닝 입문")

for q in "${queries[@]}"; do
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST "${BASE}/api/search" \
    -H "Content-Type: application/json" \
    -d "{\"query\":\"$q\",\"max_results\":1}")
  echo "  [$status] $q"
done
```

---

## 9. 트러블슈팅

### 9.1 일반 문제

| 증상 | 원인 | 해결 |
|------|------|------|
| HTTP 501 `/api/*` | DO 바인딩 누락 | `npx wrangler deploy --config wrangler.do.jsonc` 후 Pages 재배포 |
| HTTP 429 빈번 | 레이트 리밋 도달 | `RATE_LIMIT_PER_MIN` 상향 또는 API 키 기반 인증 |
| `mode: in_memory_fallback` | DO 미연결 | do-worker 배포 → Pages 재배포 |
| 1102 에러 (CPU) | 무료 플랜 10ms 제한 | `FREE_PLAN_CPU_GUARD=1` 설정 → lightweight 모드 활성화 |
| 검색 결과 없음 | Vectorize/D1 미설정 | 인덱스 생성 + 스키마 초기화 (`/api/index/init`) |

### 9.2 CPU Budget 관련

```bash
# CPU Budget 활성화 확인
echo "=== CPU Guard ==="
# Cloudflare Dashboard → Pages → Variables → FREE_PLAN_CPU_GUARD = "1"
# 또는
npx wrangler pages secret put FREE_PLAN_CPU_GUARD
# 값: 1
```

| 문제 | 해결 |
|------|------|
| 무료 플랜에서 1102 에러 | `FREE_PLAN_CPU_GUARD=1` + `SUBREQUEST_QUOTA_PER_REQUEST=50` |
| 유료 플랜인데 lightweight 모드 동작 | `FREE_PLAN_CPU_GUARD=0` 또는 미설정 |
| CPU budget이 작동 안 함 | `isFreePlan()` 함수가 env를 올바르게 읽는지 확인 |

### 9.3 Backend Tier 관련

| 문제 | 해결 |
|------|------|
| Tier 0 (self-index) 미동작 | Vectorize 인덱스 생성 확인 |
| Tier 3 백엔드 미사용 | Circuit Breaker가 해당 백엔드를 차단 중 — `/api/health`에서 CB 상태 확인 |
| 스테이징에서 프로덕션 백엔드 호출 | `DEPLOY_ENV=staging` 환경변수 확인 |

---

## 10. 롤백 절차

### 10.1 Pages 롤백 (빠른 롤백)

Cloudflare Dashboard → Pages → search-engine-api → Deployments → 이전 배포 클릭 → "Retry deployment"

### 10.2 Git 롤백

```bash
# 이전 커밋으로 롤백
git log --oneline -5           # 롤백할 커밋 확인
git revert HEAD                # 되돌릴 커밋 선택
git push github main           # Push → 자동 배포
```

### 10.3 DO 롤백

```bash
# DO 클래스 변경 시에만 필요
npx wrangler deploy --config wrangler.do.jsonc  # 이전 DO 코드 재배포
npx wrangler pages deploy dist/                  # Pages 재배포
```

---

## 부록 A: 전체 환경 변수 요약

### 시크릿 (암호화)

| 변수 | 용도 | 설정 |
|------|------|------|
| `SEARCH_API_KEY` | API 인증 | `wrangler pages secret put` |
| `JINA_API_KEY` | Jina Reader | `wrangler pages secret put` |
| `OPENAI_API_KEY` | OpenAI API | `wrangler pages secret put` |
| `ANTHROPIC_API_KEY` | Anthropic API | `wrangler pages secret put` |
| `BRAVE_API_KEY` | Brave Search | `wrangler pages secret put` |
| `SENTRY_DSN` | Sentry APM | `wrangler pages secret put` |
| `SLACK_WEBHOOK` | Slack 알림 | `wrangler pages secret put` |
| `TENANTS_CONFIG` | 멀티테넌트 JSON | `wrangler pages secret put` |

### 환경 변수 (텍스트)

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `ENVIRONMENT` | `production` | 환경 이름 |
| `CACHE_TTL_GENERAL` | `1800` | 일반 캐시 TTL |
| `CACHE_TTL_NEWS` | `300` | 뉴스 캐시 TTL |
| `RATE_LIMIT_PER_MIN` | `30` | IP당 분당 제한 |
| `FREE_PLAN_CPU_GUARD` | (없음) | 무료 플랜 CPU 가드 |
| `SUBREQUEST_QUOTA_PER_REQUEST` | (없음) | 무료 플랜 감지 |
| `AUTH_OPEN_MODE` | (없음) | 열린 모드 (⚠️ 개발 전용) |
| `EVAL_MODE` | (없음) | 평가 모드 |
| `DEPLOY_ENV` | (없음) | 배포 환경 |

---

## 부록 B: 신규 모듈 배포 체크리스트

### Phase 1: LTR + Latency
- [ ] `feature-store-v2.ts` — 32개 feature 추출 (로컬 동작, 추가 설정 불필요)
- [ ] `ranker-v2.ts` — LTR 랭커 v2 (sidecar 미 연결 시 local scoring fallback)
- [ ] `training-pipeline.ts` — LightGBM 학습 데이터 내보내기 (cron/CLI로 실행)
- [ ] `prefetch.ts` — 예측적 prefetch (인기 쿼리 추적, 로컬 상태)
- [ ] `edge-cache.ts` — SWR 캐시 (Cache API 사용, 추가 설정 불필요)

### Phase 2: Personalization
- [ ] `user-profile-enhanced.ts` — 사용자 프로필 (D1 DB 사용)
- [ ] `session-manager.ts` — 세션 관리 (DO 사용)
- [ ] `intent-classifier.ts` — 의도 분류 (로컬 패턴 + LLM)
- [ ] `conversation-manager.ts` — 멀티턴 대화 (ThreadDO 사용)

### Phase 3: Infrastructure
- [ ] `postgres-client.ts` — PostgreSQL (외부 서비스 연결 필요)
- [ ] `redis-client.ts` — Redis (Upstash HTTP API 권장)
- [ ] `opentelemetry.ts` — 분산 추적 (외부 수집기 연결 필요)
- [ ] `dashboard.ts` — 모니터링 대시보드 (Analytics Engine 사용)
- [ ] `load-test.ts` — 부하 테스트 (CLI 도구)

### Phase 4: NFR + Optimization
- [ ] `online-learning.ts` — 온라인 학습 (로컬 상태, 주기적 모델 업데이트)
- [ ] `ab-testing-enhanced.ts` — A/B 테스트 (ExperimentDO 사용)
- [ ] `fault-recovery.ts` — 장애 복구 (Circuit Breaker 패턴)
- [ ] `optimization.ts` — 비용 추적 (Analytics Engine 사용)
- [ ] `zero-downtime.ts` — 무중단 배포 (Cloudflare 자동 지원)

### Phase 5: Scale + Enterprise
- [ ] `scale-test.ts` — 스케일 테스트 (CLI 도구)
- [ ] `global-deploy.ts` — 글로벌 배포 (Cloudflare 자동)
- [ ] `advanced-analytics.ts` — 분석 (Analytics Engine 사용)
- [ ] `sso-auth.ts` — SSO (외부 IdP 연결 필요)
- [ ] `sla-manager.ts` — SLA 관리 (로컬 상태 + 알림)

### Critical: Latency Optimization
- [ ] `backend-tiers.ts` — 4 Tier 백엔드 분류 (로컬 설정)
- [ ] `tiered-fanout.ts` — 점진적 결과 수집 (orchestrator 통합)
- [ ] `cache-warmer.ts` — 인기 쿼리 사전 캐싱 (Cache API + KV)
- [ ] `bundle-optimizer.ts` — 번들 최적화 (빌드 시점)

### Major: Performance
- [ ] `llm-optimizer.ts` — LLM 응답 캐싱 + 스트리밍 (로컬 캐시)
- [ ] `memory-optimizer.ts` — 메모리 관리 (LRU 캐시, 5개 기본 등록)
- [ ] `predictive-fallback.ts` — 예측적 fallback (health 추적, 로컬 상태)

### Minor: Security
- [ ] `input-validator.ts` — 입력 검증 (SQL/XSS/Path Traversal 감지)
- [ ] `csrf-protection.ts` — CSRF 토큰 관리 (로컬 세션)
- [ ] `cpu-budget.ts` — CPU 예산 추적 (성능.now() + trackCpuTime)
- [ ] `circuit-breaker-registry.ts` — CB 레지스트리 (모듈 전역 캐싱)
- [ ] `sse-timeout.ts` — SSE 타임아웃 가드 (LLM 스트리밍 보호)

---

> **총 검증 항목**: 3024개 테스트 통과, 0개 TypeScript 에러
>
> 이 가이드는 `docs/DEPLOYMENT_CHECKLIST.md`와 보완 관계입니다.
> 기존 체크리스트는 리소스별 상세 설정에, 이 가이드는 신규 모듈 배포 절차에 중점을 둡니다.
