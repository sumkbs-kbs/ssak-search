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
#   --auto-rollback: 정합 불일치 시 이전 버전으로 자동 롤백한다 (부분 배포 방지):
#                     ① Pages 배포 실패 → DO 만 새 버전 → DO 를 배포 직전 버전으로
#                     ② **번들 커밋 검증 실패** (수정 61) → DO+Pages 가 새 버전인데 배포 URL
#                       번들이 대상 커밋을 담지 않음 → DO 와 Pages 를 이전 버전으로.
#                       Pages 롤백은 공식 Rollback API 를 쓴다 — production(브랜치 main)만
#                       대상 (preview/staging 은 Cloudflare 제약으로 롤백 불가 — 재배포 권장).
#                       토큰은 CLOUDFLARE_API_TOKEN 우선, 없으면 wrangler OAuth 토큰
#                       (~/.wrangler/config/default.toml oauth_token) 사용.
#   --self-test: 가짜 npx/curl 로 부분 배포 판정 + 자동 롤백 조건을 검증하는
#                오프라인 회귀 테스트 (실제 배포 없음, node 불필요).
#
# Env:
#   GOLD_CHECK=0  배포 후 라이브 gold 회수 검증 생략 (기본 1=수행)
#   EQ_CHECK=0    배포 후 staging↔production 동치 대조 생략 (기본 1=수행, staging 전용)
#   EQ_NOTIFY=0   동치 대조 실패 Slack 알림 생략 (기본 1=발송). staging 배포 후
#                 동치 대조가 실패하면 런타임 동치(헬스/검색/gold) 실패 항목을
#                 Slack danger 알림으로 보낸다 — SLACK_WEBHOOK 또는
#                 ALERT_SLACK_WEBHOOK 환경변수 필요 (미설정이면 no-op).
#                 커밋 불일치 단독은 알림 제외 (staging 배포 직후 production
#                 미배포의 정상 상태). 동치 대조 실패는 배포 자체를 실패시키지
#                 않는다 (경고만 — CI 게이트와 달리 로컬 배포는 경고 유지).
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
# 번들 커밋 검증 (수정 56, 2026-08-15):
#   Pages 배포 직후, wrangler 출력에서 방금 생성된 **배포 URL(고유 해시)** 을
#   추출해 그 URL 의 /api/health build_commit 을 대상 커밋과 대조한다 — 빌드
#   타임에 BUILD_COMMIT=<sha> 가 vite define 으로 번들에 심어진다
#   (src/lib/deploy-env.ts BUILD_COMMIT → vite.config.ts __BUILD_COMMIT__).
#   main URL 은 라우팅/캐시로 이전 배포를 가리킬 수 있어 반드시 배포 URL 을
#   사용한다. 불일치 시 exit 1 (스테일 번들 조기 차단) — "Uploaded 0 files"
#   카운트와 무관하게 런타임에서 새 코드 포함을 증명하는 강한 검증이다.
#   CI/deploy.yml 빌드도 BUILD_COMMIT=${{ github.sha }} 를 주입하므로
#   어느 배포 경로든 동일하게 동작한다.
#
# 출력 해석 — Pages "Uploaded 0 files (3 already uploaded)" (2026-08-14 실측):
#   이 메시지는 **스테일(stale)이 아니다**. wrangler pages deploy 의 "Uploaded N
#   files" 카운트는 **정적 에셋(manifest.json / static/style.css / sw.js — 배포
#   간 해시 불변, 그래서 항상 0~3개)** 만 집계한다. Workers Functions 번들
#   (_worker.js)은 별도 Functions 경로로 업로드되어 **이 카운트에 안 집계된다**.
#   Cloudflare API 실측: 배포 file_count = 정적 3파일뿐, 해시는 모든 배포에서
#   동일 — 번들은 배포마다 신선하게 새로 올라간다. 신선도는 "Uploaded N files"가
#   아니라 ① 배포 URL(고유 해시) ② [6/6] Source commit 검증으로 확인한다
#   (배포 로그의 "Source f3511e4" 등). 번들 내용은 결정적 — 동일 커밋 재빌드는
#   동일 해시를 낸다 (vite 캐시로 74ms 등 빠른 빌드도 정상).
#   → "0 files"를 보고 스테일로 오해해 재배포를 반복하지 말 것 (중복 배포만 생성).
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
      echo "✨ Success! Deployment complete."
      # bundle_mismatch 시나리오: 배포 URL 출력 → 번들 커밋 검증 발동 (수정 61)
      if [ "${FAKE_NPX_SCENARIO:-}" = "bundle_mismatch" ]; then
        echo "Deployment complete! https://abc12345.search-engine-api.pages.dev"
      fi
      exit 0
    fi
    if [ "${2:-}" = "deployment" ]; then
      if [[ "$*" == *"--json"* ]]; then
        # pages deployment list --json — 배포 전 PREV_PAGES_ID 캡처용
        echo '[{"Id":"11111111-1111-4222-8333-444455556666","Environment":"Production","Branch":"main","Source":"prevsha","Deployment":"https://11111111.search-engine-api.pages.dev"}]'
        exit 0
      fi
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
# 셀프테스트용 가짜 curl:
#   -w http_code (헬스 확인) → 200
#   /api/health (번들 커밋 검증) → bundle_mismatch 시나리오만 불일치 SHA 반환
#   -X POST (Pages Rollback API) → {"success":true}
echo "curl $*" >> "${FAKE_NPX_LOG:?}"
if [[ "$*" == *"-w"* ]]; then echo "200"; exit 0; fi
if [[ "$*" == *"/api/health"* ]]; then
  if [ "${FAKE_NPX_SCENARIO:-}" = "bundle_mismatch" ]; then echo '{"build_commit":"0000000"}'; fi
  exit 0
fi
if [[ "$*" == *"-X POST"* ]]; then echo '{"success":true}'; exit 0; fi
exit 0
FAKEEOF
  chmod +x "$FAKE_BIN/curl"

  FAILURES=0
  run_scenario() {
    local name="$1" opts="$2" expect_exit="$3" expect_rollback="$4" expect_pages_rollback="${5:-no}"
    : > "$FAKE_NPX_LOG"
    local out="$SELFTEST_TMP/$name.out"
    (
      export PATH="$FAKE_BIN:$PATH" FAKE_NPX_SCENARIO="$name"
      export GOLD_CHECK=0 EQ_CHECK=0 COMMIT_SYNC_CHECK=0 SELFTEST_TARGET_RUN=1
      # Rollback API 경로를 결정적으로 만들기 위한 가짜 인증 (수정 61)
      export CLOUDFLARE_ACCOUNT_ID=0123456789abcdef0123456789abcdef CLOUDFLARE_API_TOKEN=fake-token
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
    if [ "$expect_pages_rollback" = "yes" ]; then
      grep -q "curl .*rollback" "$FAKE_NPX_LOG" || ok=0
    else
      grep -q "curl .*rollback" "$FAKE_NPX_LOG" && ok=0
    fi
    if [ "$ok" = "1" ]; then
      echo " ✅ $name: exit=$got rollback=$expect_rollback pages_rollback=$expect_pages_rollback"
    else
      echo " ❌ $name: exit=$got (기대 $expect_exit) rollback=$(grep -c 'wrangler rollback' "$FAKE_NPX_LOG" || true)건 (기대 $expect_rollback) pages_rollback=$(grep -c 'curl .*rollback' "$FAKE_NPX_LOG" || true)건 (기대 $expect_pages_rollback)"
      tail -30 "$out" >&2
      FAILURES=$((FAILURES + 1))
    fi
  }

  run_scenario pages_fail "--auto-rollback" 1 yes no    # Pages 실패 → DO 자동 롤백 (PREV_DO_VERSION)
  run_scenario pages_fail ""               1 no  no    # 플래그 없으면 롤백 안 함 (수동 안내만)
  run_scenario cron_fail  ""               1 no  no    # DO+Pages 일치 — 롤백하면 오히려 틀림
  run_scenario do_fail    ""               1 no  no    # 아무것도 배포 안 됨 — 롤백 대상 없음
  run_scenario success    ""               0 no  no    # 전체 성공 — 롤백 없음, exit 0
  # 번들 커밋 불일치 (수정 61): --auto-rollback → DO + Pages Rollback API 자동 롤백
  run_scenario bundle_mismatch "--auto-rollback" 1 yes yes
  run_scenario bundle_mismatch ""               1 no  no    # 플래그 없으면 롤백 없이 실패 보고만

  rm -rf "$SELFTEST_TMP"
  if [ "$FAILURES" != "0" ]; then
    echo " ❌ deploy-local-worktree.sh self-test FAIL: $FAILURES case(s) 실패"
    exit 1
  fi
  echo " ✅ deploy-local-worktree.sh self-test: all PASS (7/7)"
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
  echo "             ⚠️  'Uploaded 0 files (3 already uploaded)' 는 스테일 아님 — 카운트는 정적 에셋 3개(배포 간 불변)만 집계,"
  echo "                 _worker.js Functions 번들은 별도 경로로 업로드 (신선도는 배포 URL + Source commit 검증으로 확인, 헤더 '출력 해석' 절 참조)"
  echo "   번들검증 : 배포 URL(고유 해시)의 /api/health build_commit == $SHORT_SHA 대조 — 배포된 번들이 실제 새 코드인지 런타임 증명 (수정 56)"
  echo "   ③ cron   : npx wrangler deploy --config=$CRON_CONFIG"
  echo "   검증     : Pages Source commit == $SHORT_SHA + $HEALTH_URL HTTP 200"
  echo "   gold     : 6개 대표 쿼리 gold 회수 (top-10) — GOLD_CHECK=0 으로 생략 가능"
  echo "   동치 대조 : staging↔production 동치 (커밋·헬스·검색 top-5·gold) — staging 전용, EQ_CHECK=0 으로 생략"
  echo "             실패 시 Slack 알림 (EQ_NOTIFY=1 기본 — SLACK_WEBHOOK/ALERT_SLACK_WEBHOOK 필요, 미설정 no-op)"
  echo "   동치     : staging↔production 배포 커밋 동치 (경량) — COMMIT_SYNC_CHECK=0 으로 생략 가능"
  if [ "${GOLD_FAIL_HARD:-0}" = "1" ]; then
    echo "   fail-hard: gold 미회수 시 ${GOLD_FAIL_HARD_RETRIES:-3}회 재시도 후 배포 실패 처리 (GOLD_FAIL_HARD=1)"
  fi
  echo "   부분배포 : 각 단계 성공/실패를 추적해 중간 실패 시 상태를 요약 (DO 롤백 명령 포함)"
  if [ "$AUTO_ROLLBACK" = "1" ]; then
    echo "   auto-rollback: ① Pages 실패(DO 롤백) ② 번들 커밋 불일치(DO + production 은 Pages 까지 롤백) (--auto-rollback)"
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

# ── 배포 전 이전 Pages 배포 ID 캡처 (번들 커밋 불일치 자동 롤백용, 수정 61) ──
# 같은 브랜치의 직전 배포 = 이번 배포의 '이전' (Rollback API 대상). 프로젝트에
# staging/production 이 혼재하므로 --json 의 Branch 필드로 같은 브랜치만 뽑는다.
PREV_PAGES_ID="$(npx wrangler pages deployment list --project-name=search-engine-api --json 2>/dev/null | python3 -c "
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    sys.exit(0)
branch = '$PAGES_BRANCH'
for dep in d:
    if dep.get('Branch') == branch:
        print(dep.get('Id', ''))
        break
" 2>/dev/null || true)"
echo "   이전 Pages 배포: ${PREV_PAGES_ID:-알 수 없음}"

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
# 수정 56 (2026-08-15): BUILD_COMMIT 도 빌드 타임에 심어(→ src/lib/deploy-env.ts
# BUILD_COMMIT), 배포 직후 배포 URL 의 /api/health build_commit 과 대조해
# 'Uploaded 0 files' 가 스테일이 아님을 런타임에서 검증한다.
echo " [2/6] 빌드 (vite build, DEPLOY_ENV=$ENV_NAME, BUILD_COMMIT=$SHORT_SHA)"
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
  BUILD_COMMIT="$FULL_SHA" DEPLOY_ENV="$ENV_NAME" npm run build 2>&1 | tail -2
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
PAGES_DEPLOY_URL=""
PAGES_BUNDLE_OK=2  # 0=실패 1=통과 2=검증 생략 (URL 미추출 등)
ROLLBACK_PENDING=0  # 번들 커밋 불일치 + --auto-rollback → cron/[6/6] 생략 후 롤백
if [ "$DO_DEPLOYED" = "1" ]; then
  echo " [4/6] ② Pages 배포 (branch=$PAGES_BRANCH)"
  # ⚠️ "Uploaded 0 files (3 already uploaded)"는 스테일이 아님 — 카운트는 정적
  # 에셋 3개(배포 간 불변)만 집계하고 _worker.js Functions 번들은 별도 경로로
  # 업로드된다 (헤더 "출력 해석" 절 참조). 신선도는 아래 **배포 URL 번들 검증**
  # (build_commit == 대상 SHA) 과 Source commit 검증이 보장한다 — 0 files 여부로
  # 재배포하지 말 것.
  PAGES_OUT="$(npx wrangler pages deploy dist/ --project-name=search-engine-api --branch="$PAGES_BRANCH" --commit-dirty=true 2>&1)"
  if printf '%s\n' "$PAGES_OUT" | grep -qE '✨ Success|Deployment complete'; then
    PAGES_DEPLOYED=1
    echo "   ✓ Pages 배포 성공"
    if printf '%s\n' "$PAGES_OUT" | grep -q 'Uploaded 0 files'; then
      echo "   (정적 에셋 3개 불변 — 'Uploaded 0 files'는 정상. _worker.js 번들은 별도 업로드, 스테일 아님)"
    fi
    printf '%s\n' "$PAGES_OUT" | grep -E '✨ Success|Deployment complete|pages.dev' || true

    # ── 배포 URL 번들 검증 (수정 56) ───────────────────────────────────
    # 방금 만들어진 배포 URL(고유 해시)의 /api/health build_commit 이 대상
    # 커밋과 일치하는지 확인한다 — 정적 에셋 카운트와 무관하게 **배포된
    # 번들이 실제로 새 코드를 담는지** 런타임에서 증명한다. main URL 은
    # 라우팅/캐시로 이전 배포를 가리킬 수 있으므로 반드시 배포 URL 을 쓴다.
    PAGES_DEPLOY_URL="$(printf '%s\n' "$PAGES_OUT" | grep -oE 'https://[a-z0-9]+\.search-engine-api\.pages\.dev' | head -1)"
    if [ -n "$PAGES_DEPLOY_URL" ]; then
      BUNDLE_COMMIT="$(curl -s -m 20 "$PAGES_DEPLOY_URL/api/health" | python3 -c 'import json,sys
h=json.load(sys.stdin)
print(h.get("build_commit",""))' 2>/dev/null || echo '')"
      if [ "$BUNDLE_COMMIT" = "$FULL_SHA" ]; then
        PAGES_BUNDLE_OK=1
        echo "   ✅ 번들 커밋 검증: $PAGES_DEPLOY_URL → build_commit=$SHORT_SHA (배포된 번들이 대상 커밋 포함)"
      else
        PAGES_BUNDLE_OK=0
        echo " ❌ 번들 커밋 불일치: 배포 URL build_commit='${BUNDLE_COMMIT:-비어있음}' vs 대상 $SHORT_SHA" >&2
        echo "    배포된 번들이 스테일일 수 있습니다 — deployment list Source 와 대조 후 재배포 권장." >&2
        if [ "$AUTO_ROLLBACK" = "1" ]; then
          ROLLBACK_PENDING=1
          echo "    --auto-rollback: DO + Pages 를 이전 버전으로 되돌립니다 (cron/검증 생략, 아래)." >&2
        fi
      fi
    else
      echo " ⚠️  배포 URL 추출 실패 — 번들 커밋 검증 생략 (수동: wrangler pages deployment list)" >&2
    fi
  else
    echo " ❌ Pages 배포 실패 — DO는 새 버전($SHORT_SHA), Pages는 이전 버전 유지 (부분 배포)." >&2
    printf '%s\n' "$PAGES_OUT" | tail -20 >&2
  fi
fi

# ── ③ cron 스케줄러 배포 ────────────────────────────────────────────────
# 번들 커밋 불일치 + auto-rollback 이면 cron 은 배포하지 않는다 — DO/Pages 를
# 이전 버전으로 되돌릴 예정이므로 새 버전 cron 을 남기면 오히려 정합이 깨진다.
if [ "$PAGES_DEPLOYED" = "1" ] && [ "$ROLLBACK_PENDING" = "0" ]; then
  echo " [5/6] ③ cron 스케줄러 배포 ($CRON_CONFIG)"
  if npx wrangler deploy --config="$CRON_CONFIG" 2>&1 | grep -E 'Uploaded|Current Version ID'; then
    CRON_DEPLOYED=1
    echo "   ✓ cron 배포 성공"
  else
    echo " ❌ cron 배포 실패 — DO+Pages는 배포됨, cron만 이전 버전 (부분 배포)." >&2
  fi
fi

# ── Source commit 검증 (Pages가 배포된 경우에만 — 롤백 예정이면 생략) ────
PAGES_COMMIT_OK=0
GOLD_OK=0
if [ "$PAGES_DEPLOYED" = "1" ] && [ "$ROLLBACK_PENDING" = "0" ]; then
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
  # 실패 시 Slack 알림 (EQ_NOTIFY=1 기본): 런타임 동치(헬스/검색/gold) 실패 항목을
  # Slack danger 알림으로 보낸다 — SLACK_WEBHOOK 또는 ALERT_SLACK_WEBHOOK 환경변수
  # 필요 (미설정이면 no-op). 커밋 불일치 단독은 staging 배포 직후 production
  # 미배포의 정상 상태라 알림 제외. EQ_NOTIFY=0 으로 생략 가능. 동치 대조 실패는
  # 배포 자체를 실패시키지 않는다 (경고만 — CI post-deploy 게이트와 달리 로컬
  # 배포는 배포 성공을 우선).
  if [ "${EQ_CHECK:-1}" = "1" ] && [ "$ENV_NAME" = "staging" ]; then
    echo " staging ↔ production 동치 대조"
    if EQ_NOTIFY="${EQ_NOTIFY:-1}" bash "$REPO_ROOT/scripts/verify-env-equivalence.sh"; then
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
  if [ "$PAGES_BUNDLE_OK" = "1" ]; then
    echo "   번들 커밋 검증: ✅ 배포 URL 의 번들이 $SHORT_SHA 포함"
  elif [ "$PAGES_BUNDLE_OK" = "0" ]; then
    echo "   번들 커밋 검증: ❌ 불일치 (아래 참조) — 배포는 완료됐지만 배포 URL 번들이 스테일일 수 있음"
  fi
  echo "   로그: npx wrangler tail ssak-do-worker --config wrangler.do.jsonc"
elif [ "$ROLLBACK_PENDING" = "1" ]; then
  echo " ⚠️  번들 커밋 불일치 — DO + Pages 를 이전 버전으로 되돌립니다 (아래)"
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

# ── 롤백 헬퍼: DO 를 배포 직전 버전으로 (wrangler rollback) ───────────────
# 배포 전에 캡처한 PREV_DO_VERSION (배포 직전 최신 = 이번 배포의 '이전').
rollback_do() {
  local reason="$1"
  if [ -n "${PREV_DO_VERSION:-}" ]; then
    if npx wrangler rollback "$PREV_DO_VERSION" --config=wrangler.do.jsonc \
      -m "auto-rollback by deploy-local-worktree.sh: $reason ($SHORT_SHA → $ENV_NAME)" 2>&1 | tail -3; then
      DO_ROLLED_BACK=1
      echo " ✅ DO 롤백 완료 → ${PREV_DO_VERSION}"
      return 0
    fi
    echo " ❌ DO 롤백 실패 — 수동 롤백 필요: npx wrangler rollback $PREV_DO_VERSION --config=wrangler.do.jsonc" >&2
    return 1
  fi
  echo " ⚠️  이전 DO 버전을 확인하지 못해 자동 롤백 생략 — 수동: npx wrangler rollback --config=wrangler.do.jsonc" >&2
  return 1
}

# ── 롤백 헬퍼: Pages 를 이전 배포로 (공식 Rollback API, 수정 61) ────────────
# POST /accounts/{acct}/pages/projects/{proj}/deployments/{target}/rollback —
# 대시보드 'Rollback to this deployment' 와 동일한 엔드포인트. target 은 이번
# 배포 직전의 동일 브랜치 배포 ID (PREV_PAGES_ID). 토큰은 CLOUDFLARE_API_TOKEN
# 우선, 없으면 wrangler OAuth 토큰(~/.wrangler/config/default.toml oauth_token —
# pages:write 스코프 포함). Cloudflare 제약상 **production(브랜치 main) 배포만**
# Rollback 대상 (preview/staging 은 불가 — 'preview deployments are not valid
# rollback targets'). 호출부에서 production 전용으로 게이트한다.
rollback_pages() {
  local target="$1"
  local token="${CLOUDFLARE_API_TOKEN:-}"
  local acct="${CLOUDFLARE_ACCOUNT_ID:-}"
  if [ -z "$token" ]; then
    token="$(sed -n 's/^[[:space:]]*oauth_token[[:space:]]*=[[:space:]]*"\([^"]*\)".*/\1/p' "$HOME/.wrangler/config/default.toml" 2>/dev/null | head -1)"
  fi
  if [ -z "$acct" ]; then
    acct="$(npx wrangler whoami 2>/dev/null | grep -oE '[0-9a-f]{32}' | head -1)"
  fi
  if [ -z "$token" ] || [ -z "$acct" ]; then
    echo " ⚠️  Pages 롤백에 필요한 인증 정보 없음 (CLOUDFLARE_API_TOKEN/CLOUDFLARE_ACCOUNT_ID 또는 wrangler OAuth) — 수동 롤백 필요:" >&2
    echo "    curl -X POST \"https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/pages/projects/search-engine-api/deployments/$target/rollback\" \" -H 'Authorization: Bearer <TOKEN>'" >&2
    echo "    (또는 대시보드: Deployments → 해당 배포 ⋯ → Rollback to this deployment)" >&2
    return 1
  fi
  local resp
  resp="$(curl -s -m 30 -X POST "https://api.cloudflare.com/client/v4/accounts/$acct/pages/projects/search-engine-api/deployments/$target/rollback" \
    -H "Authorization: Bearer $token" -H 'Content-Type: application/json' 2>&1 || true)"
  if printf '%s' "$resp" | grep -q '"success"[[:space:]]*:[[:space:]]*true'; then
    echo " ✅ Pages 롤백 완료 → $target (이전 배포로 production 전환)"
    return 0
  fi
  echo " ❌ Pages 롤백 실패: $(printf '%s' "$resp" | head -c 300)" >&2
  return 1
}

# ── --auto-rollback ①: Pages 배포 실패 → DO 만 이전 버전으로 ───────────────
# 정합 불일치(DO=새 버전, Pages=이전)일 때만 롤백이 옳다 — cron 실패(DO+Pages
# 일치)나 DO 실패(아무것도 배포 안 됨)에서는 롤백하지 않는다.
DO_ROLLED_BACK=0
PAGES_ROLLED_BACK=0
if [ "$AUTO_ROLLBACK" = "1" ] && [ "$DO_DEPLOYED" = "1" ] && [ "$PAGES_DEPLOYED" = "0" ]; then
  echo ""
  echo " [자동 롤백] Pages 배포 실패 → DO 를 이전 버전으로 되돌립니다"
  rollback_do "Pages deploy failed"
fi

# ── --auto-rollback ②: 번들 커밋 불일치 → DO + Pages 를 이전 버전으로 (수정 61) ──
# DO+Pages 는 새 버전인데 배포 URL 번들이 대상 커밋을 담지 않음(스테일) — 두
# 컴포넌트 모두 이전 버전으로 되돌린다. Pages 롤백은 production(Rollback API
# 대상)만 자동 — staging(preview) 은 Cloudflare 제약상 불가라 재배포를 안내한다.
if [ "$AUTO_ROLLBACK" = "1" ] && [ "$ROLLBACK_PENDING" = "1" ]; then
  echo ""
  echo " [자동 롤백] 번들 커밋 불일치 (배포 URL 번들이 $SHORT_SHA 미포함) → DO + Pages 를 이전 버전으로 되돌립니다"
  rollback_do "bundle commit mismatch"
  if [ "$ENV_NAME" = "production" ]; then
    if [ -n "${PREV_PAGES_ID:-}" ]; then
      rollback_pages "$PREV_PAGES_ID" && PAGES_ROLLED_BACK=1
    else
      echo " ⚠️  이전 Pages 배포 ID 를 확인하지 못해 Pages 롤백 생략 — 수동: 대시보드 Deployments → Rollback" >&2
    fi
  else
    echo " ⚠️  staging(preview) 은 Pages Rollback 대상 불가 (Cloudflare 제약 — 'preview deployments are not valid rollback targets') — Pages 는 스테일 배포 유지:" >&2
    echo "    올바른 번들로 재배포: bash scripts/deploy-local-worktree.sh $SHORT_SHA staging (스테일 원인: 빌드 캐시 의심 → ISOLATED_BUILD=1 권장)" >&2
  fi
fi

# ── GOLD_FAIL_HARD=1 이고 gold 미회수가 지속된 경우 최종 보고 ─────────────
if [ "${GOLD_FAIL_HARD_FAILED:-0}" = "1" ]; then
  echo " ❌ 검증 게이트 실패: gold 미회수 지속 (GOLD_FAIL_HARD=1) — 배포 자체는 완료됐지만"
  echo "    라이브 검색이 gold 도메인을 회수하지 못해 실패 처리합니다."
  echo "    원인(백엔드 서킷/업스트림) 조사 후 재실행: bash scripts/deploy-local-worktree.sh $SHORT_SHA $ENV_NAME"
fi

# ── exit code: 부분 배포(실패 단계 존재) / gold 미회수 지속(GOLD_FAIL_HARD) /
#    번들 커밋 불일치(배포 URL 이 대상 커밋 미포함) 이면 1 ──
# PAGES_BUNDLE_OK=2(검증 생략)는 실패 아님 — URL 미추출(셀프테스트/이상 출력) 시
# 배포 자체는 성공 처리한다.
if [ "$DO_DEPLOYED" = "0" ] || [ "$PAGES_DEPLOYED" = "0" ] || [ "$CRON_DEPLOYED" = "0" ] || [ "${GOLD_FAIL_HARD_FAILED:-0}" = "1" ] || [ "$PAGES_BUNDLE_OK" = "0" ]; then
  exit 1
fi
exit 0
