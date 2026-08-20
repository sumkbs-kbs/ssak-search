#!/usr/bin/env python3
"""
Cloudflare 동기화 스크립트 v2
로컬 인덱스(search-index-v2)의 URL을 Cloudflare로 동기화
"""

import argparse
import json
import time
from typing import Any, Dict, List

import chromadb
import requests

# ─── 설정 ──────────────────────────────────────────────
DEFAULT_API_URL = "https://search-engine-api.pages.dev"
LOCAL_CHROMA_PATH = "./local-index/chroma-data-v2"
LOCAL_COLLECTION = "search-index-v2"


class CloudflareSync:
    def __init__(self, api_url: str, api_key: str):
        self.api_url = api_url
        self.api_key = api_key
        self.headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        }

    def test_connection(self) -> bool:
        """API 연결 테스트"""
        try:
            resp = requests.get(f"{self.api_url}/api/health", timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                print(f"✅ API 연결 성공: {self.api_url}")
                print(f"   상태: {data.get('status', 'unknown')}")
                return True
            print(f"❌ API 연결 실패: HTTP {resp.status_code}")
            return False
        except Exception as e:
            print(f"❌ API 연결 오류: {e}")
            return False

    def test_auth(self) -> bool:
        """인증 테스트"""
        try:
            # 키 목록 조회로 인증 확인
            resp = requests.get(
                f"{self.api_url}/api/keys",
                headers=self.headers,
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                keys = data.get("keys", [])
                print(f"✅ 인증 성공 (활성 키: {len(keys)}개)")
                for k in keys:
                    print(f"   - {k.get('name', 'unnamed')} ({k.get('scope', 'unknown')})")
                return True
            print(f"❌ 인증 실패: HTTP {resp.status_code} — {resp.text[:100]}")
            return False
        except Exception as e:
            print(f"❌ 인증 오류: {e}")
            return False

    def get_cloudflare_index_stats(self) -> Dict[str, Any]:
        """Cloudflare 인덱스 상태 조회"""
        try:
            resp = requests.get(
                f"{self.api_url}/api/index/stats",
                headers=self.headers,
                timeout=10,
            )
            if resp.status_code == 200:
                return resp.json()
        except Exception:
            pass
        return {}

    def sync_urls(self, urls: List[str], batch_size: int = 5) -> Dict[str, Any]:
        """URL 목록을 Cloudflare로 동기화"""
        results = {"success": 0, "failed": 0, "total": len(urls), "details": []}

        for i in range(0, len(urls), batch_size):
            batch = urls[i : i + batch_size]
            batch_num = i // batch_size + 1
            total_batches = (len(urls) + batch_size - 1) // batch_size
            print(f"\n📦 배치 {batch_num}/{total_batches} ({len(batch)}개 URL)")

            try:
                resp = requests.post(
                    f"{self.api_url}/api/index",
                    headers=self.headers,
                    json={"urls": batch},
                    timeout=60,
                )

                if resp.status_code == 200:
                    data = resp.json()
                    # 응답 형식: { message, results: [{success, url, chunksIndexed}], stats: {succeeded, failed} }
                    stats = data.get("stats", {})
                    succeeded = stats.get("succeeded", 0)
                    failed_count = stats.get("failed", 0)
                    results_list = data.get("results", [])

                    if succeeded > 0:
                        results["success"] += succeeded
                        print(f"   ✅ 성공: {succeeded}개 인덱싱됨")
                        for r in results_list:
                            if r.get("success"):
                                print(f"      - {r.get('url', '?')} ({r.get('chunksIndexed', 0)}개 청크)")
                        results["details"].append({"batch": batch_num, "status": "ok", "count": succeeded})
                    if failed_count > 0:
                        results["failed"] += failed_count
                        for r in results_list:
                            if not r.get("success"):
                                print(f"      ❌ {r.get('url', '?')}: {r.get('error', 'unknown')}")
                        results["details"].append({"batch": batch_num, "status": "partial", "failed": failed_count})
                    if succeeded == 0 and failed_count == 0:
                        # 예상치 못한 응답 형식
                        msg = data.get("message", data.get("error", "Unknown response"))
                        print(f"   ⚠️ 응답: {msg}")
                        results["details"].append({"batch": batch_num, "status": "unknown", "message": msg})
                elif resp.status_code == 401:
                    results["failed"] += len(batch)
                    print(f"   ❌ 인증 실패: API 키를 확인하세요")
                    results["details"].append({"batch": batch_num, "status": "auth_error"})
                    break  # 인증 오류면 중단
                elif resp.status_code == 429:
                    print(f"   ⚠️ Rate limit — 10초 대기 후 재시도")
                    time.sleep(10)
                    # 재시도
                    resp2 = requests.post(
                        f"{self.api_url}/api/index",
                        headers=self.headers,
                        json={"urls": batch},
                        timeout=60,
                    )
                    if resp2.status_code == 200:
                        data2 = resp2.json()
                        count = data2.get("indexed", len(batch))
                        results["success"] += count
                        print(f"   ✅ 재시도 성공: {count}개")
                    else:
                        results["failed"] += len(batch)
                        print(f"   ❌ 재시도 실패: HTTP {resp2.status_code}")
                else:
                    results["failed"] += len(batch)
                    print(f"   ❌ 실패: HTTP {resp.status_code} — {resp.text[:100]}")
                    results["details"].append({"batch": batch_num, "status": "http_error", "code": resp.status_code})

            except Exception as e:
                results["failed"] += len(batch)
                print(f"   ❌ 오류: {e}")
                results["details"].append({"batch": batch_num, "status": "exception", "error": str(e)})

            # Rate limit 방지
            time.sleep(3)

        return results


def get_local_urls(chroma_path: str = LOCAL_CHROMA_PATH) -> List[str]:
    """로컬 인덱스에서 고유 URL 목록 추출"""
    try:
        client = chromadb.PersistentClient(path=chroma_path)
        collection = client.get_collection(name=LOCAL_COLLECTION)

        # 모든 메타데이터 가져오기
        all_data = collection.get(include=["metadatas"])
        urls = set()
        for meta in all_data.get("metadatas", []):
            if meta and meta.get("url"):
                urls.add(meta["url"])

        return sorted(urls)
    except Exception as e:
        print(f"❌ 로컬 인덱스 읽기 실패: {e}")
        return []


def main():
    parser = argparse.ArgumentParser(description="Cloudflare 동기화 v2")
    parser.add_argument("--api-url", default=DEFAULT_API_URL, help="Cloudflare API URL")
    parser.add_argument("--api-key", required=True, help="API 키 (Bearer 토큰)")
    parser.add_argument("--urls", nargs="+", help="동기화할 URL 목록 (미지정 시 로컬 인덱스에서 추출)")
    parser.add_argument("--batch-size", type=int, default=5, help="배치 크기")
    parser.add_argument("--dry-run", action="store_true", help="동기화하지 않고 URL 목록만 출력")
    parser.add_argument("--stats", action="store_true", help="Cloudflare 인덱스 상태 조회")

    args = parser.parse_args()

    sync = CloudflareSync(args.api_url, args.api_key)

    # 연결 테스트
    if not sync.test_connection():
        return

    # 인증 테스트
    if not sync.test_auth():
        print("\n💡 API 키를 확인하세요:")
        print("   Cloudflare Dashboard → Workers & Pages → search-engine-api → Settings → Secrets")
        print("   또는: npx wrangler pages secret put SEARCH_API_KEY --project-name=search-engine-api")
        return

    # 상태 조회
    if args.stats:
        stats = sync.get_cloudflare_index_stats()
        print(f"\n📊 Cloudflare 인덱스 상태:")
        print(f"   총 문서: {stats.get('totalDocuments', 0)}")
        print(f"   총 청크: {stats.get('totalChunks', 0)}")
        print(f"   인덱스 건강: {stats.get('indexHealth', 'unknown')}")
        return

    # URL 목록 준비
    if args.urls:
        urls = args.urls
    else:
        print("\n📂 로컬 인덱스에서 URL 추출 중...")
        urls = get_local_urls()
        if not urls:
            print("❌ 로컬 인덱스에서 URL을 찾을 수 없습니다.")
            return
        print(f"   추출된 URL: {len(urls)}개")

    if args.dry_run:
        print(f"\n📋 동기화 대상 URL ({len(urls)}개):")
        for i, url in enumerate(urls, 1):
            print(f"   {i}. {url}")
        return

    # 동기화 실행
    print(f"\n🚀 Cloudflare 동기화 시작")
    print(f"   API URL: {args.api_url}")
    print(f"   URL 수: {len(urls)}")
    print(f"   배치 크기: {args.batch_size}")
    print()

    start_time = time.time()
    results = sync.sync_urls(urls, args.batch_size)
    elapsed = time.time() - start_time

    # 결과 출력
    print(f"\n{'='*60}")
    print(f"✅ 동기화 완료!")
    print(f"   성공: {results['success']}/{results['total']}")
    print(f"   실패: {results['failed']}/{results['total']}")
    print(f"   소요 시간: {elapsed:.1f}초")
    print(f"{'='*60}")

    # 동기화 후 상태 확인
    print(f"\n📊 동기화 후 Cloudflare 인덱스 상태:")
    stats = sync.get_cloudflare_index_stats()
    print(f"   총 문서: {stats.get('totalDocuments', 0)}")
    print(f"   총 청크: {stats.get('totalChunks', 0)}")


if __name__ == "__main__":
    main()
