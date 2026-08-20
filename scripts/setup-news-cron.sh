#!/bin/bash
# 뉴스 RSS 스케줄러 cron 설정
# 매일 새벽 2시에 자동 실행

set -e

PYTHON="/Users/mr.k/miniforge3/envs/local-index/bin/python"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="$PROJECT_DIR/local-index/logs"
LOG_FILE="$LOG_DIR/news-rss-$(date +%Y%m%d).log"

mkdir -p "$LOG_DIR"

echo "🔧 뉴스 RSS 스케줄러 cron 설정"
echo "================================"
echo ""

# 기존 cron 백업
EXISTING=$(crontab -l 2>/dev/null || echo "")

# 새 cron 작업 추가
CRON_LINE="0 2 * * * cd $PROJECT_DIR && $PYTHON scripts/news-rss-scheduler.py --limit=20 >> $LOG_DIR/news-rss-\$(date +\%Y\%m\%d).log 2>&1"

# 기존에 이미 설정되어 있는지 확인
if echo "$EXISTING" | grep -q "news-rss-scheduler"; then
    echo "⚠️ 이미 cron이 설정되어 있습니다:"
    echo "$EXISTING" | grep "news-rss-scheduler"
    echo ""
    echo "변경하려면 기존 설정을 삭제하고 다시 실행하세요."
    exit 0
fi

# cron 설정
echo "$EXISTING
# [ssak-search] 뉴스 RSS 자동 인덱싱 — 매일 새벽 2시
$CRON_LINE" | crontab -

echo "✅ cron 설정 완료!"
echo ""
echo "📋 설정된 작업:"
echo "   실행 시간: 매일 새벽 2시"
echo "   작업: 뉴스 RSS 인덱싱 (39개 피드, 피드당 20개 기사)"
echo "   로그: $LOG_DIR/news-rss-YYYYMMDD.log"
echo ""
echo "📌 관리 명령어:"
echo "   # 현재 cron 확인"
echo "   crontab -l"
echo ""
echo "   # cron 삭제"
echo "   crontab -l | grep -v 'news-rss-scheduler' | crontab -"
echo ""
echo "   # 수동 실행"
echo "   npm run news:index"
echo ""
echo "   # 로그 확인"
echo "   tail -f $LOG_DIR/news-rss-\$(date +%Y%m%d).log"
