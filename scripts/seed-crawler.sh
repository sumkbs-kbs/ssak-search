#!/bin/bash
# ============================================================
# 크롤러 시드 URL 제공 스크립트
# ============================================================
# 
# 사용법: bash scripts/seed-crawler.sh [BASE_URL]
#
# ============================================================

BASE_URL="${1:-https://ssak-search.pages.dev}"

echo "=========================================="
echo "크롤러 시드 URL 제공"
echo "=========================================="
echo ""
echo "대상 URL: $BASE_URL"
echo ""

# 색상 정의
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

# 함수
success() { echo -e "${GREEN}✓${NC} $1"; }
warn() { echo -e "${YELLOW}⚠${NC} $1"; }
error() { echo -e "${RED}✗${NC} $1"; }

# API 키 확인
if [ -z "$SEARCH_API_KEY" ]; then
    warn "SEARCH_API_KEY 환경 변수가 설정되지 않았습니다."
    echo "설정: export SEARCH_API_KEY=your-api-key"
    echo ""
    echo "또는 직접 입력:"
    read -p "API 키 입력: " SEARCH_API_KEY
fi

# ============================================================
# 1단계: 기술 문서 시드 (20개)
# ============================================================
echo ""
echo "[1/4] 기술 문서 시드 (20개)..."

TECH_DOCS='{
  "urls": [
    "https://developers.cloudflare.com/",
    "https://docs.github.com/",
    "https://react.dev/",
    "https://vuejs.org/",
    "https://nextjs.org/",
    "https://nuxt.com/",
    "https://svelte.dev/",
    "https://angular.io/",
    "https://typescriptlang.org/",
    "https://developer.mozilla.org/",
    "https://docs.python.org/",
    "https://nodejs.org/docs/",
    "https://redis.io/docs/",
    "https://kubernetes.io/docs/",
    "https://docker.com/docs/",
    "https://postgresql.org/docs/",
    "https://mysql.com/doc/",
    "https://mongodb.com/docs/",
    "https://elasticsearch.co/docs/",
    "https://opentelemetry.io/docs/"
  ],
  "config": {
    "max_depth": 2,
    "max_pages_per_domain": 50,
    "politeness_delay_ms": 1000
  }
}'

RESPONSE=$(curl -s -X POST "$BASE_URL/api/crawl" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SEARCH_API_KEY" \
  -d "$TECH_DOCS" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"added"'; then
    ADDED=$(echo "$RESPONSE" | grep -o '"added":[^,]*' | cut -d: -f2 | tr -d ' ')
    success "기술 문서 시드 완료: $ADDED 개"
else
    error "기술 문서 시드 실패"
    echo "응답: $RESPONSE"
fi

# ============================================================
# 2단계: 뉴스 사이트 시드 (20개)
# ============================================================
echo ""
echo "[2/4] 뉴스 사이트 시드 (20개)..."

NEWS_SITES='{
  "urls": [
    "https://reuters.com/",
    "https://bbc.com/news",
    "https://cnn.com/",
    "https://nytimes.com/",
    "https://washingtonpost.com/",
    "https://theguardian.com/",
    "https://apnews.com/",
    "https://bloomberg.com/",
    "https://cnbc.com/",
    "https://npr.org/",
    "https://m.news.naver.com/",
    "https://news.naver.com/",
    "https://yna.co.kr/",
    "https://hani.co.kr/",
    "https://donga.com/",
    "https://chosun.com/",
    "https://joongang.co.kr/",
    "https://mk.co.kr/",
    "https://sedaily.com/",
    "https://etnews.com/"
  ],
  "config": {
    "max_depth": 1,
    "max_pages_per_domain": 30,
    "politeness_delay_ms": 2000
  }
}'

RESPONSE=$(curl -s -X POST "$BASE_URL/api/crawl" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SEARCH_API_KEY" \
  -d "$NEWS_SITES" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"added"'; then
    ADDED=$(echo "$RESPONSE" | grep -o '"added":[^,]*' | cut -d: -f2 | tr -d ' ')
    success "뉴스 사이트 시드 완료: $ADDED 개"
else
    error "뉴스 사이트 시드 실패"
    echo "응답: $RESPONSE"
fi

# ============================================================
# 3단계: 학술/금융 시드 (20개)
# ============================================================
echo ""
echo "[3/4] 학술/금융 시드 (20개)..."

ACADEMIC_FINANCE='{
  "urls": [
    "https://arxiv.org/list/cs.AI/recent",
    "https://arxiv.org/list/cs.LG/recent",
    "https://pubmed.ncbi.nlm.nih.gov/",
    "https://nature.com/",
    "https://science.org/",
    "https://ieee.org/",
    "https://acm.org/",
    "https://springer.com/",
    "https://finance.yahoo.com/",
    "https://nasdaq.com/market-activity/",
    "https://investing.com/",
    "https://stockanalysis.com/",
    "https://marketwatch.com/",
    "https://finance.naver.com/",
    "https://m.stock.naver.com/",
    "https://dart.fss.or.kr/",
    "https://krx.co.kr/",
    "https://coinmarketcap.com/",
    "https://scholar.google.com/",
    "https://semanticscholar.org/"
  ],
  "config": {
    "max_depth": 1,
    "max_pages_per_domain": 20,
    "politeness_delay_ms": 2000
  }
}'

RESPONSE=$(curl -s -X POST "$BASE_URL/api/crawl" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SEARCH_API_KEY" \
  -d "$ACADEMIC_FINANCE" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"added"'; then
    ADDED=$(echo "$RESPONSE" | grep -o '"added":[^,]*' | cut -d: -f2 | tr -d ' ')
    success "학술/금융 시드 완료: $ADDED 개"
else
    error "학술/금융 시드 실패"
    echo "응답: $RESPONSE"
fi

# ============================================================
# 4단계: 기술 커뮤니티/위키백과 시드 (40개)
# ============================================================
echo ""
echo "[4/4] 기술 커뮤니티/위키백과 시드 (40개)..."

COMMUNITY_WIKI='{
  "urls": [
    "https://news.ycombinator.com/",
    "https://reddit.com/r/programming/",
    "https://reddit.com/r/webdev/",
    "https://reddit.com/r/javascript/",
    "https://stackoverflow.com/questions",
    "https://dev.to/",
    "https://medium.com/",
    "https://hackernoon.com/",
    "https://techcrunch.com/",
    "https://theverge.com/",
    "https://arstechnica.com/",
    "https://wired.com/",
    "https://venturebeat.com/",
    "https://thenextweb.com/",
    "https://engadget.com/",
    "https://velog.io/",
    "https://tistory.com/",
    "https://blog.naver.com/",
    "https://techblog.woowahan.com/",
    "https://toss.tech/",
    "https://kakao.com/tech",
    "https://line.github.io/",
    "https://www.samsung.com/semiconductor/minisite/exynos/",
    "https://lgcommunity.lge.com/",
    "https://woowa.in/",
    "https://en.wikipedia.org/",
    "https://ko.wikipedia.org/",
    "https://ja.wikipedia.org/",
    "https://zh.wikipedia.org/",
    "https://fr.wikipedia.org/",
    "https://www.coursera.org/",
    "https://www.edx.org/",
    "https://www.udemy.com/",
    "https://www.khanacademy.org/",
    "https://leetcode.com/",
    "https://www.hackerrank.com/",
    "https://www.codecademy.com/",
    "https://freecodecamp.org/",
    "https://theodinproject.com/",
    "https://www.geeksforgeeks.org/"
  ],
  "config": {
    "max_depth": 1,
    "max_pages_per_domain": 20,
    "politeness_delay_ms": 1500
  }
}'

RESPONSE=$(curl -s -X POST "$BASE_URL/api/crawl" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $SEARCH_API_KEY" \
  -d "$COMMUNITY_WIKI" 2>/dev/null)

if echo "$RESPONSE" | grep -q '"added"'; then
    ADDED=$(echo "$RESPONSE" | grep -o '"added":[^,]*' | cut -d: -f2 | tr -d ' ')
    success "기술 커뮤니티/위키백과 시드 완료: $ADDED 개"
else
    error "기술 커뮤니티/위키백과 시드 실패"
    echo "응답: $RESPONSE"
fi

# ============================================================
# 요약
# ============================================================
echo ""
echo "=========================================="
echo "시드 URL 제공 완료"
echo "=========================================="
echo ""
echo "다음 단계:"
echo "1. 크롤링 시작: curl -X POST $BASE_URL/api/crawl/start"
echo "2. 상태 확인: curl -s $BASE_URL/api/crawl/status | jq '.stats'"
echo "3. 인덱스 확인: curl -s $BASE_URL/api/index/stats | jq '.bindings'"
echo ""
echo "예상 소요 시간:"
echo "- 시드 URL 추가: 즉시"
echo "- 크롤링 완료: 6시간"
echo "- 인덱싱 완료: 크롤링과 동시"
echo ""

