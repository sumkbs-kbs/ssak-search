# 17. GitHub Actions `CLOUDFLARE_API_TOKEN` 시크릿 교체 절차

> 작성일: 2026-08-14 · 대상: `sumkbs-kbs/ssak-search` · 배포 워크플로우: `.github/workflows/deploy.yml`
> 근거: 2026-08-12 마지막 성공 배포 이후 모든 GitHub Actions 기반 배포가 아래 오류로 실패
> ```
> ✘ Authentication error [code: 10000] — /workers/services/ssak-do-worker
> ✘ Max auth failures reached [code: 9109]
> ```

---

## 0. 증상 요약 (왜 필요한가)

| 항목 | 값 |
|---|---|
| 실패 워크플로우 | Deploy (workflow_dispatch + workflow_run 자동 staging) |
| 실패 단계 | `Deploy do-worker` — 첫 Cloudflare 호출에서 즉시 실패 |
| 에러 코드 | `10000` (Authentication error) → `9109` (Max auth failures) |
| 영향 | staging/production 자동 배포 전부 중단 · CI 통과해도 배포 안 됨 |
| 완화 경로 | 로컬 `wrangler` OAuth(`sumkbs@gmail.com`, 프로젝트 소유자)로 수동 배포 — 정상 |

**원인 판정**: GitHub Actions에 저장된 `CLOUDFLARE_API_TOKEN` 시크릿이 만료/무효화됨.
Cloudflare API 토큰은 만료일이 있거나(최대 1년) 삭제/재발급 시 즉시 무효화된다.
`CLOUDFLARE_ACCOUNT_ID`는 계정의 불변 식별자라 깨지지 않는다 — 갱신 대상은 **토큰뿐**이다.

---

## 1. 사전 확인 (30초)

토큰이 실제로 깨졌는지 로컬에서 무해한 호출로 확인한다 (토큰 값이 필요하므로
GitHub Actions 로그가 아닌 **대시보드**에서 시크릿을 열어야 확인 가능 — 아니면
아래 2단계로 바로 진행).

```bash
# GitHub Actions 로그 (최근 실패 run)에서 확인:
#   https://github.com/sumkbs-kbs/ssak-search/actions → Deploy → 실패 run
#   "Deploy do-worker" 단계 로그: Authentication error [code: 10000]
```

로컬 wrangler OAuth는 별개 인증이므로 그대로 유효하다 (이 문서의 절차와 무관).

---

## 2. Cloudflare 대시보드에서 새 API 토큰 발급 (5분)

1. https://dash.cloudflare.com/profile/api-tokens 에 로그인 (계정: `sumkbs@gmail.com` — 프로젝트 소유자)
2. **Create Token** → 템플릿 **"Edit Cloudflare Workers"** 선택 (최소 권한 템플릿)
3. 템플릿 기본 권한 확인/조정:
   - `Account - Cloudflare Workers Scripts - Edit`
   - `Account - Cloudflare Pages - Edit` (템플릿에 없으면 **Add more**로 추가 — Pages 배포에 필수)
   - `User - User Details - Read` (계정 ID 조회용, 선택)
4. **Account Resources**: `ssak-search` 계정 (또는 전 계정 — 단일 계정이면 동일)
5. **Zone Resources**: 포함 안 함 (이 프로젝트는 API/worker 호출만 사용 — 영역 권한 불필요, 최소화)
6. **TTL**: 만료일 설정 (최대 1년). **재발급 주기를 다이어리/문서에 기록**:
   - 토큰 이름에 만료일 포함 권장: `github-actions-deploy-2027-08`
7. **Create Token** → 생성된 토큰을 **즉시 복사** (다시 볼 수 없음 — 유실 시 재생성)

> ⚠️ 보안: 토큰을 절대 로그/커밋/채팅에 남기지 말 것. 아래 3단계에서 GitHub
> 시크릿에 직접 붙여넣는다.

---

## 3. GitHub 시크릿 갱신 (2분)

1. https://github.com/sumkbs-kbs/ssak-search/settings/secrets/actions
2. `CLOUDFLARE_API_TOKEN` → **Update**
3. 2단계에서 복사한 새 토큰을 **Value**에 붙여넣기 (공백/줄바꿈 없이)
4. **Update secret**
5. `CLOUDFLARE_ACCOUNT_ID`는 **변경 불필요** (계정 ID는 불변) — 단, 실수로 삭제됐다면
   대시보드 우측 하단 "Account ID"에서 복사해 동일하게 갱신

> GitHub Actions 캐시 주의: 시크릿 변경은 워크플로우 실행 시점에 반영된다.
> 이미 실행 중인 run은 이전 값을 쓴다 — 교체 직후 새 디스패치가 곧 검증이다.

### 3-1. verify-secret-set.sh — set 전후 5단계 자동 검증 (수정 93/100)

대시보드 수동 붙여넣기 대신 **`scripts/verify-secret-set.sh`** 로 set 의 **조용한
실패**(PAT scope 부족 / 다른 repo / gh 미인증 / 무효 토큰)를 사전 차단할 수 있다:

```bash
# 새 토큰을 파일에 넣고 (argv·히스토리 노출 방지):
bash scripts/verify-secret-set.sh --file /path/to/new-token.txt   # 이 repo에서 실행
# 사전 점검만 (set 없음):
bash scripts/verify-secret-set.sh --dry-run
# 오프라인 로직 검증:
bash scripts/verify-secret-set.sh --self-test
```

**5단계**: ① `gh auth status` (로그인+repo scope — 부족 시 set 전 차단) ② repo
컨텍스트 (잘못된 repo에 조용히 set 되는 실수 방지) ③ `gh secret set` (stdin 주입)
④ API `updated_at` 전/후 비교 (실제 반영 ground truth) ⑤ (기본 on) 새 토큰을
Cloudflare `/user/tokens/verify` 로 검증.

#### 3-1-1. 알려진 한계 — credential fallback 그림자화 (수정 100 실측)

토큰 해석 체인(GH_TOKEN → gh auth token → git credential helper)은 **①단계의
gh 하드 게이트 뒤**에 있다. 따라서:

- gh **미인증** → ① 에서 차단 (credential helper 경로 도달 불가)
- gh **인증** → `gh auth token` 이 성공 (credential fallback 불필요)

즉 **git credential helper(osxkeychain)는 실제로 도달 불가능한 폴백**이다
(도달 가능 케이스: gh 로그인됐는데 token 만 빈 이례). 2026-08-17 라이브 실측 —
이 셸의 osxkeychain 은 유효 토큰을 반환하고 GitHub API 도 통과하지만(rate_limit
5000 OK), 스크립트는 ①에서 "gh 미인증"으로 차단했다. gh secret set 은 gh 가
필수이므로 credential helper 토큰이 **대체 경로가 될 수 없다**.

#### 3-1-2. 설계 — `--pre-check` (gh 불요 사전 검증 모드, 구현 예정)

위 한계로 gh 미인증 환경에서는 **아무 사전 검증도 못 하고** ①에서 멈춘다 —
"gh 미인증"과 "토큰 무효"가 겹치면 gh 를 고치고 나서야 토큰 무효를 발견한다.
이를 위해 **`--pre-check`** 모드를 설계한다 (gh 를 전혀 호출하지 않음):

```
흐름: ① repo 해석(--repo/GH_REPO/git remote)            ← gh 불요
      ② 토큰 해석(GH_TOKEN → gh[있으면 시도·실패 무시] → credential)
      ③ GET /repos/{repo} → 200 (토큰 유효 + repo 접근)
      ④ GET /actions/secrets (시크릿 존재 + 현재 updated_at — secrets read scope 증명)
      ⑤ 새 토큰 /user/tokens/verify (--skip-cf-verify 로 생략 가능)
      ⑥ 요약: 통과 = set 전제 준비 (남은 블로커는 gh 인증뿐)
```

- **판정**: exit 0 = set 단계의 모든 전제 준비 · exit 1 = 경로별 사유 (수정 100 의 경로별 메시지 재사용)
- **--dry-run 과 관계**: --dry-run 은 ①②(gh 게이트) 통과 후 중단 — gh 미인증 환경에선 무용. --pre-check 는 gh 가 필요 없는 검증 전체를 수행
- **구현 시**: `PRE_CHECK` 플래그 + 수정 100 의 토큰 해석 블록을 `resolve_api_token` 으로 함수화 (main 과 공유) + 분기. 유닛 테스트: gh 미인증 fake 에서 pre-check 통과/실패 케이스

---

## 4. 교체 후 staging 파이프라인 검증 (10분)

시크릿 교체 후 **staging 디스패치로 검증**한다 (production은 위험하므로 staging부터).

### 4-1. workflow_dispatch 발사

```bash
# GitHub API로 staging 디스패치 (gh CLI 또는 저장된 git credential 사용)
gh workflow run deploy.yml -f environment=staging
# 또는
curl -X POST https://api.github.com/repos/sumkbs-kbs/ssak-search/actions/workflows/deploy.yml/dispatches \
  -H "Authorization: Bearer <PAT>" -H "Accept: application/vnd.github+json" \
  -d '{"ref":"main","inputs":{"environment":"staging"}}'
```

### 4-2. run 모니터링

```bash
gh run list --workflow=deploy.yml --limit=1
gh run watch <run-id>
```

### 4-2-1. 교체 여부 사전 확인 (30초 — 권장)

GitHub API로 시크릿 갱신 시각을 확인한다 (시크릿 값 자체는 읽을 수 없지만
`updated_at`으로 교체 여부를 판정):

```bash
curl -s -H "Authorization: Bearer <PAT>" \
  https://api.github.com/repos/sumkbs-kbs/ssak-search/actions/secrets | \
  python3 -c "import json,sys; [print(s['name'], s['updated_at']) for s in json.load(sys.stdin)['secrets'] if 'CLOUDFLARE' in s['name'].upper()]"
```

교체 직후라면 `updated_at`이 현재 시각 근처여야 한다. 여전히 08-12 같은 과거
시각이면 교체가 안 된 것 — 2~3단계부터 다시 확인한다.

### 4-2-2. 시크릿 교체 워처 — 자동 감지 + staging 자동 디스패치 (수정 47, 2026-08-14)

수동 폴링 대신 **`scripts/watch-secret-rotation.sh`** 를 두면 교체를 자동으로
감지하고 **바로 staging 디스패치를 발사**한다:

```bash
bash scripts/watch-secret-rotation.sh              # 1회 폴링 (감지 시 자동 디스패치)
bash scripts/watch-secret-rotation.sh --watch      # 5분 간격 반복 (WATCH_MINUTES, 0=무기한)
bash scripts/watch-secret-rotation.sh --dry-run    # 감지만 — 디스패치 안 함
```

- **신호**: GitHub API `actions/secrets` 의 `CLOUDFLARE_API_TOKEN.updated_at`
  (값이 갱신될 때만 변함 — 4-2-1과 동일 신호)
- **동작**: updated_at 변경 감지 → `deploy.yml` workflow_dispatch
  `environment=staging` 자동 발사 (성공 시에만 baseline 갱신 — 실패하면 다음
  폴링에서 재시도, 동일 값 재폴링은 no-op)
- **PAT**: `GH_TOKEN` → `gh auth token` → git credential helper 순서로 해결
  (이 저장소 git credential 의 PAT 는 repo+workflow 스코프 + repo admin)
- **안전**: 기본 `TARGET_ENV=staging` 전용 — production 은 `ALLOW_PRODUCTION=1`
  필수. 디스패치 후 새 토큰 검증은 CI guard(수정 28/46)가 담당
- **알림**: 교체 감지 시 `SLACK_WEBHOOK`/`ALERT_SLACK_WEBHOOK` 로 Slack 알림
  (미설정 no-op). 상태는 `ROTATION_STATE`(기본 /tmp/gh-secret-rotation-state.json)

> ✅ **허점 수정됨 (2026-08-14, 커밋 f5ef768)**: pre-deploy guard(`verify-do-binding.sh`)
> 가 이제 COMMIT_CHECK_ONLY 시작 시 `/user/tokens/verify`로 토큰 **유효성**을
> 검사한다 — 무효(만료) 토큰은 guard가 즉시 `❌ INVALID/EXPIRED (verify HTTP 401)`
> 로 BLOCK (실측: run 31800422203 — guard fail-fast, 빌드도 안 돌고 즉시 중단).
> 교체 성공 판정은 여전히 4-3의 **`Deploy do-worker (Staging)` green**이 기준이며,
> guard green은 이제 "토큰 유효"를 전제로 하므로 신뢰할 수 있다.
>
> ✅ **만료 임박 경고 추가됨 (2026-08-14, 수정 46)**: verify_cf_token 이
> `expires_on` 을 파싱해 만료까지 남은 일수가 `TOKEN_EXPIRY_WARN_DAYS`(기본 7일)
> 이내면 guard 를 통과시킨 채 `⚠️ expires in N day(s) (on YYYY-MM-DD)` 경고 로그를
> 남긴다 — 만료 직전까지 조용히 있다가 갑자기 guard 가 깨지는 사고를 예방. 만료 없는
> 토큰(expires_on null)은 경고 없음. 유닛 테스트 5건으로 분기 검증 (수정 46 참조).

### 4-3. 통과 기준 (전부 확인)

| 단계 | 성공 기준 |
|---|---|
| `Verify staging deployment commit baseline (pre-deploy guard)` | green (시크릿 유효 확인 — verify-do-binding.sh가 Pages API 호출) |
| `Deploy do-worker (Staging)` | green — **여기서 10000 에러가 사라졌는지가 핵심** |
| `Deploy to Pages (Staging)` | green → `https://staging.search-engine-api.pages.dev` 새 배포 |
| `Deploy probe-scheduler (Staging)` | green |
| `Verify deployed commit matches repo (post-deploy gate)` | green (Source commit == `github.sha`) |

### 4-4. 실패 시 판정

| 실패 양상 | 원인 | 조치 |
|---|---|---|
| 여전히 `code: 10000` | 토큰 복사 오류 / 권한 부족 | 2-3단계 재검토, **Account + Pages 권한 포함** 확인 |
| `code: 10010` / `9109` 지속 | 새 토큰도 무효 | 토큰을 대시보드 API Tokens에서 삭제 후 재발급 |
| 첫 단계(verify)부터 fail | `CLOUDFLARE_ACCOUNT_ID` 누락/오타 | 3단계 5번 확인 |
| pre-deploy gate가 commit drift로 fail | 배포 시점 이슈 (시크릿과 무관) | `ALLOW_BEHIND=1` 확인 · `scripts/verify-do-binding.sh` 로그 참조 |

---

## 5. 유지보수 — 재발급 예방

- **만료일 알림**: 토큰 TTL을 최대 1년으로 잡고, 대시보드의 "API Tokens" 목록에서
  만료 전 2주 알림 확인
- **교체 기록**: docs/08_CHANGELOG에 토큰 교체일을 기록 (이 문서 0단계 증상을 갱신)
- **비상 대체 경로**: GitHub Actions가 깨진 동안에도 로컬 worktree 절차로 배포 가능
  (S105/S106/S73 시리즈 실무 적용). **자동화 스크립트** (2026-08-14 추가):
  ```bash
  npm run deploy:local            # HEAD → production
  npm run deploy:local -- staging # HEAD → staging
  npm run deploy:local -- 41218df staging  # 특정 커밋 → staging
  npm run deploy:local -- --dry-run staging  # 실행 계획만 확인 (미커밋/push 상태 경고 포함)
  ```

  **드라이런 (`--dry-run`, 순서 무관)**: 아무것도 배포하지 않고 사전 확인(커밋 존재 ·
  push 여부 · 미커밋 변경 · OAuth) + 실행 계획을 출력한다. 미커밋 작업이 있어도
  `git worktree add <sha>`가 대상 커밋의 clean 체크아웃을 만들므로 배포 내용은
  오염되지 않는다 (⚠️ 단, node_modules 심링크 공유로 인해 미커밋 `package*.json`
  변경 시 의존성 혼합 가능 — 스크립트가 경고를 출력하며, 정확성을 위해선 main repo에서
  `npm ci` 후 실행).

  **부분 배포 보고 (2026-08-14)**: DO → Pages → cron 각 단계의 성공/실패를 개별
  추적해, 중간 실패 시에도 즉시 종료하지 않고 어디까지 배포됐는지를 명확히 보고한다.
  DO 배포 전에 이전 DO 버전 ID를 캡처해 두므로, DO만 새 버전이고 Pages가 실패한
  경우엔 `npx wrangler rollback --config=wrangler.do.jsonc` 롤백 명령을 함께 제시한다
  (Pages는 자동 롤백 없이 이전 배포를 유지 — DO를 이전 버전으로 되돌리는 게 정합).
  실패가 있으면 exit 1. 가짜 npx 래퍼로 3개 실패 시나리오 + 성공 시나리오를
  실배포 검증 완료.

  **--auto-rollback (2026-08-14)**: Pages 배포 실패로 "DO 는 새 버전, Pages 는
  이전 버전" 정합 불일치가 되면, 배포 전에 캡처한 PREV_DO_VERSION 으로 DO 를
  자동 롤백한다 (`npx wrangler rollback <version-id>` + 사유 메시지). cron 실패
  (DO+Pages 일치)나 DO 실패(아무것도 배포 안 됨)에서는 롤백하지 않는다. 가짜
  npx 래퍼로 Pages 실패 시나리오 실측 — 정확한 PREV_DO_VERSION 으로 롤백 호출
  확인 (이후 실제 rollback 으로 테스트 부작용 원상 복구).

  **--auto-rollback ②: 번들 커밋 불일치 롤백 (2026-08-15, 수정 61)**: Pages 배포
  직후 번들 커밋 검증(build_commit == 대상 SHA)이 실패하면 — DO+Pages 는 새
  버전인데 배포 URL 번들이 대상 커밋을 담지 않은 스테일 상태 — cron/[6/6] 검증을
  생략하고 **DO 와 Pages 를 이전 버전으로 자동 롤백**한다. 배포 전에 동일
  브랜치의 직전 배포 ID(PREV_PAGES_ID)를 캡처해 두고, Pages 는 공식 Rollback
  API(`POST /accounts/{acct}/pages/projects/search-engine-api/deployments/
  {PREV_ID}/rollback` — 대시보드 'Rollback to this deployment' 와 동일)로
  production 을 이전 배포로 전환한다. 토큰은 `CLOUDFLARE_API_TOKEN` 우선, 없으면
  wrangler OAuth 토큰(`~/.wrangler/config/default.toml` oauth_token — pages:write
  스코프)을 쓴다. **staging(preview) 은 Cloudflare 제약**('preview deployments are
  not valid rollback targets' + 브랜치 최신 배포는 삭제 불가)으로 Pages 자동 롤백이
  불가 — DO 는 롤백하고 Pages 는 올바른 번들로 재배포를 안내한다 (스테일 원인이
  빌드 캐시면 `ISOLATED_BUILD=1` 권장).

  **--auto-redeploy: staging 번들 불일치 → 캐시 무효화 자동 재배포 (2026-08-16, 수정 76/79)**:
  staging(preview) 배포는 Pages Rollback API 대상이 될 수 없으므로(Cloudflare 제약
  'preview deployments are not valid rollback targets'), 번들 커밋 불일치 시 롤백 대신
  **빌드 캐시를 무효화하고 올바른 번들로 재배포**한다. `--auto-rollback` 과 달리
  **staging 전용** — production 에서 이 플래그는 무시된다 (production 은 롤백이 정답,
  아래 선택 가이드 참조). 두 플래그를 동시에 주면 `--auto-rollback` 이 우선한다 (elif 순서).

  **실행 절차**:

  ```bash
  # 정상 경로 — 번들 불일치가 실제로 나면 자동으로 캐시 무효화 재배포가 발동한다
  bash scripts/deploy-local-worktree.sh HEAD staging --auto-redeploy
  bash scripts/deploy-local-worktree.sh <sha> staging --auto-redeploy        # 특정 커밋
  bash scripts/deploy-local-worktree.sh HEAD staging --auto-redeploy --dry-run  # 계획만 확인

  # E2E 검증 (수정 75 훅 재사용) — 첫 번들 검증만 의도적으로 불일치로 취급해
  # 재배포 복구 경로를 라이브로 발동시킨다 (재배포 후 검증은 실제 HTTP 대조)
  E2E_FORCE_BUNDLE_MISMATCH=1 bash scripts/deploy-local-worktree.sh <sha> staging --auto-redeploy
  ```

  **동작 순서 (번들 불일치 감지 시)**:
  1. 배포 URL 번들 검증 실패(build_commit ≠ 대상 SHA) 감지 → cron/[6/6] 생략 (부분 배포 보고)
  2. 캐시 무효화: `rm -rf dist node_modules/.vite` — 심링크 node_modules 가 스테일 원인일 수
     있으므로 worktree 내부에서 `npm ci` 후 재빌드 (`BUILD_COMMIT=<sha> DEPLOY_ENV=staging
     npm run build`)
  3. Pages 재배포(`--commit-dirty=true`) → **실제 HTTP 대조**로 build_commit 재검증
     (최대 2회 시도)
  4. 성공 시 cron 스케줄러까지 재배포 후 exit 0 / 2회 모두 실패 시 exit 1 + 수동 안내
     (deployment list Source 대조 · `ISOLATED_BUILD=1` 재시도 권장)

  **실측 (2026-08-16, staging @ 00cfc5f)**: E2E 훅으로 의도적 불일치를 유발해 실행 — 1차
  재배포는 배포 직후 전파 레이스(빈 build_commit)로 불일치 처리 → 2차 재배포에서
  `✅ build_commit=00cfc5f` 로 복구 → cron 재배포 → **exit 0**. 독립 재확인: staging alias
  build_commit=00cfc5f (full SHA) · deployment list 최신 3건 모두 Source=00cfc5f ·
  production 무영향(7dada19 유지). ⚠️ 알려진 한계: **재배포 후 검증은 단발 curl** — 수정 79의
  5×10s 재시도가 첫 번들 검증에만 적용돼, 전파 레이스 시 2회차 루프가 흡수한다 (실패는
  아니지만 1차에서 확정 판정하려면 재배포 검증에도 동일 재시도 추가 권장).

  **복구 전략 선택 가이드 (staging vs production)**:

  | 상황 | staging (preview) | production |
  |---|---|---|
  | 번들 커밋 불일치 (스테일 의심) | **--auto-redeploy** — 캐시 무효화 후 올바른 번들 재배포 | **--auto-rollback** — DO+Pages 를 이전 버전으로 롤백 (Rollback API 대상 가능) |
  | Pages 배포 자체 실패 (DO 신/Pages 구) | --auto-rollback — DO 롤백 + Pages 는 재배포 안내 | --auto-rollback — DO 롤백 + Pages Rollback API 로 이전 배포 복구 |
  | cron 배포 실패 (DO+Pages 일치) | 롤백/재배포 없음 — cron 만 재배포 | 동일 |
  | 전파 레이스 오탐 (빈 build_commit) | 수정 79 재시도(5×10s)가 흡수 — 재배포 전 재확인 | 동일 |
  | 스테일 원인이 빌드 캐시 | `ISOLATED_BUILD=1` (worktree 내부 격리 npm ci) 권장 | `ISOLATED_BUILD=1` 권장 |

  **배포 후 gold 회수 자동 검증 (2026-08-14)**:
  `scripts/verify-deployed-gold.sh`가 6개 대표 gold 쿼리(kr-stock/zh-travel/
  en-fact/gk/en-tech/ja-news)를 배포 URL에 보내 top-10에서 gold 도메인 회수를
  판정한다 (S49 label-suffix 규칙 — eval/metrics.ts 와 동일). 전체 500쿼리 eval
  대신 빠른 스모크 테스트용.  `GOLD_CHECK=0`으로 생략 가능. 실측: production/staging
  모두 6/6 통과. `GOLD_FAIL_HARD=1`이면 gold 미회수가 `GOLD_FAIL_HARD_RETRIES`
  (기본 3회 — 일시적 업스트림 지연과 지속 실패 구분) 동안 지속될 때 배포를
  **실패 처리**(exit 1)한다. 기본 0 = 경고만 출력. 재시도 간격은
  `GOLD_FAIL_HARD_RETRY_WAIT`(기본 30s).

  **DO 인스턴스 분리 (방안 B, 2026-08-14)**: staging/production 은 같은 DO
  워커(ssak-do-worker)를 공유하지만, RATE_LIMITER 인스턴스 키를 환경별로 분리해
  서킷·rate window·cooldown 을 독립화했다 (`src/lib/deploy-env.ts` — vite define
  `__DEPLOY_ENV__` 주입). 이제 staging 부하(full-eval 등)가 production 서킷을
  망가뜨릴 수 없다. 배포 경로마다 DEPLOY_ENV 가 자동 설정된다: ① 로컬 worktree
  스크립트(빌드에 `DEPLOY_ENV=$ENV_NAME`) ② GitHub Actions ci.yml(환경별 아티팩트
  worker-bundle-production/staging) ③ deploy.yml 폴백 빌드. ⚠️ 배포 스크립트는
  **커밋의 clean 체크아웃**에서 빌드하므로 변경이 실배포되려면 먼저 커밋해야
  한다 (미커밋 상태에서 배포하면 이전 코드가 배포됨 — 2026-08-14 실측). 구
  'global' 인스턴스는 스토리지에 잔존하며, 열린 서킷이 있으면 60s 주기 alarm
  프로브가 RPC 없이도 DO 를 깨워 업스트림 robots.txt 프로브를 계속 쏜다
  (마이그레이션 클리너, 2026-08-14): `bash scripts/clean-global-limiter.sh`
  (status = 대상 존재 확인 / reset = 정리 실행) — reset() RPC 가 상태 + alarm 을
  모두 지우고, reset 전후 getAlarmInfo() 대조로 정리 완료를 검증한다.

  **--full-eval (2026-08-14)**: `bash scripts/verify-deployed-gold.sh --full-eval`
  로 eval/queries.ts 전체 497쿼리를 배포 URL에 순차 전송해 gold 회수율을 집계한다.
  결과는 JSONL 체크포인트(/tmp/gold-verify-out.jsonl)에 즉시 저장 — 중단돼도 재실행이
  resume한다 (요청 실패분만 재시도). ⚠️ **주의 (실측)**: staging/production 은 같은
  DO 를 공유하므로 페이싱 없이 500쿼리를 돌리면 wikipedia 공유 100/min 버짓을
  폭주시켜 en/zh.wikipedia 서킷이 트립되고 B1 미러 체인을 거쳐 wikidata/news.google
  까지 degrade 된다 (S73 재발). `GOLD_DELAY_MS`(기본 2500ms) 페이싱을 유지하고
  비수요 시간에만 실행할 것 — 전량 회귀가 목적이면 로컬 eval 하네스(eval/index.ts)를
  우선 사용한다.

  **환경 동치 대조 (2026-08-14, 수정 52 갱신)**: `scripts/verify-env-equivalence.sh`가
  staging 배포 후 staging ↔ production 의 4가지를 자동 비교한다: ① 배포 커밋
  (Source commit) ② 헬스 (백엔드별 status) ③ 검색 top-5 도메인 시퀀스 ④ gold 회수율.
  staging 배포 시 `deploy-local-worktree.sh` 가 자동 호출 (EQ_CHECK=0 으로 생략).
  production 이 아직 그 커밋이 아니면 커밋 항목만 실패로 표시된다 (정상 — production
  배포 후 전체 green). 실측: staging/production 모두 f5ef768 로 맞춘 뒤 4/4 동치 확인.
  **알림 (수정 52)**: staging 배포 자동화는 `EQ_NOTIFY=1` 을 **기본값으로 명시**
  (EQ_NOTIFY=0 으로 생략) — 동치 대조 실패 시 런타임 동치(헬스/검색/gold) 실패 항목을
  Slack danger 알림으로 보낸다. 웹훅은 환경변수 `SLACK_WEBHOOK` 또는
  `ALERT_SLACK_WEBHOOK` (둘 다 없으면 no-op) — 로컬 배포 스크립트는 Cloudflare
  시크릿이 아니라 **실행 환경의 env var** 를 읽는다. 커밋 불일치 단독은 알림 제외
  (staging 배포 직후 production 미배포의 정상 상태). 동치 대조 실패는 **배포 자체를
  실패시키지 않는다** (경고만 — CI post-deploy 게이트는 실패 처리, 로컬 배포는
  배포 성공 우선). 드라이런 계획에도 알림 동작이 표시된다.

  **실패 알림 (2026-08-14)**: 런타임 동치(헬스/검색/gold) 실패 시 Slack webhook
  알림을 보낸다 (`EQ_NOTIFY`, 기본 1; webhook 미설정 시 no-op — SLACK_WEBHOOK 또는
  ALERT_SLACK_WEBHOOK). 커밋 불일치 단독은 staging 배포 직후 production 미배포의
  정상 상태라 알림에서 제외 (EQ_NOTIFY_COMMIT=1 로 강제 가능). 페이로드는 monitor.yml
  과 같은 Slack blocks 형식 — 실패 항목별 상세(헬스 diff/검색 diff/gold 회수율) 포함,
  런타임 실패는 danger, 커밋 단독은 warning 색상.

  **헬스 동치 의미론 (방안 B 이후, 2026-08-14, 수정 50 갱신)**: DO 인스턴스가
  환경별로 독립되면서 헬스 status 는 더 이상 코드 동치 지표가 아니다 (캐시 히트 시
  백엔드 fetch 없음 → 미추적, fresh 인스턴스 누적 차이). 대조는 ① 한쪽만 추적 중인
  호스트는 정보성(실패 아님) ② 공통 호스트의 **한쪽만 down 은 경고(WARN)** — 해당
  환경 DO 서킷만 트립된 런타임 상태로 동치 실패가 아니다 (실측 2026-08-15:
  production lookup.dbpedia.org down vs staging operational → [2/4] 통과 + 경고)
  ③ degraded vs operational 은 시점 차이로 정보성. 실질적인 동치 신호는 검색
  top-5 + gold 회수. 비교 로직은 `scripts/verify-env-health-diff.py` (순수 헬퍼,
  유닛 테스트 7건) — 한쪽-down 단독은 Slack warning 알림, 게이트(FAIL)는 통과.

  **CI 등록 (2026-08-14, 수정 51 갱신)**: deploy.yml 의 `deploy-staging` job 에
  동치 대조를 post-deploy gate 로 등록 — **매 staging 배포 후 자동 실행**된다.
  `SKIP_COMMIT=1` (커밋 일치는 verify-do-binding.sh post-deploy gate 가 이미
  검증) + 최종 시도에서만 Slack 알림(EQ_NOTIFY). 실패 시 job 실패 처리.
  workflow_run 에서 production 배포가 동시 진행될 수 있어 45s 간격 1회 재시도.
  배포 이전 단계가 실패하면 동치 대조는 실행되지 않는다. **수정 51 (2026-08-15)**:
  ① 웹훅 시크릿 이름 양쪽 지원 — `SLACK_WEBHOOK`(Pages 프로젝트 관례) 또는
  `ALERT_SLACK_WEBHOOK`(docs 관례) 어느 쪽이든 GitHub Actions 시크릿으로 설정하면
  동작 (env 에 두 이름 모두 매핑, resolveWebhookUrl: SLACK_WEBHOOK 우선). ② 동치
  대조 이전 단계(guard/배포/post-deploy gate) 실패 시엔 동치 대조가 실행되지 않아
  알림이 전혀 없던 갭을 보완 — `Notify staging pipeline failure` 스텝
  (`if: !cancelled() && steps.equivalence.outcome == 'skipped'`)이 파이프라인 어느
  단계 실패든 danger 알림 전송 (동치 대조 실패는 상세 알림과 중복 방지). 조건에
  `failure()` 를 쓰지 않는 이유: 다운로드 스텝(continue-on-error) 이후 `if:
  failure()` 는 발화하지 않을 수 있어 verify-deploy-workflow 가 거부함 — equivalence
  는 마지막 무조건 스텝이라 'skipped' ⟺ 이전 단계 실패. ⚠️ GitHub
  Actions 시크릿 `ALERT_SLACK_WEBHOOK`(또는 SLACK_WEBHOOK) 미설정 상태 — 실측
  (2026-08-15) repo secrets 는 CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN 만 존재.

  **셀프테스트 (수정 40, 2026-08-14)**: `bash scripts/deploy-local-worktree.sh
  --self-test` — 가짜 npx/curl 바이너리로 모든 wrangler/curl 호출을 스텁하고
  (오프라인, node 불필요 — 빌드 생략 + git worktree 만 사용) 부분 배포 판정 +
  --auto-rollback 발동 조건을 검증하는 회귀 테스트. 5개 시나리오: ① Pages 실패 +
  --auto-rollback → 정확한 PREV_DO_VERSION 으로 롤백 + exit 1 ② Pages 실패
  (플래그 없음) → 롤백 없음 ③ cron 실패 → 롤백 없음 (DO+Pages 일치) ④ DO 실패 →
  롤백 없음 ⑤ 전체 성공 → exit 0. mutation 검증 완료 (롤백 조건을 뒤집자 ①이
  정확히 실패). ci.yml 의 `deploy-selftest` job 으로 CI 에서도 자동 실행된다 —
  이전에 수동으로 돌리던 가짜 npx 래퍼 실측을 정식화.

  **드라이런 유닛 테스트 (수정 41, 2026-08-14)**: `tests/unit/deploy-local-worktree.test.ts`
  (신규) — 드라이런 모드를 **vitest 유닛 테스트로 검증** (parse-cron-health.test.ts 와
  동일 패턴: execFileSync 로 bash 스크립트 스폰, 가짜 npx 로 whoami 만 스텁). 7개
  케이스: ① 계획만 출력 + **배포 명령 미실행**(가짜 npx 로그에 whoami 만 존재 —
  드라이런이 배포로 진행하는 회귀는 whoami 외 호출이 실패해 즉시 적발) ② staging
  변형(branch/cron/헬스 URL/DEPLOY_ENV) ③ GOLD_FAIL_HARD=1 계획 라인 ④
  --auto-rollback 계획 라인 ⑤ 미지 옵션 exit 1 ⑥ 미존재 커밋 exit 1 ⑦ OAuth 실패 시
  드라이런도 실패.  npm test (vitest unit project) 에 자동 포함 — CI 에서도 실행.

  **격리 빌드 (수정 42, 2026-08-14)**: `ISOLATED_BUILD=1` — node_modules 심링크
  대신 **worktree 내부에서 `npm ci`** 로 대상 커밋의 package-lock.json 기준으로
  정확히 설치 후 빌드한다. main repo 의 미커밋 package*.json 변경·stale
  node_modules 와 무관한 재현 가능 빌드 (의존성 혼합 위험 원천 제거). 기본 0 =
  심링크 공유 (빠름, CI/일상 배포용). 드라이런 계획에 격리 경로 표시, 미커밋
  package*.json 경고가 ISOLATED_BUILD=1 일 때 안내 문구를 대체한다.
  유닛 테스트(수정 41 파일)에 격리 계획 케이스 추가. 실측: worktree 에서 npm ci
  → build 성공 (dist/_worker.js 1,094.21 kB).

  **배포 커밋 동치 전용 검증 (수정 43, 2026-08-14)**: `scripts/verify-deploy-commit-sync.sh`
  (신규) — staging ↔ production 의 최신 배포 **Source commit 동치만** 자동 확인하는
  경량 스크립트 (wrangler pages deployment list 만 조회 — 검색/gold/헬스 부하
  없음, rate limit 무관). verify-env-equivalence.sh 의 [1/4] 를 전용으로 분리한
  것. `EXPECTED_COMMIT` 지정 시 양쪽 모두 그 커밋이어야 함, 불일치 시 Slack 알림
  (SYNC_NOTIFY, 미설정 no-op). deploy-local-worktree.sh 의 post-deploy 단계에
  COMMIT_SYNC_CHECK(기본 1)로 통합 — **production 배포에도 cross-env 커밋 동치를
  자동 확인** (기존 EQ 는 staging 전용이었음). 불일치는 배포 성공에 영향 없이
  경고로만 (production 배포 직후 staging 미배포는 정상).  유닛 테스트 5건 (동치/불일치/EXPECTED 일치·불일치/미배포) — 가짜 npx 로 deployment list 픽스처
  검증. 실측: 양쪽 1941786 → ✅ 동치 exit 0.

  **deep probe cron 발화 검증 (수정 44, 2026-08-14)**: `scripts/probe-deep-probe-cron.sh`
  (신규) — staging/production 스케줄러 + staging Pages 를 wrangler tail 로 동시 관찰해
  15분 cron 틱이 실제 발화하는지 검증하는 프로브. tail 연결 확인용 자체 트래픽(대조군),
  직접 wrangler 바이너리 사용(npx 병렬 시작 경합 회피). **실측 (15:15 UTC 틱)**:
  staging scheduler `[cron-probe] deep health probe triggered` (probe_url=staging,
  HTTP 200) + production scheduler 동시 발화(대조군) + staging Pages 에서
  `user-agent: ssak-cron-probe/1.0` 의 `GET /api/health?depth=full` 수신 →
  `[health] deep health probe complete` (cached:false, down_backends none) —
  로컬 worktree 배포(1941786) 후 staging 딥 프로브가 실제 도는 것 tail 로 확정.

  `scripts/deploy-local-worktree.sh`가 worktree 생성 → node_modules 심링크 → build →
  3단계 배포(DO → Pages → cron) → Source commit 검증 → 헬스 확인 → worktree 정리
  (실패 시 trap 정리)를 자동 수행한다. 로컬 OAuth(`wrangler login`)가 살아있는 한
  이 경로는 시크릿과 무관하게 동작한다. 수동 절차는 하단 참고:
  1. `git worktree add /tmp/deploy <sha>` + `ln -s` node_modules
  2. `npm run build`
  3. `npx wrangler deploy --config=wrangler.do.jsonc`
  4. `npx wrangler pages deploy dist/ --project-name=search-engine-api --branch=main`
  5. `npx wrangler deploy --config=wrangler.cron.jsonc`
