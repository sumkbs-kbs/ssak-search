#!/bin/bash
# 로컬 인덱싱 환경 설정 스크립트

set -e

echo "🔧 로컬 인덱싱 환경 설정"
echo "================================"
echo ""

# 1. Python 의존성 확인
echo "1. Python 의존성 확인..."
if ! command -v python3 &> /dev/null; then
    echo "❌ Python3 미설치"
    exit 1
fi
echo "   ✅ Python3: $(python3 --version)"

# 2. 필수 패키지 설치
echo ""
echo "2. 필수 패키지 설치..."
pip3 install requests 2>/dev/null || pip install requests 2>/dev/null
echo "   ✅ requests 패키지 설치 완료"

# 3. Ollama 확인
echo ""
echo "3. Ollama 확인..."
if ! command -v ollama &> /dev/null; then
    echo "❌ Ollama 미설치"
    echo "   설치: https://ollama.ai"
    exit 1
fi
echo "   ✅ Ollama: $(which ollama)"

# 4. nomic-embed-text 모델 확인
echo ""
echo "4. 임베딩 모델 확인..."
if ollama list 2>/dev/null | grep -q "nomic-embed-text"; then
    echo "   ✅ nomic-embed-text 모델 설치됨"
else
    echo "   ⚠️ nomic-embed-text 모델 미설치"
    echo "   설치 중..."
    ollama pull nomic-embed-text
    echo "   ✅ 모델 설치 완료"
fi

# 5. ChromaDB 확인
echo ""
echo "5. ChromaDB 확인..."
if ! command -v chroma &> /dev/null; then
    echo "❌ ChromaDB 미설치"
    echo "   설치: pip3 install chromadb"
    exit 1
fi
echo "   ✅ ChromaDB: $(which chroma)"

# 6. ChromaDB 시작
echo ""
echo "6. ChromaDB 서비스 시작..."
if curl -s http://localhost:8000/api/v2/heartbeat > /dev/null 2>&1; then
    echo "   ✅ ChromaDB 이미 실행 중"
else
    mkdir -p ./local-index/chroma-data
    nohup chroma run --path ./local-index/chroma-data > /tmp/chroma.log 2>&1 &
    sleep 3
    if curl -s http://localhost:8000/api/v2/heartbeat > /dev/null 2>&1; then
        echo "   ✅ ChromaDB 시작됨 (포트: 8000)"
    else
        echo "   ⚠️ ChromaDB 시작 실패 (로그: /tmp/chroma.log)"
    fi
fi

# 7. Ollama 서비스 확인
echo ""
echo "7. Ollama 서비스 확인..."
if curl -s http://localhost:11434/api/tags > /dev/null 2>&1; then
    echo "   ✅ Ollama 서비스 실행 중"
else
    echo "   ⚠️ Ollama 미실행"
    echo "   실행: ollama serve"
fi

# 8. 디렉토리 구조 생성
echo ""
echo "8. 디렉토리 구조 생성..."
mkdir -p ./local-index/data
mkdir -p ./local-index/logs
echo "   ✅ 디렉토리 생성 완료"

# 완료
echo ""
echo "================================"
echo "✅ 설정 완료!"
echo ""
echo "📌 사용법:"
echo "   # 인덱싱"
echo "   python3 scripts/local-index.py --category=tech-docs --limit=10"
echo ""
echo "   # 검색"
echo "   python3 scripts/local-search.py --search='react hooks'"
echo ""
echo "   # 통계"
echo "   python3 scripts/local-index.py --stats"
echo ""
echo "   # Cloudflare 동기화"
echo "   python3 scripts/sync-to-cloudflare.py --api-key=YOUR_KEY --urls=URL1 URL2"
