#!/usr/bin/env python3
"""
Cloudflare 동기화 스크립트
로컬 인덱스를 Cloudflare로 동기화
"""

import argparse
import json
import time
import requests
from typing import List, Dict, Any

# 설정
CHROMA_URL = "http://localhost:8000"
COLLECTION_NAME = "search-index"
DEFAULT_API_URL = "https://search-engine-api.pages.dev"

class CloudflareSync:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url
        self.api_key = api_key
        self.headers = {
            "Content-Type": "application/json",
            "X-API-Key": api_key
        }
        
    def test_connection(self) -> bool:
        """API 연결 테스트"""
        try:
            response = requests.get(f"{self.api_url}/api/health")
            if response.status_code == 200:
                print(f"✅ API 연결 성공: {self.api_url}")
                return True
            else:
                print(f"❌ API 연결 실패: {response.status_code}")
                return False
        except Exception as e:
            print(f"❌ API 연결 오류: {e}")
            return False
    
    def sync_urls(self, urls: List[str], batch_size: int = 10) -> Dict[str, Any]:
        """URL 목록을 Cloudflare로 동기화"""
        results = {"success": 0, "failed": 0, "total": len(urls)}
        
        for i in range(0, len(urls), batch_size):
            batch = urls[i:i+batch_size]
            print(f"\n[{i+1}-{min(i+batch_size, len(urls))}/{len(urls)}] 동기화 중...")
            
            try:
                response = requests.post(
                    f"{self.api_url}/api/index",
                    headers=self.headers,
                    json={"urls": batch}
                )
                
                if response.status_code == 200:
                    data = response.json()
                    if data.get("success"):
                        results["success"] += len(batch)
                        print(f"✅ 배치 동기화 성공: {len(batch)}개 URL")
                    else:
                        results["failed"] += len(batch)
                        print(f"❌ 배치 동기화 실패: {data.get('error', 'Unknown error')}")
                else:
                    results["failed"] += len(batch)
                    print(f"❌ 배치 동기화 실패: HTTP {response.status_code}")
                
            except Exception as e:
                results["failed"] += len(batch)
                print(f"❌ 배치 동기화 오류: {e}")
            
            # Rate limit 방지
            time.sleep(2)
        
        return results

def main():
    parser = argparse.ArgumentParser(description="Cloudflare 동기화 스크립트")
    parser.add_argument("--api-url", default=DEFAULT_API_URL,
                       help="Cloudflare API URL")
    parser.add_argument("--api-key", required=True,
                       help="API 키")
    parser.add_argument("--urls", nargs="+",
                       help="동기화할 URL 목록")
    parser.add_argument("--batch-size", type=int, default=10,
                       help="배치 크기")
    
    args = parser.parse_args()
    
    # 동기화 초기화
    sync = CloudflareSync(args.api_url, args.api_key)
    
    # 연결 테스트
    if not sync.test_connection():
        print("❌ API 연결 실패. URL과 API 키를 확인하세요.")
        return
    
    # URL 목록 준비
    if not args.urls:
        print("❌ URL 목록을 지정하세요. (--urls 옵션)")
        return
    
    # 동기화 실행
    print(f"\n🚀 Cloudflare 동기화 시작")
    print(f"   API URL: {args.api_url}")
    print(f"   URL 수: {len(args.urls)}")
    print()
    
    start_time = time.time()
    results = sync.sync_urls(args.urls, args.batch_size)
    elapsed = time.time() - start_time
    
    # 결과 출력
    print(f"\n{'='*60}")
    print(f"✅ 동기화 완료!")
    print(f"   성공: {results['success']}/{results['total']}")
    print(f"   실패: {results['failed']}/{results['total']}")
    print(f"   소요 시간: {elapsed:.1f}초")
    print(f"{'='*60}")

if __name__ == "__main__":
    main()
