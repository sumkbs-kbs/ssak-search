# CI 게이트 재검증 리포트 (S67, 2026-08-09)

## 1. 로컬 재검증 — 5대 게이트 전부 그린

| 게이트 | 명령 | 결과 |
|---|---|---|
| eslint lint (0-warning) | `npm run lint:eslint:ci` (src/ tests/ scripts/ eval/ --max-warnings=0) | ✅ 0 |
| typecheck | `npm run lint:ci` (tsc --noEmit -p tsconfig.json) | ✅ 0 |
| format | `npm run format:check` (ts/tsx/js/mjs 전체 — S62/S64/S66) | ✅ 0 |
| unit | `npx vitest run --project unit` | ✅ 1,470건 (74파일) |
| build | `npm run build` (vite) | ✅ dist/_worker.js 1,074KB |

integration(cloudflare-pool) 로컬 스모크: `vitest.integration.config.ts` parsers 25건 ✅ (3.9s) — 로컬 정상.

## 2. 워크플로우 3종

| 워크플로우 | 트리거 | 실행 게이트 |
|---|---|---|
| **ci.yml** | push(main) + PR(main) | lint, typecheck, format, unit(+coverage), binding-verify, build, audit(비차단), snapshot integrity |
| **eval.yml** | push/PR(paths: src/**, eval/**, package.json) + **schedule(주 1회)** + dispatch | format(S64), eval:ci(:slack) — **회귀 게이트**(compareWithBaseline + failed/regression 시 exit≠0, S33/S58), baseline 저장(push만), README(schedule) |
| **integration-tests.yml** | **PR 전용**(paths) + dispatch | build, wrangler pages dev 프리뷰 서버, test:integration(HTTP E2E) |

baseline: eval/baselines/latest.json (2026-08-09T02:25Z, 500쿼리) 존재 — 회귀 비교 기준 유효.

## 3. 트리거 × 게이트 매트릭스

| 게이트 | push→main | PR | schedule(주간) | workflow_dispatch |
|---|---|---|---|---|
| eslint lint | ✅ ci | ✅ ci | ❌ | ❌ |
| typecheck | ✅ ci | ✅ ci | ❌ | ❌ |
| format | ✅ ci + ✅ eval | ✅ ci | ✅ eval | ✅ eval |
| unit 테스트 | ✅ ci | ✅ ci | ❌ | ❌ |
| build | ✅ ci | ✅ ci + ✅ int | ❌ | ❌ (int에서만) |
| **integration 테스트** | **❌ 갭** | ✅ int | ❌ | ✅ int |
| eval 회귀 게이트 | ✅ eval(단일 run) | ✅ eval(단일 run) | ✅ eval(단일 run) | ✅ eval(단일 run) |
| eval baseline 저장 | ✅ (--save) | ❌ | ❌ | ⚙️ (input) |
| binding-verify | ✅ ci | ✅ ci | ❌ | ❌ |
| coverage 임계 | ❌ (생성만) | ❌ | ❌ | ❌ |

## 4. 갭 분석 (심각도순)

### G1. integration 테스트: push→main 미실행 ⚠️ HIGH
integration-tests.yml이 **PR 전용** (pull_request + dispatch, push 트리거 없음). main에 직접 push하면
(PR 병합 없이) 통합 테스트 전체를 건너뜀 — src/ 변경이 merge 후 검증 없이 배포될 수 있음.
- 영향: 통합 테스트는 실제 Workers 런타임+HTTP E2E로, 유닛이 못 잡는 배선 오류를 검출
- 수정: `push: branches:[main]` + 동일 paths를 on에 추가 (PR과 동일 조건). 워크플로우 YAML 2줄.
- 로컬 통합 테스트는 4초(parsers)~수분 — push 트리거 추가 비용 합리적

### G2. eval 회귀 게이트가 단일 run 노이즈에 취약 — 실측 13%, 52%가 가용성 기인 ⚠️ HIGH(조치 우선)
모든 트리거에서 `eval:ci`는 **단일 run**. NDCG 회귀 임계 `-0.05` (diffBaseline, S58 gold-강건
재계산)은 존재하나, **저장 run-1..3을 S54 재계산으로 페어 비교한 실측 (scripts/probe-s67-gate-noise.ts):
run 페어 1,500개 중 195개(13.0%)가 `<-0.05` 플래그** — 고유 쿼리 126/500(25%), 페어별 run1vs2
58, run2vs3 74, run1vs3 63. **분해: 101/195(52%)는 패배 run이 wikipedia 백엔드 부재(가용성 기인 —
실제 NDCG 손실, 게이트가 "랭킹 회귀"와 "가용성 회귀"를 구분 못 함), 37/195(19%)는 양쪽 모두
wikipedia 보유(순수 run/랭킹 노이즈 — 게이트의 실질 오탐 플로어), 57/195(29%)는 모호(패배 run은
wikipedia 보유, 승리 run이 부재).**
- **핵심 함의**: eval/index.ts는 `regressions.length > 0`(단일 쿼리라도)이면 non-zero exit —
  13% 오탐/고유 126개면 **src/를 건드리는 push마다 eval 게이트가 사실상 거의 항상 fail**할 것으로
  예상. 현재 운영에서 만성 적신호인지 GitHub Actions 이력으로 확인 필요 (열린 질문).
- 수정: PR/게이트에 2-run 안정화(둘 다 -0.05 이상 하락 시에만 fail) 또는 가용성 기인 플래그를
  S37 loss 게이트로 위임(이 게이트에서 제외); median(runs=3)은 dispatch에서만 가능한 한계 유지

### G3. coverage 임계값 없음 LOW
unit job이 coverage.json을 생성·요약만 하고 **하락 시 실패시키지 않음** — 커버리지 회귀가 조용히
통과. `--coverage.thresholds` (lines/branches) 설정이 없음.

### G4. npm audit 비차단 LOW
`npm audit --audit-level=high ... || true` — 취약점이 경고만 남기고 통과.

### G5. schedule eval은 baseline 미갱신 LOW
주간 eval이 README만 갱신하고 baseline은 push 때만 저장 — schedule 측정치가 다음 push 전까지 회귀
게이트 기준이 되지 않음 (의도된 설계일 수 있으나 명시 필요).

### G6. --save 순환성 (설계 특성) INFO
push마다 baseline을 갱신해 "회귀" 기준이 매 push 이동 — A→B 회귀로 fail된 후 다음 push에서 baseline=B로
기록됨. 회귀를 평균화하는 S33 설계 (gold 강건성은 S58로 확보). 기록용으로 명시.

### 비갭 (확인됨)
- eval.yml paths 제한(src/eval/package.json)은 의도된 것 — docs/scripts/tests만의 변경은 eval 불필요
- lint/typecheck/unit이 eval.yml에 없는 것은 ci.yml이 push/PR에서 전부 커버하므로 실질 갭 아님
  (schedule/dispatch는 이미 게이트된 코드 상태를 측정)

## 5. 권고 우선순위
1. **G2** — 단일 run 게이트가 push마다 만성 fail할 것으로 예상 (13%, 52% 가용성 기인) — 2-run
   안정화 또는 가용성 플래그를 S37 loss 게이트로 위임. **우선 조치**
2. **G1** — integration-tests.yml에 push 트리거 추가 (같은 paths 필터 필수 — docs-only push 방지;
   src 변경 push는 eval.yml과 비용 중복, 실패는 게이팅이 아닌 가시성 제공임을 인지)
3. **G3/G4** — coverage 임계 + audit 차단 여부 정책 결정
4. G5/G6 — 문서화 (이 리포트로 대체)

## 6. 로컬 재현
- 5대 게이트: 위 표 명령 그대로 (전부 exit 0)
- eval 회귀 게이트 단독 스모크: `npx tsx eval/index.ts --ci --summary` (단일 run ~15-20분, 이번 턴 미실행 —
  baseline 유효성은 2026-08-09 저장값으로 확인)
