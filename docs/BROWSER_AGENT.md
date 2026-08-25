# Browser Agent — 로컬 브라우저 기반 검색 백엔드 (Phase I v1)

> 작성일: 2026-08-24 · 상태: v1 구현
> 발단: 봇 차단 심화에 대한 사용자 제안 — 「내가 쓰던 창을 붙잡는다(로그인 세션) → 페이지를 연다 → 화면을 읽는다」
> 실증: 실행 중인 Chrome(DevToolsActivePort 9222)에 Playwright `connectOverCDP`로 붙어
> Bing SERP 유기적 결과 판독 성공 (2026-08-24, 한국어 Bing 확인)

---

## 1. 왜 이 방법인가

봇 차단의 판별 축은 ① IP 신용(데이터센터 vs 거주) ② 브라우저 핑거프린트 ③ 행동
패턴이다. Cloudflare Worker의 서버사이드 fetch는 세 축을 전부 벗을 수 없고,
사용자의 실제 Chrome은 세 축을 전부 통과한다. 개인 단일 사용자라는 제약이 이
방식의 최대 약점(가용성·동시성)을 무력화하므로, 본 프로젝트에서 비용 대비
효과가 가장 큰 해법이다.

## 2. 아키텍처

```
Hermes → ssak-search (Cloudflare Pages)
              │
              ├─ [무변경] RSS · OpenAlex · HN · arXiv · Wikipedia API · 금융/크립토 카드
              ├─ [무변경] 자체 인덱스 · 캐시 · 동치 게이트
              │
              └─ ★ 신규 browser 백엔드 (tier1, env 게이트)
                    POST {BROWSER_AGENT_URL}/serp   ← Bing/Naver SERP
                    POST {BROWSER_AGENT_URL}/page   ← 기사 본문 추출
                         ↑
        내 Mac: browser-agent 데몬 (Node + playwright)
                CDP → 실행 중인 Chrome (DevToolsActivePort 자동 감지)
```

- **완전한 하위호환**: `BROWSER_AGENT_URL` env 미설정 시 태스크 자체가 생성되지
  않음 — 지금과 100% 동일 동작.
- **장애 격리**: 에이전트 다운/Mac 꺼짐 = 백엔드 하나 다운 → 기존 회로차단기가
  자동 우회. 클라우드 경로(RSS·API·인덱스)는 폴백으로 항상 존재.

## 3. 컴포넌트 계약

### 3.1 로컬 데몬 (`browser-agent/server.mjs`, 포트 8765)

| 엔드포인트 | 입력 | 출력 |
|---|---|---|
| `GET /health` | — | `{ok, chrome:"connected", lastNavMs}` |
| `POST /serp` | `{engine:"bing"\|"naver", query, count?≤10}` | `{results:[{title,url,domain,snippet}]}` |
| `POST /page` | `{url}` | `{title,content}` (본문 텍스트 ≤20KB) |

- **인증**: `Authorization: Bearer $BROWSER_AGENT_TOKEN` 전 요청 필수.
- **SSRF 방어** (/page): http(s)만 허용, localhost/사설 대역/`.internal`/
  포트 명시 차단. /serp는 URL을 외부에서 받지 않고 engine+query로 내부 생성.
- **계정 보호 페이싱**: 연속 내비게이션 최소 간격 4초 (초과 요청은 큐 대기).
- **CDP 연결**: `DevToolsActivePort` 파일 자동 감지(우선) → `BROWSER_CDP_WS`
  수동 지정 폴백. 연결 끊김 시 재접속.

### 3.2 Cloudflare 측 (`src/lib/browser-search.ts`)

- `browserAgentSearch(ctx)`: `/serp` 호출 → `SearchResult[]` 매핑
  (score = position 기반 + 신뢰 부스트 없음 — 스코어러가 재계산).
- 게이트: `env.BROWSER_AGENT_URL` 있을 때만 태스크 생성 (buildBackendTasks).
- 타이머: 10s 하드 타임아웃, 실패 시 회로차단기 기록(기존 인프라).
- 배치: tier1 (bing/naver와 나란히 — 가용할 때 최상품).

## 4. 리스크 & 방어

| 리스크 | 방어 |
|---|---|
| Mac 꺼짐/에이전트 정지 | 회로차단기 우회 → 클라우드 폴백 (품질 일부 강등, 중단 아님) |
| 계정 플래그 (네이버/구글 잠금) | 전용 프로필 권장, 읽기 전용 탐색, 페이싱 4s, 페이지네이션 금지(v1) |
| 프롬프트 인젝션 | 추출물은 기존 `sanitizeEvidenceContent` 경유 후 LLM 전달 |
| 에이전트 자체 SSRF | 위 3.1 방어 참조 + Bearer 토큰 |
| 노출 창구 | Tailscale(설치됨) 또는 cloudflared tunnel — 공개 인터넷 직노출 금지 권장 |

## 5. v1 범위 밖 (v2 후보)

- Naver 로그인 세션 활용(개인화 결과), 이미지/뉴스 vertical
- 에이전트 결과의 자체 인덱스 역피드 (크롤러 역할 겸업)
- 다중 탭 병렬화

## 5.5 운영 실측 노트 (2026-08-24 첫날)

- **CDP 웨지 사례**: 하루 종료 반복 연결 후 Chrome 디버그 서버가 WS 핸드셰이크
  타임아웃 상태로 웨지됨(45s+). Chrome 재시작 없이도 수 분 뒤 자가 해제 확인 —
  에이전트는 매 호출마다 DevToolsActivePort를 재독학하므로 재설정 불필요 자동 복구.
- **launchd 상시 기동은 v1에서 철거**: 데몬은 어차피 Chrome 실행 중일 때만
  의미가 있어 부팅 자동기동이 불필요한 복잡성이었음(+미스터리 hang 1건).
  `browser-agent/start.sh`(중복 기동 방지 + 토큰 자동 로드) 사용이 v1 표준.
- **Naver 2026 리디자인**: 유기적 결과가 fender-ui_<해시> 컴포넌트 안쪽이라
  클래스 셀렉터 무효 — 외부 호스트 링크 수집 방식으로 우회(광고 ader.naver.com
  자동 배제). 광고 비율이 시간대별로 다르므로 결과 수 변동은 정상.

## 6. 운영 체크리스트

1. `cd browser-agent && npm install && npm start` (Chrome 실행 상태 필요)
2. Tailscale: `tailscale serve 8765` (또는 funnel) → URL 확보
3. Pages 환경변수: `BROWSER_AGENT_URL`, `BROWSER_AGENT_TOKEN` 설정
4. 확인: `/api/health`의 backends에 `browser: operational` + 로그 `[browser]`
