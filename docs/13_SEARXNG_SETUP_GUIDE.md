# SearXNG 설정 가이드 — zh 교차언어 오염 완화 (S26)

> 문서 ID: 13 · 작성: 2026-08-07 · 관련: S26 (zh-general-12 완화), S16 (커뮤니티 라우팅)

## 0. 실측 갱신 (2026-08-14 — S104 zh site: 라우팅 검증, FIX-2026-08-14-05)

자체 호스팅 SearXNG(2026.7.9, docker)에서 7개 zh gold 도메인 site: 배터리
(`scripts/probe-searxng-zh.ts`) 실측 결과 — **CN Baidu/Bing 가정을 반증하고 google cse로
결정**:

| 엔진 | site: 인정 | 실측 | 결론 |
|---|---|---|---|
| **google cse** | ✅ | top5 gold 5/5 (ctrip/dianping/trip/qunar/zhihu) · xiaohongshu 4/5 · mafengwo 1/5 | **S104 site: 라우트의 주력** — 단, **language 파라미터를 명시하면 site: 쿼리에서 0건** (plain은 무관) → S104 태스크는 language 없이 호출 |
| bing | ❌ | `site:ctrip.com 张家界旅游攻略`이 mafengwo 자연 랭킹 반환 (여행 쿼리 10/10은 우연), ctrip/dianping/xiaohongshu/qunar 0건 | 비활성 (bing site: 무시는 모바일/데스크톱/RSS에 이어 4번째 경로 확정) |
| baidu | ✅ (CN IP) | 비CN IP에서 wappass CAPTCHA (HTTP 302, suspended 3600) | CN VPS 배치 시에만 gold 공급 — 설정에 유지 (비CN IP에선 결과만 비어 무해) |
| duckduckgo/brave/startpage | — | 이 egress에서 CAPTCHA/rate-limit | 비활성 |

**설정 결론** (`searxng/settings.yml`): `use_default_settings: true` + bing/duckduckgo/brave/startpage
`disabled: true` + google cse·baidu `disabled: false`. 주의:
- **레거시 `engines=google,baidu` 요청 파라미터는 2026.7.9에서 폐지** (`disabled_engines=<name>__<category>`
  로 대체 — `parse_dict`→`EnginesSetting.parse_cookie`). `engines` 파라미터를 보내면 조용히 무시되어
  전체 엔진이 돌므로(오염) 반드시 settings 레벨로 고정한다.
- `- name: google`은 no-op — 이 버전의 활성 google 엔진 이름은 **`google cse`** (google.py는 HTML
  스크래퍼로 기본 비활성, google_cse.py가 활성).
- **google cse도 과도한 연속 호출(~40건/수분) 시 Google bot 감지 suspension** (suspended_time=180).
  DDG 202 버스트와 같은 클래스의 상한 — 자연 간격 호출은 정상, eval 벌크도 쿼리당 1회·간격이면 유지.
  프로덕션은 이 한도를 넘지 않도록 `server.limiter` + 요청 페이싱을 권장 (docs/16 재시도 정책과 상충 없음).

**S104 태스크 배선**: `buildZhTravelCommunityTask`는 SEARXNG_URL 설정 시 `site:<gold> <query>`를
**language 없이** searxngSearch로 호출 (maxResults 5). DDG 폴백 경로와는 독립 — SEARXNG_URL이
설정돼 있으면 DDG site: 태스크는 생성되지 않는다 (P24의 !searxngConfigured 규칙).

---

## 1. 왜 필요한가 — 문제 데이터

`bing mkt=zh-CN`은 미국 IP에서 **교차언어 결과로 오염**된다. eval:median (2026-08-07,
500쿼리 median-of-3)의 zh-general-12 (`考研复习计划`) 실제 풀:

```
backends: ["bing"]   resultCount: 10   ndcg@10: 0.447   relevantHits: 3
0 zhihu.com       | 发现 - 知乎                          (관련성 낮음)
1 zhihu.com       | 登录codex的时候弹出电话号码验证怎么办？ (무관)
2 jingyan.baidu.com | 怎样在whatsapp中加好友              (무관)
3 jingyan.baidu.com | SketchUp中提示不是实体怎么解决        (무관)
4 zhihu.com       | 美国人用什么聊天软件？                 (무관)
5 irish-presidency.consilium.europa.eu | EU climate...   (영어 뉴스!)
6 linkedin.com    | Climate resilience in focus Norway   (영어 뉴스!)
7 newsroom.consilium.europa.eu | Informal meeting...     (영어 뉴스!)
8 dailydigest.ie  | EU Climate Ministers...              (영어 뉴스!)
9 gov.ie          | Minister O'Brien chairs...           (영어 뉴스!)
```

10건 중 **4건이 EU 기후 영어 뉴스** — 쿼리·언어와 완전 무관. computeScore의 교차언어
패널티(0.15)와 품질 임계값이 있지만, 풀 자체가 빈약하면 adaptive threshold가 열려
하위 티어 결과가 유입된다. **랭킹으로는 근본 해결 불가 — 소스 레벨에서 관련성 높은
중국어 커뮤니티 결과를 공급해야 한다.**

S26에서 이미 코드로 공급하는 소스:

| 백엔드 | 엔드포인트 | 키 | 금액 | 상태 |
|---|---|---|---|---|
| CSDN | `so.csdn.net/api/v3/search` | 없음 | 무료 | **구현됨** (zh-tech + zh-general, 라이브 검증 5/5 관련) |
| Juejin | `api.juejin.cn/search_api/v1/search` | 없음 | 무료 | 구현됨 (S16, zh-tech) |
| SearXNG (본 문서) | 자체호스팅 `/search?format=json` | 선택 | 서버 비용 | **이 가이드** |
| zhihu | `zhihu.com/api/v4/search_v3` | 쿠키 필요 | — | **차단됨** (비CN IP 400) — SearXNG의 Baidu/Bing zh 엔진으로 우회 가능 |

## 2. 통합 동작 방식

`src/lib/searxng-search.ts`의 `searxngSearch()`는 `env.SEARXNG_URL`이 설정돼 있을 때만
활성화된다. 설정 시:

- `AllStrategy.buildTasks()`에서 **SearXNG가 primary 일반 백엔드**로 추가됨
  (`!searxngConfigured`면 DDG가 fallback — 설정 시 DDG는 제외됨)
- 언어 파라미터(`language=zh-CN`)를 넘겨 중국어 쿼리를 중국어 엔진으로 라우팅
- `SEARXNG_API_KEY` 설정 시 `Authorization: Bearer <key>` 헤더 전송

```
Worker (search-engine-api)
  └─ searxngSearch(query, { language: 'zh-CN', category: 'general' })
       └─ GET {SEARXNG_URL}/search?q=...&format=json&language=zh-CN
            └─ SearXNG (자체호스팅, Docker)
                 ├─ google cse (site: 인정 — S104 주력, §0 실측)
                 ├─ baidu (CN VPS 배치 시 gold 커버리지 강화)
                 └─ valkey (rate limiter)
```

## 3. 설정 절차

### 3.1 서버 준비 (Docker Compose)

`sidecar/searxng/docker-compose.yml`:

```yaml
services:
  searxng:
    image: docker.io/searxng/searxng:latest
    container_name: searxng
    restart: unless-stopped
    ports:
      - "8888:8080"
    volumes:
      - ./config:/etc/searxng:rw
    environment:
      - SEARXNG_BASE_URL=http://localhost:8888/
      # 정적 값만 사용 (compose는 env 값 안의 $() 치환을 지원하지 않아 파싱이
      # 실패할 수 있음). 먼저 별도 셸에서 아래로 생성하고 붙여넣는다:
      #   openssl rand -hex 32
      - SEARXNG_SECRET=CHANGE_ME_여기에_openssl_rand_hex_32_결과를_붙여넣기
    depends_on:
      - valkey

  valkey:
    image: docker.io/valkey/valkey:alpine
    container_name: searxng-valkey
    restart: unless-stopped
    command: valkey-server --save 30 1 --loglevel warning
    volumes:
      - valkey-data:/data

volumes:
  valkey-data:
```

### 3.2 설정 파일 (`config/settings.yml`)

```yaml
use_default_settings: true    server:
  secret_key: "CHANGE_ME_랜덤_시크릿"     # 3.1의 SEARXNG_SECRET과 동일 값
  limiter: true                          # bot 보호 — valkey 필수

# JSON API 활성화 (HTML만 허용하면 curl이 403) — 반드시 필요
search:
  formats:
    - html
    - json

valkey:
  url: valkey://searxng-valkey:6379/0

# S104 site: 라우팅 실측 기준 (2026-08-14, §0) — google cse만 site: 인정.
# bing은 site: 무시(자연 랭킹만)라 site: 라우트에서 오염 — 비활성.
# baidu는 CN IP에서만 동작 — CN VPS 배치 시 활성 효과.
engines:
  - name: google cse
    disabled: false
  - name: baidu
    disabled: false
  - name: bing
    disabled: true
  - name: duckduckgo
    disabled: true
  - name: brave
    disabled: true
  - name: startpage
    disabled: true
```

> 주의: `- name: google`은 no-op (활성 엔진은 `google cse`). 요청 파라미터
> `engines=...`는 2026.7.9에서 폐지 — 엔진 고정은 settings 레벨로만 한다 (§0).

### 3.3 Worker에 연결 (`wrangler.jsonc`)

현재 `vars` 블록이 없어 기본 off 상태. 추가:

```jsonc
"vars": {
  "SEARXNG_URL": "http://<서버-IP-또는-도메인>:8888",
  "SEARXNG_API_KEY": "<SearXNG token — 3.4 참고>"
}
```

> ⚠️ Workers가 외부에서 이 URL에 도달해야 하므로 `localhost`는 불가. VPS/내부망 IP 또는
> 터널(Cloudflare Tunnel 등)을 사용. API 키가 없는 사설 인스턴스면 `SEARXNG_API_KEY` 생략 가능.

### 3.4 인증 (선택 — 공개 노출 시 권장)

SearXNG는 자체 토큰 인증이 없으므로, 공개 인스턴스는 앞단에서 제한한다:

- **권장**: Cloudflare Access / WAF로 `/search` 엔드포인트를 애플리케이션 IP로만 제한
- 또는 `server.limiter: true` + valkey로 IP당 rate 제한 (위 설정 포함됨)

`SEARXNG_API_KEY`는 커스텀 미들웨어/리버스 프록시가 검증하는 경우에만 사용한다.

## 4. 검증 절차

### 4.1 로컬 curl (Worker 없이)

```bash
# JSON 포맷 활성화 확인 — 200 + results[] 가 오면 성공
curl -s 'http://localhost:8888/search?q=%E8%80%83%E7%A0%94%E5%A4%8D%E4%B9%A0%E8%AE%A1%E5%88%92&format=json&language=zh-CN' \
  -H 'Accept: application/json' | head -c 400

# 403이면 settings.yml의 search.formats에 json 누락
# 결과가 빈 배열이면 중국어 엔진 비활성/밴 — engines 설정 확인
```

### 4.2 Worker 통합 확인

```bash
# 1. 배포 후 헬스 체크에서 SearXNG 사용 여부 확인
curl -s https://<your-domain>/api/health | grep -o 'searxng[^,}]*' || echo "no searxng field"

# 2. zh 쿼리 라이브 스모크 — EU 영어 뉴스가 사라지고 중국어 커뮤니티 결과가 오는지
curl -s 'https://<your-domain>/api/search?q=%E8%80%83%E7%A0%94%E5%A4%8D%E4%B9%A0%E8%AE%A1%E5%88%92' \
  -H 'X-API-Key: <key>' | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
    const r=JSON.parse(s); (r.results||[]).slice(0,6).forEach(x=>console.log(x.domain,"|",(x.title||"").slice(0,40)))
  })'

# 3. eval 재실행으로 실측 NDCG 확정 (S18~S26 공동 측정)
npm run eval:median:save
```

### 4.3 확인할 신호

| 신호 | 의미 |
|---|---|
| `results`에 blog.csdn.net / juejin.cn / baidu zh 결과 | 중국어 커뮤니티 공급 정상 |
| consilium.europa.eu / gov.ie 같은 영어 뉴스 부재 | 교차언어 오염 완화 확인 |
| `logger.warn('SearXNG returned 403')` | JSON 포맷 미활성 — 3.2 확인 |
| `logger.warn('SearXNG search failed')` | 네트워크/타임아웃 — 서버 도달성 확인 |

## 5. 효과 범위와 한계

**해결되는 것:**
- zh-general (考研复习计划, 手游排行榜 등) 쿼리의 교차언어 영어 오염 → SearXNG의
  google cse로 중국어 결과 우선 공급 (S104 site: 라우트는 language 없이 — §0 퀴크)
- zh-tech 커뮤니티 갭 (zhihu가 차단돼 있어도 google cse site:zhihu.com이 표면화 —
  실측 top5 5/5)

**해결되지 않는 것 (별도 레버):**
- zhihu.com 검색 API 자체 (비CN IP 400) — SearXNG의 Baidu/Bing zh 엔진이 페이지
  레벨로 대체하지만 실시간 API만큼 정확하진 않음
- 랭킹의 adaptive threshold가 여전히 하위 티어를 열 수 있음 — 풀이 풍부해지면
  자동 완화됨 (품질 임계값은 최상위 결과 기준으로 동작)
- SearXNG 서버 운영비 + 유지보수 — 무료 API 백엔드(CSDN/Juejin)가 이미 코드에
  구현돼 있어, 교차언어 오염이 심한 zh-general/zh-tech 쿼리만 우선 커버 가능

## 6. 운영 노트

- **업스트림 밴 주의**: SearXNG가 과도한 요청으로 Baidu/Google에 IP 밴되면 결과가
  비어 돌아온다. `server.limiter: true` + valkey를 유지하고, 이중화로 다른 인스턴스를
  두는 것을 권장.
- **`timeoutMs: 10000`** 기본값 — 검색 워커 타임아웃(14s eval 한도) 안에 충분.
- **category 파라미터**: 현재 구현은 `general`만 사용 (news/finance는 SearXNG 제외 —
  `all.ts`에서 `!ctx.isNews && !ctx.isFinance` 게이트).
- **비용**: 서버 1대 (1 vCPU/512MB면 충분) + valkey. egress 트래픽만 발생.
