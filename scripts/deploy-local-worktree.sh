#!/usr/bin/env bash
# =============================================================================
# deploy-local-worktree.sh — GitHub Actions 실패 시 로컬 worktree 배포 자동화
#
# GitHub Actions의 CLOUDFLARE_API_TOKEN 시크릿이 무효/만료되어 workflow_dispatch
# 배포가 실패하는 동안, 로컬 wrangler OAuth(wrangler login)로 동일 커밋을
# 3단계 배포(DO 워커 → Pages → cron 스케줄러)한다. S105/S106/S73 시리즈에서
# 반복 적용한 수동 절차를 스크립트화한 것 — docs/17 §5 참조.
#
# 사용법:
#   scripts/deploy-local-worktree.sh [commit] [staging|production] [--dry-run] [--auto-rollback] [--self-test]
#     commit   : 배포할 SHA (기본: 현재 HEAD)
#     env      : production(기본) | staging
#   --dry-run: 아무것도 실행하지 않고 실행 계획만 출력 (인자 순서 무관)
#   --auto-rollback: Pages 배포 실패로 DO 가 새 버전만 남은 정합 불일치가 되면,
#                    DO 를 배포 직전 버전으로 자동 롤백한다 (부분 배포 방지).
#   --self-test: 가짜 npx/curl 로 부분 배포 판정 + 자동 롤백 조건을 검증하는
#                오프라인 회귀 테스트 (실제 배포 없음, node 불필요).
#
# Env:
#   GOLD_CHECK=0  배포 후 라이브 gold 회수 검증 생략 (기본 1=수행)
#   EQ_CHECK=0    배포 후 staging↔production 동치 대조 생략 (기본 1=수행, staging 전용)
#   GOLD_FAIL_HARD=1  gold 미회수가 재시도 횟수 동안 지속되면 배포를 실패 처리(exit 1).
#                     기본 0 = 경고만 출력하고 배포는 성공 처리.
#   GOLD_FAIL_HARD_RETRIES      GOLD_FAIL_HARD=1 시 총 시도 횟수 (기본 3 — 일시적
#                               업스트림 지연과 지속 실패를 구분)
#   GOLD_FAIL_HARD_RETRY_WAIT   재시도 사이 대기 초 (기본 30)
#   ISOLATED_BUILD=1  node_modules 심링크 대신 **worktree 내부에서 npm ci** 로
#                     격리 빌드 (기본 0 = 심링크 공유). 대상 커밋의
#                     package-lock.json 기준으로 정확히 설치되므로, main repo 의
#                     미커밋 package*.json 변경·stale node_modules 와 무관하게
#                     재현 가능한 빌드를 보장한다. 느리지만 안전 (기본 사용 권장은
#                     심링크 — CI/일상 배포는 npm ci 를 이미 수행한 node_modules 사용)
#   COMMIT_SYNC_CHECK=0  배포 후 staging↔production 배포 커밋 동치 확인 생략
#                     (기본 1=수행 — 경량: wrangler deployment list 만 조회,
#                     검색/gold/헬스 부하 없음). 불일치는 배포 성공에 영향 없이
#                     경고로만 (production 배포 직후 staging 미배포는 정상 상태)
#
# 예:
#   scripts/deploy-local-worktree.sh                       # HEAD → production
#   scripts/deploy-local-worktree.sh 41218df staging       # S73e → staging
#   scripts/deploy-local-worktree.sh --dry-run staging     # 계획만 확인
#   scripts/deploy-local-worktree.sh HEAD staging --dry-run
#
# 전제:
#   - 로컬 wrangler OAuth 유효 (`npx wrangler whoami` → 계정 표시)
#   - 배포할 SHA는 로컬에 존재하는 커밋이어야 함 (push 안 된 커밋은 경고 후 진행)
#
# 안전성 (미커밋 작업과의 관계):
#   - `git worktree add <sha>`는 지정 커밋의 CLEAN 체크아웃을 만든다 — 워킹 트리의
#     미커밋/staged 변경은 배포 내용에 절대 복사되지 않는다 (배포 무결성 보장).
#   - ⚠️ node_modules 심링크: 워킹 트리에 미커밋 package.json/package-lock.json
#     변경이 있으면, 과거 커밋 빌드가 새/누락 의존성과 섞일 수 있다 → 미커밋
#     package*.json 감지 시 경고를 출력한다. 완전한 재현성을 원하면
#     ISOLATED_BUILD=1 (수정 42) — 심링크 대신 worktree 내부에서 npm ci 로
#     대상 커밋의 lockfile 기준 격리 빌드 (의존성 혼합 위험 원천 제거, 느림).
#   - ⚠️ /tmp/ssak-deploy-<sha>가 이미 존재하면 --force로 제거 후 재생성한다 —
#     같은 SHA worktree를 직접 만들어 작업 중이었다면 유실될 수 있다.
#
# 부분 배포 보고 (2026-08-14):
#   각 단계(DO → Pages → cron)의 성공/실패를 개별 추적해, 중간에 실패해도 즉시
#   종료하지 않고 어디까지 배포됐는지를 명확히 보고한다. DO 배포 전에 이전 DO
#   버전 ID를 캡처해, DO만 새 버전이고 Pages가 실패한 경우 롤백 명령을 제시한다
#   (Pages는 롤백 없이 이전 배포를 유지 — DO를 이전 버전으로 되돌리는 게 정합).
#   실패 시 exit 1 (부분 배포가 있으면 그 상태를 요약).
#
# 동작: 사전 확인(커밋/미커밋/push 상태) → worktree 생성 → node_modules 심링크 →
#       build → 3단계 배포(각 단계 성공/실패 추적) → Pages Source commit 검증 →
#       헬스 확인 → 부분 배포 상태 요약 → worktree 정리(실패 시에도 trap).
#       --dry-run이면 계획 출력 후 종료. --self-test면 가짜 npx/curl 시뮬레이션으로
#       부분 배포 판정 + --auto-rollback 발동 조건을 검증하고 종료 (수정 40 —
#       이전에 수동으로 돌리던 가짜 npx 래퍼 실측을 스크립트 자체에 정식화).
# =============================================================================
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

# ── --self-test: 가짜 npx 시뮬레이션 정식화 (회귀 방지) ────────────────────
# 실제 배포·네트워크 없이 부분 배포 판정 + --auto-rollback 발동 조건을 검증한다.
# verify-do-binding.sh --self-test / parse-cron-health.py --self-test 와 같은
# 컨벤션 — 모든 wrangler/curl 호출을 가짜 바이너리로 대체해 시나리오별로
# DO/Pages/cron 성공·실패를 흉내낸다 (오프라인, node 불필요 — 빌드 생략).
if [ "${1:-}" = "--self-test" ]; then
  echo "━━━ deploy-local-worktree.sh self-test (가짜 npx 시뮬레이션) ━━━"
  SELFTEST_TMP="$(mktemp -d /tmp/ssak-selftest.XXXXXX)"
  FAKE_BIN="$SELFTEST_TMP/bin"
  mkdir -p "$FAKE_BIN"
  export FAKE_NPX_LOG="$SELFTEST_TMP/npx.log"
  export REAL_NPX="$(command -v npx || echo /usr/bin/env)"

  cat > "$FAKE_BIN/npx" <<'FAKEEOF'
#!/usr/bin/env bash
# 셀프테스트용 가짜 npx — wrangler 호출만 가로채고 나머지는 진짜 npx 로 통과.
# 시나리오(FAKE_NPX_SCENARIO)에 따라 DO/Pages/cron 배포 성공·실패를 흉내낸다.
echo "npx $*" >> "${FAKE_NPX_LOG:?}"
if [ "${1:-}" != "wrangler" ]; then exec "$REAL_NPX" "$@"; fi
shift
case "${1:-}" in
  whoami)
    echo "sumkbs@users.noreply.cloudflare.com"; exit 0 ;;
  deployments)
    # deployments list --config=wrangler.do.jsonc → PREV_DO_VERSION (UUID)
    echo "Version(s): 0532d4a2-1111-4222-8333-444455556666"; exit 0 ;;
  pages)
    if [ "${2:-}" = "deploy" ]; then
      if [ "${FAKE_NPX_SCENARIO:-}" = "pages_fail" ]; then
        echo "✗ Error: pages deploy failed (simulated)" >&2; exit 1
      fi
      echo "✨ Success! Deployment complete."; exit 0
    fi
    if [ "${2:-}" = "deployment" ]; then
      # pages deployment list — Source 커밋 검증용 테이블 행 (컬럼 5 = SHA)
      FULL="$(git rev-parse HEAD 2>/dev/null || echo 0000000000000000000000000000000000000000)"
      echo "│ $(date +%F) │ abc │ main │ ${FULL:0:7} │"
      exit 0
    fi
    echo "✗ unexpected wrangler pages: $*" >&2; exit 1 ;;
  deploy)
    # DO 배포(--config=wrangler.do.jsonc)와 cron 배포(그 외)를 구분
    if [ "${FAKE_NPX_SCENARIO:-}" = "do_fail" ] && [[ "$*" == *"wrangler.do.jsonc"* ]]; then
      echo "✗ Error: DO deploy failed (simulated)" >&2; exit 1
    fi
    if [ "${FAKE_NPX_SCENARIO:-}" = "cron_fail" ] && [[ "$*" != *"wrangler.do.jsonc"* ]]; then
      echo "✗ Error: cron deploy failed (simulated)" >&2; exit 1
    fi
    echo "Uploaded ssak-do-worker (v0.0.0-selftest)"
    echo "Current Version ID: abc12345-1111-4222-8333-444455556666"
    exit 0 ;;
  rollback)
    echo "Success! Version rollback → ${2:-?}."; exit 0 ;;
  *) echo "✗ unexpected wrangler subcommand: $*" >&2; exit 1 ;;
esac
FAKEEOF
  chmod +x "$FAKE_BIN/npx"

  cat > "$FAKE_BIN/curl" <<'FAKEEOF'
#!/usr/bin/env bash
# 셀프테스트용 가짜 curl — 헬스 확인(-w http_code)은 200, 그 외 no-op.
echo "curl $*" >> "${FAKE_NPX_LOG:?}"
if [[ "$*" == *"-w"* ]]; then echo "200"; fi
exit 0
FAKEEOF
  chmod +x "$FAKE_BIN/curl"

  FAILURES=0
  run_scenario() {
    local name="$1" opts="$2" expect_exit="$3" expect_rollback="$4"
    : > "$FAKE_NPX_LOG"
    local out="$SELFTEST_TMP/$name.out"
    (
      export PATH="$FAKE_BIN:$PATH" FAKE_NPX_SCENARIO="$name"
      export GOLD_CHECK=0 EQ_CHECK=0 COMMIT_SYNC_CHECK=0 SELFTEST_TARGET_RUN=1
      bash "$REPO_ROOT/scripts/deploy-local-worktree.sh" HEAD production $opts
    ) > "$out" 2>&1
    local got=$?
    local ok=1
    [ "$got" = "$expect_exit" ] || ok=0
    if [ "$expect_rollback" = "yes" ]; then
      grep -q "wrangler rollback 0532d4a2-1111-4222-8333-444455556666" "$FAKE_NPX_LOG" || ok=0
    else
      grep -q "wrangler rollback" "$FAKE_NPX_LOG" && ok=0
    fi
    if [ "$ok" = "1" ]; then
      echo " ✅ $name: exit=$got rollback=$expect_rollback"
    else
      echo " ❌ $name: exit=$got (기대 $expect_exit) rollback=$(grep -c 'wrangler rollback' "$FAKE_NPX_LOG" || true)건 (기대 $expect_rollback)"
      tail -30 "$out" >&2
      FAILURES=$((FAILURES + 1))
    fi
  }

  run_scenario pages_fail "--auto-rollback" 1 yes   # Pages 실패 → DO 자동 롤백 (PREV_DO_VERSION)
  run_scenario pages_fail ""               1 no    # 플래그 없으면 롤백 안 함 (수동 안내만)
  run_scenario cron_fail  ""               1 no    # DO+Pages 일치 — 롤백하면 오히려 틀림
  run_scenario do_fail    ""               1 no    # 아무것도 배포 안 됨 — 롤백 대상 없음
  run_scenario success    ""               0 no    # 전체 성공 — 롤백 없음, exit 0

  rm -rf "$SELFTEST_TMP"
  if [ "$FAILURES" != "0" ]; then
    echo " ❌ deploy-local-worktree.sh self-test FAIL: $FAILURES case(s) 실패"
    exit 1
  fi
  echo " ✅ deploy-local-worktree.sh self-test: all PASS (5/5)"
  exit 0
fi

# ── 인자 파싱 (commit/env/--dry-run/--auto-rollback 순서 무관) ────────────
DRY_RUN=0
AUTO_ROLLBACK=0
TARGET_COMMIT="HEAD"
ENV_NAME="production"
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --auto-rollback) AUTO_ROLLBACK=1 ;;
    production|staging) ENV_NAME="$arg" ;;
    -*) echo " ❌ 알 수 없는 옵션: $arg (지원: [commit] [production|staging] [--dry-run] [--auto-rollback] [--self-test])" >&2; exit 1 ;;
    *) TARGET_COMMIT="$arg" ;;
  esac
done

case "$ENV_NAME" in
  production)
    PAGES_BRANCH="main"
    CRON_CONFIG="wrangler.cron.jsonc"
    HEALTH_URL="https://search-engine-api.pages.dev/api/health"
    ;;
  staging)
    PAGES_BRANCH="staging"
    CRON_CONFIG="wrangler.cron.staging.jsonc"
    HEALTH_URL="https://staging.search-engine-api.pages.dev/api/health"
    ;;
  *)
    echo " ❌ 환경은 production|staging 중 하나여야 합니다 (입력: '$ENV_NAME')" >&2
    exit 1
    ;;
esac

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo " 로컬 worktree 배포 시작$([ "$DRY_RUN" = 1 ] && echo ' (DRY-RUN — 실행 안 함)')"
echo "   커밋 : $TARGET_COMMIT"
echo "   환경 : $ENV_NAME (Pages branch=$PAGES_BRANCH, cron=$CRON_CONFIG)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── 0. 사전 확인 ────────────────────────────────────────────────────────
echo " [0/6] 사전 확인"
if ! git rev-parse --verify "$TARGET_COMMIT^{commit}" >/dev/null 2>&1; then
  echo " ❌ 커밋 '$TARGET_COMMIT'이 존재하지 않습니다." >&2
  exit 1
fi
FULL_SHA="$(git rev-parse "$TARGET_COMMIT^{commit}")"
SHORT_SHA="${FULL_SHA:0:7}"
echo "   대상 SHA: $FULL_SHA ($SHORT_SHA)"

# 0-1. push 여부 — 배포할 커밋이 origin/main보다 앞서면 (로컬에만 있으면) 경고.
LOCAL_AHEAD="$(git rev-list --count origin/main.."$FULL_SHA" 2>/dev/null || echo 0)"
if [ "$LOCAL_AHEAD" != "0" ]; then
  echo " ⚠️  대상 커밋이 origin/main보다 $LOCAL_AHEAD개 앞서 있습니다 (로컬에만 존재)."
  echo "    의도된 경우만 진행하세요 — 배포 후 소스 추적이 어긋날 수 있습니다."
fi

# 0-2. 미커밋 변경 감지 — 배포 내용과는 무관하지만 node_modules 심링크로 인한
#      의존성 혼합 위험 + 작업 유실 주의를 알린다.
DIRTY_FILES="$(git status --porcelain | wc -l | tr -d ' ')"
PKG_DIRTY="$(git status --porcelain -- package.json package-lock.json | wc -l | tr -d ' ')"
if [ "$DIRTY_FILES" != "0" ]; then
  echo " ⚠️  워킹 트리에 미커밋 변경 $DIRTY_FILES건이 있습니다 (배포 내용에는 영향 없음 —"
  echo "    worktree는 대상 커밋의 clean 체크아웃을 사용합니다)."
  if [ "$PKG_DIRTY" != "0" ]; then
    echo "    ⚠️  package.json/package-lock.json 미커밋 변경 감지 — worktree는 main repo의"
    echo "    node_modules를 공유하므로 의존성 상태가 대상 커밋과 다를 수 있습니다."
    if [ "${ISOLATED_BUILD:-0}" != "1" ]; then
      echo "    정확한 빌드를 원하면 main repo에서 'npm ci' 후 재실행하거나 ISOLATED_BUILD=1 로"
      echo "    worktree 내부 격리 npm ci 를 사용하세요 (수정 42)."
    fi
  fi
fi

# 0-3. OAuth 확인 (드라이런에서도 수행 — 읽기 전용이라 무해)
if ! npx wrangler whoami 2>/dev/null | grep -qiE 'sumkbs|@'; then
  echo " ⚠️  wrangler OAuth 계정이 감지되지 않습니다 — 'npx wrangler login' 후 재시도하세요." >&2
  echo "    (CLOUDFLARE_API_TOKEN을 쓰는 GitHub Actions와 달리 로컬은 OAuth로 인증합니다)" >&2
  exit 1
fi
echo "   wrangler OAuth 인증 OK"

# ── 드라이런: 계획 출력 후 종료 ──────────────────────────────────────────
WORKTREE_DIR="/tmp/ssak-deploy-${SHORT_SHA}"
if [ "$DRY_RUN" = 1 ]; then
  echo ""
  echo " [DRY-RUN] 아래 계획을 실행하지 않습니다:"
  echo "   worktree : $WORKTREE_DIR (대상 커밋의 clean 체크아웃)"
  if [ "${ISOLATED_BUILD:-0}" = "1" ]; then
    echo "   build    : npm ci (worktree 내부 격리 — 대상 커밋 lockfile 기준) → DEPLOY_ENV=$ENV_NAME npm run build"
  else
    echo "   build    : DEPLOY_ENV=$ENV_NAME npm run build (worktree 내부, node_modules는 main repo 심링크)"
  fi
  echo "             ⚠️  DO 인스턴스 키를 환경별로 분리 — staging 은 'staging', production 은 'production' 인스턴스 사용 (방안 B)"
  echo "   ① DO     : npx wrangler deploy --config=wrangler.do.jsonc"
  echo "   ② Pages  : npx wrangler pages deploy dist/ --project-name=search-engine-api --branch=$PAGES_BRANCH"
  echo "   ③ cron   : npx wrangler deploy --config=$CRON_CONFIG"
  echo "   검증     : Pages Source commit == $SHORT_SHA + $HEALTH_URL HTTP 200"
  echo "   gold     : 6개 대표 쿼리 gold 회수 (top-10) — GOLD_CHECK=0 으로 생략 가능"
  echo "   동치     : staging↔production 배포 커밋 동치 (경량) — COMMIT_SYNC_CHECK=0 으로 생략 가능"
  if [ "${GOLD_FAIL_HARD:-0}" = "1" ]; then
    echo "   fail-hard: gold 미회수 시 ${GOLD_FAIL_HARD_RETRIES:-3}회 재시도 후 배포 실패 처리 (GOLD_FAIL_HARD=1)"
  fi
  echo "   부분배포 : 각 단계 성공/실패를 추적해 중간 실패 시 상태를 요약 (DO 롤백 명령 포함)"
  if [ "$AUTO_ROLLBACK" = "1" ]; then
    echo "   auto-rollback: Pages 실패 시 DO 를 이전 버전(${PREV_DO_VERSION:-알 수 없음})으로 자동 롤백 (--auto-rollback)"
  fi
  echo "   정리     : trap으로 worktree 제거 (실패 시에도)"
  echo ""
  echo " ✅ 드라이런 완료 — 실제 배포를 원하면 --dry-run 없이 재실행하세요."
  exit 0
fi

# ── worktree 생성 (실패 시에도 정리되도록 trap) ──────────────────────────
cleanup() {
  echo " [정리] worktree 제거: $WORKTREE_DIR"
  git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
}
trap cleanup EXIT

# ── 배포 전 이전 DO 버전 캡처 (부분 배포 시 롤백 안내용) ─────────────────
PREV_DO_VERSION="$(npx wrangler deployments list --config=wrangler.do.jsonc 2>/dev/null | grep -m1 'Version(s):' | grep -oE '[0-9a-f]{8}-[0-9a-f-]{27}' | head -1 || true)"
echo "   이전 DO 버전: ${PREV_DO_VERSION:-알 수 없음}"

echo " [1/6] worktree 생성: $WORKTREE_DIR"
if [ -d "$WORKTREE_DIR" ]; then
  echo "   ⚠️  기존 worktree 제거 후 재생성 (같은 SHA worktree에서 작업 중이었다면 유실될 수 있음)"
fi
git worktree remove --force "$WORKTREE_DIR" 2>/dev/null || true
git worktree add "$WORKTREE_DIR" "$FULL_SHA" >/dev/null 2>&1
# node_modules: 기본은 main repo 심링크 (npm ci 시간 절약 — worktree add 는
# node_modules 를 만들지 않으므로 clean 체크아웃이 심링크를 지우는 문제 없음).
# ISOLATED_BUILD=1 이면 심링크를 만들지 않고 [2/6] 에서 worktree 내부에 npm ci
# 로 격리 설치한다 (대상 커밋 lockfile 기준 — main repo 의 미커밋 package*.json
# 변경·stale node_modules 와 무관한 재현 가능 빌드, 수정 42).
if [ "${ISOLATED_BUILD:-0}" != "1" ]; then
  ln -sfn "$REPO_ROOT/node_modules" "$WORKTREE_DIR/node_modules"
else
  echo "   (ISOLATED_BUILD=1 — 심링크 없음, worktree 내부 npm ci 로 격리)"
fi
cd "$WORKTREE_DIR"

# ── 빌드 ────────────────────────────────────────────────────────────────
# 방안 B (2026-08-14): DEPLOY_ENV 를 빌드 타임에 주입해 DO 인스턴스 키를
# 환경별로 분리한다 (vite define → src/lib/deploy-env.ts). 같은 커밋이라도
# staging 은 'staging', production 은 'production' 인스턴스를 가리킨다.
echo " [2/6] 빌드 (vite build, DEPLOY_ENV=$ENV_NAME)"
if [ "${SELFTEST_TARGET_RUN:-0}" = "1" ]; then
  # 셀프테스트 대상 실행 — 실제 빌드 없이 성공 처리 (오프라인 회귀 테스트)
  echo "   (셀프테스트 — 빌드 생략, 성공 처리)"
  BUILD_OK=0
else
  if [ "${ISOLATED_BUILD:-0}" = "1" ]; then
    # 격리 빌드 — worktree 내부에서 대상 커밋의 lockfile 기준으로 정확히 설치
    echo "   npm ci (격리 — worktree 내부, 대상 커밋 package-lock.json 기준)"
    if ! npm ci 2>&1 | tail -5; then
      echo " ❌ npm ci 실패 — 의존성 설치 오류 (네트워크/레지스트리 상태 확인)" >&2
      exit 1
    fi
  fi
  DEPLOY_ENV="$ENV_NAME" npm run build 2>&1 | tail -2
  BUILD_OK=$?
fi
if [ "$BUILD_OK" != "0" ]; then
  echo " ❌ 빌드 실패 — 아무것도 배포하지 않았습니다." >&2
  exit 1
fi

# ── 부분 배포 상태 추적 변수 ─────────────────────────────────────────────
DO_DEPLOYED=0
PAGES_DEPLOYED=0
CRON_DEPLOYED=0

# ── ① DO 워커 배포 ──────────────────────────────────────────────────────
echo " [3/6] ① DO 워커 배포 (wrangler.do.jsonc)"
if npx wrangler deploy --config=wrangler.do.jsonc 2>&1 | grep -E 'Uploaded|Current Version ID'; then
  DO_DEPLOYED=1
  echo "   ✓ DO 워커 배포 성공"
else
  echo " ❌ DO 워커 배포 실패 — 이후 단계를 건너뜁니다 (아무것도 배포되지 않음)." >&2
  # set -uo pipefail이지만 if 조건 안에서는 실패가 종료로 이어지지 않음
fi

# ── ② Pages 배포 ────────────────────────────────────────────────────────
if [ "$DO_DEPLOYED" = "1" ]; then
  echo " [4/6] ② Pages 배포 (branch=$PAGES_BRANCH)"
  if npx wrangler pages deploy dist/ --project-name=search-engine-api --branch="$PAGES_BRANCH" --commit-dirty=true 2>&1 | grep -E '✨ Success|Deployment complete'; then
    PAGES_DEPLOYED=1
    echo "   ✓ Pages 배포 성공"
  else
    echo " ❌ Pages 배포 실패 — DO는 새 버전($SHORT_SHA), Pages는 이전 버전 유지 (부분 배포)." >&2
  fi
fi

# ── ③ cron 스케줄러 배포 ────────────────────────────────────────────────
if [ "$PAGES_DEPLOYED" = "1" ]; then
  echo " [5/6] ③ cron 스케줄러 배포 ($CRON_CONFIG)"
  if npx wrangler deploy --config="$CRON_CONFIG" 2>&1 | grep -E 'Uploaded|Current Version ID'; then
    CRON_DEPLOYED=1
    echo "   ✓ cron 배포 성공"
  else
    echo " ❌ cron 배포 실패 — DO+Pages는 배포됨, cron만 이전 버전 (부분 배포)." >&2
  fi
fi

# ── Source commit 검증 (Pages가 배포된 경우에만) ────────────────────────
PAGES_COMMIT_OK=0
GOLD_OK=0
if [ "$PAGES_DEPLOYED" = "1" ]; then
  echo " [6/6] 배포 검증"
  cd "$REPO_ROOT"
  sleep 5
  DEPLOYED_COMMIT="$(npx wrangler pages deployment list --project-name=search-engine-api 2>/dev/null | grep -E '│' | grep -vE 'Id|─' | head -1 | awk -F'│' '{gsub(/ /,"",$5); print $5}' || true)"
  if [ -z "$DEPLOYED_COMMIT" ]; then
    echo " ⚠️  deployment list에서 커밋을 읽지 못했습니다 — 수동 확인 필요:" >&2
    echo "    npx wrangler pages deployment list --project-name=search-engine-api" >&2
  else
    echo "   예상 커밋: $SHORT_SHA | 배포된 커밋: $DEPLOYED_COMMIT"
    if [ "$DEPLOYED_COMMIT" = "$SHORT_SHA" ]; then
      echo " ✅ Source commit 일치 — 배포 성공"
      PAGES_COMMIT_OK=1
    else
      echo " ⚠️  Source commit 불일치 (방금 배포가 목록 최신이 아닐 수 있음) — 수동 확인 권장" >&2
    fi
  fi

  # ── 헬스 확인 ─────────────────────────────────────────────────────────
  echo " 헬스 확인: $HEALTH_URL"
  HEALTH_STATUS="$(curl -s -m 20 -o /dev/null -w '%{http_code}' "$HEALTH_URL" || echo 000)"
  echo "   HTTP $HEALTH_STATUS"
  if [ "$HEALTH_STATUS" = "200" ]; then
    echo " ✅ 헬스 OK"
  else
    echo " ⚠️  헬스 비정상 (HTTP $HEALTH_STATUS) — 라이브 검색으로 추가 확인 필요" >&2
  fi

  # ── 라이브 gold 회수 검증 (선택) ──────────────────────────────────────
  # GOLD_CHECK=0 이면 건너뜀. worktree 내부(eval/ 데이터 포함)에서 실행해야
  # 하므로, 이미 main repo 로 돌아와 있으면 worktree 로 다시 들어간다.
  # GOLD_FAIL_HARD=1 이면 미회수가 재시도 횟수 동안 지속될 때 배포를 실패 처리한다
  # (일시적 업스트림 지연과 지속 실패를 구분하기 위한 재시도 포함).
  if [ "${GOLD_CHECK:-1}" = "1" ]; then
    echo " gold 회수 검증 (6개 대표 쿼리, top-10)"
    # verify-deployed-gold.sh 는 SEARCH_URL 에 /api/search 를 붙이므로,
    # /api/health 가 아닌 환경의 검색 base URL 을 넘긴다.
    GOLD_SEARCH_URL="${HEALTH_URL%/api/health}"
    GOLD_ATTEMPT=1
    GOLD_MAX_ATTEMPTS=1
    [ "${GOLD_FAIL_HARD:-0}" = "1" ] && GOLD_MAX_ATTEMPTS="${GOLD_FAIL_HARD_RETRIES:-3}"
    while [ "$GOLD_ATTEMPT" -le "$GOLD_MAX_ATTEMPTS" ]; do
      if ( cd "$WORKTREE_DIR" && SEARCH_URL="$GOLD_SEARCH_URL" bash "$REPO_ROOT/scripts/verify-deployed-gold.sh" ); then
        GOLD_OK=1
        echo " ✅ gold 회수 검증 통과"
        break
      elif [ "$GOLD_ATTEMPT" -lt "$GOLD_MAX_ATTEMPTS" ]; then
        echo " ⚠️  gold 회수 실패 (시도 $GOLD_ATTEMPT/$GOLD_MAX_ATTEMPTS) — ${GOLD_FAIL_HARD_RETRY_WAIT:-30}s 후 재시도" >&2
        sleep "${GOLD_FAIL_HARD_RETRY_WAIT:-30}"
      fi
      GOLD_ATTEMPT=$((GOLD_ATTEMPT + 1))
    done
    if [ "$GOLD_OK" != "1" ] && [ "${GOLD_FAIL_HARD:-0}" = "1" ]; then
      GOLD_FAIL_HARD_FAILED=1
      echo " ❌ gold 미회수가 ${GOLD_MAX_ATTEMPTS}회 시도 동안 지속 — GOLD_FAIL_HARD=1 이므로 배포를 실패 처리합니다" >&2
    elif [ "$GOLD_OK" != "1" ]; then
      echo " ⚠️  gold 회수 검증 실패 — 일시적 업스트림 지연이면 무해, 지속되면 조사 필요 (GOLD_FAIL_HARD=1 로 실패 처리 가능)" >&2
    fi
    cd "$REPO_ROOT"
  fi

  # ── staging ↔ production 동치 대조 (staging 배포 후에만 의미 있음) ──────
  # 배포 커밋 · 헬스 · 검색 top-5 · gold 회수를 양쪽에서 비교해 staging 이
  # production 과 동일하게 동작하는지 확인한다. EQ_CHECK=0 으로 생략.
  if [ "${EQ_CHECK:-1}" = "1" ] && [ "$ENV_NAME" = "staging" ]; then
    echo " staging ↔ production 동치 대조"
    if bash "$REPO_ROOT/scripts/verify-env-equivalence.sh"; then
      echo " ✅ 환경 동치 확인 통과"
    else
      echo " ⚠️  환경 동치 불일치 — production 이 아직 이 커밋이 아니면 정상 (f5ef768 vs 41218df 사례)" >&2
    fi
  fi

  # ── staging ↔ production 배포 커밋 동치 (경량, 양쪽 환경 모두) ──────────
  # verify-deploy-commit-sync.sh — wrangler deployment list 만 조회해 두
  # 환경의 최신 배포 Source commit 을 비교 (검색/gold/헬스 부하 없음).
  # staging 배포는 위 EQ [1/4] 가 이미 커버하지만, production 배포에는
  # cross-env 커밋 확인이 없었으므로 여기서 채운다. 불일치는 배포 자체의
  # 성공에는 영향 없이 경고로만 (production 배포 직후 staging 미배포는 정상).
  if [ "${COMMIT_SYNC_CHECK:-1}" = "1" ]; then
    echo " staging ↔ production 배포 커밋 동치 (경량)"
    if bash "$REPO_ROOT/scripts/verify-deploy-commit-sync.sh"; then
      echo " ✅ 배포 커밋 동치 확인 통과"
    else
      echo " ⚠️  배포 커밋 동치 불일치 — production 배포 직후 staging 미배포면 정상, 양쪽 배포 후 재확인" >&2
    fi
  fi
fi

# ── 최종 요약 — 부분 배포 상태를 명확히 보고 ─────────────────────────────
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
if [ "$DO_DEPLOYED" = "1" ] && [ "$PAGES_DEPLOYED" = "1" ] && [ "$CRON_DEPLOYED" = "1" ]; then
  echo " ✅ 전체 배포 완료: $ENV_NAME @ $SHORT_SHA"
  echo "   DO: ssak-do-worker · Pages: $PAGES_BRANCH · cron: $CRON_CONFIG"
  echo "   로그: npx wrangler tail ssak-do-worker --config wrangler.do.jsonc"
elif [ "$DO_DEPLOYED" = "1" ] && [ "$PAGES_DEPLOYED" = "1" ] && [ "$CRON_DEPLOYED" = "0" ]; then
  echo " ⚠️  부분 배포: DO + Pages 는 $SHORT_SHA, cron 만 이전 버전"
  echo "    다음 중 하나를 진행하세요:"
  echo "      (a) cron만 재배포: npx wrangler deploy --config=$CRON_CONFIG"
  echo "      (b) 전체 재시도:   bash scripts/deploy-local-worktree.sh $SHORT_SHA $ENV_NAME"
elif [ "$DO_DEPLOYED" = "1" ] && [ "$PAGES_DEPLOYED" = "0" ]; then
  echo " ⚠️  부분 배포: DO 는 새 버전($SHORT_SHA), Pages 는 이전 버전 유지 — 정합 불일치!"
  if [ "$AUTO_ROLLBACK" = "1" ]; then
    echo "    → --auto-rollback 으로 DO 를 이전 버전으로 되돌립니다 (아래)"
  else
    echo "    Pages 가 실패했으므로 DO 를 이전 버전으로 되돌리는 것을 권장합니다:"
    if [ -n "${PREV_DO_VERSION:-}" ]; then
      echo "      롤백: npx wrangler rollback $PREV_DO_VERSION --config=wrangler.do.jsonc"
    else
      echo "      롤백: npx wrangler rollback --config=wrangler.do.jsonc"
    fi
    echo "      또는 --auto-rollback 플래그로 자동화 가능"
  fi
  echo "      또는 Pages 재시도: bash scripts/deploy-local-worktree.sh $SHORT_SHA $ENV_NAME (DO 재배포 포함)"
else
  echo " ❌ DO 배포 실패 — 아무것도 배포되지 않았습니다 (이전 상태 유지)."
  echo "    원인 확인 후 재시도: bash scripts/deploy-local-worktree.sh $SHORT_SHA $ENV_NAME"
fi
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

# ── --auto-rollback: Pages 실패 시 DO 를 이전 버전으로 자동 롤백 ────────────
# 정합 불일치(DO=새 버전, Pages=이전)일 때만 롤백이 옳다 — cron 실패(DO+Pages
# 일치)나 DO 실패(아무것도 배포 안 됨)에서는 롤백하지 않는다. 롤백 대상은
# 배포 전에 캡처한 PREV_DO_VERSION (배포 직전 최신 = 이번 배포의 '이전').
DO_ROLLED_BACK=0
if [ "$AUTO_ROLLBACK" = "1" ] && [ "$DO_DEPLOYED" = "1" ] && [ "$PAGES_DEPLOYED" = "0" ]; then
  echo ""
  echo " [자동 롤백] Pages 배포 실패 → DO 를 이전 버전으로 되돌립니다"
  if [ -n "${PREV_DO_VERSION:-}" ]; then
    if npx wrangler rollback "$PREV_DO_VERSION" --config=wrangler.do.jsonc \
      -m "auto-rollback by deploy-local-worktree.sh: Pages deploy failed ($SHORT_SHA → $ENV_NAME)" 2>&1 | tail -3; then
      DO_ROLLED_BACK=1
      echo " ✅ DO 롤백 완료 → ${PREV_DO_VERSION}"
    else
      echo " ❌ DO 롤백 실패 — 수동 롤백 필요: npx wrangler rollback $PREV_DO_VERSION --config=wrangler.do.jsonc" >&2
    fi
  else
    echo " ⚠️  이전 DO 버전을 확인하지 못해 자동 롤백 생략 — 수동: npx wrangler rollback --config=wrangler.do.jsonc" >&2
  fi
fi

# ── GOLD_FAIL_HARD=1 이고 gold 미회수가 지속된 경우 최종 보고 ─────────────
if [ "${GOLD_FAIL_HARD_FAILED:-0}" = "1" ]; then
  echo " ❌ 검증 게이트 실패: gold 미회수 지속 (GOLD_FAIL_HARD=1) — 배포 자체는 완료됐지만"
  echo "    라이브 검색이 gold 도메인을 회수하지 못해 실패 처리합니다."
  echo "    원인(백엔드 서킷/업스트림) 조사 후 재실행: bash scripts/deploy-local-worktree.sh $SHORT_SHA $ENV_NAME"
fi

# ── exit code: 부분 배포(실패 단계 존재) 또는 gold 미회수 지속(GOLD_FAIL_HARD)이면 1 ──
if [ "$DO_DEPLOYED" = "0" ] || [ "$PAGES_DEPLOYED" = "0" ] || [ "$CRON_DEPLOYED" = "0" ] || [ "${GOLD_FAIL_HARD_FAILED:-0}" = "1" ]; then
  exit 1
fi
exit 0
