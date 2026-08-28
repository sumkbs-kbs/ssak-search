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
echo "https://dash.cloudflare.com/ → Pages → search-engine-api → Settings → Variables"
```

---

## 3. Durable Object 바인딩

### 개요

Durable Object(DO)는 Cloudflare Workers의 상태 저장(sticky) 컴퓨팅 레이어입니다.
총 **11개**의 DO 클래스가 `src/index.tsx`에서 export되어 있습니다
(RateLimiterDO · ThreadDO · PagesDO · LibraryDO · UserProfileDO · SpaceDO · ApiKeyDO ·
CrawlerDO · ClickLogDO · ExperimentDO · CanaryOrchestratorDO).

**구현 완료 (P2 ④, 2026-08-10)**: Pages 프로젝트는 DO를 **직접 소유/생성할 수 없습니다**
(Cloudflare 공식 문서: "You cannot create and deploy a Durable Object within a Pages
project"). 따라서 11개 DO 클래스는 **별도 Workers(`ssak-do-worker`, `wrangler.do.jsonc`)로
배포**하고 Pages(`wrangler.jsonc`)에서 `script_name`으로 바인딩합니다. 이 구조로
2026-08-10에 실배포 완료 — `/api/health`가 `rate_limiter_do: true` + `mode: durable_object`
+ `hosts_tracked` 단조 증가를 확인했습니다.

**배포 순서 (반드시 이 순서)**:
1. `npx wrangler deploy --config wrangler.do.jsonc` — DO 클래스 호스트 워커 배포
2. `npm run build && npx wrangler pages deploy` — Pages 워커 배포 (script_name 바인딩)
3. `npx wrangler deploy --config wrangler.cron.jsonc` — **딥 프로브 스케줄러 워커** 배포 (S104-③-fix)
   - Pages는 크론 트리거를 **지원하지 않음** (Workers ✅ / Pages ❌ — wrangler도 Pages config의 `triggers`를 거부해 배포 차단).
   - 15분 간격 딥 프로브는 별도 Workers 스크립트 `ssak-probe-scheduler`가 소유하며, `PROBE_URL`(기본 `https://search-engine-api.pages.dev`)의 `/api/health?depth=full`을 주기 호출한다 (2026-08-11 실측: 11:30/11:45 틱 모두 발동 확인).
   - **환경별 스케줄러 분리 (S104-③-⑤, 2026-08-11)**: staging은 `npx wrangler deploy --config wrangler.cron.staging.jsonc`로 **별도 워커 `ssak-probe-scheduler-staging`**(PROBE_URL=`https://staging.search-engine-api.pages.dev`)을 배포한다 — staging 딥 프로브가 자동화되고, 프로덕션 스케줄러의 PROBE_URL을 오염시키지 않는다. (수정 전 deploy.yml staging 잡이 프로덕션 config로 배포해 staging 스케줄러가 production을 프로브하던 배선 수정).
   - CI: `.github/workflows/deploy.yml` — staging 잡은 `wrangler.cron.staging.jsonc`, production 잡은 `wrangler.cron.jsonc`.

> 과거 버전의 "Dashboard에서 DO 바인딩 추가" 방식은 Pages가 DO를 직접 소유할 수 없어
> 동작하지 않았습니다 (P2 실측). project 레벨 바인딩은 git 연결 빌드에만 적용됩니다.

---

### DO 클래스별 상세 설정 가이드

#### 🔴 반드시 설정할 것 (필수)

| # | DO 클래스 | 바인딩 이름 | 파일 | 설정 우선순위 | 없을 때 동작 |
|---|-----------|-------------|------|:------------:|-------------|
| 3.1 | `RateLimiterDO` | `RATE_LIMITER` | `src/lib/rate-limiter-do.ts` | **⭐ 최우선** | 인메모리 fallback (isolate별, 콜드스타트 리셋) |

#### 🟡 적극 권장 (상태 유지 기능)

| # | DO 클래스 | 바인딩 이름 | 파일 | 관련 라우트 | 없을 때 동작 |
|---|-----------|-------------|------|-----------|-------------|
| 3.2 | `ApiKeyDO` | `API_KEY_DO` | `src/lib/api-key-do.ts` | `/api/keys` | 501 응답 (`binding_missing`) |
| 3.3 | `ThreadDO` | `THREAD_DO` | `src/lib/thread-do.ts` | `/api/chat` | 501 응답 (`binding_missing`) |
| 3.4 | `PagesDO` | `PAGES_DO` | `src/lib/pages-do.ts` | `/api/pages` | 501 응답 (`binding_missing`) |
| 3.5 | `LibraryDO` | `LIBRARY_DO` | `src/lib/library-do.ts` | `/api/library` | 501 응답 (`binding_missing`) |

#### 🟢 선택 사항 (고급 기능)

| # | DO 클래스 | 바인딩 이름 | 파일 | 관련 라우트 | 없을 때 동작 |
|---|-----------|-------------|------|-----------|-------------|
| 3.6 | `UserProfileDO` | `USER_PROFILE_DO` | `src/lib/user-profile-do.ts` | `/api/profile` | 501 응답 (`binding_missing`) |
| 3.7 | `SpaceDO` | `SPACE_DO` | `src/lib/space-do.ts` | `/api/spaces` | 501 응답 (`binding_missing`) |
| 3.8 | `CrawlerDO` | `CRAWLER_DO` | `src/lib/crawler-do.ts` | `/api/crawl` | 501 응답 (`binding_missing`) |
| 3.9 | `ClickLogDO` | `CLICK_LOG_DO` | `src/lib/ltr/click-logger.ts` | `/api/ltr`, `/api/monitor` | 501 응답 (`binding_missing`) |
| 3.10 | `ExperimentDO` | `EXPERIMENT_DO` | `src/lib/experiments/ab-test.ts` | `/api/experiments`, `/api/monitor` | 501 응답 (`binding_missing`) |
| 3.11 | `CanaryOrchestratorDO` | `CANARY_DO` | `src/lib/canary/canary-orchestrator.ts` | `/api/canary` | 500 응답 (가드가 500 — `binding_missing`) |

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
      { "name": "CLICK_LOG_DO", "class_name": "ClickLogDO" },
      { "name": "EXPERIMENT_DO", "class_name": "ExperimentDO" },
      { "name": "CANARY_DO", "class_name": "CanaryOrchestratorDO" },
    ]
  }
}
```

> `wrangler.dev.jsonc`(로컬 dev)는 `exports` 맵 + script_name 없는 바인딩으로
> Pages 엔트리포인트에서 DO 클래스를 직접 해석합니다. `wrangler.jsonc`(프로덕션)는
> `script_name: "ssak-do-worker"`로 별도 배포된 DO 워커를 참조합니다.

#### 3.2 프로덕션 환경 (별도 DO 워커 배포)

##### Step 1: DO 호스트 워커 배포
```bash
# DO 클래스 11개를 별도 Workers로 배포 (migrations 자동 적용)
npx wrangler deploy --config wrangler.do.jsonc
# → Uploaded ssak-do-worker … Deployed ssak-do-worker.sumkbs.workers.dev
```

##### Step 2: Pages 배포 (script_name 바인딩)

`wrangler.jsonc`에 이미 11개 DO 바인딩이 `script_name: "ssak-do-worker"`로
선언되어 있습니다. DO 변경이 없는 한 이 파일을 다시 편집할 필요가 없습니다:

```jsonc
"durable_objects": {
  "bindings": [
    { "name": "RATE_LIMITER", "class_name": "RateLimiterDO", "script_name": "ssak-do-worker" },
    { "name": "THREAD_DO", "class_name": "ThreadDO", "script_name": "ssak-do-worker" },
    // … 11개 전부 …
  ]
}
```

```bash
# Pages 워커 재배포 (script_name 바인딩 적용)
npm run build && npx wrangler pages deploy
```

##### Step 3: 검증
```bash
curl -s https://search-engine-api.pages.dev/api/health | python3 -c \
  "import sys,json; d=json.load(sys.stdin); rl=d['rate_limiter'];
  print('mode:', rl['mode'], '| hosts_tracked:', rl['hosts_tracked'])"
# Expected: mode: durable_object | hosts_tracked: 6+ (단조 증가)
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
| `CLICK_LOG_DO` | `ClickLogDO` | LTR 클릭/노출 로깅 (impression/click) | SQLite 내장 |
| `EXPERIMENT_DO` | `ExperimentDO` | A/B 실험 생성/분석 (pause/resume/click) | SQLite 내장 |
| `CANARY_DO` | `CanaryOrchestratorDO` | 파서 회귀 감지 오케스트레이션 (스냅샷 비교/알림) | SQLite 내장 |

> 모든 DO는 Cloudflare Durable Object의 내장 SQLite를 사용하므로 별도의 DB 설정이 필요 없습니다.

---

### 3.5 문제 해결

| 증상 | 원인 | 해결 |
|------|------|------|
| `curl /api/chat` → HTTP 501 | `THREAD_DO` 바인딩 누락 | `wrangler.jsonc`에서 THREAD_DO script_name 확인 후 do-worker + Pages 재배포 |
| `curl /api/health` → rate_limiter_do: false | `RATE_LIMITER` 미바인딩 또는 do-worker 미배포 | `npx wrangler deploy --config wrangler.do.jsonc` 후 Pages 재배포 |
| `curl /api/ltr` → HTTP 501 | `CLICK_LOG_DO` 바인딩 누락 | wrangler.jsonc CLICK_LOG_DO 확인 후 재배포 |
| `curl /api/experiments` → HTTP 501 | `EXPERIMENT_DO` 바인딩 누락 | wrangler.jsonc EXPERIMENT_DO 확인 후 재배포 |
| `curl /api/canary` → HTTP 500 | `CANARY_DO` 바인딩 누락 | wrangler.jsonc CANARY_DO 확인 후 재배포 |
| 배포 후에도 `mode: in_memory_fallback` | Pages가 DO를 직접 소유 불가 — do-worker 미배포 | ① `npx wrangler deploy --config wrangler.do.jsonc` ② Pages 재배포 (script_name 적용) |
| 로컬 dev에서 DO 미동작 | wrangler.dev.jsonc에 bindings 누락 | wrangler.dev.jsonc에 durable_objects.bindings 추가 |
| 배포 후 DO 변경이 반영 안 됨 | 캐시된 이전 버전 | do-worker 재배포 후 Pages 재배포 |

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
# Cloudflare Dashboard → Pages → search-engine-api → Settings → Bindings
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
# Cloudflare Dashboard → Pages → search-engine-api → Settings → Functions
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
# 2. Pages → search-engine-api → Settings → Bindings
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

### 6.5 Slack Incoming Webhook 실수신 검증 (S104-③-②)

> **목적**: production 딥 프로브가 백엔드 `down`을 감지하면 `src/routes/health.ts` →
> `alertBackendDown()`(`src/lib/slack-alert.ts`)이 `SLACK_WEBHOOK`(또는 `ALERT_SLACK_WEBHOOK`)
> 으로 fire-and-forget POST를 보냅니다. 실제 Slack 채널 도착까지 확정하는 절차.
> 현재 `SLACK_WEBHOOK` 시크릿은 **임시 캡처 싱크**(`ssak-alert-capture`)를 가리키고
> 있어 전달 홉까지만 검증된 상태 — 아래 체크리스트로 실수신으로 전환합니다.
>
> **트리거 조건**: `status === 'down'`인 백엔드만 알림 (`degraded`/`unconfigured`는 무시).
> 전달 payload: `🔴 Backend Down: <name>` + attachment(Backend/Status/Latency 필드).

#### 6.5.1 Slack 측 사전 준비 (웹훅 URL 생성)

| # | 작업 | 명령/경로 | 완료 |
|---|------|-----------|:----:|
| A1 | Incoming Webhook 앱 설치 | Slack → 앱 관리 → 검색창 `incoming-webhook` → 앱 추가/설치 | ☐ |
| A2 | 수신 채널 선택 + URL 복사 | 설치 시 채널 선택 → `https://hooks.slack.com/services/T…/B…/X…` 복사 | ☐ |
| A3 | **URL 독립 검증** (Slack 측 먼저) | `curl -s -X POST -H 'Content-type: application/json' -d '{"text":"[TEST] webhook reachable"}' '<URL>'` → 응답 `ok` + 채널 도착 | ☐ |

> A3이 실패하면 Slack 쪽 문제 — 앱 재설치/채널 권한 확인 후 진행 (앱 코드는 건드리지 않음).

#### 6.5.2 시크릿 교체

| # | 작업 | 명령/경로 | 완료 |
|---|------|-----------|:----:|
| B1 | Pages production 시크릿 교체 | `npx wrangler pages secret put SLACK_WEBHOOK --project-name search-engine-api` → URL 입력 (또는 Dashboard: Pages → search-engine-api → Settings → Variables and Secrets → Production → SLACK_WEBHOOK) | ☐ |
| B2 | (선택) do-worker canary 알림 | `npx wrangler secret put ssak-do-worker SLACK_WEBHOOK` — `canary-orchestrator.ts`도 동일 웹훅 사용 (canary 알림 불필요 시 생략) | ☐ |
| B3 | 시크릿 반영 확인 | Dashboard Variables and Secrets → Production에 `SLACK_WEBHOOK` 표시 확인 | ☐ |

#### 6.5.3 재배포 + 커밋 일치 검증

| # | 작업 | 명령/경로 | 완료 |
|---|------|-----------|:----:|
| C1 | 빌드 | `npm run build` | ☐ |
| C2 | Pages production 배포 | `npx wrangler pages deploy dist/ --project-name=search-engine-api --branch=main` (시크릿은 배포 스냅샷에 반영) — 또는 deploy 워크플로우 `workflow_dispatch(environment=production)` 사용 | ☐ |
| C3 | 커밋 일치 + DO 재검증 | `ENVIRONMENT=production EXPECTED_COMMIT=<배포 SHA> bash scripts/verify-do-binding.sh` → `Deployment commit matches` + Route 10/10 + exit 0 | ☐ |

#### 6.5.4 전달 경로 검증 (웹훅 → Slack)

| # | 작업 | 명령/경로 | 완료 |
|---|------|-----------|:----:|
| D1 | **실 payload 재현** (앱이 보내는 것과 동일 구조) | `curl -s -X POST -H 'Content-type: application/json' -d '{"text":"🔴 Backend Down: test — Backend *test* is *down* (1234ms)","attachments":[{"color":"danger","blocks":[{"type":"header","text":{"type":"plain_text","text":"🔴 Backend Down: test"}}]}]}' '<URL>'` → `ok` + 채널에 `🔴 Backend Down: test` 도착 | ☐ |
| D2 | 현재 백엔드 상태 확인 | `curl -s 'https://search-engine-api.pages.dev/api/health?depth=full'` → `down_backends` 필드 확인 (현재 down 0건이면 6.5.5 대기) | ☐ |

#### 6.5.5 실제 다운 이벤트에서 수신 확정

| # | 작업 | 명령/경로 | 완료 |
|---|------|-----------|:----:|
| E1 | 다운 이벤트 모니터링 | `python3 scripts/run-alert-monitor.py` (240s 폴링, 최대 90분) — 다운 감지 시각 기록. wikipedia 429 창 / duckduckgo 사이클 등 자연 이벤트 대기 | ☐ |
| E2 | production 로그에서 전송 확인 | `npx wrangler pages deployment tail <deploy-id> --project-name search-engine-api --format json` → 다운 감지 시각에 `[Slack] Alert sent` (성공) 또는 `[Slack] Webhook send failed` 로그 | ☐ |
| E3 | **Slack 채널 도착 확정** | 다운 감지 시각 전후 Slack 채널에 `🔴 Backend Down: <backend>` 메시지 수신 확인 ← 최종 목표 | ☐ |
| E4 | (선택) 회귀 게이트 교차 확인 | `FAIL_ON_REGRESSION=1 bash scripts/verify-do-binding.sh`가 같은 다운을 `new_down`으로 잡는지 대조 | ☐ |

#### 6.5.6 실패 시 트러블슈팅

| 증상 | 원인/조치 |
|------|-----------|
| `[Slack] Webhook send failed` + 4xx | URL 오타·앱 권한 — Slack에서 앱 재설치 후 A3 재검증 |
| `[Slack] Webhook send failed` + 3xx | 구 웹훅 URL 폐기됨 — 새 URL로 B1 재실행 |
| 알림 자체 미발생 | 트리거는 `down`만 — wikipedia 429 창이 `degraded`로 분류되면 알림 없음 (정상). `down_backends`가 비어있지 않은 tick을 기다려야 함 |
| E1이 다운을 못 잡음 | 90분 내 자연 이벤트 부재 가능 — 모니터 재실행 또는 E2 tail을 15분 크론 틱과 병행 관찰 |

#### 6.5.7 (전환 후) 임시 캡처 배선 정리

- 실수신 확정 후 `ssak-alert-capture`(src/slack-capture.ts · wrangler.slack-capture.jsonc)와
  `scripts/run-alert-monitor.py`는 더 이상 필요 없음 — 선택적 제거: `npx wrangler delete --config wrangler.slack-capture.jsonc ssak-alert-capture` + 커밋에서 파일 삭제

---

## 7. CI/CD 파이프라인

### 7.1 GitHub Actions 워크플로우

| # | 워크플로우 | 파일 | 트리거 | 설명 |
|---|-----------|------|--------|------|
| 7.1 | **CI** | `.github/workflows/ci.yml` | PR, push to main | **린트 0-경고 게이트 (`lint:eslint:ci`)** + 타입체크 + 유닛테스트 + 빌드 (병렬) — ESLint 경고/에러 1건이라도 발생하면 `build` 잡이 `needs` 차단으로 함께 실패 (S29) |
| 7.2 | **Deploy** | `.github/workflows/deploy.yml` | main push, workflow_dispatch | CI 아티팩트 재사용 → Pages 배포 |
| 7.3 | **Monitor** | `.github/workflows/monitor.yml` | 15분마다 스케줄 | `/api/health` 체크 → Slack 알림 |

```bash
# CI/CD 상태 확인
# GitHub → Actions → 모든 워크플로우가 ✅ 상태인지 확인

# 수동 배포 테스트
npx wrangler pages deploy dist/ --project-name=search-engine-api --branch=main
```

> **브랜치 보호 권장 (S29)**: main 브랜치 보호 규칙에서 **`lint-typecheck`와 `unit-tests`를
> required status checks로 지정**할 것 — 그래야 lint 0-경고 게이트가 실패한 PR이 머지되지
> 않는다 (워크플로우 실패로는 부족 — 머지 차단은 브랜치 보호 규칙이 담당).
> GitHub → Settings → Branches → Add rule → `main` → Require status checks to pass → `lint-typecheck`, `unit-tests`

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

### 10.0 표준 검증 매트릭스 (2.9.0+ — 프로덕션 실측 프로토콜)

매 배포 후 아래 매트릭스를 통과해야 합니다 (2026-08-28 2.9.0 배포에서 22항목 검증된 프로토콜):

| # | 검증 | 기대 | 비고 |
|---|------|------|------|
| V1 | `GET /api/health` version | 배포 버전과 일치 | health.ts 하드코딩 — 릴리스마다 갱신 |
| V2 | 게이트 라우트 21개 무키 | 전부 401 | `API_AUTH_GATED_PREFIXES` 전수 (agent 3종, research, chat, suggest, video, products, news-hub, queue, spaces, pages, library, profile, canary, monitor + search/extract/keys/blacklist/crawl/usage) |
| V3 | 공개 라우트 | health/metrics/UI 200 | 과보호 여부 확인 |
| V4 | 게이트 에러 페이로드 | agent형 구조(`UNAUTHORIZED`+`agent_hint`+`retryable`+`suggested_action`) | 신규 미들웨어 배포 증명 |
| V5 | `OPTIONS` 프리플라이트 | 401 아님(204/200) | CORS 사전점검이 인증을 뚫지 않아야 함 |
| V6 | 보안 헤더 | HSTS/X-Frame/X-Content-Type(API), CSP/X-XSS(HTML) | 스코핑 확인 |
| V7 | `/api/metrics` | Prometheus 형식 | |
| V8 | 피싱 가드 | 금융 쿼리에서 공식 도메인 clean, 오탐 0 | `phishing_filtered`/`security_warning` 필드 |
| V9 | 리다이렉트 탐지 | 타 도메인 리다이렉트 추출 시 `metadata.security_warning` | 예: aka.ms |
| V10 | deep-research | 병렬 추출, 소스별 성공/경고 | MCP 바이너리로 검증 가능 |

> 참고: 무인증 IP 레이트리밋은 per-isolate(인메모리)라 엣지 분산 시 실효 한도가 희석됨 —
> 볼류메트릭 남용 방어는 Cloudflare 대시보드의 Rate Limiting 룰로 구성 권장.

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
# Cloudflare Dashboard → Pages → search-engine-api → Deployments
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
# Cloudflare Dashboard → Workers & Pages → search-engine-api
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
- [ ] `npx wrangler pages deploy dist/ --project-name=search-engine-api --branch=main`
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
