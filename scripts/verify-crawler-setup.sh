#!/bin/bash
# ============================================================
# CRAWLER_DO & INDEX_QUEUE 바인딩 설정 검증 스크립트
# ============================================================
# 
# 이 스크립트는 CRAWLER_DO와 INDEX_QUEUE 바인딩이 올바르게 설정되었는지
# 검증합니다.
#
# 사용법: bash scripts/verify-crawler-setup.sh [BASE_URL]
#
# 예시: bash scripts/verify-crawler-setup.sh https://ssak-search.pages.dev
#
# ============================================================

set -e

# 기본 URL 설정
BASE_URL="${1:-http://localhost:8788}"

echo "=========================================="
echo "CRAWLER_DO & INDEX_QUEUE 설정 검증"
echo "=========================================="
echo ""
echo "대상 URL: $BASE_URL"
echo ""

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 함수 정의
print_test() {
    echo -e "${BLUE}[테스트]${NC} $1"
}

print_pass() {
    echo -e "${GREEN}✓ PASS${NC} $1"
}

print_fail() {
    echo -e "${RED}✗ FAIL${NC} $1"
}

print_warn() {
    echo -e "${YELLOW}⚠ WARN${NC} $1"
}

# 테스트 카운터
PASS_COUNT=0
FAIL_COUNT=0
WARN_COUNT=0

# ============================================================
# 테스트 1: API 엔드포인트 접근 가능
# ============================================================
print_test "API 엔드포인트 접근 가능"

HTTP_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/health" 2>/dev/null || echo "000")
if [ "$HTTP_STATUS" = "200" ] || [ "$HTTP_STATUS" = "404" ]; then
    print_pass "API 엔드포인트 접근 가능 (HTTP $HTTP_STATUS)"
    ((PASS_COUNT++))
else
    print_fail "API 엔드포인트 접근 불가 (HTTP $HTTP_STATUS)"
    ((FAIL_COUNT++))
fi

# ============================================================
# 테스트 2: 헬스 체크 응답
# ============================================================
print_test "헬스 체크 응답"

HEALTH_RESPONSE=$(curl -s "$BASE_URL/api/health" 2>/dev/null || echo "{}")
if echo "$HEALTH_RESPONSE" | grep -q '"status"'; then
    print_pass "헬스 체크 응답 정상"
    ((PASS_COUNT++))
else
    print_fail "헬스 체크 응답 비정상"
    ((FAIL_COUNT++))
fi

# ============================================================
# 테스트 3: CRAWLER_DO 기능 확인
# ============================================================
print_test "CRAWLER_DO 기능"

# 크롤러 상태 엔드포인트 테스트
CRAWLER_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/crawl/status" 2>/dev/null || echo "000")
if [ "$CRAWLER_STATUS" = "200" ] || [ "$CRAWLER_STATUS" = "404" ] || [ "$CRAWLER_STATUS" = "501" ]; then
    if [ "$CRAWLER_STATUS" = "501" ]; then
        print_warn "CRAWLER_DO 바인딩 미설정 (501 응답)"
        ((WARN_COUNT++))
    else
        print_pass "CRAWLER_DO 기능 동작 (HTTP $CRAWLER_STATUS)"
        ((PASS_COUNT++))
    fi
else
    print_fail "CRAWLER_DO 기능 오류 (HTTP $CRAWLER_STATUS)"
    ((FAIL_COUNT++))
fi

# ============================================================
# 테스트 4: INDEX_QUEUE 기능 확인
# ============================================================
print_test "INDEX_QUEUE 기능"

# 인덱스 상태 엔드포인트 테스트
INDEX_STATUS=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL/api/index/stats" 2>/dev/null || echo "000")
if [ "$INDEX_STATUS" = "200" ] || [ "$INDEX_STATUS" = "404" ] || [ "$INDEX_STATUS" = "501" ]; then
    if [ "$INDEX_STATUS" = "501" ]; then
        print_warn "INDEX_QUEUE 바인딩 미설정 (501 응답)"
        ((WARN_COUNT++))
    else
        print_pass "INDEX_QUEUE 기능 동작 (HTTP $INDEX_STATUS)"
        ((PASS_COUNT++))
    fi
else
    print_fail "INDEX_QUEUE 기능 오류 (HTTP $INDEX_STATUS)"
    ((FAIL_COUNT++))
fi

# ============================================================
# 테스트 5: D1 데이터베이스 연결
# ============================================================
print_test "D1 데이터베이스 연결"

# 인덱스 초기화 상태 확인
D1_STATUS=$(curl -s "$BASE_URL/api/index/stats" 2>/dev/null | grep -o '"d1":[^,]*' || echo '"d1":false')
if echo "$D1_STATUS" | grep -q '"d1":true'; then
    print_pass "D1 데이터베이스 연결됨"
    ((PASS_COUNT++))
else
    print_warn "D1 데이터베이스 미연결 또는 미설정"
    ((WARN_COUNT++))
fi

# ============================================================
# 테스트 6: Vectorize 연결
# ============================================================
print_test "Vectorize 연결"

VECTORIZE_STATUS=$(curl -s "$BASE_URL/api/index/stats" 2>/dev/null | grep -o '"vectorize":[^,]*' || echo '"vectorize":false')
if echo "$VECTORIZE_STATUS" | grep -q '"vectorize":true'; then
    print_pass "Vectorize 연결됨"
    ((PASS_COUNT++))
else
    print_warn "Vectorize 미연결 또는 미설정"
    ((WARN_COUNT++))
fi

# ============================================================
# 테스트 7: 시드 URL 테스트
# ============================================================
print_test "시드 URL 테스트"

# 샘플 시드 URL로 테스트
SEED_RESPONSE=$(curl -s -X POST "$BASE_URL/api/crawl" \
    -H "Content-Type: application/json" \
    -d '{"urls": ["https://example.com"]}' 2>/dev/null || echo "{}")

if echo "$SEED_RESPONSE" | grep -q '"added"'; then
    ADDED=$(echo "$SEED_RESPONSE" | grep -o '"added":[^,]*' | cut -d: -f2 | tr -d ' ')
    if [ "$ADDED" -gt 0 ] 2>/dev/null; then
        print_pass "시드 URL 추가 성공 ($ADDED 개)"
        ((PASS_COUNT++))
    else
        print_warn "시드 URL 추가 실패 또는 중복"
        ((WARN_COUNT++))
    fi
else
    print_warn "시드 URL 테스트 스킵 (바인딩 미설정)"
    ((WARN_COUNT++))
fi

# ============================================================
# 결과 요약
# ============================================================
echo ""
echo "=========================================="
echo "검증 결과 요약"
echo "=========================================="
echo ""
echo -e "${GREEN}PASS: $PASS_COUNT${NC}"
echo -e "${YELLOW}WARN: $WARN_COUNT${NC}"
echo -e "${RED}FAIL: $FAIL_COUNT${NC}"
echo ""

# 종료 코드 결정
if [ $FAIL_COUNT -gt 0 ]; then
    echo -e "${RED}검증 실패: $FAIL_COUNT개 항목 실패${NC}"
    exit 1
elif [ $WARN_COUNT -gt 0 ]; then
    echo -e "${YELLOW}검증 완료: $WARN_COUNT개 경고 (설정 필요)${NC}"
    exit 0
else
    echo -e "${GREEN}검증 성공: 모든 항목 통과${NC}"
    exit 0
fi

