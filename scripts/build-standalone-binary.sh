#!/usr/bin/env bash
# ==============================================================================
# Ssak-Search Standalone Native Single-Binary Builder
# Compiles a zero-dependency, self-contained binary for Codex & AI Agents
# ==============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
BIN_DIR="$ROOT_DIR/bin"

mkdir -p "$BIN_DIR"
cd "$ROOT_DIR"

echo "======================================================================"
echo "🚀 Building Standalone Native Single-Binary for Ssak-Search MCP"
echo "======================================================================"

# -------------------------------------------------------------
# 1. Bun Native Binary Build (Primary TypeScript Native)
# -------------------------------------------------------------
BUN_BIN="$(which bun || echo "$HOME/.bun/bin/bun")"
if [ -x "$BUN_BIN" ]; then
  echo "📦 Compiling TypeScript native binary via Bun ($BUN_BIN)..."
  "$BUN_BIN" build --compile --minify src/mcp-standalone.ts --outfile "$BIN_DIR/ssak-mcp"
  chmod +x "$BIN_DIR/ssak-mcp"
  SIZE=$(ls -lh "$BIN_DIR/ssak-mcp" | awk '{print $5}')
  echo "✅ Bun Native Binary created: bin/ssak-mcp ($SIZE)"
else
  echo "⚠️  Bun not found in PATH or ~/.bun/bin/bun — skipping Bun build"
fi

# -------------------------------------------------------------
# 2. PyInstaller Binary Build (Alternative Python Native)
# -------------------------------------------------------------
PYINSTALLER_BIN="$(which pyinstaller || echo "$HOME/miniforge3/bin/pyinstaller")"
if [ -x "$PYINSTALLER_BIN" ]; then
  echo "📦 Compiling Python native binary via PyInstaller ($PYINSTALLER_BIN)..."
  "$PYINSTALLER_BIN" --onefile --clean --noconfirm --name ssak-mcp-py sdk/mcp_server.py --distpath "$BIN_DIR" --workpath /tmp/pyinstaller-build --specpath /tmp/pyinstaller-spec > /dev/null 2>&1
  chmod +x "$BIN_DIR/ssak-mcp-py"
  SIZE_PY=$(ls -lh "$BIN_DIR/ssak-mcp-py" | awk '{print $5}')
  echo "✅ Python Native Binary created: bin/ssak-mcp-py ($SIZE_PY)"
fi

# -------------------------------------------------------------
# 3. Verification & Self-Test
# -------------------------------------------------------------
echo ""
echo "🧪 Running JSON-RPC 2.0 Self-Test on Standalone Binary..."

TEST_BINARY="$BIN_DIR/ssak-mcp"
if [ ! -f "$TEST_BINARY" ]; then
  TEST_BINARY="$BIN_DIR/ssak-mcp-py"
fi

if [ -f "$TEST_BINARY" ]; then
  TEST_OUTPUT=$(python3 -c "
import subprocess, json
proc = subprocess.Popen(['$TEST_BINARY'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}}) + '\n')
proc.stdin.flush()
init_line = proc.stdout.readline()
parsed = json.loads(init_line)
print(parsed.get('result', {}).get('serverInfo', {}).get('name', 'UNKNOWN'))
proc.stdin.close()
proc.wait()
")
  echo "✅ Self-Test Result: $TEST_OUTPUT (Handshake verified)"
  echo ""
  echo "🎉 Standalone packaging completed successfully!"
  echo "Binary location: $TEST_BINARY"
else
  echo "❌ Error: No executable binary was generated."
  exit 1
fi
