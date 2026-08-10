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

# 실패 시 worktree 유지 (디버깅용)
bash scripts/verify-commits-ci.sh --keep
```

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

## 한계

- **build는 로컬(노드 22, vite v8) 기준** — CI는 ubuntu-latest + Node 20. 빌드
  로직 자체는 플랫폼 독립적이나, Node 버전 차이는 CI에서 최종 확인.
- **node_modules symlink 검증은 의존성 설치 과정을 재현하지 않는다** — lockfile
  정합성(`npm ci`의 검증)은 범위-vs-메인 가드(②)로 간접 보장. 매니페스트를
  건드린 커밋이 범위에 있으면 자동으로 npm ci 경로로 전환되므로 안전.
- **eval 게이트는 제외** (~60분 — `npm run eval:median:ci`는 별도 실행).
- `act`는 Docker 필요 — Docker 설치 후 `act -W .github/workflows/ci.yml`로
  CI와 동일한 러너 이미지 검증 가능 (보강 옵션).
