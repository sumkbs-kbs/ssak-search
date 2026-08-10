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
```

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

## 한계

- **worktree 스크립트**: build는 로컬(노드 22) 기준이고 node_modules symlink라
  `npm ci`/lockfile 정합성·워크플로우 인라인 스텝을 재현하지 않는다 — 이 갭을
  act로 커버한다 (위 act 섹션).
- **act 한계**: ① `actions/upload-artifact@v4`는 실제 러너의
  `ACTIONS_RUNTIME_TOKEN`이 필요해 로컬에서 실패 (build 잡의 마지막 스텝만 —
  build/dist 검증 자체는 통과). ② Docker Desktop 재시작 직후 간헐
  `context canceled` — 포그라운드 실행으로 안정화. ③ eval 게이트는 제외
  (~60분 — `npm run eval:median:ci`는 별도 실행).
- **실제 CI는 GitHub 러너에서 최종 확인 필요** — act는 근사치이며, artifact
  업로드·GitHub 토큰·네트워크 정책 등은 실제 러너 전용.
