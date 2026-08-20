#!/usr/bin/env python3
"""
하이브리드 검색 파이프라인
- 로컬 인덱스 (ChromaDB + Ollama) + Cloudflare (Bing/DuckDuckGo)
- 로컬 우선, 부족하면 클라우드 폴백
- 결과 통합 + 리랭킹
"""

import argparse
import json
import time
import os
import sys
from typing import List, Dict, Optional, Tuple
from dataclasses import dataclass, asdict
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# ChromaDB
from chromadb import PersistentClient

# 임베딩
import ollama

@dataclass
class SearchResult:
    """검색 결과"""
    url: str
    title: str
    snippet: str
    score: float
    source: str  # 'local', 'cloudflare', 'hybrid'
    metadata: Dict = None

class HybridSearchEngine:
    """하이브리드 검색 엔진"""
    
    def __init__(
        self,
        local_db_path: str = "./local-index/chroma-data",
        collection_name: str = "search-index",
        cloudflare_api_url: str = "https://search-engine-api.pages.dev",
        api_key: str = None,
        embedding_model: str = "nomic-embed-text",
        max_local_results: int = 10,
        max_cloud_results: int = 10,
        cloud_threshold: float = 0.3  # 로컬 결과가 이 점수 이하면 클라우드 검색
    ):
        self.local_db_path = local_db_path
        self.collection_name = collection_name
        self.cloudflare_api_url = cloudflare_api_url
        self.api_key = api_key or os.getenv("SEARCH_API_KEY")
        self.embedding_model = embedding_model
        self.max_local_results = max_local_results
        self.max_cloud_results = max_cloud_results
        self.cloud_threshold = cloud_threshold
        
        # 로컬 ChromaDB 연결
        self.chroma = PersistentClient(path=local_db_path)
        
        # 통계
        self.stats = {
            "local_queries": 0,
            "cloud_queries": 0,
            "total_time_ms": 0
        }
    
    def search(self, query: str, verbose: bool = False) -> List[SearchResult]:
        """
        하이브리드 검색 실행
        
        1. 로컬 인덱스에서 검색
        2. 로컬 결과가 부족하거나 점수가 낮으면 클라우드 검색
        3. 결과 통합 + 리랭킹
        """
        start_time = time.time()
        results = []
        
        # 1단계: 로컬 인덱스 검색
        local_results = self._search_local(query)
        self.stats["local_queries"] += 1
        
        if verbose:
            print(f"🏠 로컬 검색: {len(local_results)}건")
        
        # 2단계: 로컬 결과 평가
        max_local_score = max([r.score for r in local_results], default=0) if local_results else 0
        needs_cloud = (
            len(local_results) < self.max_local_results or
            max_local_score < self.cloud_threshold
        )
        
        # 3단계: 클라우드 검색 (필요시)
        cloud_results = []
        if needs_cloud:
            cloud_results = self._search_cloudflare(query)
            self.stats["cloud_queries"] += 1
            
            if verbose:
                print(f"☁️ 클라우드 검색: {len(cloud_results)}건")
        
        # 4단계: 결과 통합 + 리랭킹
        results = self._merge_and_rerank(query, local_results, cloud_results)
        
        # 통계 업데이트
        elapsed_ms = (time.time() - start_time) * 1000
        self.stats["total_time_ms"] += elapsed_ms
        
        return results
    
    def _search_local(self, query: str) -> List[SearchResult]:
        """로컬 인덱스 검색"""
        results = []
        
        try:
            # Ollama로 쿼리 임베딩
            response = ollama.embeddings(model=self.embedding_model, prompt=query)
            query_embedding = response["embedding"]
            
            # 지정된 컬렉션에서 검색
            try:
                collection = self.chroma.get_collection(self.collection_name)
                search_results = collection.query(
                    query_embeddings=[query_embedding],
                    n_results=min(self.max_local_results, 10),
                    include=["documents", "metadatas", "distances"]
                )
                
                all_docs = []
                if search_results["ids"][0]:
                    for i, doc_id in enumerate(search_results["ids"][0]):
                        all_docs.append({
                            "id": doc_id,
                            "document": search_results["documents"][0][i],
                            "metadata": search_results["metadatas"][0][i],
                            "distance": search_results["distances"][0][i],
                            "collection": self.collection_name
                        })
            except Exception as e:
                print(f"  ⚠️ 컬렉션 '{self.collection_name}' 검색 실패: {e}", file=sys.stderr)
                all_docs = []
            
            # 거리 기반 점수 변환 (거리가 작을수록 좋음)
            for doc in all_docs:
                # cosine 거리는 0~2 범위, 0이면 완전 일치
                distance = doc["distance"]
                similarity = max(0, 1 - (distance / 2))
                
                results.append(SearchResult(
                    url=doc["metadata"].get("url", ""),
                    title=doc["metadata"].get("title", doc["document"][:100]),
                    snippet=doc["document"][:300],
                    score=similarity,
                    source="local",
                    metadata={
                        "collection": doc["collection"],
                        "distance": doc["distance"]
                    }
                ))
            
            # 점수순 정렬
            results.sort(key=lambda x: x.score, reverse=True)
            results = results[:self.max_local_results]
            
        except Exception as e:
            print(f"❌ 로컬 검색 오류: {e}", file=sys.stderr)
        
        return results
    
    def _search_cloudflare(self, query: str) -> List[SearchResult]:
        """Cloudflare 검색 (Bing/DuckDuckGo)"""
        results = []
        
        try:
            headers = {"Content-Type": "application/json"}
            if self.api_key:
                headers["X-API-Key"] = self.api_key
            
            payload = {
                "query": query,
                "max_results": self.max_cloud_results,
                "engines": ["bing", "duckduckgo"]
            }
            
            response = requests.post(
                f"{self.cloudflare_api_url}/api/search",
                headers=headers,
                json=payload,
                timeout=10
            )
            
            if response.status_code == 200:
                data = response.json()
                for item in data.get("results", []):
                    results.append(SearchResult(
                        url=item.get("url", ""),
                        title=item.get("title", ""),
                        snippet=item.get("snippet", ""),
                        score=item.get("score", 0.5),
                        source="cloudflare",
                        metadata={"engine": item.get("engine", "unknown")}
                    ))
            else:
                print(f"⚠️ Cloudflare API 오류: {response.status_code}", file=sys.stderr)
                
        except Exception as e:
            print(f"❌ Cloudflare 검색 오류: {e}", file=sys.stderr)
        
        return results
    
    def _merge_and_rerank(
        self,
        query: str,
        local_results: List[SearchResult],
        cloud_results: List[SearchResult]
    ) -> List[SearchResult]:
        """
        결과 통합 및 리랭킹
        
        전략:
        1. 로컬 결과에 가중치 부여 (신뢰도 높음)
        2. 클라우드 결과로 보완
        3. 중복 URL 제거
        4. 최종 순위 매김
        """
        # 로컬 가중치 (1.2x)
        LOCAL_WEIGHT = 1.2
        # 클라우드 가중치 (1.0x)
        CLOUD_WEIGHT = 1.0
        
        merged = {}
        
        # 로컬 결과 추가
        for r in local_results:
            if r.url not in merged:
                merged[r.url] = SearchResult(
                    url=r.url,
                    title=r.title,
                    snippet=r.snippet,
                    score=r.score * LOCAL_WEIGHT,
                    source="local",
                    metadata=r.metadata or {}
                )
                merged[r.url].metadata["sources"] = ["local"]
            else:
                # 이미 있으면 점수 업데이트
                merged[r.url].score = max(merged[r.url].score, r.score * LOCAL_WEIGHT)
                merged[r.url].metadata["sources"].append("local")
        
        # 클라우드 결과 추가
        for r in cloud_results:
            if r.url not in merged:
                merged[r.url] = SearchResult(
                    url=r.url,
                    title=r.title,
                    snippet=r.snippet,
                    score=r.score * CLOUD_WEIGHT,
                    source="cloudflare",
                    metadata=r.metadata or {}
                )
                merged[r.url].metadata["sources"] = ["cloudflare"]
            else:
                # 이미 있으면 점수 업데이트 (양쪽 소스에서 나온 결과는 보너스)
                merged[r.url].score = max(merged[r.url].score, r.score * CLOUD_WEIGHT)
                merged[r.url].metadata["sources"].append("cloudflare")
                # 보너스: 양쪽 소스에서 나온 결과는 10% 보너스
                if len(merged[r.url].metadata["sources"]) > 1:
                    merged[r.url].score *= 1.1
                    merged[r.url].source = "hybrid"
        
        # 점수순 정렬
        results = sorted(merged.values(), key=lambda x: x.score, reverse=True)
        
        return results[:15]  # 최대 15건 반환
    
    def get_stats(self) -> Dict:
        """검색 통계 반환"""
        return self.stats.copy()

def format_results(results: List[SearchResult], verbose: bool = False) -> str:
    """검색 결과 포맷팅"""
    lines = []
    
    for i, r in enumerate(results, 1):
        source_icon = {"local": "🏠", "cloudflare": "☁️", "hybrid": "🔗"}.get(r.source, "❓")
        
        lines.append(f"\n{i}. {source_icon} [{r.title}]({r.url})")
        lines.append(f"   점수: {r.score:.2f} | 소스: {r.source}")
        
        if verbose and r.metadata:
            sources = r.metadata.get("sources", [])
            if sources:
                lines.append(f"   출처: {', '.join(sources)}")
        
        if r.snippet:
            snippet = r.snippet[:200].replace("\n", " ")
            lines.append(f"   {snippet}...")
    
    return "\n".join(lines)

def main():
    parser = argparse.ArgumentParser(description="하이브리드 검색 (로컬 + Cloudflare)")
    parser.add_argument("--search", "-s", required=True, help="검색 쿼리")
    parser.add_argument("--local-db", default="./local-index/chroma-data", help="로컬 DB 경로")
    parser.add_argument("--api-url", default="https://search-engine-api.pages.dev", help="Cloudflare API URL")
    parser.add_argument("--api-key", default=None, help="API 키")
    parser.add_argument("--max-results", type=int, default=10, help="최대 결과 수")
    parser.add_argument("--cloud-threshold", type=float, default=0.3, help="클라우드 검색 임계값")
    parser.add_argument("--verbose", "-v", action="store_true", help="상세 출력")
    parser.add_argument("--json", action="store_true", help="JSON 출력")
    
    args = parser.parse_args()
    
    # 엔진 초기화
    engine = HybridSearchEngine(
        local_db_path=args.local_db,
        cloudflare_api_url=args.api_url,
        api_key=args.api_key,
        max_local_results=args.max_results,
        cloud_threshold=args.cloud_threshold
    )
    
    # 검색 실행
    print(f"🔍 검색: {args.search}")
    print(f"   임계값: {args.cloud_threshold} (로컬 점수가 이 이하면 클라우드 검색)")
    print()
    
    results = engine.search(args.search, verbose=args.verbose)
    
    # 결과 출력
    if args.json:
        output = [asdict(r) for r in results]
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        print(f"📊 검색 결과: {len(results)}건")
        print(format_results(results, verbose=args.verbose))
    
    # 통계
    stats = engine.get_stats()
    print(f"\n📈 통계: 로컬 {stats['local_queries']}회, 클라우드 {stats['cloud_queries']}회")

if __name__ == "__main__":
    main()
