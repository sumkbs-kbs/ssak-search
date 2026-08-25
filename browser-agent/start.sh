#!/bin/bash
# ssak-browser-agent 시작 — Chrome 실행 중일 때 사용 (127.0.0.1:8765)
set -e
cd "$(dirname "$0")"
TOKEN_FILE="$HOME/.ssak-search/browser-agent-token.txt"
if [ -f "$TOKEN_FILE" ]; then
  export BROWSER_AGENT_TOKEN="$(cat "$TOKEN_FILE")"
fi
if curl -s -m 3 http://127.0.0.1:8765/health > /dev/null 2>&1; then
  echo "이미 실행 중 ✓ (http://127.0.0.1:8765)"
  exit 0
fi
nohup node server.mjs >> /tmp/ssak-browser-agent.log 2>&1 &
sleep 2
curl -s -m 5 http://127.0.0.1:8765/health && echo && echo "시작 ✓ (PID $!)" || { echo "❌ 기동 실패 — Chrome 실행 상태 확인"; exit 1; }
