#!/usr/bin/env python3
"""
대량 크롤링 자동화 스케줄러
- 배치 처리 (1,000개씩)
- 자동 재시작
- 실시간 모니터링
- Cloudflare 동기화 통합
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Optional

import requests

# ============================================================
# 설정
# ============================================================

# 배치 크기
BATCH_SIZE = 1000

# 배치 간 대기 시간 (초)
BATCH_DELAY = 60

# 최대 재시도 횟수
MAX_RETRIES = 3

# 로그 디렉토리
LOG_DIR = Path("local-index/logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)

# 상태 파일
STATUS_FILE = Path("local-index/bulk-crawl-status.json")


# ============================================================
# 상태 관리
# ============================================================

class CrawlStatus:
    """크롤링 상태 관리"""
    
    def __init__(self):
        self.data = self._load()
    
    def _load(self) -> dict:
        """상태 로드"""
        if STATUS_FILE.exists():
            with open(STATUS_FILE, "r") as f:
                return json.load(f)
        return {
            "current_batch": 0,
            "total_batches": 0,
            "total_urls": 0,
            "completed_urls": 0,
            "failed_urls": 0,
            "status": "idle",
            "last_update": None,
            "history": [],
        }
    
    def save(self):
        """상태 저장"""
        self.data["last_update"] = datetime.now().isoformat()
        with open(STATUS_FILE, "w") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
    
    def start_batch(self, batch_num: int, total_batches: int, urls_in_batch: int):
        """배치 시작"""
        self.data["current_batch"] = batch_num
        self.data["total_batches"] = total_batches
        self.data["status"] = "running"
        self.data["history"].append({
            "batch": batch_num,
            "start_time": datetime.now().isoformat(),
            "urls": urls_in_batch,
        })
        self.save()
    
    def complete_batch(self, batch_num: int, success: int, failed: int):
        """배치 완료"""
        self.data["completed_urls"] += success
        self.data["failed_urls"] += failed
        self.data["history"][-1].update({
            "end_time": datetime.now().isoformat(),
            "success": success,
            "failed": failed,
        })
        self.save()
    
    def finish(self):
        """크롤링 완료"""
        self.data["status"] = "completed"
        self.save()
    
    def error(self, message: str):
        """에러 발생"""
        self.data["status"] = "error"
        self.data["error"] = message
        self.save()


# ============================================================
# 배치 크롤러
# ============================================================

def run_batch(
    batch_num: int,
    total_batches: int,
    urls: list,
    seed_file: str,
    checkpoint_file: str,
) -> tuple:
    """단일 배치 실행"""
    print(f"\n🔄 배치 {batch_num}/{total_batches} 시작 ({len(urls)}개 URL)")
    
    # 임시 시드 파일 생성
    temp_seed = Path(f"local-index/temp-batch-{batch_num}.json")
    temp_seed.parent.mkdir(parents=True, exist_ok=True)
    
    batch_data = {"batch": urls}
    with open(temp_seed, "w") as f:
        json.dump(batch_data, f)
    
    # 크롤러 실행
    import subprocess
    cmd = [
        sys.executable,
        "scripts/bulk-crawler-10k.py",
        "--seed-file", str(temp_seed),
        "--checkpoint", checkpoint_file,
        "--max-workers", "5",
        "--delay-min", "1.0",
        "--delay-max", "3.0",
    ]
    
    result = subprocess.run(cmd, capture_output=False)
    
    # 임시 파일 삭제
    temp_seed.unlink(missing_ok=True)
    
    return result.returncode == 0


def load_urls(seed_file: str, category: Optional[str] = None) -> list:
    """시드 파일에서 URL 로드"""
    with open(seed_file, "r") as f:
        data = json.load(f)
    
    urls = []
    for cat, cat_urls in data.items():
        if category and cat != category:
            continue
        for url in cat_urls:
            urls.append({"url": url, "category": cat})
    
    return urls


def main():
    parser = argparse.ArgumentParser(description="대량 크롤링 자동화 스케줄러")
    parser.add_argument("--seed-file", default="scripts/seed-data/seed-urls-10k.json", help="시드 URL 파일")
    parser.add_argument("--batch-size", type=int, default=BATCH_SIZE, help="배치 크기")
    parser.add_argument("--batch-delay", type=int, default=BATCH_DELAY, help="배치 간 대기 시간 (초)")
    parser.add_argument("--category", help="특정 카테고리만 크롤링")
    parser.add_argument("--resume", action="store_true", help="이전 배치부터 재시작")
    
    args = parser.parse_args()
    
    print("🚀 대량 크롤링 자동화 스케줄러")
    print("=" * 60)
    
    # 상태 관리
    status = CrawlStatus()
    
    # URL 로드
    urls = load_urls(args.seed_file, args.category)
    total_urls = len(urls)
    
    print(f"\n📊 총 URL: {total_urls}개")
    print(f"📊 배치 크기: {args.batch_size}개")
    print(f"📊 총 배치: {(total_urls + args.batch_size - 1) // args.batch_size}개")
    
    # 배치 분할
    batches = []
    for i in range(0, total_urls, args.batch_size):
        batch = urls[i:i + args.batch_size]
        batches.append(batch)
    
    total_batches = len(batches)
    
    # 이전 상태 확인
    start_batch = 0
    if args.resume and status.data.get("current_batch"):
        start_batch = status.data["current_batch"]
        print(f"\n🔄 배치 {start_batch}부터 재시작")
    
    # 크롤링 시작
    status.data["total_batches"] = total_batches
    status.data["total_urls"] = total_urls
    status.save()
    
    success_count = 0
    failed_count = 0
    
    for batch_num, batch in enumerate(batches[start_batch:], start=start_batch + 1):
        print(f"\n{'='*60}")
        print(f"📦 배치 {batch_num}/{total_batches}")
        print(f"   URL: {len(batch)}개")
        print(f"{'='*60}")
        
        # 배치 시작
        status.start_batch(batch_num, total_batches, len(batch))
        
        # 크롤러 실행
        checkpoint_file = f"local-index/bulk-crawl-batch-{batch_num}-checkpoint.json"
        success = run_batch(
            batch_num=batch_num,
            total_batches=total_batches,
            urls=batch,
            seed_file=args.seed_file,
            checkpoint_file=checkpoint_file,
        )
        
        if success:
            success_count += len(batch)
            status.complete_batch(batch_num, len(batch), 0)
            print(f"\n✅ 배치 {batch_num} 완료")
        else:
            failed_count += len(batch)
            status.complete_batch(batch_num, 0, len(batch))
            print(f"\n❌ 배치 {batch_num} 실패")
        
        # 배치 간 대기
        if batch_num < total_batches:
            print(f"\n⏳ {args.batch_delay}초 대기 중...")
            time.sleep(args.batch_delay)
    
    # 완료
    status.finish()
    
    print(f"\n{'='*60}")
    print("📊 크롤링 완료!")
    print(f"   성공: {success_count}개")
    print(f"   실패: {failed_count}개")
    print(f"   총 배치: {total_batches}개")
    print(f"{'='*60}")
    
    # 상태 파일 저장
    status_file = LOG_DIR / f"bulk-crawl-status-{datetime.now().strftime('%Y%m%d-%H%M%S')}.json"
    with open(status_file, "w") as f:
        json.dump(status.data, f, indent=2, ensure_ascii=False)
    
    print(f"\n📝 상태 파일: {status_file}")


if __name__ == "__main__":
    main()
