# 15. DuckDuckGo 202 Anti-bot: fail-fast 유지 + 선택적 재시도 도입 분석

- 작성일: 2026-08-12
- 대상: `src/lib/duckduckgo.ts` (html → lite 폴백 체인)
- 판정: **B안 채택 권장** — 202 시 lite 스킵(현재 설계)은 유지하고, 202를 제외한 일시 장애(5xx/네트워크/타임아웃)에 한해 `withRetry`로 html 요청을 재시도. 200-0결과 → lite 폴백은 그대로.

---

## 1. 현재 설계 상태 (State Machine)

`duckDuckGoSearch`는 html 엔드포인트 1회 요청 후 결과가 없을 때만 lite로 폴백한다:

| html 응답 | htmlReturned200 | 동작 | lite 폴백 |
|---|---|---|---|
| 200 + 결과 ≥ 1 | true | 파싱 → 반환 | ❌ |
| 200 + 결과 0 (파서 실패/진짜 0건) | true | 0건 유지 | ✅ 시도 |
| **202 anti-bot** | **false** | **0건 유지** | **❌ 스킵 (현재 설계)** |
| 4xx/5xx | false | 0건 유지 | ❌ 스킵 |
| 네트워크 오류/타임아웃 (throw) | false | 0건 유지 | ❌ 스킵 |

핵심 게이트는 `results.length === 0 && htmlReturned200` — 200으로 정상 응답했는데 0건일 때만 lite로 간다. 202·5xx·네트워크 오류는 모두 lite를 건너뛴다.

## 2. 202 fail-fast 설계의 근거 (코드베이스 기록)

1. `duckduckgo.ts` 주석: *"DDG returns HTTP 202 for anti-bot challenges — response.ok is TRUE (2xx) but the page contains no search results. We must NOT fall through to lite in that case, because lite will also get 202 from the same IP, doubling the timeout for zero gain."*
2. `CHANGELOG` 2.0.0: "DuckDuckGo HTML/Lite fallback with 202 anti-bot fail-fast"
3. withRetry 전수 조사 기록(직전 세션): *"duckduckgo — html→lite 폴백 체인, 202 anti-bot은 동일 IP에서 lite도 202가 되므로 의도적으로 fail-fast"*
4. `backend-tasks.ts` (stack-exchange 주석): *"DDG site: trips the 202 anti-bot challenge"* — 데이터센터 IP에서 DDG는 사이트 연산자 쿼리에도 202를 반환한다는 실측 기록.

**핵심 성격**: DDG의 202는 **요청(엔드포인트) 단위가 아니라 IP/핑거프린트 단위**로 발동한다. Cloudflare Workers의 egress IP는 데이터센터 IP라 다중 테넌트/다중 쿼리가 공유하며, 이 IP는 DDG 봇 탐지에 지속적으로 걸린다. 따라서 **202는 일시 장애가 아니라 (해당 IP에서) 지속 상태**에 가깝다.

## 3. 실패 분류와 재시도 가치

| 실패 종류 | 성격 | 재시도 가치 | lite 폴백 가치 |
|---|---|---|---|
| **202 anti-bot** | IP-지속 챌린지 (빠른 응답) | **낮음** — 같은 IP에서 반복 202 예상 | **없음** — lite도 동일 챌린지 (현재 설계대로 스킵) |
| **5xx** (503/502/500) | 서버 과부하/일시 장애 | **높음** — 백오프 후 회복 가능성 | 중간 |
| **네트워크 오류/타임아웃** | 일시적 네트워크 결함 | **높음** — 블립(blip) 회복 가능성 | 중간 (동일 결함일 가능성) |
| **4xx** (403 등) | 영구 거부 | 없음 — fail-fast | 없음 |
| **200 + 0 결과** | 파서 레이아웃 변경/진짜 0건 | 중간 (레이아웃 변경은 재시도로 안 풀림) | **높음** — lite는 HTML 구조가 달라 파싱 성공 가능 (현재 유지) |

**현재 설계의 실제 갭**: 202가 아닌 **일시 장애(5xx/네트워크)에서 재시도가 전혀 없다**는 점이다. 네트워크 블립 한 번으로 DDG 백엔드 전체가 (lite까지 포함해) 0건 처리된다. 반면 202에 대한 lite 스킵은 정당하다 — 리트라이를 추가하더라도 이 부분은 유지해야 한다.

## 4. 제안 설계: 202 스킵 유지 + 일시 장애 선택적 재시도

```
duckDuckGoSearch(query):
  # A. html 요청 (withRetry, 202 제외 일시 장애만 재시도)
  html_res = withRetry(() => fetchHtml(), {
    maxRetries: 1,
    delaysMs: [150],
    jitter: false,
    retryable: (err) => err instanceof TransientDdgError   # 5xx/네트워크만
  }).catch(() => null)

  # B. 상태 판정
  if html_res.status == 202:        return []          # ✅ 현재 설계 유지 (lite 스킵)
  if html_res.status == 200:
      results = parse(html)
      if results.length > 0:        return results
      else:                         → C. lite 폴백    # ✅ 현재 설계 유지
  else:                              return []          # 4xx/소진

  # C. lite 폴백 (200-0결과일 때만, 기존과 동일)
```

핵심 원칙:
1. **202는 재시도하지 않는다** — IP-지속 챌린지라 재시도가 서브리퀘스트만 낭비 (아래 6절 비용).
2. **202면 lite도 건너뛴다** — 기존 fail-fast 설계 그대로.
3. **5xx/네트워크/타임아웃은 1회 재시도** — 일시 장애 회복 가능성을 확보. withRetry의 `retryable` 프레디킷으로 202를 제외 (withRetry 통일 작업의 일관된 패턴).
4. **200-0결과 → lite 폴백 유지** — 파서 레이아웃 갭을 메우는 기존 가치 보존.

## 5. 팬아웃 예산 (이전 세션의 splitRetryBudget 규율 적용)

fanout ceiling: `BACKEND_TIMEOUT_MS.duckduckgo = 2000ms` (fanout.ts). buildDuckDuckGoTask/emergencyFallback은 timeoutMs 5000을 넘기지만, 팬아웃 경로에서는 ceiling 2000이 실제 상한이다.

1회 재시도(2 attempts) + 150ms 비트:
```
perAttempt = splitRetryBudget(2000, 2, 150, 800) = max(⌊1850/2⌋, 800) = 925ms
worst case = 2 × 925 + 150 = 2000ms ≤ ceiling ✓
```
- 정상 응답(~300–600ms)에서는 재시도가 발화하지 않아 지연 영향 없음.
- 202 케이스는 재시도 없음 → 202 응답(빠름) 1회로 종료, 지연 증가 없음.
- 네트워크 블립: 1회 재시도로 최대 2000ms까지 회복 기회 (기존에는 1회 타임아웃 소진 후 즉시 0건).

## 6. 비용·리스크 분석

| 항목 | 영향 | 비고 |
|---|---|---|
| 서브리퀘스트 | 202 재시도 없음 → 증가 0. 5xx/네트워크에서 +1 (최대 2/쿼리) | 쿼리당 예산 ~27에서 DDG 몫 최대 2 → 허용 |
| 지연 | 정상/202 경로 불변. 일시 장애 시 +최대 ~1850ms | ceiling 내 |
| eval 회귀 | DDG는 마지막 수단 백엔드(emergencyFallback priority 2, 정규 fanout 태스크). 결과 0건이던 시나리오가 일부 회복 → 회귀 없음 | 한국어 쿼리는 원래 DDG 스킵 (fallback.ts) — 무관 |
| 기존 테스트 | duckduckgo.test.ts 33건 — 202 fail-fast 계약(html 202 → [] 반환, lite 미호출)은 `retryable` 프레디킷으로 **보존** | 신규 테스트: 5xx 1회 재시도, 네트워크 1회 재시도, 202 재시도 안 함, 202 → lite 스킵 유지 |

**위험 시나리오**: 5xx가 200ms 내에 반복되는 "지속 과부하"의 경우 재시도 1회가 낭비된다 — 그러나 백오프 150ms + ceiling 2000 내라 손실이 작고, DDG가 자주 걸리는 상태가 아니라면 실익이 더 크다. 202를 재시도 대상에 넣는 C안만 피하면 된다.

## 7. 선택지 요약

| 안 | 202 재시도 | 202→lite | 5xx/네트워크 재시도 | 판정 |
|---|---|---|---|---|
| **A. 현행 유지** | ❌ | 스킵 | ❌ | 기준선. 네트워크 블립에 취약 |
| **B. 선택적 재시도 (권장)** | ❌ | **스킵 유지** | ✅ 1회 (150ms) | 202 설계 보존 + 일시 장애 회복 |
| **C. 202도 1회 재시도** | ✅ 1회 | 스킵 유지 | ✅ | 데이터센터 IP에서 202가 지속성 높아 서브리퀘스트 낭비 — 비권장 |

## 8. 권고 및 구현 시 테스트 계획

**권고: B안.** 202 fail-fast 설계는 IP-지속 챌린지라는 실측 근거로 정당하므로 그대로 두고, 유일한 실질 갭인 "일시 장애 시 재시도 부재"만 `withRetry({ maxRetries: 1, delaysMs: [150], retryable: 일시 장애만 })`로 메운다. 구현 시:

1. `TransientDdgError` 마커(5xx/네트워크) + 202는 마커 없이 반환 → `retryable`이 202를 자동 제외.
2. TDD: (a) 5xx 1회 재시도 후 성공, (b) 5xx 소진 시 [], (c) 네트워크 오류 1회 재시도, (d) **202 → 재시도 0회 + lite 미호출** (기존 계약 고정), (e) 200-0결과 → lite 폴백 유지.
3. `retry-budget-simulation.test.ts`에 duckduckgo 체인(2×925+150=2000) 추가.
4. withRetry 전수 기록(CHANGELOG)의 "duckduckgo 제외" 사유를 "202 제외, 일시 장애는 재시도"로 갱신.

**구현하지 않는 이유 (202 재시도)**: Cloudflare 데이터센터 IP에서 202는 동일 IP·다중 테넌트에 지속적으로 발동하는 챌린지이며, eval 실측 기록("DDG site: trips the 202")이 이를 뒷받침한다. 202를 재시도하면 서브리퀘스트 1회가 추가로 소모될 뿐 결과는 동일할 가능성이 높고, ceiling 2000 안에서 재시도가 성공하더라도 lite가 같은 IP로 202를 반환해 얻는 것이 없다.
