# Production Deployment Checklist

> **Last updated**: 2026-07-21
>
> 한 눈에 확인하는 배포 전 점검 목록. 모든 항목이 ✅로 표시되어야 프로덕션 배포를
> 진행할 수 있습니다. 각 항목에는 설정 방법과 검증 커맨드가 포함되어 있습니다.

---

## 목차

1. [사전 준비](#1-사전-준비)
2. [환경 변수 & 시크릿](#2-환경-변수--시크릿)
3. [Durable Object 바인딩](#3-durable-object-바인딩)
4. [스토리지 (KV / R2 / D1)](#4-스토리지-kv--r2--d1)
5. [Workers AI & Analytics Engine](#5-workers-ai--analytics-engine)
6. [모니터링 & 알림](#6-모니터링--알림)
7. [CI/CD 파이프라인](#7-cicd-파이프라인)
8. [보안](#8-보안)
9. [테스트 & 빌드](#9-테스트--빌드)
10. [배포 후 검증](#10-배포-후-검증)
11. [장애 대응](#11-장애-대응)

---

## 1. 사전 준비

| # | 항목 | 설명 | 완료 |
|---|------|------|:----:|
| 1.1 | Cloudflare 계정 | Pages 기능이 활성화된 계정. [dash.cloudflare.com](https://dash.cloudflare.com) | ☐ |
| 1.2 | GitHub 저장소 | CI/CD 및 모니터링 워크플로우 연결. `git remote -v` 확인 | ☐ |
| 1.3 | Node.js >= 20 | `node -v` → `v20.x.x` 이상 | ☐ |
| 1.4 | npm / pnpm | `npm -v` 또는 `pnpm -v` | ☐ |
| 1.5 | Wrangler CLI 인증 | `npx wrangler whoami` → 계정 정보 표시 | ☐ |

```bash
# 필수 검증
echo "Node: $(node -v)"
echo "npm: $(npm -v)"
npx wrangler whoami 2>&1 | head -3
```

---

## 2. 환경 변수 & 시크릿

### 암호화 시크릿 (wrangler pages secret put)

Cloudflare Pages 환경에서 `wrangler pages secret put <NAME>`으로 설정합니다.
한 번 설정하면 대시보드에서 값이 표시되지 않습니다 (복호화 불가).

| # | 시크릿 | 필수 | 설명 |
|---|--------|:----:|------|
| 2.1 | `SEARCH_API_KEY` | **예** | API 인증 키 (공개 배포 시 반드시 설정) |
| 2.2 | `JINA_API_KEY` | 아니오 | Jina Reader API 키 (추출 품질 향상) |
| 2.3 | `OPENAI_API_KEY` | 아니오 | OpenAI 호환 엔드포인트용 키 |
| 2.4 | `ANTHROPIC_API_KEY` | 아니오 | Anthropic API 키 (Council 기능) |
| 2.5 | `TENANTS_CONFIG` | 아니오 | 멀티테넌트 설정 (JSON) |
| 2.6 | `FLICKR_API_KEY` | 아니오 | Flickr 이미지 검색 키 |
| 2.7 | `UNSPLASH_ACCESS_KEY` | 아니오 | Unsplash 이미지 검색 키 |
| 2.8 | `ANALYTICS_API_TOKEN` | 아니오 | Analytics Engine SQL API용 Cloudflare API 토큰 |
| 2.9 | `SEARXNG_API_KEY` | 아니오 | SearXNG 자체 호스팅 인증 키 |
| 2.10 | `EMBEDDING_API_KEY` | 아니오 | 커스텀 임베딩 API 키 |
| 2.11 | `EMBEDDING_ENDPOINT` | 아니오 | 커스텀 임베딩 엔드포인트 URL |

```bash
# 설정 명령어 예시
npx wrangler pages secret put SEARCH_API_KEY
npx wrangler pages secret put JINA_API_KEY
```

### 환경 변수 (wrangler pages variable put 또는 Pages Dashboard)

| # | 변수 | 기본값 | 설명 |
|---|------|--------|------|
| 2.11 | `CACHE_TTL_GENERAL` | `1800` | 일반 검색 캐시 TTL (초) |
| 2.12 | `CACHE_TTL_NEWS` | `300` | 뉴스/금융 캐시 TTL (초) |
| 2.13 | `HEALTH_CANARY_ENABLED` | (없음) | `"true"` 설정 시 Parser 회귀 감지 활성화 |
| 2.14 | `ACCOUNT_ID` | (없음) | Analytics Engine SQL API용 Cloudflare 계정 ID |
| 2.15 | `ANALYTICS_DATASET` | `SEARCH_API_METRICS` | Analytics Engine 데이터셋 이름 |
| 2.16 | `SEARXNG_URL` | (없음) | SearXNG 자체 호스팅 URL |

### GitHub Actions 시크릿

| # | 시크릿 | 필수 | 설명 | 설정 위치 |
|---|--------|:----:|------|-----------|
| 2.17 | `CLOUDFLARE_API_TOKEN` | **예** | Deploy 워크플로우 (Permissions: Workers, Pages) | GitHub → Settings → Secrets |
| 2.18 | `CLOUDFLARE_ACCOUNT_ID` | **예** | Deploy 워크플로우 | GitHub → Settings → Secrets |
| 2.19 | `ALERT_SLACK_WEBHOOK` | 아니오 | Monitor 워크플로우 알림 | GitHub → Settings → Secrets |

### 전체 설정 검증

```bash
echo "=== 암호화 시크릿 (설정 확인만) ==="
npx wrangler pages secret list 2>&1

echo "=== 환경 변수 (Pages Dashboard에서 확인) ==="
echo "https://dash.cloudflare.com/ → Pages → ssak-search → Settings → Variables"
```

---

## 3. Durable Object 바인딩

### 개요

Durable Object(DO)는 Cloudflare Workers의 상태 저장(sticky) 컴퓨팅 레이어입니다.
총 **8개**의 DO 클래스가 `src/index.tsx`에서 export되어 있습니다.

**중요**: Pages Functions에서 DO 바인딩은 `wrangler.jsonc`가 아닌 **Cloudflare Dashboard**에서 설정해야 합니다.
`wrangler.jsonc`의 `durable_objects.bindings`는 로컬 개발(wrangler pages dev)에서만 사용됩니다.

---

### DO 클래스별 상세 설정 가이드

#### 🔴 반드시 설정할 것 (필수)

| # | DO 클래스 | 바인딩 이름 | 파일 | 설정 우선순위 | 없을 때 동작 |
|---|-----------|-------------|------|:------------:|-------------|
| 3.1 | `RateLimiterDO` | `RATE_LIMITER` | `src/lib/rate-limiter-do.ts` | **⭐ 최우선** | 인메모리 fallback (isolate별, 콜드스타트 리셋) |

#### 🟡 적극 권장 (상태 유지 기능)

| # | DO 클래스 | 바인딩 이름 | 파일 | 관련 라우트 | 없을 때 동작 |
|---|-----------|-------------|------|-----------|-------------|
| 3.2 | `ApiKeyDO` | `API_KEY_DO` | `src/lib/api-key-do.ts` | `/api/keys` | 501 응답 |
| 3.3 | `ThreadDO` | `THREAD_DO` | `src/lib/thread-do.ts` | `/api/chat` | 501 응답 |
| 3.4 | `PagesDO` | `PAGES_DO` | `src/lib/pages-do.ts` | `/api/pages` | 501 응답 |
| 3.5 | `LibraryDO` | `LIBRARY_DO` | `src/lib/library-do.ts` | `/api/library` | 501 응답 |

#### 🟢 선택 사항 (고급 기능)

| # | DO 클래스 | 바인딩 이름 | 파일 | 관련 라우트 | 없을 때 동작 |
|---|-----------|-------------|------|-----------|-------------|
| 3.6 | `UserProfileDO` | `USER_PROFILE_DO` | `src/lib/user-profile-do.ts` | `/api/profile` | 501 응답 |
| 3.7 | `SpaceDO` | `SPACE_DO` | `src/lib/space-do.ts` | `/api/spaces` | 501 응답 |
| 3.8 | `CrawlerDO` | `CRAWLER_DO` | `src/lib/crawler-do.ts` | `/api/crawl` | 501 응답 |

---

### 단계별 설정 방법

#### 3.1 개발 환경 (wrangler pages dev)

로컬 개발에서 DO를 활성화하려면 `wrangler.jsonc`에 바인딩을 추가합니다:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "name": "RATE_LIMITER", "class_name": "RateLimiterDO" },
      { "name": "API_KEY_DO", "class_name": "ApiKeyDO" },
      { "name": "THREAD_DO", "class_name": "ThreadDO" },
      { "name": "PAGES_DO", "class_name": "PagesDO" },
      { "name": "LIBRARY_DO", "class_name": "LibraryDO" },
      { "name": "USER_PROFILE_DO", "class_name": "UserProfileDO" },
      { "name": "SPACE_DO", "class_name": "SpaceDO" },
      { "name": "CRAWLER_DO", "class_name": "CrawlerDO" },
    ]
  }
}
```

> ⚠️ `wrangler.jsonc`의 `durable_objects.bindings`는 로컬 개발 전용입니다.
> 프로덕션 배포 시에는 이 설정이 무시됩니다. 반드시 Dashboard에서도 설정하세요.

#### 3.2 프로덕션 환경 (Cloudflare Dashboard)

##### Step 1: Dashboard 접속
1. [Cloudflare Dashboard](https://dash.cloudflare.com/) 로그인
2. 좌측 메뉴 → **Workers & Pages** → **ssak-search**
3. 상단 탭 → **Settings** → **Functions**

##### Step 2: DO 바인딩 추가

**RATE_LIMITER (최우선):**
```
1. Settings → Functions → Durable Objects → "Add binding"
2. Namespace name: RATE_LIMITER
3. Class name: RateLimiterDO
4. "Save"
```

**나머지 DO (위와 동일한 방법으로 반복):**

| 바인딩 이름 | Class 이름 |
|-------------|-----------|
| `RATE_LIMITER` | `RateLimiterDO` |
| `API_KEY_DO` | `ApiKeyDO` |
| `THREAD_DO` | `ThreadDO` |
| `PAGES_DO` | `PagesDO` |
| `LIBRARY_DO` | `LibraryDO` |
| `USER_PROFILE_DO` | `UserProfileDO` |
| `SPACE_DO` | `SpaceDO` |
| `CRAWLER_DO` | `CrawlerDO` |

##### Step 3: 재배포
```
1. "Save & Redeploy" 버튼 클릭
2. 배포 완료까지 약 1-2분 소요
3. 배포 상태가 "Success"로 표시되는지 확인
```

---

### 3.3 DO 설정 검증

전용 검증 스크립트로 모든 DO 바인딩 상태를 한 번에 확인:

```bash
# 모든 DO 바인딩 검증
bash scripts/verify-do-binding.sh

# 특정 DO만 수동 확인 (health 엔드포인트)
curl -s https://your-worker.pages.dev/api/health | \
  python3 -c "
import sys, json
d = json.load(sys.stdin)
print('RATE_LIMITER:', d.get('features', {}).get('rate_limiter_do', False))
print('Rate Limiter Mode:', d.get('rate_limiter', {}).get('mode', 'unknown'))
"

# 각 DO별 라우트 호출로 검증 (501이 아닌 200/4xx가 반환되어야 함)
for route in chat pages library profile spaces crawl keys; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "https://your-worker.pages.dev/api/${route}")
  if [ "$status" = "501" ]; then
    echo "⚠️  /api/${route}: DO 바인딩 누락 (501)"
  elif [ "$status" != "000" ]; then
    echo "✅ /api/${route}: 응답 ${status}"
  fi
done
```

---

### 3.4 DO별 기능 요약

| 바인딩 | Class | 기능 요약 | DB 사용 |
|--------|-------|---------|:-------:|
| `RATE_LIMITER` | `RateLimiterDO` | 크로스-아이솔레이트 레이트 리밋 + 회로 차단기 | SQLite 내장 |
| `API_KEY_DO` | `ApiKeyDO` | API 키 발급/조회/삭제, 키-사용자 매핑 | SQLite 내장 |
| `THREAD_DO` | `ThreadDO` | 대화 스레드 저장/조회 (멀티턴 채팅) | SQLite 내장 |
| `PAGES_DO` | `PagesDO` | 연구 보고서 생성/공유 | SQLite 내장 |
| `LIBRARY_DO` | `LibraryDO` | 검색 컬렉션 저장/북마크 | SQLite 내장 |
| `USER_PROFILE_DO` | `UserProfileDO` | 사용자 프리퍼런스 저장 | SQLite 내장 |
| `SPACE_DO` | `SpaceDO` | 워크스페이스/프로젝트 관리 | SQLite 내장 |
| `CRAWLER_DO` | `CrawlerDO` | 웹 크롤링 작업 스케줄링/실행 | SQLite 내장 |

> 모든 DO는 Cloudflare Durable Object의 내장 SQLite를 사용하므로 별도의 DB 설정이 필요 없습니다.

---

### 3.5 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| `curl /api/chat` → HTTP 501 | `THREAD_DO` 바인딩 누락 | Dashboard에서 THREAD_DO 추가 후 redeploy |
| `curl /api/health` → rate_limiter_do: false | `RATE_LIMITER` 바인딩 누락 | Dashboard에서 RATE_LIMITER 추가 후 redeploy |
| 로컬 dev에서 DO 미동작 | wrangler.jsonc에 bindings 누락 | wrangler.jsonc에 durable_objects.bindings 추가 |
| 배포 후 DO 변경이 반영 안 됨 | 캐시된 이전 버전 | Dashboard에서 새 deployment 강제 트리거 |

---

## 4. 스토리지 (KV / R2 / D1)

| # | 리소스 | 바인딩 이름 | 필수 | 설명 |
|---|--------|-------------|:----:|------|
| 4.1 | KV Namespace | `CACHE_KV` | 아니오 | 영구 응답 캐시 (Cache API 없이 콜드스타트 보존). 없으면 Cache API만 사용 (per-isolate, cold start 시 소실) |
| 4.2 | R2 Bucket | `UPLOAD_BUCKET` | 아니오 | 파일 업로드 저장소 (`search-engine-uploads`) |
| 4.3 | D1 Database | `SEARCH_INDEX_DB` | 아니오 | 인덱스 메타데이터/URL 중요도 |
| 4.4 | Vectorize Index | `VECTORIZE_INDEX` | 아니오 | 밀집 벡터 검색 인덱스 |
| 4.5 | Queue | `INDEX_QUEUE` | 아니오 | 비동기 URL 인덱싱 |

### 설정 방법 (선택사항)

#### KV Namespace
```bash
# 1. 대시보드에서 생성
# Cloudflare Dashboard → Workers & Pages → KV → Create namespace
# name: search-engine-cache

# 2. Pages 바인딩 설정
# Cloudflare Dashboard → Pages → ssak-search → Settings → Bindings
# → KV → Add binding (Variable name: CACHE_KV)
```

#### R2 Bucket
```bash
# Wrangler CLI로 생성
npx wrangler r2 bucket create search-engine-uploads

# Pages 바인딩 설정 (Dashboard)
# → R2 → Add binding (name: UPLOAD_BUCKET, bucket: search-engine-uploads)
```

### 스토리지 검증

```bash
# KV (설정된 경우)
curl -s https://your-worker.pages.dev/api/health | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print('KV:', 'CACHE_KV' in str(d.get('features',{})))"
```

---

## 5. Workers AI & Analytics Engine

### Workers AI

| # | 항목 | 필수 | 설명 |
|---|------|:----:|------|
| 5.1 | AI Binding (`AI`) | 아니오 | AI 요약 생성 (`include_answer=true`) |
| 5.2 | Workers AI 유료 플랜 | 아니오 | 무료 티어는 제한적 (일 10K tokens) |

```bash
# AI 바인딩 설정
# Cloudflare Dashboard → Pages → ssak-search → Settings → Functions
# → AI → Add binding (name: AI)

# 검증
curl -s https://your-worker.pages.dev/api/health | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print('AI:', d['features'].get('answer', False))"
```

### Workers Analytics Engine

| # | 항목 | 필수 | 설명 |
|---|------|:----:|------|
| 5.3 | 데이터셋 생성 | **예** (모니터링 시) | `SEARCH_API_METRICS` (이름 자유) |
| 5.4 | `ANALYTICS` 바인딩 | **예** (모니터링 시) | Variable name: `ANALYTICS` |
| 5.5 | `ANALYTICS_API_TOKEN` | 아니오 | SQL API 쿼리용 API 토큰 |
| 5.6 | `ACCOUNT_ID` | 아니오 | SQL API용 계정 ID |
| 5.7 | Grafana 프록시 Worker | 아니오 | `/api/analytics-proxy` 엔드포인트 |

```bash
# Analytics Engine 설정
# 1. Cloudflare Dashboard → Workers & Pages → Analytics → Create dataset
#    name: SEARCH_API_METRICS
# 2. Pages → ssak-search → Settings → Bindings
#    → Workers Analytics Engine Datasets → Add binding
#    (Variable name: ANALYTICS, Dataset: SEARCH_API_METRICS)
# 3. Save & Redeploy

# 검증
curl -s https://your-worker.pages.dev/api/metrics | grep search_metrics_persistence
# Expected: search_metrics_persistence 1
```

---

## 6. 모니터링 & 알림

### 6.1 Prometheus 메트릭

| # | 항목 | 필수 | 설명 |
|---|------|:----:|------|
| 6.1 | `/api/metrics` 엔드포인트 | 자동 | Prometheus-format 메트릭 제공 |
| 6.2 | Prometheus 스크래핑 | 아니오 | 외부 Prometheus 서버 설정 |

### 6.2 Grafana 대시보드

| # | 항목 | 경로 | 설명 |
|---|------|------|------|
| 6.3 | Grafana Dashboard | `grafana/dashboard.json` | 25개 패널 (백엔드 상태, 지연시간, 캐시, SLO) |
| 6.4 | Prometheus Alert Rules | `grafana/alerts.yml` | 14개 알림 규칙 |
| 6.5 | Prometheus Scrape Config | `grafana/prometheus.yml` | Prometheus 설정 예시 |
| 6.6 | Analytics Engine Proxy | `/api/analytics-proxy` | Simple JSON 데이터소스 (Grafana 연동). Grafana에서 `grafana-simple-json-datasource` 플러그인 설치 필요 |

```bash
# Grafana 대시보드 임포트
# Grafana → Import → grafana/dashboard.json
# → DS_PROMETHEUS (Prometheus 데이터소스)
# → DS_ANALYTICS (Simple JSON 데이터소스, 선택)
```

### 6.3 Datadog 연동 (선택)

| # | 항목 | 설명 | 검증 |
|---|------|------|:----:|
| 6.7 | Datadog API Key | Organization Settings → API Keys | ☐ |
| 6.8 | Logpush Job | `scripts/create-logpush-datadog.sh` 실행 | ☐ |
| 6.9 | Datadog Dashboard | `datadog/dashboard.json` 임포트 | ☐ |
| 6.10 | Datadog Monitors | SSRF, Auth Failure, Rate Limit 모니터 | ☐ |

```bash
# Logpush 설정
export CLOUDFLARE_API_TOKEN="..."
export CLOUDFLARE_ACCOUNT_ID="..."
export DATADOG_API_KEY="..."
bash scripts/create-logpush-datadog.sh
```

### 6.4 SLO 모니터링

| SLO | 대상 | 측정 | 알림 조건 |
|-----|:----:|------|----------|
| 가용성 | 99.9% | 5xx 비율 < 0.1% | 2분간 0.1% 초과 → Critical |
| 지연시간 (p50) | < 3s | 검색 지연시간 중앙값 | 5분간 8s 초과 → Warning |
| 지연시간 (p99) | < 15s | 검색 지연시간 p99 | 5분간 15s 초과 → Warning |
| 캐시 히트율 | > 60% | 히트/(히트+미스) | 15분간 30% 미만 → Warning |

```bash
# SLO 리포트 확인
curl -s https://your-worker.pages.dev/api/monitor | python3 -m json.tool
```

---

## 7. CI/CD 파이프라인

### 7.1 GitHub Actions 워크플로우

| # | 워크플로우 | 파일 | 트리거 | 설명 |
|---|-----------|------|--------|------|
| 7.1 | **CI** | `.github/workflows/ci.yml` | PR, push to main | 타입체크 + 테스트 + 빌드 (병렬) |
| 7.2 | **Deploy** | `.github/workflows/deploy.yml` | main push, workflow_dispatch | CI 아티팩트 재사용 → Pages 배포 |
| 7.3 | **Monitor** | `.github/workflows/monitor.yml` | 15분마다 스케줄 | `/api/health` 체크 → Slack 알림 |

```bash
# CI/CD 상태 확인
# GitHub → Actions → 모든 워크플로우가 ✅ 상태인지 확인

# 수동 배포 테스트
npx wrangler pages deploy dist/ --project-name=ssak-search --branch=main
```

### 7.2 package.json 스크립트

```bash
# 필수 스크립트 (모두 통과해야 배포 가능)
npm run typecheck               # 0 에러 필수
npm run test -- --project unit # 524/524 통과 필수
npm run build                  # dist/_worker.js 생성
npm run typecheck:all          # src + tests 통합 검증
npm run test:all               # unit + integration
npm run test:coverage          # 커버리지 리포트
```

---

## 8. 보안

| # | 항목 | 설명 | 상태 |
|---|------|------|:----:|
| 8.1 | **SEARCH_API_KEY 설정** | API 인증 키 (open 모드는 위험) | ☐ |
| 8.2 | **CSP 헤더** | Content-Security-Policy (script-src, style-src 등) | ☐ |
| 8.3 | **HSTS 헤더** | Strict-Transport-Security (min 6개월) | ☐ |
| 8.4 | **SSRF 보호** | `assertSafeFetchUrl()` — 사설 IP/메타데이터 거부 | ☐ |
| 8.5 | **Rate Limiting** | Per-IP 30 req/min (DO 바인딩 권장) | ☐ |
| 8.6 | **감사 로깅** | `audit.ts` — 인증 실패, SSRF 시도, Rate Limit 초과 로깅 | ☐ |
| 8.7 | **Logpush 설정** | 감사 로그 → Datadog/R2/Splunk | ☐ |
| 8.8 | **입력 크기 제한** | body 64KB, domain 20개, extract URL 20개 | ☐ |
| 8.9 | **CORS 설정** | `/api/*`에 대해 origin: '*' 허용 | ☐ |

### 보안 검증

```bash
# CSP 헤더 확인
curl -sI https://your-worker.pages.dev/ | grep -i content-security-policy

# HSTS 확인
curl -sI https://your-worker.pages.dev/ | grep -i strict-transport-security

# SSRF 보호 확인 (extract 엔드포인트)
curl -s -X POST https://your-worker.pages.dev/api/extract \
  -H "Content-Type: application/json" \
  -d '{"urls":["http://169.254.169.254/latest/meta-data/"]}' | \
  python3 -c "import sys,json; print(json.load(sys.stdin))"

# 인증 테스트 (키가 설정된 경우)
curl -s -o /dev/null -w "HTTP %{http_code}\n" \
  https://your-worker.pages.dev/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":1}'
# Expected (with SEARCH_API_KEY): 401
# Expected (without SEARCH_API_KEY): 200
```

---

## 9. 테스트 & 빌드

### 9.1 사전 점검

```bash
# === 1. 타입체크 ===
npx tsc --noEmit
echo "Exit code: $?"  # 0이어야 함

# === 2. 단위 테스트 ===
npx vitest run --project unit --reporter=verbose
# 23 files, 524 tests passed

# === 3. 통합 테스트 (선택) ===
# npx vitest run --project integration --reporter=verbose
# (인터넷 연결 필요, 레이트 리밋 주의)

# === 4. 빌드 ===
npm run build
# Expected: dist/_worker.js (545 kB, 138 kB gzip)

# === 5. 로컬 개발 서버 테스트 (선택) ===
# npm run preview
# curl http://localhost:8788/api/health
```

### 9.2 필수 통과 기준

| 검사 | 기준 | 현재 상태 |
|------|:----:|:---------:|
| TypeScript 에러 | **0** | ✅ 0 |
| 단위 테스트 통과 | **524/524** | ✅ 524/524 |
| 통합 테스트 통과 | **N/A** (인터넷 의존) | — |
| 빌드 성공 | `dist/_worker.js` 생성 | ✅ 545 kB |
| 빌드 크기 제한 | < 1 MB | ✅ |

---

## 10. 배포 후 검증

배포 완료 후 아래 검증을 순서대로 실행합니다.

### 10.1 기본 엔드포인트

```bash
BASE="https://your-worker.pages.dev"

echo "=== 1. 헬스 체크 ==="
curl -s "${BASE}/api/health" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Status: {d[\"status\"]}')
print(f'Features: rate_limiter_do={d[\"features\"].get(\"rate_limiter_do\",False)}, '
      f'analytics={d[\"features\"].get(\"analytics_engine\",False)}, '
      f'ai={d[\"features\"].get(\"answer\",False)}')
print(f'Auth: {d[\"auth_required\"]}')
print(f'Rate Limiter: mode={d[\"rate_limiter\"][\"mode\"]}, '
      f'hosts={d[\"rate_limiter\"][\"hosts_tracked\"]}')
backends = [k for k,v in d['backends'].items() if isinstance(v,dict)]
healthy = sum(1 for k in backends if d['backends'][k].get('status')=='operational')
print(f'Backends: {healthy}/{len(backends)} healthy')
"

echo "=== 2. 메트릭 ==="
curl -s "${BASE}/api/metrics" | grep -E "^(search_requests|search_errors|search_latency|cache_hit)" | head -10

echo "=== 3. 검색 API ==="
curl -s -X POST "${BASE}/api/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":1}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(f'Query: {d[\"query\"]}, Results: {len(d[\"results\"])}, '
        f'Time: {d[\"response_time_ms\"]}ms, Backend: {d[\"backend\"]}')"

echo "=== 4. PWA 매니페스트 ==="
curl -s "${BASE}/manifest.json" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Name: {d[\"name\"]}, Display: {d[\"display\"]}')"

echo "=== 5. Docs 페이지 ==="
curl -s -o /dev/null -w "HTTP %{http_code} (%{size_download} bytes)\n" "${BASE}/docs"

echo "=== 6. OpenAPI 스펙 ==="
curl -s -o /dev/null -w "HTTP %{http_code} (%{size_download} bytes)\n" "${BASE}/openapi.yaml"

echo "=== 7. 모니터 엔드포인트 ==="
curl -s "${BASE}/api/monitor" | python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Health: {d[\"health\"]}, Version: {d[\"version\"]}')"
```

### 10.2 고급 기능 검증

```bash
echo "=== 8. AI 답변 ==="
curl -s -X POST "${BASE}/api/search" \
  -H "Content-Type: application/json" \
  -d '{"query":"what is cloudflare","max_results":3,"include_answer":true}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(f'Answer: {\"yes\" if d.get(\"answer\") else \"no\"}, '
        f'Results: {len(d[\"results\"])}')"

echo "=== 9. 뉴스 ==="
curl -s -X POST "${BASE}/api/news" \
  -H "Content-Type: application/json" \
  -d '{"query":"technology","max_results":3}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); print(f'News results: {len(d.get(\"results\",[]))}')"

echo "=== 10. 추출 ==="
curl -s -X POST "${BASE}/api/extract" \
  -H "Content-Type: application/json" \
  -d '{"urls":["https://example.com"]}' | \
  python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(f'Extract results: {len(d.get(\"results\",[]))}')"
```

### 10.3 모니터링 검증

```bash
echo "=== 11. DO 바인딩 ==="
bash scripts/verify-do-binding.sh

echo "=== 12. Analytics Engine 프록시 ==="
curl -s "${BASE}/api/analytics-proxy/" | python3 -m json.tool

echo "=== 13. SLO 리포트 ==="
curl -s "${BASE}/api/monitor" | python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(f'SLO: {d.get(\"slos\",{})}')"

echo "=== 14. 사용량 ==="
curl -s "${BASE}/api/usage" | python3 -c "import sys,json; d=json.load(sys.stdin); \
  print(f'Requests: {d[\"totalRequests\"]}, Errors: {d[\"totalErrors\"]}, '
        f'Avg Subreq: {d[\"avgSearchSubrequests\"]}')"
```

---

## 11. 장애 대응

### 11.1 주요 장애 시나리오

| 증상 | 원인 | 대응 |
|------|------|------|
| `/api/search`가 500 반환 | 백엔드 파서 회귀 (Bing/Naver HTML 변경) | `HEALTH_CANARY_ENABLED=true`로 감지 후 hotfix |
| 모든 검색이 0건 반환 | 모든 백엔드 차단 (IP 밴) | DuckDuckGo lite 폴백 확인, IP 로테이션 |
| Rate limit 미작동 | `RATE_LIMITER` DO 바인딩 누락 | Dashboard에서 DO 바인딩 추가 후 redeploy |
| AI 답변 미생성 | Workers AI 바인딩 누락 또는 할당량 소진 | Dashboard에서 AI 바인딩 확인, 유료 플랜 고려 |
| 메트릭 리셋 | `ANALYTICS` 바인딩 누락 | Analytics Engine 데이터셋 생성 + 바인딩 추가 |
| `Subrequest quota exceeded` | 무료 플랜 (50/req) 초과 | 캐시 TTL 증가, Pages Paid 플랜 업그레이드 |
| Cold start 지연 | 첫 요청이 30초 이상 지연 | `wrangler.jsonc`에 `workers_dev` = false 설정 |
| CORS 에러 | 브라우저에서 API 직접 호출 | API 호출은 백엔드 서버에서 실행 |

### 11.2 롤백 절차

```bash
# 1. 이전 배포로 롤백
# Cloudflare Dashboard → Pages → ssak-search → Deployments
# → 이전 성공한 배포 → "Rollback to this deployment"

# 2. 또는 GitHub Actions에서 재배포
# GitHub → Actions → Deploy workflow → Run workflow
# → Branch: main (또는 특정 commit)

# 3. 긴급 수정 후 재배포 (hotfix 브랜치)
git checkout -b hotfix/parser-regression
# 수정...
git commit -m "fix: parser regression for Bing HTML change"
git push origin hotfix/parser-regression
# → PR 생성 → CI 통과 → main merge → 자동 배포
```

### 11.3 디버깅 명령어 모음

```bash
# 로그 확인 (7일간 무료)
# Cloudflare Dashboard → Workers & Pages → ssak-search
# → Logs & Analytics → Logs → Live Tail
# 필터: "AUDIT_SECURITY:" (감사 이벤트)
# 필터: "error" (에러 로그)

# 메트릭 확인
curl -s https://your-worker.pages.dev/api/metrics

# 백엔드 상태 확인
curl -s https://your-worker.pages.dev/api/health | python3 -m json.tool

# 특정 백엔드 테스트
curl -s -o /dev/null -w "HTTP %{http_code} (%{time_total}s)\n" \
  -H "User-Agent: Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)" \
  "https://www.bing.com/search?q=test&count=5"

# 캐시 확인
curl -sI -X POST https://your-worker.pages.dev/api/search \
  -H "Content-Type: application/json" \
  -d '{"query":"test","max_results":1}' | grep -i "x-from-cache\|cf-cache-status"
```

---

## 체크리스트 요약

### 배포 전 (Pre-flight)

- [ ] `npx tsc --noEmit` → 0 에러
- [ ] `npx vitest run --project unit` → 524/524 통과
- [ ] `npm run build` → `dist/_worker.js` 생성 (545 kB)
- [ ] `SEARCH_API_KEY` 시크릿 설정
- [ ] `RATE_LIMITER` DO 바인딩 활성
- [ ] GitHub Actions 시크릿 설정 (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID)
- [ ] Git main 브랜치 최신 상태

### 배포 중

- [ ] `npm run build` 실행 → `dist/` 디렉토리 생성
- [ ] `npx wrangler pages deploy dist/ --project-name=ssak-search --branch=main`
- [ ] 배포 로그 확인 (에러 없음)

### 배포 후 (Post-flight)

- [ ] `/api/health` → `status: "ok"`
- [ ] `/api/search` → 결과 1건 이상 반환
- [ ] `/api/metrics` → Prometheus 포맷 출력
- [ ] `rate_limiter_do: true` (DO 활성)
- [ ] 모든 정적 페이지 (/, /docs, /status) 정상 렌더링
- [ ] PWA 매니페스트 (/manifest.json) 정상
- [ ] OpenAPI 스펙 (/openapi.yaml) 정상
- [ ] Logpush → Datadog 로그 수신 (설정된 경우)

---

*이 문서는 `README.md`, `AUDIT.md`, `MONITORING_GUIDE.md`, `SLO.md`, `wrangler.jsonc`, `src/types.ts`의 정보를 종합하여 작성되었습니다.*
