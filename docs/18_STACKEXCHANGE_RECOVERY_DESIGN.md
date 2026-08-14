# 18. stackexchange 서킷 Cloudflare challenge 우회 복구 설계

> 작성일: 2026-08-14 · 상태: **방안 A 구현 완료 (수정 36)** · 근거: egress 실측 + 서킷 로그 분석
> 대상: `api.stackexchange.com` 서킷 (health: down, tripped, failures=5, tripCount=2)
> 구현: `rate-limiter-do.ts` — `isStackExchangeHost()` + probeHost SE 분기
> (`/2.3/info?site=stackoverflow`, 400+error_id:502 → alive) + SE 전용 10분 프로브
> 간격. 테스트 4건 추가 (전체 2,637 통과).

---

## 1. 실측 — "Cloudflare challenge"는 부분 진실

### egress (Workers)에서 실제 응답

| 경로 | 응답 | 해석 |
|---|---|---|
| `stackoverflow.com/robots.txt` | **403 HTML** "Just a moment..." | 진짜 Cloudflare challenge (UA 무관) |
| `api.stackexchange.com/robots.txt` | **400 JSON** | Cloudflare 아님 — **SE API 자체 응답** |
| `api.stackexchange.com/2.3/search/advanced` | **400 JSON** `error_id:502 "too many requests from this IP, more requests available in 79048 seconds"` | **SE API rate-limit** (~22h 남음) |

### 핵심 발견

1. **`api.stackexchange.com`은 Cloudflare challenge가 아니다** — SE API(기업 엔드포인트)가 egress IP를 **rate-limit** 중 (error_id 502, 약 22시간 후 리셋). 이는 이전 과도한 프로빙/해머링의 누적 결과.
2. **서킷은 alarm 프로브가 만들었다** — `stack-exchange.ts`는 `rateLimitedFetch`를 **사용하지 않는다** (grep 확인). 즉 실제 검색은 rate limiter와 무관하게 직접 fetch. `api.stackexchange.com` 서킷은 DO alarm의 `probeHost`가 `robots.txt`를 fetch하면서 생성·트립된 것.
3. **검색은 서킷과 독립적으로 실패 중** — SE API가 400(rate-limit) 반환 → `quotaRemaining=0` 가드 발동 → 이후 쿼리는 fetch 전 [] (S73 쿼터 가드가 이미 작동 중이라 실패 누적 없음).

### rate-limiter 실패 집계 규칙 (수정 전제 확인)

`rate-limiter.ts`: `success = status !== 429 && status !== 503` — **400은 서킷 실패로 집계되지 않는다**. 따라서 SE API 400 응답 자체는 서킷을 트립시키지 않는다. 트립의 원인은 오직 **alarm 프로브의 alive 판정 실패** (200/429/301/302만 alive) 뿐.

---

## 2. 문제 분해

| # | 문제 | 원인 | 영향 |
|---|---|---|---|
| A | 서킷이 열려 있음 | alarm 프로브가 robots.txt 400을 alive로 인정 안 함 | health down + fail-fast (검색 경로엔 무관하지만 상태 오보) |
| B | 실제 검색도 결과 없음 | SE API egress IP rate-limit (~22h) | stackoverflow.com gold 부재 |
| C | 프로브가 rate-limit을 갱신/연장 | alarm이 60s마다 robots.txt fetch → SE IP 502 상태 유지 | 회복 지연 |

---

## 3. 설계안

### 방안 A (권장): SE 프로브 경로/판정 특수화 — 서킷 상태 정직화

**목표**: 서킷을 "down"이 아니라 실제 상태("alive하나 rate-limited")로 표시 → alarm 에스컬레이션 중단 → rate-limit 리셋 후 자동 회복.

1. **프로브 경로 변경** (rate-limiter-do.ts `probeHost`): `api.stackexchange.com`은 robots.txt 대신 실제 API 헬스 경로 사용
   ```
   https://api.stackexchange.com/2.3/info?site=stackoverflow
   ```
   (SE API 공식 경로 — robots.txt는 API가 아니므로 응답이 왜곡됨)

2. **판정 규칙**: `resp.ok` 또는 **`status===400 && body에 error_id:502 포함`** 을 alive로 인정
   - 502(error_id) = "too many requests from this IP" = 서버는 살아있고 일시적 rate-limit → **alive**
   - 서킷이 닫히면: alarm 에스컬레이션 중단 + health가 down→healthy(또는 degraded)로 정직화
   - 실제 검색은 쿼터 가드가 계속 [] 반환 (rate-limit 중엔 어차피 결과 없음) — 서킷 닫힘이 해가 되지 않음

3. **프로브 간격 확대** (SE만): `CIRCUIT_PROBE_INTERVAL_MS` 60s → SE에 한해 **10~15분** — rate-limit 갱신/연장 방지 (방안 C 해결)

4. **부수**: `isStackExchangeHost` 헬퍼로 wikipedia 특수화와 동일 패턴 (이미 `isWikipediaHost` 선례 존재)

**효과**: 서킷 상태 정직화 + 22h 후 rate-limit 리셋 시 검색 자동 회복 + 프로브가 회복을 방해하지 않음.

### 방안 B (대체 경로): 타사 미러/스크래핑

- `stackprinter.appspot.com`, `stackoverflow.com` 직접 크롤링 등 — **비권장**: ToS 위험 + challenge 우회는 서비스 약관 위반 소지 + 유지보수 부담. SE API가 정식 인터페이스이므로 재개를 기다리는 게 정석.

### 방안 C (완화): 검색 풀에서 SO gold를 다른 백엔드로 충당 — **기각 (실측)**

- **실측 (2026-08-14, `scripts/probe-bing-stackoverflow.ts`)**: SO gold 대표 13쿼리
  (en-tech/kr-tech/adv)에서 **bing 자연 0/13 · DDG 자연 0/13 · production 검색 풀
  0/13** — stackoverflow.com 이 어디에도 노출되지 않았다. production 풀 0/13 은
  Workers egress 기준의 직접 실측이라 확정적이다 (SE API rate-limit 의 직접 영향).
- **판단**: bing/DDG 자연 랭킹으로는 SO gold 를 충당할 수 없다 → 방안 C 기각.
  SO gold 회복은 SE API rate-limit 리셋을 기다리는 수밖에 없고, 방안 A 가 서킷
  상태를 정직화하므로 리셋 후 자동 회복된다.
- ⚠️ 보조 관찰: 로컬 egress 의 bing/DDG 직접 결과는 노이즈가 심하다 (OAuth 쿼리에
  인도 선거 사이트, 한국어 로컬라이즈 등) — 방안 C 판단은 production 풀 실측을
  기준으로 한다.

---

## 4. 구현 범위 (방안 A 채택 시)

| 파일 | 변경 |
|---|---|
| `src/lib/rate-limiter-do.ts` | `isStackExchangeHost()` + `probeHost` 경로/판정 특수화 + SE 전용 프로브 간격 |
| `tests/unit/rate-limiter-do.test.ts` | SE 400+502 alive 판정 · SE 간격 확대 테스트 |
| `docs/08_CHANGELOG.md` | 수정 30 기록 |

**예상 코드** (probeHost 내 SE 분기):
```ts
if (isStackExchangeHost(host)) {
  const resp = await fetch('https://api.stackexchange.com/2.3/info?site=stackoverflow', { headers: { UA } })
  const text = await resp.text()
  const rateLimited = resp.status === 400 && text.includes('error_id') && text.includes('502')
  return { alive: resp.ok || rateLimited, status: resp.status, snippet: text.slice(0, 60) }
}
```

---

## 5. 리스크/한계

- **22시간 대기**: rate-limit 리셋 전엔 검색 결과가 없음 — 서킷 닫힘은 "상태 정직화"일 뿐 gold 회수는 리셋 후
- **쿼터(300/day)**: 리셋 후에도 하루 300건 — 쿼터 가드(QUOTA_FLOOR)가 이미 통제 중, 프로브를 API 경로로 바꾸면 쿼터를 소모함 → **간격 확대 필수** (10~15분 = 하루 ~100건, 검색과 공유)
- **alarm 프로브가 SE 쿼터를 소모하는 부작용**: `/2.3/info`도 쿼터 1건 소모 — 간격 확대 + robots.txt 유지(쿼터 미소모) 대안도 있으나 robots.txt는 400 판정이 애매 → 502 감지가 정확

## 6. 결정 필요

1. 방안 A(서킷 정직화 + 간격 확대) 구현 여부 — **권장**
2. 프로브 경로: `/2.3/info` (쿼터 소모, 정확) vs robots.txt 유지+502 판정 (쿼터 무소모, 애매) — **/2.3/info 권장**
3. SE 프로브 간격: 10분 vs 15분
