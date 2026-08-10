#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# do-worker secrets 설정 — S94 (P0-B, 2026-08-10)
#
# ssak-do-worker는 11개 DO 클래스를 실행한다 (S88 분리 배포). DO들이
# this.env에서 읽는 비밀값 4종이 Pages worker와 별도로 존재해야 한다:
#
#   GITHUB_TOKEN / GITHUB_REPO  — CanaryOrchestratorDO (canary 회귀 감지)
#   SLACK_WEBHOOK               — CanaryOrchestratorDO (알림)
#   BRAVE_API_KEY               — CrawlerDO (크롤링)
#
# 실측 (2026-08-10): `wrangler secret list --config wrangler.do.jsonc` = []
# — 4종 전부 미설정. canary/crawler가 키리스로 degraded 상태다.
#
# 사용법:
#   bash scripts/setup-do-worker-secrets.sh                 # 4종 대화형 입력
#   GITHUB_TOKEN=xxx bash scripts/setup-do-worker-secrets.sh --non-interactive
#   bash scripts/setup-do-worker-secrets.sh --verify        # 현재 상태만 확인
# ═══════════════════════════════════════════════════════════════
set -euo pipefail

CONFIG="--config=wrangler.do.jsonc"

if [[ "${1:-}" == "--verify" ]]; then
  echo "=== do-worker 현재 secrets ==="
  npx wrangler secret list $CONFIG
  exit 0
fi

declare -A SECRETS=(
  [GITHUB_TOKEN]="GitHub Personal Access Token (canary 이슈/PR 조회용, repo:read)"
  [GITHUB_REPO]="GitHub 저장소명 (예: sumkbs-kbs/ssak-search)"
  [SLACK_WEBHOOK]="Slack Incoming Webhook URL (백엔드 장애 알림)"
  [BRAVE_API_KEY]="Brave Search API 키 (크롤러 폴백 검색)"
)

for name in GITHUB_TOKEN GITHUB_REPO SLACK_WEBHOOK BRAVE_API_KEY; do
  prompt="${SECRETS[$name]}"
  if [[ -n "${!name:-}" ]]; then
    value="${!name}"
    echo "[env] $name (${prompt})"
  else
    read -rsp "$name — ${prompt}: " value
    echo
  fi
  if [[ -z "$value" ]]; then
    echo "  ⚠️ $name 비어있음 — 건너뜀 (나중에 wrangler secret put $CONFIG $name)"
    continue
  fi
  echo "$value" | npx wrangler secret put "$name" $CONFIG
done

echo
echo "=== 검증: do-worker secrets ==="
npx wrangler secret list $CONFIG
