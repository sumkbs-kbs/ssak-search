#!/bin/bash
# ============================================================
# Cloudflare Dashboard 설정 검증 스크립트
# ============================================================
# 
# 사용법: bash verify-setup.sh [BASE_URL]
#
# ============================================================

BASE_URL="${1:-http://localhost:8788}"

echo "=========================================="
echo "Cloudflare Dashboard 설정 검증"
echo "=========================================="
echo ""
echo "대상 URL: $BASE_URL"
echo ""

# 색상 정의
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

PASS=0
WARN=0
FAIL=0

# 함수
pass() { echo -e "${GREEN}✓ PASS${NC} $1"; ((PASS++)); }
warn() { echo -e "${YELLOW}⚠ WARN${NC} $1"; ((WARN++)); }
fail() { echo -e "${RED}✗ FAIL${NC} $1"; ((FAIL++)); }

# 1. API 접근 가능
echo "[1/7] API 접근 가능..."
HTTP=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health" 2>/dev/null || echo "000")
if [ "$HTTP" = "200" ] || [ "$HTTP" = "404" ]; then
    pass "API 접근 가능 (HTTP $HTTP)"
else
    fail "API 접근 불가 (HTTP $HTTP)"
fi

# 2. 헬스 체크
echo "[2/7] 헬스 체크..."
HEALTH=$(curl -s "$BASE_URL/api/health" 2>/dev/null || echo "{}")
if echo "$HEALTH" | grep -q '"status"'; then
    pass "헬스 체크 응답 정상"
else
    fail "헬스 체크 응답 비정상"
fi

# 3. CRAWLER_DO 기능
echo "[3/7] CRAWLER_DO 기능..."
CRAWLER=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/crawl/status" 2>/dev/null || echo "000")
if [ "$CRAWLER" = "200" ]; then
    pass "CRAWLER_DO 동작 (HTTP $CRAWLER)"
elif [ "$CRAWLER" = "501" ]; then
    warn "CRAWLER_DO 미설정 (501)"
else
    fail "CRAWLER_DO 오류 (HTTP $CRAWLER)"
fi

# 4. INDEX_QUEUE 기능
echo "[4/7] INDEX_QUEUE 기능..."
INDEX=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/index/stats" 2>/dev/null || echo "000")
if [ "$INDEX" = "200" ]; then
    pass "INDEX_QUEUE 동작 (HTTP $INDEX)"
elif [ "$INDEX" = "501" ]; then
    warn "INDEX_QUEUE 미설정 (501)"
else
    fail "INDEX_QUEUE 오류 (HTTP $INDEX)"
fi

# 5. D1 연결
echo "[5/7] D1 데이터베이스 연결..."
D1=$(curl -s "$BASE_URL/api/index/stats" 2>/dev/null | grep -o '"d1":[^,]*' || echo '"d1":false')
if echo "$D1" | grep -q '"d1":true'; then
    pass "D1 연결됨"
else
    warn "D1 미연결"
fi

# 6. Vectorize 연결
echo "[6/7] Vectorize 연결..."
VEC=$(curl -s "$BASE_URL/api/index/stats" 2>/dev/null | grep -o '"vectorize":[^,]*' || echo '"vectorize":false')
if echo "$VEC" | grep -q '"vectorize":true'; then
    pass "Vectorize 연결됨"
else
    warn "Vectorize 미연결"
fi

# 7. 시드 URL 테스트
echo "[7/7] 시드 URL 테스트..."
SEED=$(curl -s -X POST "$BASE_URL/api/crawl" \
    -H "Content-Type: application/json" \
    -d '{"urls": ["https://example.com"]}' 2>/dev/null || echo "{}")
if echo "$SEED" | grep -q '"added"'; then
    ADDED=$(echo "$SEED" | grep -o '"added":[^,]*' | cut -d: -f2 | tr -d ' ')
    if [ "$ADDED" -gt 0 ] 2>/dev/null; then
        pass "시드 URL 추가 성공 ($ADDED 개)"
    else
        warn "시드 URL 추가 실패"
    fi
else
    warn "시드 URL 테스트 스킵"
fi

# 결과 요약
echo ""
echo "=========================================="
echo "검증 결과: PASS=$PASS / WARN=$WARN / FAIL=$FAIL"
echo "=========================================="

if [ $FAIL -gt 0 ]; then
    echo -e "${RED}실패: $FAIL개 항목${NC}"
    exit 1
elif [ $WARN -gt 0 ]; then
    echo -e "${YELLOW}경고: $WARN개 항목 (설정 필요)${NC}"
    exit 0
else
    echo -e "${GREEN}성공: 모든 항목 통과${NC}"
    exit 0
fi
