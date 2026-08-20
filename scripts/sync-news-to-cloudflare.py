#!/usr/bin/env python3
"""
로컬 뉴스 RSS 기사 → Cloudflare 인덱스 동기화
- news-rss-index 컬렉션에서 기사 추출
- 각 기사의 콘텐츠를 청킹
- Cloudflare /api/index 엔드포인트로 전송
"""

import argparse
import json
import time
import os
import sys
import sqlite3
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict
import requests

# ChromaDB
from chromadb import PersistentClient

@dataclass
class NewsArticle:
    """뉴스 기사"""
    id: str
    url: str
    title: str
    content: str
    source: str
    published: str = ""

class NewsSyncManager:
    """뉴스 동기화 매니저"""
    
    def __init__(
        self,
        local_db_path: str = "./local-index/chroma-data",
        collection_name: str = "news-rss-index",
        cloudflare_api_url: str = "https://search-engine-api.pages.dev",
        api_key: str = None
    ):
        self.local_db_path = local_db_path
        self.collection_name = collection_name
        self.cloudflare_api_url = cloudflare_api_url
        self.api_key = api_key or os.getenv("SEARCH_API_KEY")
        
        # 로컬 ChromaDB 연결
        self.chroma = PersistentClient(path=local_db_path)
        
        # 통계
        self.stats = {
            "total_articles": 0,
            "synced": 0,
            "failed": 0,
            "skipped": 0,
            "errors": []
        }
    
    def get_articles(self, limit: int = None) -> List[NewsArticle]:
        """뉴스 기사 목록 조회"""
        articles = []
        
        try:
            collection = self.chroma.get_collection(self.collection_name)
            
            # 모든 문서 조회
            results = collection.get(
                include=["documents", "metadatas"]
            )
            
            if results["ids"]:
                for i, doc_id in enumerate(results["ids"]):
                    metadata = results["metadatas"][i] if results["metadatas"] else {}
                    
                    articles.append(NewsArticle(
                        id=doc_id,
                        url=metadata.get("url", ""),
                        title=metadata.get("title", ""),
                        content=results["documents"][i] if results["documents"] else "",
                        source=metadata.get("source", ""),
                        published=metadata.get("published", "")
                    ))
            
            self.stats["total_articles"] = len(articles)
            
            if limit:
                articles = articles[:limit]
                
        except Exception as e:
            print(f"❌ 기사 조회 오류: {e}", file=sys.stderr)
        
        return articles
    
    def chunk_content(self, content: str, max_chunk_size: int = 500) -> List[str]:
        """콘텐츠 청킹"""
        if not content:
            return []
        
        chunks = []
        
        # 문단으로 분리
        paragraphs = content.split("\n\n")
        
        current_chunk = ""
        for para in paragraphs:
            para = para.strip()
            if not para:
                continue
            
            # 현재 청크에 추가할 수 있는지 확인
            if len(current_chunk) + len(para) + 2 <= max_chunk_size:
                current_chunk += para + "\n\n"
            else:
                # 현재 청크 저장
                if current_chunk:
                    chunks.append(current_chunk.strip())
                current_chunk = para + "\n\n"
        
        # 마지막 청크 저장
        if current_chunk:
            chunks.append(current_chunk.strip())
        
        return chunks if chunks else [content[:max_chunk_size]]
    
    def sync_to_cloudflare(
        self,
        articles: List[NewsArticle],
        batch_size: int = 5,
        concurrency: int = 1
    ) -> Dict:
        """Cloudflare로 동기화"""
        results = {
            "success": 0,
            "failed": 0,
            "errors": []
        }
        
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        
        for i in range(0, len(articles), batch_size):
            batch = articles[i:i+batch_size]
            
            print(f"\n📦 배치 {i//batch_size + 1}/{(len(articles) + batch_size - 1)//batch_size}")
            
            for article in batch:
                try:
                    # 콘텐츠 청킹
                    chunks = self.chunk_content(article.content)
                    
                    # 각 청크를 개별 문서로 인덱싱
                    for j, chunk in enumerate(chunks):
                        payload = {
                            "url": article.url,
                            "title": article.title,
                            "content": chunk,
                            "source": article.source,
                            "metadata": {
                                "type": "news",
                                "source": article.source,
                                "published": article.published,
                                "chunk_index": j,
                                "total_chunks": len(chunks)
                            }
                        }
                        
                        response = requests.post(
                            f"{self.cloudflare_api_url}/api/index",
                            headers=headers,
                            json=payload,
                            timeout=10
                        )
                        
                        if response.status_code == 200:
                            results["success"] += 1
                        else:
                            error_msg = f"HTTP {response.status_code}: {response.text[:100]}"
                            results["failed"] += 1
                            results["errors"].append({
                                "url": article.url,
                                "error": error_msg
                            })
                    
                    # API 호출 간 대기
                    time.sleep(0.5)
                    
                except Exception as e:
                    results["failed"] += 1
                    results["errors"].append({
                        "url": article.url,
                        "error": str(e)
                    })
            
            # 배치 간 대기
            time.sleep(1)
        
        self.stats["synced"] = results["success"]
        self.stats["failed"] = results["failed"]
        self.stats["errors"] = results["errors"]
        
        return results
    
    def get_stats(self) -> Dict:
        """동기화 통계"""
        return self.stats.copy()

def format_report(stats: Dict, results: Dict) -> str:
    """동기화 리포트 생성"""
    lines = []
    lines.append("=" * 60)
    lines.append("📊 뉴스 RSS → Cloudflare 동기화 리포트")
    lines.append("=" * 60)
    
    lines.append(f"\n📰 총 기사: {stats['total_articles']}개")
    lines.append(f"✅ 동기화 성공: {results['success']}개")
    lines.append(f"❌ 동기화 실패: {results['failed']}개")
    
    if results["errors"]:
        lines.append(f"\n⚠️ 에러 목록 ({len(results['errors'])}개):")
        for err in results["errors"][:10]:
            lines.append(f"  - {err['url'][:50]}...: {err['error']}")
    
    lines.append(f"\n{'='*60}")
    lines.append("💡 팁")
    lines.append(f"{'='*60}")
    lines.append("  - API 키가 필요합니다: SEARCH_API_KEY 환경변수 설정")
    lines.append("  - Cloudflare API 키가 없으면 /api/index 엔드포인트 사용")
    lines.append("  - 배치 크기를 줄이면 안정적 (batch_size=3 권장)")
    
    return "\n".join(lines)

def main():
    parser = argparse.ArgumentParser(description="뉴스 RSS → Cloudflare 동기화")
    parser.add_argument("--local-db", default="./local-index/chroma-data", help="로컬 DB 경로")
    parser.add_argument("--collection", default="news-rss-index", help="컬렉션 이름")
    parser.add_argument("--api-url", default="https://search-engine-api.pages.dev", help="Cloudflare API URL")
    parser.add_argument("--api-key", default=None, help="API 키")
    parser.add_argument("--limit", type=int, default=None, help="동기화할 기사 수 제한")
    parser.add_argument("--batch-size", type=int, default=5, help="배치 크기")
    parser.add_argument("--dry-run", action="store_true", help="실제 동기화 없이 테스트")
    parser.add_argument("--output", default="sync-news-results.json", help="결과 저장 경로")
    
    args = parser.parse_args()
    
    print("🚀 뉴스 RSS → Cloudflare 동기화 시작")
    print(f"   로컬 DB: {args.local_db}")
    print(f"   컬렉션: {args.collection}")
    print(f"   API URL: {args.api_url}")
    if args.limit:
        print(f"   제한: {args.limit}개")
    print()
    
    # 매니저 초기화
    manager = NewsSyncManager(
        local_db_path=args.local_db,
        collection_name=args.collection,
        cloudflare_api_url=args.api_url,
        api_key=args.api_key
    )
    
    # 기사 조회
    articles = manager.get_articles(limit=args.limit)
    print(f"📰 조회된 기사: {len(articles)}개")
    
    if not articles:
        print("❌ 동기화할 기사가 없습니다.")
        return
    
    # 샘플 기사 출력
    print("\n📋 샘플 기사 (처음 3개):")
    for i, article in enumerate(articles[:3], 1):
        print(f"  {i}. {article.title[:50]}...")
        print(f"     URL: {article.url[:60]}...")
        print(f"     소스: {article.source}")
        print(f"     콘텐츠 길이: {len(article.content)}자")
        print()
    
    # Dry run 확인
    if args.dry_run:
        print("🔍 Dry run 모드 - 실제 동기화하지 않습니다.")
        return
    
    # 동기화 실행
    print("\n🔄 동기화 시작...")
    start_time = time.time()
    
    results = manager.sync_to_cloudflare(
        articles=articles,
        batch_size=args.batch_size
    )
    
    elapsed = time.time() - start_time
    
    # 리포트 출력
    stats = manager.get_stats()
    report = format_report(stats, results)
    print("\n" + report)
    
    print(f"\n⏱️ 소요 시간: {elapsed:.1f}초")
    
    # JSON 저장
    output = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "stats": stats,
        "results": results,
        "elapsed_seconds": elapsed
    }
    
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"\n📄 결과 저장: {args.output}")

if __name__ == "__main__":
    main()
