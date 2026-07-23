## Phase 4: 검색 품질 평가 자동화 — 구현 계획

### 배경 (검증 완료)
eval 인프라는 상당히 갖춰져 있지만 (120쿼리, CI 연동, baseline diffing), **NDCG/MRR이 없고 gold-standard relevance judgment가 없음**. llm-judge 모듈은 존재하지만 메인 runner와 분리되어 있음.

### 목표
CI에서 매 PR마다 NDCG@10 + 인용 정확도를 측정하고, 직전 baseline 대비 -5% 시 실패.

---

### 작업 1: EvalQuery에 relevance grades 필드 추가
**파일:** `eval/types.ts`

```ts
export interface EvalQuery {
  // ... 기존 필드 ...
  /** Gold-standard relevance judgments: URL → grade (0-3). Phase 4. */
  relevantUrls?: string[]          // grade 2+ URLs (relevant)
  relevantGrades?: Record<string, number>  // URL → 0|1|2|3
}
```

### 작업 2: NDCG@10 / MRR / Precision@K 메트릭 함수 구현
**파일:** `eval/metrics.ts`

순수 함수로 구현 (외부 의존성 없음):
- `computeNdcg(results, grades, k=10)` — DCG/iDCG 계산
- `computeMrr(results, relevantUrls)` — 첫 번째 관련 문서의 역수 순위
- `computePrecisionAtK(results, relevantUrls, k=10)` — 상위 K개 중 관련 문서 비율
- `aggregateRankingMetrics(allResults)` — 전체 쿼리 평균

### 작업 3: Gold-standard 데이터 작성
**파일 (신규):** `eval/gold-standards.json`

120개 쿼리 중 핵심 30개에 대해 수동으로 관련 URL 리스트 작성. 예:
```json
{
  "kr-tech-01": { "relevantUrls": ["react.dev", "developer.mozilla.org"] },
  "en-technical-01": { "relevantUrls": ["developer.mozilla.org", "github.com"] }
}
```
이는 완벽한 gold-standard가 아닌 **합리적 기준선** — 각 쿼리에 대해 예상되는 권위 도메인 목록.

### 작업 4: runner.ts에 랭킹 메트릭 통합
**파일:** `eval/runner.ts`

`runEval`에서 각 쿼리 실행 후 NDCG/MRR/Precision을 계산하여 `EvalResult`에 추가. gold-standard가 없는 쿼리는 스킵 (기존 동작 유지).

### 작업 5: baseline 회귀 임계값에 NDCG 추가
**파일:** `eval/runner.ts` (`diffBaseline`)

직전 baseline 대비 NDCG@10이 -5% 이상 하락하면 regression으로 플래그.

### 작업 6: reporter에 NDCG/MRR 출력 추가
**파일:** `eval/reporter.ts`

GitHub Step Summary markdown에 NDCG@10 / MRR / Precision@10 섹션 추가.

### 작업 7: 테스트
**파일 (신규):** `tests/unit/eval-metrics.test.ts`

NDCG/MRR/Precision 함수의 수학적 정확성 검증 (알려진 입력/출력 케이스).

---

### 예상 변경 파일
| 파일 | 작업 |
|---|---|
| `eval/types.ts` | relevance grades 필드 추가 |
| `eval/metrics.ts` | NDCG/MRR/Precision 함수 |
| `eval/gold-standards.json` | 30개 쿼리 gold-standard (신규) |
| `eval/runner.ts` | 랭킹 메트릭 통합 + 회귀 임계값 |
| `eval/reporter.ts` | NDCG 출력 |
| `tests/unit/eval-metrics.test.ts` | 메트릭 테스트 (신규) |

### 기대 효과
- CI에서 객관적 검색 품질 측정 가능 (NDCG@10)
- 품질 회귀 자동 차단
- "보통 — 평가 척도 부족" 격차 해소