#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════
# 로컬 개발 서버 실행 스크립트
# ═══════════════════════════════════════════════════════════════
#
# 사용법:
#   chmod +x scripts/start-local.sh
#   ./scripts/start-local.sh              # 기본 실행
#   ./scripts/start-local.sh --no-ollama  # Ollama 없이 실행
#   ./scripts/start-local.sh --dev        # vite dev 서버 (HMR)
#
# 이 스크립트는:
#   1. .env 파일 로드
#   2. Ollama 실행 상태 확인 (선택)
#   3. 빌드 + 프리뷰 서버 시작
#   4. 종료 시 Ollama 정리
# ═══════════════════════════════════════════════════════════════

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

# ──颜色 ──
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

info()  { echo -e "${BLUE}[INFO]${NC} $1"; }
ok()    { echo -e "${GREEN}[OK]${NC} $1"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $1"; }
err()   { echo -e "${RED}[ERROR]${NC} $1"; }

# ── 인자 파싱 ──
NO_OLLAMA=false
DEV_MODE=false
for arg in "$@"; do
  case "$arg" in
    --no-ollama) NO_OLLAMA=true ;;
    --dev) DEV_MODE=true ;;
    *) warn "알 수 없는 인자: $arg (무시됨)" ;;
  esac
done

# ── 배너 ──
echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}     🔍 Search Engine API — 로컬 실행          ${BLUE}║${NC}"
echo -e "${BLUE}║${NC}     무료 + 오프라인 + 나만의 검색 에이전트   ${BLUE}║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: .env 파일 로드 ──
if [ -f ".env" ]; then
  info ".env 파일 로드 중..."
  set -a
  source .env
  set +a
  ok ".env 파일 로드 완료"
else
  warn ".env 파일이 없습니다. .env.example을 복사하세요:"
  warn "  cp .env.example .env"
  warn "기본 설정으로 계속합니다."
fi

# ── Step 2: Ollama 확인 (선택) ──
if [ "$NO_OLLAMA" = false ]; then
  if [ -z "${OLLAMA_BASE_URL:-}" ]; then
    warn "OLLAMA_BASE_URL이 설정되지 않았습니다."
    warn "Ollama를 사용하려면 .env 파일에 다음을 추가하세요:"
    warn "  OLLAMA_BASE_URL=http://localhost:11434"
    warn "또는 --no-ollama 플래그로 건너뜁니다."
    echo ""
  else
    info "Ollama 연결 확인 중... (${OLLAMA_BASE_URL})"

    # Ollama 서버 실행 확인
    if command -v ollama &> /dev/null; then
      OLLAMA_RUNNING=false
      if curl -s "$OLLAMA_BASE_URL/api/tags" &>/dev/null; then
        OLLAMA_RUNNING=true
        ok "Ollama 서버 실행 중"
      fi

      if [ "$OLLAMA_RUNNING" = false ]; then
        info "Ollama 서버 시작 중..."
        ollama serve &>/tmp/ollama-server.log &
        OLLAMA_PID=$!

        # Ollama 준비될 때까지 대기 (최대 10초)
        for i in {1..10}; do
          if curl -s "$OLLAMA_BASE_URL/api/tags" &>/dev/null; then
            OLLAMA_RUNNING=true
            ok "Ollama 서버 시작 완료 (PID: $OLLAMA_PID)"
            break
          fi
          sleep 1
        done

        if [ "$OLLAMA_RUNNING" = false ]; then
          warn "Ollama 서버 시작 실패. 로그 확인: /tmp/ollama-server.log"
          warn "수동으로 실행: ollama serve"
        fi
      fi

      # 설치된 모델 목록 표시
      if [ "$OLLAMA_RUNNING" = true ]; then
        MODELS=$(curl -s "$OLLAMA_BASE_URL/api/tags" 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    models = [m['name'] for m in data.get('models', [])]
    for m in models:
        print(f'  • {m}')
except: pass
" 2>/dev/null || echo "  (모델 목록을 불러올 수 없음)")

        if [ -n "$MODELS" ]; then
          info "설치된 Ollama 모델:"
          echo "$MODELS"

          # 임베딩 모델(nomic-embed-text) 확인 — 자체 인덱스 검색에 필수
          if echo "$MODELS" | grep -qi "nomic-embed-text"; then
            ok "임베딩 모델(nomic-embed-text) 확인됨 — 자체 인덱스 검색 사용 가능"
          else
            warn "임베딩 모델(nomic-embed-text)이 없습니다."
            warn "자체 인덱스(Vectorize + D1) 검색이 hash fallback으로 동작합니다."
            warn "설치: ollama pull nomic-embed-text   (~270MB)"
          fi
        else
          warn "설치된 Ollama 모델이 없습니다."
          warn "답변 생성: ollama pull hf.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive:Q6_K_P"
          warn "임베딩:    ollama pull nomic-embed-text"
        fi
      fi
    else
      warn "Ollama가 설치되어 있지 않습니다."
      warn "설치: brew install ollama"
      warn "또는 --no-ollama 플래그로 건너뜁니다."
    fi
    echo ""
  fi
else
  info "--no-ollama 플래그로 Ollama 확인 생략"
  echo ""
fi

# ── Step 3: SearXNG 확인 ──
if [ -n "${SEARXNG_URL:-}" ]; then
  info "SearXNG 연결 확인 중... (${SEARXNG_URL})"
  if curl -s "${SEARXNG_URL}/health" &>/dev/null; then
    ok "SearXNG 연결 성공"
  else
    warn "SearXNG에 연결할 수 없습니다. 검색은 기존 백엔드로 동작합니다."
  fi
  echo ""
fi

# ── Step 4: 의존성 확인 ──
if [ ! -d "node_modules" ]; then
  info "npm 의존성 설치 중..."
  npm install
  ok "의존성 설치 완료"
fi

# ── Step 4.5: DO 워커 기동 ──
# Pages 워커가 Durable Object를 script_name: ssak-do-worker 로 참조하므로
# 로컬에서도 DO 워커가 dev registry에 등록되어 있어야 /api/* 가 500 없이 동작한다.
DO_WORKER_PID=""
if lsof -i :8787 -sTCP:LISTEN &>/dev/null; then
  ok "DO 워커가 이미 8787 포트에서 실행 중"
else
  if [ ! -f "wrangler.do.jsonc" ]; then
    warn "wrangler.do.jsonc 없음 — DO 바인딩이 필요한 엔드포인트(/api/health 등)에서 500 발생 가능"
  else
    info "DO 워커(ssak-do-worker) 시작 중... (포트 8787)"
    nohup npx wrangler dev -c wrangler.do.jsonc --port 8787 >/tmp/ssak-do-worker.log 2>&1 &
    DO_WORKER_PID=$!
    for _ in $(seq 1 20); do
      if lsof -i :8787 -sTCP:LISTEN &>/dev/null; then
        ok "DO 워커 시작 완료 (PID: $DO_WORKER_PID, 로그: /tmp/ssak-do-worker.log)"
        break
      fi
      sleep 1
    done
    if [ -n "$DO_WORKER_PID" ] && ! lsof -i :8787 -sTCP:LISTEN &>/dev/null; then
      warn "DO 워커 시작 확인 실패 — 로그 확인: /tmp/ssak-do-worker.log"
    fi
    echo ""
  fi
fi

# ── Step 5: 서버 시작 ──
if [ "$DEV_MODE" = true ]; then
  info "Vite Dev Server 시작 (HMR 지원)..."
  echo ""
  echo -e "${GREEN}  → http://localhost:5173${NC}"
  echo -e "${GREEN}  → http://localhost:5173/api/health${NC}"
  echo ""
  npm run dev
else
  info "빌드 중..."
  npm run build 2>&1 | tail -1
  ok "빌드 완료"

  echo ""
  echo -e "${GREEN}  ╔════════════════════════════════════════╗${NC}"
  echo -e "${GREEN}  ║${NC}      🚀  서버 실행 중!               ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}                                      ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}  메인 페이지:                         ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}    http://localhost:8788               ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}                                      ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}  API 엔드포인트:                       ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}    GET  /api/health    (상태 확인)    ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}    POST /api/search   (검색)         ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}    GET  /api/search/stream (스트리밍) ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}    POST /api/chat     (채팅)         ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}                                      ${GREEN}║${NC}"
  echo -e "${GREEN}  ║${NC}  종료: Ctrl+C                         ${GREEN}║${NC}"
  echo -e "${GREEN}  ╚════════════════════════════════════════╝${NC}"
  echo ""

  # ── 종료 시 정리 ──
  cleanup() {
    echo ""
    info "서버 종료 중..."
    if [ -n "${DO_WORKER_PID:-}" ]; then
      info "DO 워커 종료 중... (PID: $DO_WORKER_PID)"
      kill "$DO_WORKER_PID" 2>/dev/null || true
    fi
    if [ -n "${OLLAMA_PID:-}" ]; then
      info "Ollama 서버 종료 중... (PID: $OLLAMA_PID)"
      kill "$OLLAMA_PID" 2>/dev/null || true
    fi
    ok "종료 완료"
  }
  trap cleanup EXIT INT TERM

  npm run preview -- --port 8788
fi
