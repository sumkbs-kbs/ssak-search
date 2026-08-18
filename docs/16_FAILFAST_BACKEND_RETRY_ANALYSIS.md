# 16. Fail-fast 백엔드 일시 장애 재시도 여부 분석 (brave / searxng / openalex / arxiv / reddit 외)

- 작성일: 2026-08-13
- 대상: `src/lib/brave-search.ts`, `src/lib/searxng-search.ts`, `src/lib/bing-search.ts`, `src/lib/openalex.ts`, `src/lib/specialized.ts`(arxiv/hackernews/reddit), `src/lib/youtube-search.ts`, `src/lib/stack-exchange.ts`
- 배경: docs/15에서 duckduckgo에 "202 제외 일시 장애(5xx/네트워크) 1회 재시도"를 적용한 뒤, 동일 기준으로 나머지 fail-fast 백엔드의 재시도 도입 여부를 판정
- 판정 요약: **arxiv / openalex / brave 3곳은 도입 권장, searxng / reddit / stack-exchange 3곳은 조건부, bing / hackernews / youtube 3곳은 비권장**. 단, 모든 도입 지점은 `fetchWithTimeout`의 회로 개방 throw를 `retryable`에서 반드시 제외해야 함.

---

## 1. 공통 인프라 — 재시도를 평가하는 전제

모든 백엔드 fetch는 `fetchWithTimeout`(util.ts:820)을 경유하며, 이는 단일 초크포인트로 rate-limiter(`./rate-limiter`)에 연결되어 있다:

```
fetchWithTimeout → canRequest(url) → rateLimitedFetch(url)
   ├─ 회로 개방(open) 또는 동시성 포화 → throw Error("Upstream unavailable (circuit open or at capacity)")
   └─ rateLimitedFetch가 null 반환(용량 경쟁) → throw Error("Rate limiter rejected (capacity race)")
```

rate-limiter `HOST_CONFIGS` (rate-limiter.ts:58):

| 호스트 | maxConcurrent | failureThreshold | resetTimeoutMs | rateLimitPerMinute |
|---|---|---|---|---|
| www.bing.com | 3 | 5 | 60s | 60 |
| html.duckduckgo.com | 1 | 3 | 120s | 20 |
| search.naver.com | 3 | 5 | 60s | 80 |
| en.wikipedia.org (공유 윈도우) | 3 | 5 | 30s | 100 |
| api.github.com | 2 | 3 | 60s | 100 |
| hacker-news.firebaseio.com | 3 | 5 | 30s | 100 |
| www.reddit.com | 2 | 5 | 60s | 40 |
| export.arxiv.org | 2 | 3 | 60s | 30 |
| r.jina.ai | 2 | 5 | 60s | 50 |
| (기본) | 2 | 5 | 60s | — |

**중요한 상호작용 (전제 1)**: rate-limiter에 등록된 호스트(arxiv/reddit/bing 등)는 이미 **회로 차단기 + 분당 할당량 + 동시성 제한**을 갖고 있다. 이 계층 위에 재시도를 얹을 때:
- 회로 개방 throw(`Upstream unavailable …`)는 **절대 재시도하면 안 된다** — resetTimeoutMs(30–60s) 동안 열려 있으므로 150ms 후 재시도는 같은 throw를 반복할 뿐. DDG의 `TransientDdgError`처럼 마커 기반 `retryable`에서 제외해야 한다.
- 429가 rate-limiter를 통과한 뒤 도달했다면 **분당 할당량을 초과했을 가능성**이 있다(arxiv 30/min, reddit 40/min). 이 경우 150ms 후 재시도는 같은 윈도우에서 다시 429날 가능성이 높다 — wikipedia가 per-request 재시도 대신 **공유 쿨다운 스킵**(전 세션)을 택한 이유가 바로 이것이다.

**전제 2**: fanout ceiling(`BACKEND_TIMEOUT_MS`)이 실제 예산이다. 도입 시 `splitRetryBudget(ceiling, attempts, Σdelays, minAttemptMs)`로 worst case를 ceiling 이내로 맞춰야 한다(이전 세션의 예산 규율).

**전제 3**: 4xx는 모든 백엔드에서 영구 거부(설정/키/권한 문제) — 재시도 금지가 보편적으로 성립한다. 401/403/400은 예외 없이 fail-fast.

## 2. 백엔드별 현황 매트릭스

| 백엔드 | fetch 경로 | rate-limiter | 현재 실패 처리 | ceiling | 재시도 가치 판정 |
|---|---|---|---|---|---|
| **brave** | **직접 fetch**(AbortController, util 미경유) | ❌ 미등록 | 429/401/403/기타 !ok → warn + `[]`, 네트워크 → catch + `[]` | 2000 | ✅ **도입 권장** (회로 차단기 부재가 핵심) |
| **searxng** | fetchWithTimeout | ❌ 미등록(셀프호스트 URL) | !ok → warn + `[]`, 네트워크 → catch + `[]` | 3000 | ⚠️ 조건부 |
| **bing** | fetchWithTimeout | ✅ 등록(60/min, thr 5) | 이미지: **3엔드포인트 폴오버 루프**(`!ok continue` + 엔드포인트별 try/catch, bing-search.ts:458–549), 웹: 단일 fetch + 캐시 + 회로 차단기 | 2000 | ❌ 불필요 (폴오버·회로 차단기 존재) |
| **openalex** | fetchWithTimeout | ❌ 미등록 | !ok → warn + `[]`, 네트워크 → catch + `[]` | 4500 | ✅ **도입 권장** |
| **arxiv** | fetchWithTimeout | ✅ 등록(30/min, thr 3) | !ok → `[]`, 네트워크 → catch + `[]` | 4500 | ✅ **도입 권장** (503 실측) |
| **reddit** | fetchWithTimeout | ✅ 등록(40/min, thr 5) | !ok → `[]`, 네트워크 → catch + `[]` | 2000 | ⚠️ 조건부 (429는 제외) |
| **hackernews** | fetchWithTimeout | 기본 설정(hn.algolia.com은 HOST_CONFIGS 미등록, DEFAULT thr 5) | !ok → `[]`, 네트워크 → catch + `[]` | 1800 | ❌ 비권장 (Algolia 신뢰성) |
| **youtube** | fetchWithTimeout | ❌ 미등록 | 서브페치 다수(!ok → `[]` 각각) | 2500 | ❌ 비권장 (스크래핑) |
| **stack-exchange** | fetchWithTimeout | ❌ 미등록 | quota guard(quota_remaining < 10 → 하드스톱) + !ok → `[]` | 4000(기본) | ⚠️ 조건부 (429는 제외) |
| **github** | fetchWithTimeout | ✅ 등록 | **이미 공유 쿨다운**(recordGithubSearchCall + DO 미러 + skip guard) | 2000 | ✅ 이미 해결 |
| **wikipedia** | fetchWithTimeout | ✅ 등록 | **이미 withRetry + 공유 쿨다운** | 4500 | ✅ 이미 해결 |

## 3. 상세 판정

### 3.1 brave — 도입 권장 (1회, 5xx/네트워크만)

**현재**: 429/401/403/5xx/네트워크 전부 fail-fast + `[]`. 401/403은 키 문제로 영구 — fail-fast가 정답. 429는 주석("rate limit is very generous (50 req/s)")대로 드물어 재시도 가치가 낮다. **그러나 5xx/네트워크는 재시도 가치가 있다** — 결정적으로 brave는 `fetchWithTimeout`을 쓰지 않는 **유일한 백엔드**라 rate-limiter/회로 차단기 보호가 전혀 없다. 네트워크 블립 한 번이면 paid API 결과 전체가 0건 처리된다(duckduckgo와 동일한 갭).

**판정**: duckduckgo와 동일한 B안 패턴 —
- `TransientBraveError` 마커(5xx + fetch throw 래핑)만 `retryable`
- 429/401/403은 마커 없이 `return []`(기존 warn 로그 유지) → 재시도 자동 제외
- 1회 재시도 + 150ms 비트, 예산 `splitRetryBudget(2000, 2, 150, 800)` = 925 → worst 2×925+150 = **2000 = ceiling 정확히**
- 직접 fetch(AbortController)를 유지할지 fetchWithTimeout으로 전환할지는 별도 결정 — 전환 시 회로 차단기 혜택 + 회로 개방 throw 처리 필요, 유지 시 마커만으로 충분(간단)

### 3.2 searxng — 조건부 (5xx/네트워크만, 429 제외)

**현재**: 셀프호스트 인스턴스, !ok → `[]`. 실패의 성격이 남과 다르다 — 5xx는 **사용자 인스턴스의 과부하/설정 문제**일 가능성이 높고, 429는 인스턴스 앞단 프록시나 상위 엔진의 제한이다. 셀프호스트는 재시도가 회복시킬 수 있는 "일시 장애"와 재시도가 무의미한 "설정 문제"의 경계가 모호하다.

**판정**: 5xx/네트워크 1회 재시도는 허용 가능(ceiling 3000: `splitRetryBudget(3000, 2, 150, 800)` = 1425 → worst 3000 ✓). 단 429는 제외(할당량/설정 문제 가능성). **우선순위 낮음** — 셀프호스트는 평가/운영 환경에서 기본 꺼져 있고, 설치된 환경에서도 인스턴스 상태가 재시도의 주 대상이 아니다.

### 3.3 bing — 불필요

이미지 검색은 3개 엔드포인트를 순차 시도하는 폴오버 루프(`!ok continue`) — **엔드포인트 레벨 재시도가 이미 존재**한다. 웹 검색은 캐시 + rate-limiter(60/min, thr 5) 보호. 여기에 withRetry를 얹으면 이중 재시도로 서브리퀘스트만 증가한다.

### 3.4 openalex — 도입 권장 (1회)

**현재**: !ok → warn + `[]`, ceiling 4500(느린 권위 백엔드 패턴, P1-G와 같은 사유). OpenAlex는 rateLimitPerMinute 10(엄격)이지만 rate-limiter 미등록이라 로컬 보호가 없다. 5xx/네트워크 블립 시 학술 결과(openreview/aclanthology/jmlr 랜딩)가 통째로 드롭된다.

**판정**: 1회 재시도, `splitRetryBudget(4500, 2, 150, 800)` = 2175 → worst 2×2175+150 = **4500 = ceiling 정확히**. 429/4xx는 fail-fast 유지.

### 3.5 arxiv — 도입 권장 (1회, 가장 가치 높음)

**현재**: !ok → `[]`. arxiv는 **503 "server is busy"가 실측으로 잦은** 백엔드이고(P1-G 기록: 응답 450ms–2.9s 변동), eval에서 arxiv.org gold가 드롭되면 NDCG가 크게 깨진다. rate-limiter 등록(30/min, thr 3)은 있으나 이는 동시성/회로 차단일 뿐 **5xx/503에 대한 재시도는 없다**.

**판정**: 1회 재시도, `splitRetryBudget(4500, 2, 150, 800)` = 2175 → worst **4500 = ceiling 정확히**. **단 2가지 필수 조건**:
1. 회로 개방 throw(`Upstream unavailable …`)는 `retryable`에서 제외 (thr 3이면 3연속 실패 후 60s 개방 — 재시도 무의미)
2. 429도 재시도에서 제외 또는 1회 한정 — arxiv 30/min 할당량 초과 시 150ms 후 재시도는 같은 윈도우에서 다시 429날 가능성. wikipedia 패턴(공유 쿨다운)이 더 적합할 수 있으나, arxiv는 서브리퀘스트 예산이 넉넉하고 429 빈도가 낮아 1회 재시도로 충분.

### 3.6 reddit — 조건부 (5xx/네트워크만)

**현재**: rate-limiter(40/min, thr 5) 보호 + !ok → `[]`. Reddit JSON은 데이터센터 IP에서 429가 흔한 것으로 알려져 있으나, 우리 rate-limiter가 이미 40/min으로 억제하므로 429 도달 시 "할당량 초과"일 가능성이 높다 → **429 재시도는 무의미**. 5xx/네트워크만 1회 허용, `splitRetryBudget(2000, 2, 150, 800)` = 925 → worst 2000 ✓.

### 3.7 hackernews — 비권장

Algolia API는 업계 최고 수준의 가용성, rate-limiter 100/min 등록. ceiling 1800이 타이트(1회 재시도 시 `splitRetryBudget(1800, 2, 150, 800)` = 825 → worst 1800 가능은 하나). 실패 빈도가 낮아 재시도로 얻는 이득 < 복잡도.

### 3.8 youtube — 비권장

HTML 스크래핑 + 서브페치 다수. 재시도는 같은 IP로 추가 요청을 보내 **봇 탐지/IP 밴 위험을 높인다**(DDG 202와 같은 성격의 위험). rate-limiter 미등록 상태로 두는 게 낫다.

### 3.9 stack-exchange — 조건부 (5xx/네트워크만)

**핵심**: keyless 할당량 300/day/IP. **429는 할당량 소진을 의미하므로 재시도가 오히려 해가 된다**(하루 할당량을 재시도로 낭비). quota guard(quota_remaining < 10 하드스톱)는 이미 올바른 방향. 5xx/네트워크만 1회 재시도 가능(ceiling 4000 기본: `splitRetryBudget(4000, 2, 150, 800)` = 1925 → worst 4000 ✓)하나 우선순위 낮음 — SO는 en-tech eval의 핵심 gold지만 이미 quota guard가 지배적 실패 모드를 관리한다.

## 4. 권고 요약 및 적용 우선순위

| 순위 | 백엔드 | 적용 내용 | 예산 (worst = ceiling) |
|---|---|---|---|
| 1 | **arxiv** | 5xx/503 1회 재시도, 회로 개방·429는 retryable 제외 | 2×2175+150 = 4500 |
| 2 | **openalex** | 5xx/네트워크 1회 재시도 | 2×2175+150 = 4500 |
| 3 | **brave** | 5xx/네트워크 1회 재시도 (429/401/403 fail-fast 유지) | 2×925+150 = 2000 |
| 4 | searxng | 5xx/네트워크 1회 (429 제외), 저우선 | 2×1425+150 = 3000 |
| 5 | reddit | 5xx/네트워크 1회 (429 제외) | 2×925+150 = 2000 |
| 6 | stack-exchange | 5xx/네트워크 1회 (429 = quota 소진 → 재시도 금지) | 2×1925+150 = 4000 |
| — | bing | 불필요 (엔드포인트 폴오버 존재) | — |
| — | hackernews / youtube | 비권장 | — |
| — | github / wikipedia | 이미 해결 (공유 쿨다운 / withRetry+쿨다운) | — |

## 5. 구현 시 공통 규칙 (모든 지점)

1. **마커 기반 retryable**: `TransientXxxError`(5xx + 네트워크 래핑)만 재시도. 4xx·429·**회로 개방 throw**는 마커 없이 fail-fast — DDG의 `TransientDdgError` 패턴 그대로.
2. **예산**: 각 백엔드 ceiling에서 `splitRetryBudget` 계산, worst = ceiling 정확히. `retry-budget-simulation.test.ts`에 체인 행 추가.
3. **429 정책 이원화**: rate-limiter 등록 호스트(arxiv/reddit)는 429 재시도를 제외하거나 1회 한정. 미등록 호스트(brave/openalex)도 429는 fail-fast가 기본(브레이브 50 req/s로 드묾).
4. **회로 차단기 상호작용 검증**: fetchWithTimeout이 throw하는 `Upstream unavailable (circuit open or at capacity)`를 retryable에서 제외했는지 테스트로 고정 — 누락 시 60s 회로 개방 동안 서브리퀘스트 낭비.
5. **TDD 5건/백엔드** (docs/15 기준): (a) 5xx 1회 재시도 후 성공, (b) 소진 시 `[]`, (c) 네트워크 오류 1회 재시도, (d) 4xx/429 재시도 0회, (e) 회로 개방 throw 재시도 0회.

## 6. 리스크

| 리스크 | 영향 | 완화 |
|---|---|---|
| rate-limiter와 재시도의 이중 카운팅 | 재시도가 rateLimitPerMinute를 추가 소모 — 할당량 타이트 호스트(arxiv 30/min)에서 악화 가능 | 429 retryable 제외 + 1회 한정 |
| 회로 개방 중 재시도 | 서브리퀘스트 낭비 + 실패 카운트 누적 | 회로 개방 throw를 retryable에서 제외 (규칙 1·4) |
| 셀프호스트(searxng) 재시도로 설정 문제 은폐 | 로그에 일시 장애로 보임 | 429 제외 + warn 로그에 status 포함 |
| youtube 재시도로 IP 노출 증가 | 봇 탐지 악화 | 비권장으로 배제 |

**결론**: duckduckgo B안의 "일시 장애만 재시도, 영구/할당량/회로 상태는 fail-fast" 원칙은 나머지 fail-fast 백엔드에도 그대로 적용 가능하며, 실익이 가장 큰 곳은 **arxiv(503 실측) → openalex(로컬 보호 부재) → brave(회로 차단기 부재)** 순이다. bing은 폴오버가 이미 재시도 역할을 하므로 예외.
