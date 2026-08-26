#!/bin/bash
cd "$(dirname "$0")"
export BROWSER_AGENT_TOKEN="$(cat "$HOME/.ssak-search/browser-agent-token.txt")"
exec "$(command -v node)" server.mjs
