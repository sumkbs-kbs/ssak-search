# 14. zh/ko wikipedia 429 2차 미러 구현 가능성 리포트 (S41, 2026-08-08)

> 범위: zh/ko.wikipedia.org가 wikimedia 게이트웨이 429 창에 걸렸을 때, **위키데이터(1차 티어) 외의
> 교차 인프라**에서 gold URL(`zh.wikipedia.org/wiki/…`, `ko.wikipedia.org/wiki/…`)을 재구성할 수 있는
> 2차 미러의 후보를 전수 조사·라이브 검증하고 구현 가능성을 평가한다. ja는 S38의 ja.dbpedia.org
> SPARQL 2차 티어가 이미 존재하므로 제외.
>
> **검증 방법**: 모든 후보를 2026-08-08에 라이브 프로브(`scripts/probe-nonen-mirrors.sh`)로
> 확인했다. ① 인프라 독립(wikimedia 프로덕션 엣지와 다른 호스트/클러스터인가) ② 키리스
> ③ CJK 쿼리로 검색/존재 확인 가능 ④ `<lang>.wikipedia.org` URL 재구성 가능 — 4축으로 평가했다.

---

## 1. 요약 (TL;DR)

**교차 인프라 zh/ko 2차 미러는 라이브 프로브 기준 실용적으로 존재하지 않는다.** 조사한 11개 후보 중
"살아있으면서(200) · 키리스로 · 교차 인프라에서 · zh/ko wikipedia 타이틀을 찾아 gold URL을 재구성하는"
후보는 0개였다.

| 후보 | 인프라 독립 | 키리스 | 타이틀 확보 | URL 재구성 | 라이브 상태 | 판정 |
|---|---|---|---|---|---|---|
| wikidata (현 1차) | 티어1 | ✅ | ✅(검색+sitelink) | ✅ | 200 (부하 시 게이트) | **유지 + 최적화(권고 1)** |
| zh.dbpedia.org | ✅ | ✅ | — | — | **000 다운** | 기각 |
| ko.dbpedia.org | ✅ | ✅ | — | — | **000 다운** | 기각 |
| ja.dbpedia.org | ✅ | ✅ | ✅(ja 한정) | ✅(ja) | 503 flaky | ja 전용 유지(S38) |
| **DBpedia Global SPARQL** (dbpedia.org) | ✅ | ✅ | ⚠️ 라벨→**EN 리소스**만 | **❌** | 200 (~0.9s) | 기각 (아래 §3.1) |
| **Wikimedia beta cluster** (`*.beta.wmcloud.org`) | ✅ | ✅ | ❌ 콘텐츠 stale | — | 200 | 기각 (§3.2) |
| search-api.wmcloud.org | ✅ | — | — | — | **NXDOMAIN** | 기각 |
| Wikiwand | ✅ | ✅ | ⚠️ | ❌ | **403 Cloudflare** | 기각 |
| Wayback Machine CDX | ✅ | ✅ | ⚠️ chicken-egg | ⚠️ | **연결 타임아웃** | 기각 |
| iwiki.eu.org / wikimirror.net | ✅ | ✅ | ? | ? | **000 dead** | 기각(비신뢰) |
| Baidu Baike | ✅ | ❌ | ❌ | ❌ (baike 도메인) | **403 百度安全验证** | 기각 |
| Bing `site:` (기존 백엔드) | — | ✅ | ⚠️ | ❌ (bing URL) | CJK 빈 SERP | 기각 |

**결론**: "S38 스타일의 zh/ko 2차 미러 추가"는 구현 불가(현실적 후보 없음)에 가깝다. 남은 레버는
① **1차 티어(위키데이터)의 발동률을 끌어올리는 것** (호출 수 절반화 + 가드 정책 개선 — §4) 과
② **오프라인 타이틀 인덱스** (덤프 기반, ToS 안전, §5) 이다.

---

## 2. 배경: 왜 2차 미러가 필요한가

- **20개 eval 쿼리**(zh-fact-01~10, zh-general-01~04 등)의 gold가 `zh.wikipedia.org`, 일부 kr 쿼리
  (kr-general-03 `비타민 D 부작용` 등)의 gold가 `wikipedia.org`다.
- wikipedia 429 창은 **모든 언어 위키가 공유하는 wikimedia 게이트웨이**에서 발생하므로
  (S36 실측), 미러는 반드시 **다른 인프라**여야 한다.
- S38이 ja에 대해 ja.dbpedia.org SPARQL 2차 티어를 붙였지만, **zh/ko.dbpedia.org는 다운(HTTP 000)**
  이라 zh/ko는 위키데이터 1차 티어만 남아 있다.
- **S40 실측이 결정적이다**: 위키데이터 티어는 eval 연속 부하에서 **0% 발동**(256 스킵 + 33 상태실패,
  발동 성공 0건) — 2차 티어가 필요한 이유는 1차가 게이트되기 때문이며, "게이트 자체"가 진짜 병목이다.

---

## 3. 후보별 라이브 검증 상세

### 3.1 DBpedia Global SPARQL (`dbpedia.org/sparql`) — 살아있지만 URL 재구성 불가
- `SELECT ?s WHERE { ?s rdfs:label "区块链"@zh }` → **`dbpedia.org/resource/Blockchain`** (EN 리소스)
- `…"비타민"@ko` → **`dbpedia.org/resource/Vitamin`** (EN 리소스)
- 즉 글로벌 엔드포인트는 zh/ko 라벨을 **영문 리소스 URI로만** 매핑하고, `foaf:isPrimaryTopicOf`도
  EN wikipedia URL만 준다. zh/ko wikipedia 타이틀로 가는 경로가 없음.
- `owl:sameAs`(→wikidata QID)를 타도 **sitelink 조회는 위키데이터 API = 티어 1 인프라**로 회귀.
- **판정**: 200·키리스·저지연(~0.9s)이지만 gold URL 재구성이 원천 불가 → 기각.

### 3.2 Wikimedia beta cluster (`zh/ko.wikipedia.beta.wmcloud.org`) — 살아있지만 콘텐츠가 stale
- 리다이렉트 후 200 응답, MediaWiki API 정상 (키리스, 교차 인프라).
- 그러나 **핵심 문서 전부 missing**: `titles=量子计算/区块链/人工智能`(zh), `인공지능/비타민 D`(ko)
  → `"missing":""` (엔티티 키 `-1`). 검색도 `totalhits:1`로 西夏文(서하문) 같은 엉뚱한 결과만.
- beta 클러스터는 **MediaWiki 소프트웨어 테스트용**으로 콘텐츠가 프로덕션과 동기화되지 않는다.
- **판정**: 2차 미러로 무의미 → 기각.

### 3.3 그 외 후보 (모두 라이브 실패/부적합)
| 후보 | 실측 | 사유 |
|---|---|---|
| `search-api.wmcloud.org` | NXDOMAIN | 존재하지 않음 |
| Wikiwand (`wikiwand.com/zh/…`) | 403 Cloudflare "Attention Required" | 키리스 차단; URL 도메인도 wikipedia 아님 |
| Wayback CDX (`web.archive.org`) | 연결 타임아웃 (207.241.237.3, 20s) | 도달 불가 + 타이틀 선지식 필요(chicken-egg) |
| iwiki.eu.org / wikimirror.net | HTTP 000 | dead (제3자 미러는 신뢰성·ToS 리스크도 큼) |
| Baidu Baike | 403 百度安全验证(캡차) | 키리스 불가 + URL이 baike 도메인 (gold 불일치) |
| Bing `site:zh.wikipedia.org` | 200이지만 **CJK 빈 SERP** (유기결과 0) | 기존 bing 백엔드로는 미커버 (S36의 DDG 202 차단과 동일 계열) |

---

## 4. 권고 1 (우선): "2차 미러 추가" 대신 **1차 티어 발동률 회복**

2차 미러가 필요한 것은 1차(위키데이터)가 부하에서 0% 발동하기 때문이다. 라이브 검증 결과
**단일 호출로 발동률을 2배로 끌어올릴 수 있는 길이 확인**됐다.

### 4.1 역방향 조회: `wbgetentities sites+titles` = **1호출** (현재 2호출 구조 절반화)

- **현재 구조(S36)**: `wbsearchentities`(라벨 검색, 1호출) → `wbgetentities`(배치 sitelink, 1호출)
  = **2호출/쿼리**. wbsearchentities는 `props=sitelinks`를 명시해도 sitelink를 **인라인 반환하지
  않음**(라이브 확인) — 절대 1호출로 줄일 수 없는 경로.
- **제안 구조**: `cleanWikiFallbackQuery` 후보에 대해
  `wbgetentities&sites=<siteId>&titles=<candidate>&props=sitelinks` — **1호출**.
  - 존재 시: 엔티티 키 `Q…` + sitelinks 반환 (라이브: `量子计算`→Q17995793, `비타민 D`→Q175621)
  - 부재 시: 엔티티 키 `-1` + `"missing"` (라이브: `비타민 D 부작용`→키 `-1`) → 다음 후보로
- **라이브 검증 요약**:
  ```
  wbgetentities&sites=zhwiki&titles=量子计算 → Q17995793, zhwiki:量子计算  (1호출)
  wbgetentities&sites=kowiki&titles=비타민 D   → Q175621, kowiki:비타민 D  (1호출)
  wbgetentities&sites=kowiki&titles=비타민 D 부작용 → 키 -1 (missing)       (1호출)
  ```
- **이득**:
  - 위키데이터 비인증 쿼터(IP당) 소모 **절반** → eval 부하에서 발동 가능 횟수 **2배**.
    S40의 256 스킵 + 33 상태실패 중 상당수 회복.
  - S36 검색 경로의 "관련-하위 주제 노이즈"(`区块链国家`류)가 원천 차단 (정확 타이틀 매칭).
    S36의 사후 필터(wikidataLabelRelevant)와 fetch 2회 고정 로직이 불필요해짐.
  - S38 ja.dbpedia SPARQL(정확 라벨)과 **동일 패턴** — 설계 일관성.
- **함정/대응**: 후보가 오답이면 1호출 낭비(후보 체인은 최대 3개로 제한) · 타이틀 공백/언더스코어
  정규화는 MediaWiki가 처리(`titles=`는 양쪽 호환) · **en은 기존 dbpediaSearch 유지**.

### 4.2 rate 가드 정책: `skip` → 쿨다운 만료 시점 재시도 + eval 하네스 격리 (S40 잔여)
- 현재 `isWikidataRateLimited()`이면 그냥 스킵 — 60s 쿨다운 창의 모든 후속 시도가 폐기된다.
- ① 429/5xx 응답 시 기록만 하고 **다음 후보·다음 쿼리에서 resumeAt 경과 후 재시도**하도록 변경
  ② eval 하네스는 단일 isolate에서 500쿼리×3을 연속 실행하므로 모듈 쿨다운이 영구 게이트가 됨 —
  **테스트 전용 리셋/격리**(S40 권고)로 실측 발동률을 복원.

### 4.3 KO_SUFFIX 확장 (kr gold 회복의 직접 레버, 라이브로 확인)
- `cleanWikiFallbackQuery('비타민 D 부작용','ko')` → `['비타민 D 부작용']` — **KO_SUFFIX에
  `부작용`이 없어** 후보가 그대로 남고, 역방향 조회가 **miss**(라이브 확인: 키 `-1`).
- ZH_SUFFIX(`技术|原理|方法|…`), JA_SUFFIX(`の仕組み|とは|…`)와 대칭으로
  `KO_SUFFIX = /(이란|란|에 대해| 대해|의 의미| 뜻|부작용|효능|원인|추천|장단점)$/` 확장 필요.
- 대상 쿼리: kr-general-03 `비타민 D 부작용`(gold wikipedia.org) 등.

---

## 5. 권고 2 (중기, ToS 안전): 오프라인 타이틀 인덱스 (덤프 기반)

진정한 "교차 인프라 2차 미러"의 유일한 ToS 안전 구현은 **오프라인 타이틀 인덱스**다.

- **소스**: `dumps.wikimedia.org/zhwiki/latest/zhwiki-latest-all-titles.gz` (동일 wikimedia지만
  **다운로드 CDN = API 게이트웨이와 다른 인프라**, 다운로드 중엔 429 무관)
- **규모**: zh 약 140만 / ko 약 60만 타이틀, gz 압축 수십 MB — KV/DO에 월 1회 빌드
- **동작**: `cleanWikiFallbackQuery` 후보 → 로컬 타이틀 lookup(서브스트링 → 존재 확인) →
  `<lang>.wikipedia.org/wiki/<candidate>` URL 재구성 → 관련성 게이트(기존 재사용)
- **이득**: 런타임 외부 의존성 0 · rate 가드·쿼터와 무관 · eval 하네스와 무관 · 전 언어 확장 가능
- **비용/난이도**: 빌드 스크립트 1개 + 저장소 계약 추가 — M 수준. 라이브 2차 미러(위키데이터)보다
  **신뢰성에서 우위**이므로, 위키데이터 발동률 최적화(§4) 후 차선책으로 권장.

---

## 6. 구현 시나리오 비교

| 시나리오 | 난이도 | 예상 이득 | 리스크 | 권고 |
|---|---|---|---|---|
| A. 역방향 조회로 위키데이터 1호출화 (§4.1) | S | 발동률 2배, S36 노이즈 차단 | 타이틀 정규화 엣지 | **즉시 (우선순위 1)** |
| B. rate 가드 재시도 + eval 격리 (§4.2) | S~M | eval 실측 발동률 회복 (S40의 0%→실제) | 쿨다운 창 재시도 폭주 | **즉시 (우선순위 2)** |
| C. KO_SUFFIX 확장 (§4.3) | XS | kr-general-03 등 gold 회복 | 없음 | **즉시 (우선순위 3)** |
| D. 오프라인 타이틀 인덱스 (§5) | M | 외부 의존 0, 전 언어, 평가 안정 | 저장소/빌드 계약 | 중기 (A~C 후) |
| E. 교차 인프라 라이브 미러 추가 | — | — | 후보 없음 (§3) | **기각** |

**종합 판정**: "zh/ko wikipedia 429 2차 미러"의 현실적 해법은 **새 인프라 추가가 아니라
기존 1차 티어(위키데이터)를 1호출 구조로 재설계 + 가드 정책 개선**이다. 라이브 검증된 1호출
역방향 조회는 현재 2호출 구조를 절반으로 줄이며, S38 ja.dbpedia 패턴과 일관된 구현이다.

---

## 7. 부록: 검증 명령·증거

- 프로브 스크립트: `scripts/probe-nonen-mirrors.sh` (2026-08-08 실행)
- 핵심 라이브 증거:
  - `zh.wikipedia.org/w/api.php` baseline 200 (429 창은 간헐적 — 미러는 창 동안만 필요)
  - `zh.dbpedia.org`/`ko.dbpedia.org` SPARQL → HTTP 000 (연결 실패)
  - `dbpedia.org/sparql` zh/ko 라벨 → `resource/Blockchain`, `resource/Vitamin` (EN 전용)
  - `*.beta.wmcloud.org` API 200 + 핵심 타이틀 전부 `missing:""`
  - `wbgetentities sites+titles` 역방향: 量子计算→Q17995793 / 비타민 D→Q175621 / 비타민 D 부작용→-1
  - Wikiwand 403, Baidu 403, Wayback 000(타임아웃), iwiki/wikimirror 000, search-api NXDOMAIN
