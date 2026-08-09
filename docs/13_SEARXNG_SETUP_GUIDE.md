# SearXNG 설정 가이드 — zh 교차언어 오염 완화 (S26)

> 문서 ID: 13 · 작성: 2026-08-07 · 관련: S26 (zh-general-12 완화), S16 (커뮤니티 라우팅)

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
                 ├─ baidu / bing / google / sogou (zh 엔진)
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

# 중국어 쿼리를 위한 엔진 — 해외 IP면 Baidu는 CAPTCHA 가능성이 있으므로
# bing/google zh를 우선. 국내(중국) 배포 시 baidu/sogou 추가.
#
# 참고: SearXNG는 요청 시 language=zh-CN 파라미터로 엔진을 자동 매칭한다
# (per-engine language 키는 baidu/bing/google에 표준 옵션이 아님). 아래
# language는 예시일 뿐 — 실제로는 /search?language=zh-CN 파라미터가 언어를
# 결정하므로, 설정을 따라 적을 때 "이 키 때문에 zh 엔진이 켜진다"고 오해하지
# 않도록 주의.
engines:
  - name: baidu
    engine: baidu
    disabled: false
    categories: general
  - name: bing
    engine: bing
    disabled: false
    categories: general
  - name: google
    engine: google
    disabled: false
    categories: general
```

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
  중국어 엔진 + language=zh-CN으로 중국어 결과 우선 공급
- zh-tech 커뮤니티 갭 (zhihu가 차단돼 있어도 Baidu/Bing zh 엔진이 zhihu.com 결과
  표면화 가능)

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
