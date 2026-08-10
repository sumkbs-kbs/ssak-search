# 14. CI 사전 점검 — 커밋별 게이트 재검증 (verify-commits-ci)

## 목적

푸시 전에 "각 커밋이 CI에서 그린인지"를 로컬에서 검증한다. Docker 기반 `act`가
이 머신에 없어서, **git worktree로 각 커밋을 fresh checkout**하고 CI가 실제로
실행하는 게이트 명령(ci.yml)을 그대로 재현한다. CI는 각 커밋을 독립적으로
체크아웃하므로, worktree 방식이 CI와 동일한 관찰점을 제공한다.

## 사용법

```bash
# 최근 5개 커밋 (HEAD~5..HEAD — rev-list A..B는 A 자체를 제외)
bash scripts/verify-commits-ci.sh

# 명시적 범위 (rev-list A..B — A 자체는 제외됨)
bash scripts/verify-commits-ci.sh 97a042f..fab8bf5

# 단일 커밋 (A~1..A)
bash scripts/verify-commits-ci.sh 97a042f~1..97a042f

# 빌드 생략 (가장 오래 걸리는 게이트)
bash scripts/verify-commits-ci.sh --skip-build

# eval 회귀 게이트 오프라인 재현 (build 대체) — 저장된 run-*.json 아티팩트로
bash scripts/verify-commits-ci.sh --eval

# 실패 시 worktree 유지 (디버깅용)
bash scripts/verify-commits-ci.sh --keep

# act-정확 모드 — symlink 없이 매 커밋에서 실제 npm ci 실행 (act 갭 해소)
bash scripts/verify-commits-ci.sh --force-npm-ci
```

## --force-npm-ci (2026-08-10)

기본 node_modules 전략은 manifest 미변경 시 메인 node_modules를 symlink한다.
하지만 symlink는 act/실제 CI의 **clean-container 설치**를 재현하지 않는다:
로컬 npm이 남긴 플랫폼별 optional deps·호이스팅 drift·stale postinstall이
그대로 실려, symlink에선 그린이지만 fresh 설치에선 레드가 될 수 있다.
`--force-npm-ci`는 symlink를 아예 비활성화하고 **모든 worktree에서 실제
`npm ci`를 실행**한다 (~1-2분/커밋 — 정확성이 우선일 때만 사용). act와의
검증 갭을 없애는 모드로, manifest 변경과 무관하게 동작한다.

## --eval 게이트 (2026-08-10)

`--eval`은 60분짜리 라이브 eval 대신 **저장된 eval 아티팩트로 오프라인 재현**을
한다 — 커밋의 `eval/results/run-*.json`을 로드해 `computeMedianReport`로 median
리포트를 재구성(S81 median-NDCG pick)하고, 그 커밋의 `eval/baselines/latest.json`
과 G2 안정화 비교(`diffBaselineStabilized`, 2-run 이상; 단일 run은
`diffBaseline`)를 실행한다. 수 초, 네트워크 없음.

| 상태 | 의미 | pre-flight 영향 |
|---|---|---|
| PASS | 아티팩트 있고 회귀 없음 (또는 baseline 없음) | 통과 |
| FAIL | 아티팩트 있고 회귀 감지 | 실패 |
| SKIP | 커밋에 run-*.json 없음 (median save 이전/미커밋) | 통과 (아티팩트가 없으므로 평가 불가 — 실패로 오판하지 않음) |
| ERROR | 아티팩트 있으나 손상/비일관 | 실패 |

구현: `scripts/verify-commit-eval.ts` (순수 `runGate(evalDir, opts)` export +
단위 테스트 12건). 데이터(아티팩트·gold·baseline)는 커밋의 것이고, 게이트
알고리즘(median/baseline/metrics)은 현재 체크아웃 것 — S54/S58 방식으로 과거
아티팩트를 현재 규칙으로 재스코어링한다.

## 회귀 가드 — red-gate 요약 (2026-08-10)

게이트가 하나라도 레드면 스크립트가 **어떤 커밋·어떤 게이트·어떤 파일이
레드인지** 자동 요약한다 (`scripts/summarize-gate-failures.ts`). 게이트별 로그
포맷을 파싱한다: tsc `path(line,col)`, eslint stylish 파일 헤더, prettier
`[warn]`, vitest FAIL/AssertionError, vite build 에러, eval `[EVAL GATE]` 라인.

```
❌ FAIL — red gates per commit:
  commit 2660263:
    [npmci]
      npm error Missing: @cloudflare/workers-types@4.20260702.1 from lock file
```

**NPMCI-FAIL**: 범위 내 manifest 변경 커밋이 npm ci 폴백을 강제할 때, 구
lockfile 커밋은 `npm ci`가 실패한다. 과거엔 이 실패를 조용히 삼켜 빈
node_modules로 게이트가 전부 오실패했다 — 이제 npm ci 실패를 감지해 전체 게이트를
`NPMCI-FAIL`로 표시하고 npm ci 로그(`<short>-npmci.log`)의 에러를 요약한다.

## eval 아티팩트 무결성 검증 (2026-08-10)

`scripts/verify-jsonc.ts`가 `--eval` 플래그로 **저장된 eval 아티팩트**
(`eval/results/*.json` + `eval/baselines/*.json`)도 검증한다 — offline eval
게이트(verify-commit-eval.ts)와 S54 실시간 재스코어링 경로가 읽는 바로 그
파일들이다.

- **구문 검증**: JSONC string-aware 스트립 + JSON.parse (기존 메커니즘).
- **의미 검증 (신규)**: eval 아티팩트는 `report.results` 배열을 가져야
  한다 — 부분 쓰기로 `{}`처럼 **파싱은 되지만 형태가 깨진** 파일도 잡는다
  (truncated write가 구문만으로는 미검출되는 갭을 커버).
- **SKIP 의미론**: 아티팩트가 없는 커밋(디렉터리 부재)은 `[SKIP]` exit 0 —
  CI가 아티팩트 미보유 커밋에서 오실패하지 않는다.

연결: ① ci.yml `Verify JSON/JSONC integrity` 스텝이 `--eval`로 실행
(push/PR마다 커밋된 아티팩트 손상 조기 감지) ② eval.yml은 Run evaluation
직후·아티팩트 업로드/커밋 **전에** `--eval` 검증 스텝을 실행 (`if: always()`)
— 손상된 baseline이 커밋되는 것을 원천 차단. 단위 테스트 6건 추가
(evalArtifactFiles/isEvalArtifactWellFormed/validateFile 손상·형태 검출).

### S86d: 3중 JSON 파싱 → 단일 파싱 (2026-08-10)

runGate가 아티팩트를 **한 번만 파싱**하도록 리팩터: `parseJsonc` (direct
JSON.parse fast-path — eval 아티팩트는 JSON.stringify 출력이라 순수 JSON,
실패 시에만 comment-aware strip) + `parseEvalArtifacts` (전 아티팩트를
1회 파싱해 파싱 결과 반환). runGate가 이 파싱 결과로 run 리포트를 구축해
`loadRunFiles`의 재파싱을 제거 (S86e: `loadRunFiles` 자체도 제거 — runGate/parseEvalArtifacts 단일 경로로 통일, 숫자순 재정렬은 runGate가 보존). 벤치마크 (`scripts/bench-eval-parse.ts`):

```
artifacts: 6 files, 16.9 MB total, 15 iterations (median)
old (3× parse): 997.5 ms
new (1× parse): 36.0 ms
reduction: 96.4%
```

실제 runGate CLI: **0.47초** (기존 3중 파싱 시 ~1.4초+ 예상). 단위 테스트
+2건 (S86d 재사용 경로 고정, results/latest.json 손상 ERROR).

### S86f — 2중 파싱 추가 2건 제거 (analyze-429-loss + runGate baseline)

전수 조사(S86f 사전)에서 같은 버그 클래스 2건을 추가 발견해 수정:

1. **`analyze-429-loss.ts`** — `loadRuns` + `loadRunReports`(각각 전 run-*.json을 read+parse 2회)를 `loadRunArtifacts` 단일 패스로 병합. computeLossReport가 1회 호출로 `{runMaps, reports}` 도출. 실측 벤치: **41.5ms → 20.8ms (49.9% 감소)** — `npm run eval:loss`와 매 eval:median:save 후 실행 경로에서 절감. (감사 시점의 ~394ms 추정치는 게이트 벤치의 stripJsonc 지배 비용을 plain JSON.parse 경로에 외삽한 과대값 — 실측이 정확함)
2. **`verify-commit-eval.ts`** — `loadBaselineFromWorktree` 제거, `baselineFromArtifacts` 신규: runGate가 parseEvalArtifacts의 이미 파싱된 baselines/latest.json(3.4MB) 객체를 재사용 (커밋당 재파싱 제거).

### S86g — gold-standards.json 로더 통일 (13+개 스크립트 핸드롤 파싱 제거)

전수 조사에서 **15개 핸드롤 파싱 + 2개 JSON import**를 발견해 canonical 로더로 통일:

- **`eval/metrics.ts`** — `parseGoldStandards(data)` 순수 헬퍼 추출 (병합 의미론: `_` 키 스킵 · 빈 배열은 truthy라 `key: []`로 유지 — gold가 비워진 쿼리의 `.has()` 의미론 보존 · null 항목은 방어적 스킵 — 기존엔 TypeError로 맵 전체가 {}가 되는 함정). `loadGoldStandards()`가 이를 사용
- **전환 13파일**: analyze-relevant-sim/boundary/detail/fix · sim-wave1-accuracy · verify-s49/s50 · quant-s51 · compare-s51-dirs · sweep-gold-overbreadth · verify-kr-finance · analyze-429-loss(loadGold) · detect-gold-drift(loadGoldFile은 경로 기반 유지, 파싱만 위임) + probe-s36/s38-recovery(JSON import 제거)
- **유지 2파일 (의도적)**: `generate-gold-standards.ts`(gold **작성자** — raw `{relevantDomains}` 래퍼 재직렬화 필요) · `probe-still-vuln.ts`(relevantUrls 필드 사용)
- **실측 동등성**: 실제 gold 파일은 null/비배열/빈배열 0건 — 모든 변형이 동일 결과 (gold-loader 테스트로 고정). 스모크: verify-s50 en-fact-01 NDCG 0.613, boundary bare 341 도메인, detect-gold-drift JSON, sim-wave1, sweep-gold, eval:loss 전부 정상

### S86g-② — 경계 강화가 baseline 비교를 보호하는 방식

`parseGoldStandards`의 경계 강화 3종은 단순 방어가 아니라 **게이트의 baseline
비교(S54 실시간 재계산 + G2 안정화)를 gold 편집 실수로부터 격리**한다:

| 경계 | 구 동작 (위험) | 신 동작 | baseline 보호 효과 |
|---|---|---|---|
| null 항목 (`"q3": null`) | `val.relevantDomains` → **TypeError** → catch-all `{}` — **맵 전체 소실** | 항목만 스킵, 나머지 499개 보존 | 한 줄 실수로 500쿼리 gold가 통째로 사라져 **전 쿼리 NDCG 0 → 대량 가짜 회귀로 커밋 차단**되는 연쇄 실패를 차단. 해당 쿼리만 gold 상실(NDCG 0)로 정직하게 노출 |
| 비배열 `relevantDomains` (문자열 등) | truthy라 **타입 오염 유출** → 모든 소비자의 `.join`/`.includes` 크래시 | 제외 | gold-loader 실파일 동등성 테스트의 기대 맵(truthy 필터)과 불일치해 **유닛이 레드로 즉시 경고** — 게이트 오작동 전에 잡힘 |
| 빈 배열 (`[]`) | truthy 유지 (`key: []`) | `Array.isArray([])` true → 동일 유지 | S69 gold 비움 의미론 보존 — `.has(id)` true 유지로 소비자 분기 안정 |

요약: **한 줄 실수는 그 쿼리 하나에 격리**되고, 나머지 499쿼리의 baseline
비교는 그대로 유효하다. 구 로더는 한 줄 실수가 전 코퍼스 gold 소실 → 전 쿼리
가짜 회귀 → 커밋 차단이라는 연쇄 실패를 만들었다. 추가로 S86i 가드에서
gold-standards.json은 SCORING_FILE_PATTERNS에 포함되므로, gold 편집 커밋은
게이트 로그에 `scoring-files-changed`(또는 집계 NDCG 이동 시 `[WARN]`
scoring-drift) 마커가 자동으로 붙는다.

## gold 편집 가이드 (eval/gold-standards.json)

gold는 500쿼리 NDCG/MRR/Precision@10 계산의 **평가 기준 정의 파일**이다
(관련 도메인 목록 — 라벨-접미사 매칭, 엄밀한 human-judged qrels 코퍼스가
아님). gold 변경은 "검색 품질 변경"이 아니라 **평가 기준 교정(EVAL-CRITERIA
CORRECTION)**이며, 목록에 없는 쿼리는 랭킹 메트릭에서 스킵된다.

### 형식

```json
{
  "_comment": "메타데이터/변경 이력 키 — `_` 접두사는 파서가 스킵",
  "_s70": "S70 (2026-08-10): <변경 사유 + 실측 수치> (관례 예시)",
  "kr-stock-03": {
    "relevantDomains": ["finance.naver.com", "m.stock.naver.com", "investing.com"]
  }
}
```

### 필수 규칙 (S49~S69 관례)

1. **라벨-접미사 매칭 전제** (S49): `D === G || D.endsWith('.' + G)` — bare
   레지스트러블 gold(`naver.com`)는 하위 도메인(`m.blog.naver.com`)을 전부
   매칭하므로, 의도가 좁으면 정밀 도메인(`m.stock.naver.com`)으로 쓸 것.
   크로스-레지스트러블(`trip.com` ⊄ `xinjiangtrip.com`)은 매칭되지 않는다.
2. **subsumption 페어 금지** (S50 WARNING / S52 / S63): 같은 엔티티의 좁은
   변형(docs./developers./blog.) + 넓은 레지스트러블을 함께 쓰지 말 것 —
   **넓은 쪽만 유지**(라벨-접미사가 서브도메인 변형을 이미 커버).
   kr-tech-05는 S63에서 `aws.amazon.com` 단독으로 좁힘
   (`aws.amazon.com`은 `amazon.com`과 subsumption이었음).
3. **풀에 없는 gold 금지** (S63/S69): 저장 run-1..3 풀에 한 번도 안 뜨는
   도메인은 **팬텀** — DCG에 0 기여하면서 IDCG 분모(R = min(goldLen, k))를
   부풀려 **측정 NDCG를 억제**한다. 추가 전 저장 풀에서 등장 여부를 확인할 것.
4. **비움은 `[]`로** (S69): gold를 지우려면 빈 배열로 — 키를 남겨 `.has()`
   의미론을 보존한다. `null`/비배열 값은 쓰지 말 것 (위 경계 규칙).
5. **변경 이력 `_sN` 키 필수**: 변경마다 `_sN` 메타데이터에 사유 + 실측
   수치를 남긴다 (S49/S32/S52/S63/S69 관례 — "EVAL-CRITERIA CORRECTION, not
   a search-quality change" 형식).

### 편집 후 검증 절차

1. **유닛**: `npx vitest run --project unit tests/unit/gold-loader.test.ts` —
   실파일 동등성 테스트가 경계 값(null/비배열) 유입을 레드로 잡는다.
2. **영향 실측**: `npx tsx scripts/detect-gold-drift.ts` (S57) — 저장 풀에
   재계산을 돌려 어떤 쿼리 NDCG가 gold 변경으로 움직였는지 리포트
   (네트워크 없음).
3. **게이트 재생**: `npx tsx scripts/verify-commit-eval.ts` — S86i 가드가
   `scoring-files-changed: eval/gold-standards.json` 마커를 붙이고, 집계
   NDCG가 1e-4를 넘어 움직이면 `[WARN] scoring-drift`로 baseline 대비
   델타를 표시한다.
4. **작성 도구 예외**: `eval/generate-gold-standards.ts`(생성기)는 raw
   `{relevantDomains}` 래퍼를 재직렬화해야 하므로 의도적으로
   parseGoldStandards를 쓰지 않는다 (S86g 유지 2파일 중 하나).

### S86c: --eval 게이트의 아티팩트 무결성 선행 검사 (2026-08-10)

`verify-commit-eval.ts`의 runGate가 run 파일 로딩 **전에** `checkEvalArtifacts`
(verify-jsonc.ts의 `--eval` 의미론: 구문 + report.results 형태)로 eval
디렉터리의 **모든** *.json(results/ + baselines/)를 검사한다. 손상 발견 시
게이트 ERROR(exit 3)로 조기 구분 — 이전에 조용히 삼켜지던 2가지 경로를 차단:

| 경로 | 이전 동작 | S86c 후 |
|---|---|---|
| 손상 `baselines/latest.json` | loadBaselineFromWorktree try/catch → null → "baseline: none" → **PASS** (조용한 오류) | **ERROR** (파일명+이유) |
| 손상 `results/latest.json` | loadRunFiles가 run-N.json만 읽어 **무시** → PASS | **ERROR** |
| 손상 run-N.json | 이미 ERROR | ERROR (상세 메시지 추가) |

verify-commits-ci.sh의 eval 게이트는 exit 3을 **FAIL이 아닌 ERROR**로 결과
파일에 기록해 요약 표에서 regression(FAIL)과 손상(ERROR)을 구분한다.
단위 테스트 +6건 (verify-commit-eval 4 + verify-jsonc 2, 기존 run-file
손상 테스트 1건 갱신).

### S86b: 손상 baseline 커밋 가드 (2026-08-10)

GitHub Actions는 스텝에 명시적 `if:`가 있으면 기본 `success()` 조건을
**대체**한다 — 즉 `Commit updated baseline` 스텝의 기존 `if:`(ref/event
가드만)는 verify 스텝이 실패해도 **여전히 실행**돼 손상 baseline을 커밋할 수
있었다. 수정:

- verify 스텝에 `id: verify` 부여
- `Commit updated baseline`의 `if:`에 `steps.verify.outcome == 'success'` 추가
- `Update README metrics (weekly)`도 동일 가드 (손상 메트릭 출판 방지)
- 드리프트 가드 단위 테스트 5건 (`tests/unit/eval-baseline-commit-guard
  .test.ts`) — verify 스텝 id 존재·두 커밋 스텝의 가드·verify가 `always()`
  ·커밋 스텝이 Check results보다 앞에 위치 (손상이 main에 도달하기 전
  차단) 를 js-yaml 파싱으로 고정

게이트 시뮬레이션 (5 시나리오): 손상 감지 시 commit/README 둘 다 SKIP,
정상 시 commit 실행·PR에서는 유지 (원래 게이트 보존) 확인.

## CI 워크플로우 연결 (2026-08-10)

ci.yml에 `preflight-replay` 잡 추가 — push/PR 커밋 범위를 `fetch-depth: 0`으로
체크아웃하고 `bash scripts/verify-commits-ci.sh <range> --eval`을 실행한다.
기존 잡들이 MERGED 트리를 한 번 게이트하는 반면, 이 잡은 범위 내 **모든 커밋에
같은 게이트 셋을 재현**해 중간 커밋에서 도입된 회귀를 정확히 지목한다. eval
게이트는 저장 아티팩트 기반 오프라인 재현 (초 단위, 아티팩트 없는 커밋은
SKIP). 실제 CI(push/PR)에서는 `github.event.before`가 짧은 범위를 만들어
과거의 깨진 lockfile 커밋을 포함하지 않는다.

데몬 실행 (터미널 세션과 분리 — ~3분 소요):

```bash
python3 scripts/run-verify-ci-daemon.py 97a042f..fab8bf5
tail -f /tmp/verify-ci.log
```

## 게이트 (ci.yml 미러)

| 게이트 | 명령 | CI 대응 |
|---|---|---|
| lint-ci | `npm run lint:ci` | lint-typecheck job (tsc --noEmit) |
| eslint | `npm run lint:eslint:ci` | 0-warning 게이트 |
| format | `npm run format:check` | prettier --check (src/tests/scripts/eval) |
| unit | `npx vitest run --project unit` | unit-tests job |
| build | `npm run build` | build job (needs: lint+unit) |
| eval | `npx tsx scripts/verify-commit-eval.ts` (--eval) | eval.yml 회귀 게이트의 오프라인 재현 (저장 아티팩트 기반) |

## node_modules 전략

메인의 `node_modules`(HEAD의 lock으로 설치됨)를 **symlink**하는 조건은 둘 다
필요하다: ① 범위 내 어떤 커밋도 `package.json`/`package-lock.json`을 건드리지
않음 ② 작업트리가 HEAD에서 클린 (범위가 HEAD에서 끝나야 메인 lock = 범위 lock).
하나라도 어긋나면 각 worktree에서 `npm ci`로 폴백한다 (정확하지만 느림).

## build 게이트 순서 주의

CI의 build job은 `needs: [lint-typecheck, unit-tests]`로 lint/unit 통과 후에만
실행되지만, 스크립트는 사전 점검 목적상 모든 게이트를 무조건 실행한다. 게이트
간 순서 의존성이 문제된 적은 없으나, lint/unit이 레드인 상태의 build 결과는
참고용으로만 해석할 것.

## 2026-08-10 act 교차 검증 — 실제 CI 블로커 3건 발견 및 수정

worktree 스크립트(위 표)가 6개 커밋 전부 그린이라고 판정한 뒤, Docker
Desktop + `act`(v0.2.89, `catthehacker/ubuntu:act-latest` — ubuntu-latest
이미지, Linux/arm64)로 `ci.yml`을 로컬 재현한 결과 **실제 CI 블로커 3건이
발견**됐다. worktree 스크립트는 node_modules를 symlink하므로 `npm ci` 자체와
워크플로우 인라인 스텝을 실행하지 않아서 이들을 놓쳤다.

### 발견 ①: `package-lock.json` 누락 엔트리 → `npm ci` 실패

`@cloudflare/vitest-pool-workers`의 하위 의존성 `wrangler@^4.20260625.1`이
`@cloudflare/workers-types@^4.x`를 요구하는데 lockfile packages 섹션에 중첩
4.20260702.1 엔트리가 없어 `npm ci`가 **Missing from lock**으로 실패.
`npm install --package-lock-only`로 재생성 (+11/-2) → 호스트/컨테이너 모두
`npm ci` 통과 확인. **(수정됨 — package-lock.json)**

### 발견 ②: `Verify wrangler.jsonc integrity` 스텝의 naive 정규식 버그

`node -e "JSON.parse(src.replace(/\/\/.*$/gm,''))"`가 **문자열 내부의 `//`까지
삭제** — 주석 속 `https://...` URL이 `"https:`로 깨져 JSON.parse 실패.
실제로 스텝은 레드였고 (로컬 재현 + act 재현 모두), wrangler 자체는 파일을
정상 파싱한다. **수정됨 — `scripts/verify-jsonc.ts` (string-aware 스트립 +
trailing comma 처리) + ci.yml 스텝 교체 + 단위 테스트 7건.**

### 발견 ③: `binding-verify` 잡이 프로덕션 Pages config를 검사해 항상 실패

wrangler.jsonc(프로덕션)는 Pages 프로젝트라 `wrangler pages deploy`가
durable_objects를 거부 → DO/R2 바인딩은 **파일에 의도적으로 없음** (Dashboard
구성). 그런데 ci.yml이 기본값(wrangler.jsonc)으로 `verify-do-binding.ts`를
실행 → **10개 바인딩 MISSING으로 항상 실패** (이전 커밋들도 동일 — 실제 CI도
레드). **수정됨 — ci.yml이 `--config=wrangler.dev.jsonc`를 검사하도록 변경**
(dev config는 11 DO + R2 + QUEUE 전부 선언), `verify-do-binding.ts` REQUIRED에
CLICK_LOG_DO/EXPERIMENT_DO 추가 + Pages 한계 docstring.

### act 재현 후 최종 상태 (2026-08-10)

```
job              result
lint-typecheck   PASS  (11/11 steps — lint:ci, eslint 0-warning, format, wrangler.jsonc)
unit-tests       PASS  (coverage + snapshot integrity)
binding-verify   PASS  (11 DO + R2 + QUEUE, wrangler.dev.jsonc)
build            build+dist OK (1,054 kB) — artifact 업로드만 act 한계로 skip
```

act 실행 노트: ① Docker Desktop 재시작 직후 `context canceled`(docker exec
스트리밍 취소)가 간헐 발생 — npm/코드 문제가 아니라 act-인프라 문제이며,
포그라운드 실행으로 안정화됨. `docker run` 직접 재현으로 npm ci/format이
컨테이너에서 통과함을 교차 확인. ② **전체 워크플로우 실행 시 setup-node
액션 캐시 레이스 발생** — 동시 잡이 `~/.cache/act/actions-setup-node@v4/`
재구축을 동시에 진행해 `lstat ... no such file` 실패. `--concurrent-jobs 1`
(순차 실행)로 해결. ③ `actions/upload-artifact@v4`는 로컬에서 항상 실패
(`ACTIONS_RUNTIME_TOKEN`은 실제 러너 전용) — build 잡의 마지막 스텝만
영향이며 build/dist 검증 자체는 통과. **권장 실행**: `act -W
.github/workflows/ci.yml --concurrent-jobs 1`.

### worktree 스크립트 vs act — 교차 검증 결론

| 관점 | worktree 스크립트 | act |
|---|---|---|
| npm ci / lockfile 정합성 | ✗ (symlink라 미재현) | ✓ (발견 ①) |
| 워크플로우 인라인 스텝 | ✗ (게이트만 실행) | ✓ (발견 ②③) |
| 게이트 자체 (lint/unit/build) | ✓ | ✓ (동일 결과) |
| 속도 | ~3분 (병렬) | 잡당 30초~2분 |
| Node 버전 | 로컬 (22) | CI와 동일 (20) |

**결론: 두 도구는 보완 관계다.** act가 진짜 CI 동작(의존성 설치 + 인라인
스텝)을 재현해 블로커를 잡고, worktree 스크립트는 게이트 수준 회귀를
커밋별로 빠르게 검증한다. 푸시 전에는 **act(전 잡) + worktree 스크립트
(커밋 범위)** 둘 다 실행할 것.

## 2026-08-10 검증 결과 (6개 커밋, act 미사용)

`97a042f..fab8bf5` + `97a042f~1..97a042f` 범위, 5게이트 전부 재현:

```
commit   lint-ci  eslint  format  unit     build
97a042f  PASS     PASS    PASS    PASS     PASS    (Wave 1+2, unit 1,503)
0f0902c  PASS     PASS    PASS    PASS     PASS    (Wave 4, unit 1,503)
de8c00a  PASS     PASS    PASS    PASS     PASS    (eval 게이트+아티팩트)
cd7d928  PASS     PASS    PASS    PASS     PASS    (docs)
f8eb6a1  PASS     PASS    PASS    PASS     PASS    (Wave 5 B3, unit 1,547)
fab8bf5  PASS     PASS    PASS    PASS     PASS    (Wave 4 실측 아티팩트)
```

- build: vite v8 SSR — 78~101ms, `dist/_worker.js` 1,079 kB (gzip 316 kB) 생성 확인
- unit: 커밋별 테스트 수가 정확히 반영됨 (1,503 → 1,547) — 각 커밋 상태 그대로 검증
- lint-ci/eslint: 출력 없음 (0 에러/0 워닝) — tsc/eslint 그린

**결론: 6개 커밋 전부 모든 게이트 그린. 신규 체크아웃 CI가 그린으로 시작할
것으로 확인됨 (푸시 가능).**

## 2026-08-10 회귀 가드 실측 — 과거 커밋의 npm ci 실패 재현

`86552a5~4..86552a5` 범위(lockfile 수정 커밋 포함)를 `--eval`로 실행:

```
commit   lint-ci    eslint     format     unit       eval
f8eb6a1  NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL
fab8bf5  NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL
2660263  NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL NPMCI-FAIL
86552a5  PASS       PASS       PASS       PASS       PASS
```

- f8eb6a1/fab8bf5/2660263: 86552a5의 lockfile 수정(+11/-2, 중첩
  workers-types@4.x) **이전** 커밋 — npm ci가 `Missing:
  @cloudflare/workers-types@4.20260702.1`으로 실패. 회귀 가드가 이를 명시적으로
  NPMCI-FAIL로 표시 (이전엔 빈 node_modules로 전 게이트 오실패).
- 86552a5: lockfile 수정 커밋 — npm ci 성공, 전 게이트 PASS.
- act로도 동일 재현 (workflow_dispatch → HEAD~5..HEAD 폴백). **해석**: 이건
  커밋 결함이 아니라 도구의 정확한 동작 — 과거 커밋 재현 시 해당 커밋의 lock이
  실제로 깨져 있음을 알려준다. history rewrite 없이 해결하는 방법은 없으며,
  실제 push 범위(신규 커밋)에는 영향 없다.

## 2026-08-10 --force-npm-ci vs act 교차 검증 (S86)

`--force-npm-ci`(모든 worktree에서 실제 npm ci)가 act의 fresh-container
설치를 재현하는지, 같은 범위를 양쪽에서 실행해 비교했다.

**범위**: act가 PR 이벤트 페이로드의 base.sha를 해석하지 못해 **HEAD~10..HEAD
폴백**(0f0902c8..9cfe7c8, 10커밋)을 탔다 (act 한계 — docs/14 기록과 일치).
이 범위에는 manifest 변경 커밋(86552a5)이 포함되어 npm ci 폴백이 발동.

| 커밋 | act (fresh container) | 로컬 --force-npm-ci |
|---|---|---|
| de8c00a/cd7d928/f8eb6a1/fab8bf5/2660263 | **NPMCI-FAIL** | **NPMCI-FAIL** ✓ |
| 86552a5 | (진행 중단) | PASS |
| 78b8cae/2da4c4c/d9be200/9cfe7c8 | — | PASS |

**결과: act가 재현한 5건 NPMCI-FAIL(lockfile 수정 이전 커밋)이 로컬
`--force-npm-ci`와 1:1 일치** — `--force-npm-ci`는 act의 npm ci 동작(구 lockfile
커밋의 `Missing: @cloudflare/workers-types@4.20260702.1` EUSAGE 포함)을 정확히
재현한다. symlink 모드가 이 실패를 숨겼다면 act와 갭이 발생했을 것 — 이제
없다.

**부수 발견 (도구 아티팩트)**: 중단된 실행(세션 정리 kill)이 남긴 stale
worktree가 `git worktree add`를 "already exists"로 실패시켜 해당 커밋이 전
게이트 SKIP으로 표시됐다. `git worktree prune`은 orphaned metadata만 정리하고
살아있는 등록은 남긴다 — 재실행 전 `git worktree remove --force`로 정리하면
된다. 스크립트 버그가 아니라 실행 환경 문제.

## 한계

- **worktree 스크립트**: build는 로컬(노드 22) 기준이고, symlink 모드(default)는
  `npm ci`/lockfile 정합성·워크플로우 인라인 스텝을 재현하지 않는다 — 이 갭은
  act로 커버하거나 `--force-npm-ci`로 로컬에서도 npm ci를 재현한다 (S86 교차
  검증에서 act와 1:1 일치 확인).
- **act 한계**: ① `actions/upload-artifact@v4`는 실제 러너의
  `ACTIONS_RUNTIME_TOKEN`이 필요해 로컬에서 실패 (build 잡의 마지막 스텝만 —
  build/dist 검증 자체는 통과). ② Docker Desktop 재시작 직후 간헐
  `context canceled` — 포그라운드 실행으로 안정화. ③ eval 게이트는 제외
  (~60분 — `npm run eval:median:ci`는 별도 실행).
- **실제 CI는 GitHub 러너에서 최종 확인 필요** — act는 근사치이며, artifact
  업로드·GitHub 토큰·네트워크 정책 등은 실제 러너 전용.

## 2026-08-10 act 전수 점검 — eval.yml + integration-tests.yml (2차)

ci.yml 블로커 3건 수정 후, 같은 act(--concurrent-jobs 1)로 나머지 CI
워크플로우 2종을 전수 재현.

### integration-tests.yml — 실제 CI 블로커 2건 발견·수정

| # | 블로커 | 근본 원인 | 수정 |
|---|---|---|---|
| ④ | preview 서버 기동 실패 | `NODE_VERSION: '20'`인데 **wrangler 4.112.0은 node >=22 요구** (engines) — act가 정확히 재현했고, 실제 CI 이력(96fb017/9700c75/d23cec7 등 PR run 전부)도 같은 스텝에서 레드였음 | `NODE_VERSION: '22'` |
| ⑤ | preview 서버 기동 실패 (2차) | `wrangler pages dev`는 프로덕션 wrangler.jsonc를 읽고 D1/Vectorize/AI 바인딩이 `remote: true`라 **원격 세션을 시작** — `CLOUDFLARE_API_TOKEN` 없이 "No credentials found"로 죽음 (deploy.yml은 같은 secrets를 쓰므로 저장소에 설정 전제) | preview 스텝에 `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` env 주입 + 누락 시 명확한 `::error::` 조기 종료 |

리뷰 반영: ① Generate summary가 실패 잡을 "✅ Passed"로 오보하던 버그 수정
(check 스텝이 skip되면 status가 빈 값 — `job.status == failure` 병합) ②
secrets 게이트가 ACCOUNT_ID도 함께 검사하도록 확장.

### eval.yml — 블로커 없음

act로 install/format/config 스텝 전부 그린 확인. 실제 CI(2da4c4c push)의
eval run도 steps 1-6 그린 + Run evaluation 정상 진행 (push 모드 500쿼리 ×
2 runs — 설계상 장시간). eval 실행 스텝은 100분 예산이라 act 완주는
생략(장기 실행 경로는 실제 CI run이 검증 중).

### 2차 점검 결론

ci.yml에서 잡은 3건 + 이번 2건 = **총 5건의 실제 CI 블로커**를 act가 전수
발견. deploy.yml의 download-artifact@v4 `run-id` 누락(이전 턴 발견)은
별도 수정 대상으로 남음.

## 2026-08-10 S86h — 공용 run-N.json 로더 통일 (parseRunFiles)

S86e가 마지막 공용 run 로더(loadRunFiles)를 제거한 뒤, run-N.json 파싱은
분석 스크립트 ~17곳이 각자 readdirSync + 숫자 정렬 + `report ?? raw` 폴백 +
에러 처리를 재구현하던 상태였다. **`eval/run-files.ts` — `parseRunFiles()`**
공용 로더를 신설해 전부 대체했다.

### 계약

- **eval-root 인자**: `parseEvalArtifacts`와 동일한 계약 — `results/` +
  `baselines/` 서브디렉토리를 가진 eval 루트를 받는다 ('eval' 또는 절대 경로).
  기존 스크립트의 하드코딩 `eval/results/run-N.json`과 동치.
- **단일 파싱 + 게이트 재사용**: `parseEvalArtifacts`(S86d)를 그대로 재사용해
  파일당 1파싱, **well-formed 게이트(report.results 필수)**로 corrupt/truncated
  및 **bare-format(raw.results) 파일을 제외** — CI 게이트와 동일 규칙.
- **report ?? raw**: 게이트 하에서는 항상 `report`로 귀결(방어적 폴백,
  게이트 완화 대비 주석화).
- **숫자순**: parseEvalArtifacts의 알파벳순 glob(run-1, run-10, run-2)을
  `runNumber()` 재정렬로 교정.
- **빈 결과**: run 파일이 없으면 `[]` 반환 — 스크립트별 빈 처리 정책은 유지
  (일부는 throw, 일부는 skip 계열).

### 마이그레이션 (17개 스크립트)

| 계열 | 스크립트 | 패턴 |
|---|---|---|
| loadRun(n) | verify-s49/s50, quant-s51, compare-s51-dirs | byRun Map + missing 시 throw (구 readFileSync ENOENT 동치, 메시지에 gate-excluded 명시) |
| 동일 루프 | analyze-relevant-sim/fix, sweep-gold-overbreadth | `[1,2,3].map` + throw |
| existsSync-skip | sim-wave1-accuracy, sim-wave5-cache, measure-mirror-latency, report-backend-availability | 로더가 자연 스킵 (missing run 제외), measure-mirror는 lazy-init Map |
| run-3 단일 | sim-s48, analyze-relevant-detail | `find(rf.run === 3)` + throw |
| results 추출 | probe-s67/s68 (legacy `r.results ??` 브랜치 + StoredQuery/StoredReport 인터페이스 제거), probe-still-vuln(3-run 가드 + ndcg10 레거시 폴백 제거 — 타입된 RankingMetrics) | `rf.report.results` |
| 계약 전환 | detect-gold-drift | **`resultsDir` → `evalDir`**(CLI `--results-dir` → `--eval-dir`, 외부 참조 0건으로 안전), latest.json 폴백 경로 `evalDir/results/latest.json` |

### 검증

- **유닛 1,622건 / 86파일** 통과 (+8: run-files.test.ts — 숫자순 run-1/2/10,
  report 추출, latest/baselines 제외, corrupt/bare 제외, 빈 디렉토리 [],
  헬퍼) + detect-gold-drift I/O 3건 eval-root 레이아웃 갱신
- tsc / eslint 0-warning / prettier 그린, 전환 스크립트 11종 스모크 기대값 일치
  (verify-s49 평균 0.2813, probe-s67 67/67/76, detect-gold-drift source
  run-1..3 등)
- **실측 로드**: parseRunFiles('eval') 3 run 파일(약 17MB — latest/baseline
  파싱 포함) **70.8ms** — 기존 개별 readFileSync 합계 대비 단일화 + 게이트
  의미론 일치

### S86h-② — analyze-429-loss의 loadRunArtifacts를 parseRunFiles 위로 재구성

S86h 잔여였던 loss 경로의 전용 로더를 공용 진입점으로 통합했다:

- `loadRunArtifacts(resultsDir, gold)` → **`loadRunArtifacts(evalDir, gold)`** —
  parseRunFiles(evalDir) 위의 얇은 합성 로더로 전환 (runMaps + reports를 같은
  파싱 객체에서 도출)
- **S54 recompute 의미론 보존**: pool(response.results) 존재 시 현재 gold로
  라이브 재계산, pool 부재 시 저장 ranking 폴백 (ndcg10 레거시 폴백은 타입된
  RankingMetrics로 정리) — 단위 테스트로 고정
- **bare 파일 의미론 변경 (S86f → S86h)**: S86f는 bare(raw.results) 파일이 run
  map에 기여했지만, S86h 게이트 계약(bare = corrupt = absent — verify-jsonc
  --eval과 동일)에 따라 **완전 제외**로 대체
- **계약 전환**: computeLossReport/CLI `--results-dir` → `--eval-dir` (eval 루트),
  eval/index.ts는 undefined 기본값을 쓰므로 무변경
- **벤치 정직화**: bench lossNewPath가 실제 parseRunFiles 경로(전 아티팩트
  파싱)를 측정 — **39.9 → 36.8ms (7.9%)** (S86f 기록의 20.8ms는 run 파일만
  plain-parse한 근사치)
- **테스트**: writeRuns eval-root 레이아웃 전환, bare 테스트를 게이트 계약으로
  재작성, S54 recompute-vs-stored 테스트 신규 (총 28건)

## 2026-08-10 S86i — scoring-drift 가드 (metrics/스코어링 파일 diff 감지)

### 배경

게이트가 저장 풀을 **현재 코드**로 재스코어링하므로(S54/S58), 커밋이 스코어링
레이어를 바꾸면 재계산 NDCG는 "검색 품질 변화"와 "메트릭 재정의"가 섞입니다.
커밋별 오프라인 게이트는 이 구분을 못 해, 메트릭 변경 커밋의 회귀 수치가 오해를
줄 수 있었습니다.

### 변경 (2파일 + 테스트 +8)

1. **`scripts/verify-commit-eval.ts`** — `SCORING_FILE_PATTERNS`(eval/metrics.ts,
   eval/median.ts, eval/baseline.ts, eval/gold-standards.json — NDCG 의미를 바꾸는
   파일 4종) + `scoringFilesIn()` 순수 필터 + `SCORING_DRIFT_EPSILON = 1e-4`
   (4자리 노이즈 플로어). `GateOptions.changedFiles` 추가 — baseline 존재 &&
   스코어링 파일 변경 시 **재계산 NDCG@10 vs 저장 baseline NDCG@10** 비교:
   - `|Δ| > 1e-4` → `[WARN] scoring-drift: <files> — NDCG x vs baseline y (Δ±d)`
     (회귀 델타가 메트릭 재정의일 수 있다는 **출처 경고** — status는 불변)
   - `|Δ| ≤ 1e-4` → `scoring-files-changed: <files> (NDCG@10 unchanged x)` 정보 마커
   - 스코어링 파일 없음 / baseline 없음 → 마커 없음 (기존 동작 유지)
   - CLI `--changed-files <file>` 플래그 (누락·손상 시 `[]` degrade — 게이트는
     diff 정보 없이도 정상 동작, 경고만 생략)
   - **제외 설계**: eval/run-files.ts·verify-jsonc.ts(로딩/형태 게이트)와 scripts/ 소비자는
     NDCG 의미를 안 바꾸므로 패턴에 없음
2. **`scripts/verify-commits-ci.sh`** — eval 브랜치에서 `git diff --name-only
   HEAD~1 HEAD`(detached worktree = 커밋 자체 diff)로 `$short.files` 생성 후
   `--changed-files` 전달. root 커밋은 빈 목록, **merge는 첫 부모 대비만** (선형 범위
   전제 주석화)

### 검증

- 테스트 +8 (scoringFilesIn 필터 3 + 경고/정보/무표시/무baseline/엡실론 상·하한/
  음수 부호 7) — 유닛 **1,631건 / 86파일** 통과, tsc/lint/format 그린
- **실측 스모크 (HEAD 5ab1477)**: eval/metrics.ts 변경 포함 diff →
  `scoring-files-changed: eval/metrics.ts (NDCG@10 unchanged 0.2813)` — S86g
  gold 로더 추출이 동작 중립임을 게이트가 스스로 확인 (경고 미발동).
  verify-commits-ci.sh --eval 재현에서도 동일 마커 (PASS 유지)

## 2026-08-10 preflight-push.sh — push 전 3중 최종 점검

커밋을 push하기 전 세 관점을 한 번에 검증하는 오케스트레이터
(`bash scripts/preflight-push.sh [커밋|범위]`, 기본 HEAD~1..HEAD):

| 단계 | 검사 | 역할 |
|---|---|---|
| ① | `verify-commits-ci.sh <range> --eval` | 커밋별 전 게이트 재현 (lint-ci/eslint/format/unit/eval) |
| ② | `verify-commit-eval.ts --changed-files` | HEAD 기준 eval 재생 + S86i 스코어링 마커 (`scoring-files-changed` / `[WARN] scoring-drift`) |
| ③ | `verify-baseline-equivalence.ts` | **저장 baseline NDCG@10 재현성** — 현재 코드로 재계산한 median NDCG vs 저장 값, `|Δ| <= 1e-4` (S86i epsilon) |

③은 S86i 가드(스코어링 파일 변경 시에만 비교)와 달리 **항상** 실행되는
"수치가 baseline이 의미하는 그대로인가" 단언이다. 시그니처:
`checkBaselineEquivalence(evalDir, { gold?, epsilon? })` — parseEvalArtifacts
단일 파싱 + baselineFromArtifacts(S86f) 재사용, 순수 export + 단위 테스트 9건
(PASS/DRIFT ±부호/epsilon 경계/NO_BASELINE/corrupt ERROR/쿼리 유니온).

**실측 (5ab1477)**: ① 전 게이트 PASS · ② `scoring-files-changed:
eval/metrics.ts (NDCG@10 unchanged 0.2813)` · ③ `recomputed 0.2813 ==
stored baseline 0.2813 (Δ+0.000000)` — 재계산 NDCG가 저장 baseline과
소수 6자리까지 일치, S86g/S86h 리팩터의 동작 중립을 수치로 확정.
