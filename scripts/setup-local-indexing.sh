#!/bin/bash
# ============================================================
# 로컬 인덱싱 환경 설정 스크립트
# ============================================================
#
# ChromaDB + Ollama를 사용한 완전 로컬 인덱싱 환경 구축
#
# 사용법:
#   chmod +x scripts/setup-local-indexing.sh
#   ./scripts/setup-local-indexing.sh
#
# ============================================================

set -e

# 색상 정의
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

info() { echo -e "${BLUE}[INFO]${NC} $1"; }
ok() { echo -e "${GREEN}[OK]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
err() { echo -e "${RED}[ERROR]${NC} $1"; }

echo ""
echo -e "${BLUE}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${BLUE}║${NC}     🏠 로컬 인덱싱 환경 설정                     ${BLUE}║${NC}"
echo -e "${BLUE}║${NC}     ChromaDB + Ollama (무료, 오프라인)          ${BLUE}║${NC}"
echo -e "${BLUE}╚══════════════════════════════════════════════════╝${NC}"
echo ""

# ── Step 1: Docker 확인 ──
info "Step 1: Docker 확인..."
if command -v docker &> /dev/null; then
    ok "Docker 설치됨"
else
    err "Docker가 설치되어 있지 않습니다."
    echo "  설치 방법: https://docs.docker.com/get-docker/"
    exit 1
fi

# ── Step 2: Ollama 확인 ──
info "Step 2: Ollama 확인..."
if command -v ollama &> /dev/null; then
    ok "Ollama 설치됨"
else
    warn "Ollama가 설치되어 있지 않습니다."
    echo "  설치 방법: brew install ollama (macOS)"
    echo "  또는: curl -fsSL https://ollama.com/install.sh | sh (Linux)"
    echo ""
    read -p "Ollama를 설치하시겠습니까? (y/n): " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        if [[ "$OSTYPE" == "darwin"* ]]; then
            brew install ollama
        else
            curl -fsSL https://ollama.com/install.sh | sh
        fi
    else
        err "Ollama 없이 로컬 인덱싱을 사용할 수 없습니다."
        exit 1
    fi
fi

# ── Step 3: ChromaDB 시작 ──
info "Step 3: ChromaDB 시작..."
if docker ps | grep -q chromadb; then
    ok "ChromaDB 이미 실행 중"
else
    info "ChromaDB 컨테이너 시작 중..."
    docker run -d \
        --name chromadb \
        -p 8000:8000 \
        -v chromadb-data:/chroma/chroma \
        chromadb/chroma
    
    # 시작 대기
    info "ChromaDB 시작 대기 중..."
    for i in {1..30}; do
        if curl -s http://localhost:8000/api/v1/heartbeat > /dev/null 2>&1; then
            ok "ChromaDB 시작 완료"
            break
        fi
        sleep 1
    done
fi

# ── Step 4: Ollama 서버 시작 ──
info "Step 4: Ollama 서버 시작..."
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    ok "Ollama 서버 이미 실행 중"
else
    info "Ollama 서버 시작 중..."
    ollama serve &>/tmp/ollama-server.log &
    OLLAMA_PID=$!
    
    # 시작 대기
    for i in {1..30}; do
        if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
            ok "Ollama 서버 시작 완료 (PID: $OLLAMA_PID)"
            break
        fi
        sleep 1
    done
fi

# ── Step 5: 임베딩 모델 다운로드 ──
info "Step 5: 임베딩 모델 다운로드..."
if ollama list | grep -q "nomic-embed-text"; then
    ok "임베딩 모델 이미 설치됨"
else
    info "nomic-embed-text 모델 다운로드 중... (270MB)"
    ollama pull nomic-embed-text
    ok "임베딩 모델 다운로드 완료"
fi

# ── Step 6: 연결 테스트 ──
info "Step 6: 연결 테스트..."

# ChromaDB 테스트
if curl -s http://localhost:8000/api/v1/heartbeat > /dev/null 2>&1; then
    ok "ChromaDB 연결 성공"
else
    err "ChromaDB 연결 실패"
    exit 1
fi

# Ollama 테스트
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    ok "Ollama 연결 성공"
else
    err "Ollama 연결 실패"
    exit 1
fi

# 임베딩 테스트
info "임베딩 생성 테스트..."
EMBEDDING_response=$(curl -s http://localhost:11434/api/embeddings \
    -d '{"model": "nomic-embed-text", "prompt": "test"}' 2>&1)

if echo "$EMBEDDING_response" | grep -q "embedding"; then
    ok "임베딩 생성 성공"
else
    err "임베딩 생성 실패"
    exit 1
fi

# ── 완료 ──
echo ""
echo -e "${GREEN}╔══════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║${NC}     ✅ 로컬 인덱싱 환경 설정 완료!               ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  ChromaDB: http://localhost:8000               ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  Ollama:   http://localhost:11434              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}                                              ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}  다음 단계:                                   ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    npm run local:index                        ${GREEN}║${NC}"
echo -e "${GREEN}║${NC}    npm run local:search                       ${GREEN}║${NC}"
echo -e "${GREEN}╚══════════════════════════════════════════════════╝${NC}"
echo ""
