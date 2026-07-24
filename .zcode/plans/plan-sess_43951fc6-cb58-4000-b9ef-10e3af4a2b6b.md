## 인덱스 확장 개발 계획 — 153문서 → 50,000문서

### 전략: 3단계 자동 성장 파이프라인

기존 인프라(CrawlerDO, RefreshScheduler, IndexingPipeline, executionCtx.waitUntil)를 최대한 재사용하여 3가지 성장 경로를 구축합니다.

---

### Phase A: 검색 기반 자동 인덱싱 (즉시 효과, 가장 중요)

**원리**: 사용자가 검색한 쿼리의 상위 결과를 비동기적으로 인덱스에 추가. 사용할수록 인덱스가 자동으로 성장.

**작업 A-1: search-and-index 훅 추가** (`src/routes/search.ts`)
- POST/GET `/api/search` 응답 후 `c.executionCtx.waitUntil(indexFromSearchResults(result, env))` 호출
- 상위 3개 결과의 URL+title을 추출하여 D1에 직접 인덱싱 (큐 불필요)
- `raw_content`가 있으면 그대로 사용, 없으면 스킵 (재fetch 비용 절약)
- 이미 인덱싱된 URL은 content hash로 중복 스킵

**작업 A-2: 경량 인덱싱 함수** (`src/lib/search/auto-index.ts` 신규)
```ts
export async function indexFromSearchResults(
  results: SearchResult[],
  env: Env,
): Promise<void>
```
- IndexingPipeline 인스턴스 생성
- 각 결과를 processIndexJob으로 처리 (extractContent 없이 raw_content 직접 사용)
- 최대 3개 URL, 1청크씩 (CPU 최소화)
- 모든 에러는 swallow (비동기, 응답에 영향 없음)

**예상 효과**: 활성 사용자 기준 일 100검색 → 월 9,000문서 자동 추가

### Phase B: GitHub Actions 대량 시드 (1주일 목표)

**원리**: cron으로 인기 쿼리를 검색하고 결과를 인덱싱. Pages Cron 미지원이므로 GitHub Actions 사용.

**작업 B-1: 인기 쿼리 리스트 작성** (`scripts/seed-queries.json`)
- 한국 주식 상위 50종목 (이미 STOCK_CODE_MAP에 있음)
- 기술 키워드 100개 (React, Vue, Docker, Kubernetes 등)
- Wikipedia 핵심 문서 200개
- 총 350개 시드 쿼리

**작업 B-2: cron 시드 스크립트** (`scripts/cron-seed.sh`)
- 시드 쿼리로 `/api/search` 호출 → 상위 3개 결과 URL 추출 → `/api/index`로 인덱싱
- Workers AI 레이트 리밋을 피하기 위해 10초 간격
- 350쿼리 × 3URL = 1,050문서/실행

**작업 B-3: GitHub Actions 워크플로** (`.github/workflows/index-seed.yml`)
```yaml
schedule: '0 */6 * * *'  # 6시간마다
```
- cron-seed.sh 실행
- 실패 시 재시도 없음 (다음 cron에서 보완)

**예상 효과**: 6시간마다 1,050문서 → 1주일 후 ~30,000문서

### Phase C: Wikipedia 카테고리 대량 크롤링 (2주 목표)

**원리**: Wikipedia API로 특정 카테고리 전체 문서를 가져와 인덱싱.

**작업 C-1: Wikipedia 카테고리 배치 인덱서** (`scripts/seed-wikipedia.ts`)
- Wikipedia API (`/api/rest_v1/page/summary/{title}`)로 카테고리별 문서 목록 조회
- 각 문서를 `/api/index`로 인덱싱
- 카테고리: 컴퓨터과학, 수학, 물리학, 화학, 생물학, 의학, 경제학, 역사 (각 500문서)
- 총 4,000문서 (1회성 배치)

**예상 효과**: 4,000문서 1회 추가 → Phase B와 합산 34,000문서

---

### 전체 예상 성장 곡선

```
현재:     153문서 (0.01% HIT)
Phase A:  153 + 자동성장 (사용 패턴 기반)
Phase B:  +30,000문서/주 (cron 시드)
Phase C:  +4,000문서 (Wikipedia 배치)
3개월 후: ~50,000문서 (목표 HIT 45%)
```

### 예상 파일 변경

| 파일 | 작업 |
|---|---|
| `src/lib/search/auto-index.ts` | 검색 결과 자동 인덱싱 (신규) |
| `src/routes/search.ts` | waitUntil 훅 2곳 추가 |
| `scripts/seed-queries.json` | 350개 인기 쿼리 (신규) |
| `scripts/cron-seed.sh` | cron 시드 스크립트 (신규) |
| `scripts/seed-wikipedia.ts` | Wikipedia 배치 인덱서 (신규) |
| `.github/workflows/index-seed.yml` | 6시간 cron 워크플로 (신규) |

### 순차 진행 순서
1. **Phase A** (지금): auto-index.ts + search.ts 훅 → 배포 → 즉시 자동 성장 시작
2. **Phase B** (다음): cron-seed + GitHub Actions → 대량 시드 시작
3. **Phase C** (이후): Wikipedia 배치 인덱서 → 일회성 대량 추가