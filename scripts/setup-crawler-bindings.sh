#!/bin/bash
# ============================================================
# CRAWLER_DO & INDEX_QUEUE 바인딩 설정 스크립트
# ============================================================
# 
# 이 스크립트는 Cloudflare Pages에 CRAWLER_DO와 INDEX_QUEUE 바인딩을
# 설정하는 과정을 안내합니다.
#
# 사용법: bash scripts/setup-crawler-bindings.sh
#
# ============================================================

set -e

echo "=========================================="
echo "CRAWLER_DO & INDEX_QUEUE 바인딩 설정"
echo "=========================================="
echo ""

# 색상 정의
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 함수 정의
print_step() {
    echo -e "${BLUE}[단계 $1]${NC} $2"
}

print_success() {
    echo -e "${GREEN}✓${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

print_error() {
    echo -e "${RED}✗${NC} $1"
}

print_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

# ============================================================
# 단계 1: 사전 확인
# ============================================================
print_step 1 "사전 확인 중..."

# Cloudflare CLI 확인
if ! command -v wrangler &> /dev/null; then
    print_warning "Wrangler CLI가 설치되어 있지 않습니다."
    echo "설치: npm install -g wrangler"
    echo "또는: npx wrangler"
fi

# 프로젝트 빌드 확인
if [ ! -d "dist" ]; then
    print_warning "dist 폴더가 없습니다. 먼저 빌드를 실행하세요:"
    echo "npm run build"
fi

echo ""

# ============================================================
# 단계 2: Cloudflare Dashboard 안내
# ============================================================
print_step 2 "Cloudflare Dashboard에서 바인딩 설정"

echo ""
echo "아래 단계를 Cloudflare Dashboard에서 수행하세요:"
echo ""
echo "1. Cloudflare Dashboard 접속: https://dash.cloudflare.com/"
echo "2. Workers & Pages → Pages → ssak-search 선택"
echo "3. Settings → Functions 탭"
echo ""

# ============================================================
# 단계 3: CRAWLER_DO 바인딩 설정
# ============================================================
print_step 3 "CRAWLER_DO 바인딩 설정"

echo ""
echo "=== CRAWLER_DO 설정 ==="
echo ""
echo "1. Durable Objects 섹션에서 'Add binding' 클릭"
echo "2. 다음 정보 입력:"
echo "   - Variable name: CRAWLER_DO"
echo "   - Durable Object class: CrawlerDO"
echo "   - Durable Object namespace: ssak-do-worker"
echo "3. 'Save' 클릭"
echo ""
echo "참고: CrawlerDO 클래스는 이미 코드에 정의되어 있습니다:"
echo "   - 파일: src/lib/crawler-do.ts"
echo "   - 함수: export { CrawlerDO }"
echo ""

# ============================================================
# 단계 4: INDEX_QUEUE 바인딩 설정
# ============================================================
print_step 4 "INDEX_QUEUE 바인딩 설정"

echo ""
echo "=== 4.1 Queue 생성 ==="
echo ""
echo "1. Cloudflare Dashboard → Workers & Pages → Queues"
echo "2. 'Create queue' 클릭"
echo "3. Queue name: search-index-queue 입력"
echo "4. 'Create' 클릭"
echo ""

echo "=== 4.2 Queue 바인딩 연결 ==="
echo ""
echo "1. Workers & Pages → Pages → ssak-search"
echo "2. Settings → Functions 탭"
echo "3. Queues 섹션에서 'Add binding' 클릭"
echo "4. 다음 정보 입력:"
echo "   - Variable name: INDEX_QUEUE"
echo "   - Queue: search-index-queue 선택"
echo "5. 'Save' 클릭"
echo ""

echo "=== 4.3 Queue Consumer 설정 (중요!) ==="
echo ""
echo "1. Workers & Pages → Pages → ssak-search"
echo "2. Settings → Functions"
echo "3. Queues Producers/Consumers 섹션"
echo "4. 'Add consumer' 클릭"
echo "5. 다음 정보 입력:"
echo "   - Queue: search-index-queue"
echo "   - Consumer function: indexQueueConsumer"
echo "   - Max batch size: 10"
echo "   - Max batch timeout: 30"
echo "6. 'Save' 클릭"
echo ""

# ============================================================
# 단계 5: 검증
# ============================================================
print_step 5 "설정 검증"

echo ""
echo "설정 완료 후 다음 명령어로 검증하세요:"
echo ""
echo "# 1. 헬스 체크"
echo "curl -s https://your-pages-domain.pages.dev/api/health | jq '.features'"
echo ""
echo "# 2. 인덱스 상태 확인"
echo "curl -s https://your-pages-domain.pages.dev/api/index/stats | jq '.bindings'"
echo ""
echo "# 3. 크롤러 상태 확인"
echo "curl -s https://your-pages-domain.pages.dev/api/crawl/status | jq '.stats'"
echo ""

# ============================================================
# 단계 6: 시드 URL 제공 안내
# ============================================================
print_step 6 "시드 URL 제공"

echo ""
echo "바인딩 설정 완료 후 다음 명령어로 시드 URL을 제공하세요:"
echo ""
echo "# 기술 문서 시드 (20개)"
echo 'curl -X POST https://your-pages-domain.pages.dev/api/crawl \'
echo '  -H "Content-Type: application/json" \'
echo '  -H "Authorization: Bearer YOUR_API_KEY" \'
echo '  -d '\''{"urls": ["https://developers.cloudflare.com/", "https://docs.github.com/", ...]}'\''
echo ""
echo "# 전체 시드 URL 100개는 SEED_URLS_100.md 파일 참조"
echo ""

# ============================================================
# 요약
# ============================================================
echo ""
echo "=========================================="
echo "설정 요약"
echo "=========================================="
echo ""
echo "필요한 바인딩:"
echo "  1. CRAWLER_DO (Durable Object)"
echo "  2. INDEX_QUEUE (Queue)"
echo "  3. Queue Consumer (indexQueueConsumer)"
echo ""
echo "예상 소요 시간:"
echo "  - 바인딩 설정: 15분"
echo "  - 시드 URL 제공: 5분"
echo "  - 크롤링 완료: 6시간"
echo "  - 검증: 10분"
echo ""
echo "총 예상 시간: 약 6시간 30분"
echo ""
echo "자세한 내용은 CRAWLER_SETUP_GUIDE.md 파일 참조"
echo ""

