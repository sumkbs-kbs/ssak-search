# 상용 수준 기능 개선 로드맵

> 목표: Tavily / Brave Search API / SerpAPI 수준의 기능 완성도 + 그 이상
> 원칙: 유료 API 의존 최소화, 자체 인프라로 해결

---

## Phase 0 — Quick Wins (기능 즉시 개선) ✅
**완료된 항목:**
- TypeScript strict + 0 type errors
- 124개 단위 테스트
- Multi-tenancy + API key auth
- Auto Pro/Fast routing
- Cost tracking (/api/usage)
- Eval harness (npm run eval)
- SDK (TypeScript + Python)
- Streaming (SSE + keepalive + abort)
- OpenAPI spec (/openapi.yaml)
- 페이지네이션 (page/page_size/total_results/total_pages)
- 지식그래프 (KnowledgeGraph)
- 이미지 검색 (orchestrator 내 Bing Image Search 연동)
- 멀티백엔드 (Naver + Bing + Wikipedia + GitHub + HN + Reddit + arXiv + DDG + Jina)

---

## Phase 1 — 핵심 기능 격차 해소 (Functional Parity)
**현재 vs 상용 제품 간의 가장 큰 기능 차이부터 해결**

### 1.1 전용 `/api/news` 엔드포인트 [높음]
**현재**: `topic=news` 파라미터로만 뉴스 검색 가능
**목표**: Tavily 수준의 전용 뉴스 검색 엔드포인트
- `GET/POST /api/news` — news-specific response (title, source, published_date, author)
- `GET /api/news/trending` — 실시간 트렌딩 뉴스
- 정렬: relevance / date / source
- 필터: source (CNN, BBC, 등), date_from, date_to
- 백엔드: Bing News 전용 + HackerNews + Reddit

### 1.2 전용 `/api/images` 엔드포인트 [높음]
**현재**: 이미지 검색이 orchestrator 내부에서만 실행, API 응답에 images[] 필드로만 노출
**목표**: Brave Search API / SerpAPI 수준의 이미지 검색
- `GET/POST /api/images` — image-specific response
- 필드: url, thumbnail, title, source, width, height, format
- 필터: size (small/medium/large), color, type (photo/clipart/animated), safe_search
- 백엔드: Bing Image Search (기존 코드 활용) + 필요시 Google Images via SearXNG

### 1.3 Knowledge Graph 강화 [중간]
**현재**: Wikipedia 기반 최소한의 KG만 제공
**목표**: Google Knowledge Graph 수준 (Brave Search API 대응)
- Wikipedia infobox 파싱 강화 (facts: Record<string, string> 완전 구현)
- Wikidata fallback (무료 API)
- Schema.org JSON-LD 파싱 (검색 결과 내 구조화 데이터 추출)
- 응답: title, description, url, image, type, facts, related_entities

### 1.4 Location / Country 필터 [중간]
**현재**: location 기반 검색 불가
**목표**: SerpAPI/Perplexity 수준의 지역 검색
- `POST /api/search` — `location` / `country` / `language` 파라미터 추가
- Bing `mkt` 파라미터 활용 (이미 중국어 zh-CN 구현됨, 확장)
- IP 기반 위치 감지 (Cloudflare `cf-ipcountry` 헤더)
- 지역 뉴스 / 지역 비즈니스 검색

### 1.5 Rich Snippet / 구조화 결과 파싱 [중간]
**현재**: RichSnippet 타입은 존재하지만 파싱 미흡
**목표**: Google SERP 수준의 구조화 데이터
- Bing HTML 내 rich snippet 추출 (별점, 가격, 재고, 요리시간 등)
- Schema.org JSON-LD 추출 및 응답 포함
- 응답: rich_snippet.type (product/recipe/review/article/event), data

### 1.6 추천 검색어 / Autosuggest [낮음]
**현재**: `related_queries`는 규칙 기반 생성 (단순 키워드 조합)
**목표**: Brave Autosuggest API 수준
- `/api/suggest?q=...` — 실시간 검색어 추천 엔드포인트
- Bing Autosuggest API (무료, 키 불필요) 연동
- 인기 검색어 캐싱 (KV)

---

## Phase 2 — AI 답변 고도화 (Answer Quality)
**현재**: Workers AI (@cf/meta/llama-3.1-8b-instruct-fast) — 8B 모델, 제한된 품질

### 2.1 더 강력한 AI 모델 [높음]
- Workers AI `@cf/meta/llama-3.2-11b-vision-instruct-warm` (11B, 더 나은 추론)
- 또는 `@hf/mistral/mistral-7b-instruct-v0.3`
- 장문 답변을 위한 max_tokens 512 → 2048

### 2.2 RAG (Retrieval-Augmented Generation) 개선 [높음]
**현재**: 검색 결과 5개를 단순 컨텍스트로 주입
**목표**: 상용 수준의 RAG:
- 검색 결과 10개 + content 전문 + extract 결과 함께 주입
- 검색 결과 관련도 점수 기반 중요도 가중치
- 중복 제거 및 충돌 해결 (서로 다른 소스의 모순된 정보 처리)
- 출처 인용 (citation) — 응답 내 [1], [2] 형식으로 소스 URL 매핑
- 답변 컨텐츠 타입 감지 (요약형 / 단계별 / 비교표 / 리스트)

### 2.3 Research 모드 [중간]
**현재**: 단일 쿼리 → 단일 응답
**목표**: Tavily Research / Perplexity Pro 수준:
- `/api/research` 엔드포인트
- 다중 쿼리 자동 생성 (query decomposition)
- 각 서브쿼리 병렬 검색
- 결과 취합 및 통합 답변 생성
- 깊이 제어 (basic: 3 sub-queries / advanced: 7 sub-queries)

---

## Phase 3 — 데이터 수집 인프라 (Search Index)
**현재**: 요청 시 실시간 스크래핑 (가장 큰 약점)

### 3.1 SearXNG 자체 호스팅 [높음]
**문제**: Google 결과 없음, HTML 스크래핑 취약성
**해결**: SearXNG (오픈소스 메타 검색 엔진) 자체 호스팅
- Docker compose로 VPS 또는 Cloudflare에 배포
- Google, DuckDuckGo, Bing 등 70+ 엔진 통합
- JSON API로 결과 수집
- HTML 파서 제거 리스크 분산
- 비용: ~$5-10/mo VPS

### 3.2 캐싱 레이어 고도화 [높음]
**현재**: in-memory Map (isolate별, 콜드스타트 증발)
**목표**: 상용 수준 캐싱:
- Cloudflare KV (또는 D1)로 persistent cache
- TTL 정책: news=5min, general=30min, factoid=24h
- 캐시 적중률 측정 및 보고
- LRU eviction

### 3.3 백엔드 상태 관리 + 회로 차단기 개선 [중간]
**현재**: DO 기반 rate limiter 있으나 binding 미설정
**목표**:
- DO binding 대시보드 설정 안내 + 자동 감지
- 백엔드별 health score (연속 실패 추적)
- 적응형 타임아웃 (과거 latency 기반 동적 조정)
- Self-healing (차단된 백엔드 자동 복구 시도)

---

## Phase 4 — 관측 가능성 & 운영 (Observability)
**현재**: 기본 로깅만 있음, 알림/메트릭 영속성 없음

### 4.1 메트릭 영속성 [높음]
**현재**: Metrics isolate 메모리, 콜드스타트 시 리셋
**해결**: Workers Analytics Engine (무료 티어 내)
- 각 요청마다 Analytics Engine에 데이터 포인트 기록
- 대시보드: 요청 수, 지연시간, 백엔드별 성공률, 캐시 적중률
- SQL API로 쿼리 가능

### 4.2 Parser 회귀 탐지 (Canary) [높음]
**현재**: `HEALTH_CANARY_ENABLED`가 false
**목표**: 
- Canary 쿼리셋 (한국어/영어/중국어/금융/기술 각 2개 = 10개)
- 15분 간격으로 실행
- 결과 개수 + 구조 검증 (title/url/content/score 필드 존재 확인)
- 2회 연속 0건 → Slack/Pushover 알림
- 마크업 변경 감지 로그

### 4.3 Slack / Pushover 알림 [중간]
**현재**: monitor.yml은 있으나 webhook 미설정
**해결**:
- Pushover (일회성 $5) 또는 Slack webhook
- 알림 조건: parser 회귀, 백엔드 3회 연속 실패, rate limit 초과, 에러율 > 5%
- Daily digest: 하루 검색량, 평균 지연시간, 에러율

---

## Phase 5 — 기능 확장 (Beyond Commercial)
**상용 제품에도 없는 차별화 기능**

### 5.1 결과 내 재검색 (Search-in-Search) [중간]
- 첫 검색 결과 필터링/재정렬
- `POST /api/search/refine` — 기존 결과셋에 새 필터 적용
- Facet: source, domain, date_range, content_type

### 5.2 배치 검색 [중간]
- `POST /api/search/batch` — 한 번에 최대 10개 쿼리 처리
- 각 쿼리 결과 개별 반환
- 총 subrequest 최적화 (중복 도메인 호출 제거)

### 5.3 검색 히스토리 / 개인화 [낮음]
- D1에 검색 히스토리 저장 (tenant별)
- 최근 검색어 / 자주 방문한 도메인 기반 랭킹 조정
- 개인화된 추천 검색어

### 5.4 비교 검색 [낮음]
- `POST /api/search/compare` — 두 개체 비교 (예: "React vs Vue")
- 좌우 분할 결과 + 차이점 하이라이트 + AI 비교 분석

### 5.5 Export 기능 [낮음]
- 검색 결과 JSON / CSV / Markdown export
- 공유 가능한 검색 결과 링크 (D1에 저장, 24hr TTL)

---

## 실행 우선순위

| 우선순위 | 항목 | 예상 노력 | 영향도 |
|---------|------|----------|--------|
| P0 | `/api/images` 엔드포인트 | 2-3시간 | 높음 (기능 격차) |
| P0 | `/api/news` 엔드포인트 | 2-3시간 | 높음 (기능 격차) |
| P0 | Knowledge Graph 강화 | 3-4시간 | 높음 (검색 품질) |
| P0 | RAG 개선 (better AI + citation) | 4-5시간 | 높음 (답변 품질) |
| P1 | Location/Country 필터 | 2-3시간 | 중간 |
| P1 | Rich Snippet 파싱 | 3-4시간 | 중간 |
| P1 | Canary + 알림 | 3-4시간 | 중간 (운영) |
| P1 | 메트릭 영속성 | 2-3시간 | 중간 |
| P2 | Research 모드 | 5-6시간 | 중간 |
| P2 | SearXNG 호스팅 | 3-4시간 | 높음 (검색 인프라) |
| P2 | Persistent 캐싱 (KV) | 3-4시간 | 중간 |
| P3 | 캐시 최적화 + 회로 차단기 | 2-3시간 | 낮음 |
| P3 | 재검색 / 배치 검색 | 3-4시간 | 낮음 (차별화) |
| P4 | 추천 검색어 | 2-3시간 | 낮음 |
| P4 | 검색 히스토리 / 비교 검색 | 4-5시간 | 낮음 |

---

## Phase별 실행 계획

### Phase 1-A: 즉시 실행 (이번 세션)
1. `/api/images` 엔드포인트
2. `/api/news` 엔드포인트
3. Knowledge Graph 강화
4. Location/Country 필터

### Phase 1-B: 다음 세션
5. Rich Snippet 파싱
6. Canary + 알림
7. 메트릭 영속성
8. RAG 개선

### Phase 2-A: 차주
9. Research 모드
10. SearXNG 호스팅
11. Persistent 캐싱 (KV)
12. 추천 검색어

### Phase 2-B: 차주 이후
13. 재검색 / 배치 검색
14. 검색 히스토리
15. Export 기능
