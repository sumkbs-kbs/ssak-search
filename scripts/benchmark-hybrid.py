#!/usr/bin/env python3
"""
하이브리드 검색 벤치마크
- 로컬 vs 클라우드 vs 하이브리드 비교
"""

import json
import time
import sys
import os
from typing import List, Dict
from dataclasses import dataclass, asdict, field
from concurrent.futures import ThreadPoolExecutor
import requests

# ChromaDB
from chromadb import PersistentClient
import ollama

# 테스트 쿼리
TEST_QUERIES = [
    # 기술 쿼리
    {"query": "react hooks tutorial", "category": "tech", "expected_domain": "react.dev"},
    {"query": "python async await", "category": "tech", "expected_domain": "python.org"},
    {"query": "docker compose networking", "category": "tech", "expected_domain": "docker.com"},
    {"query": "kubernetes pod lifecycle", "category": "tech", "expected_domain": "kubernetes.io"},
    {"query": "rust ownership borrowing", "category": "tech", "expected_domain": "rust-lang.org"},
    {"query": "typescript generics constraints", "category": "tech", "expected_domain": "typescriptlang.org"},
    {"query": "git rebase vs merge", "category": "tech", "expected_domain": "git-scm.com"},
    {"query": "nginx reverse proxy config", "category": "tech", "expected_domain": "nginx.org"},
    {"query": "graphql subscriptions", "category": "tech", "expected_domain": "graphql.org"},
    {"query": "tailwind css grid layout", "category": "tech", "expected_domain": "tailwindcss.com"},
    
    # 과학 쿼리
    {"query": "quantum computing qubit", "category": "science", "expected_domain": "arxiv.org"},
    {"query": "CRISPR gene editing", "category": "science", "expected_domain": "nature.com"},
    {"query": "neural network transformer", "category": "science", "expected_domain": "arxiv.org"},
    
    # 클라우드 쿼리
    {"query": "cloudflare workers deploy", "category": "cloud", "expected_domain": "developers.cloudflare.com"},
    {"query": "aws lambda cold start", "category": "cloud", "expected_domain": "aws.amazon.com"},
]

@dataclass
class BenchmarkResult:
    """벤치마크 결과"""
    query: str
    category: str
    expected_domain: str
    local_score: float = 0.0
    local_time_ms: float = 0.0
    local_top_domain: str = ""
    cloud_score: float = 0.0
    cloud_time_ms: float = 0.0
    cloud_top_domain: str = ""
    hybrid_score: float = 0.0
    hybrid_time_ms: float = 0.0
    hybrid_top_domain: str = ""
    winner: str = ""
    details: Dict = field(default_factory=dict)

class HybridBenchmark:
    """하이브리드 검색 벤치마크"""
    
    def __init__(self, local_db_path: str = "./local-index/chroma-data"):
        self.local_db_path = local_db_path
        self.chroma = PersistentClient(path=local_db_path)
        self.embedding_model = "nomic-embed-text"
    
    def run_benchmark(self) -> List[BenchmarkResult]:
        """벤치마크 실행"""
        results = []
        
        for i, test in enumerate(TEST_QUERIES, 1):
            print(f"\n{'='*60}")
            print(f"[{i}/{len(TEST_QUERIES)}] {test['query']}")
            print(f"{'='*60}")
            
            result = BenchmarkResult(
                query=test["query"],
                category=test["category"],
                expected_domain=test["expected_domain"]
            )
            
            # 1. 로컬 검색
            local_results, local_time = self._search_local(test["query"])
            result.local_time_ms = local_time
            if local_results:
                result.local_score = local_results[0]["score"]
                result.local_top_domain = self._extract_domain(local_results[0]["url"])
            
            # 2. 클라우드 검색 (DuckDuckGo)
            cloud_results, cloud_time = self._search_cloud(test["query"])
            result.cloud_time_ms = cloud_time
            if cloud_results:
                result.cloud_score = cloud_results[0].get("score", 0.5)
                result.cloud_top_domain = self._extract_domain(cloud_results[0].get("url", ""))
            
            # 3. 하이브리드 검색
            hybrid_results, hybrid_time = self._search_hybrid(test["query"])
            result.hybrid_time_ms = hybrid_time
            if hybrid_results:
                result.hybrid_score = hybrid_results[0]["score"]
                result.hybrid_top_domain = self._extract_domain(hybrid_results[0]["url"])
            
            # 승자 결정
            scores = {
                "local": result.local_score,
                "cloud": result.cloud_score,
                "hybrid": result.hybrid_score
            }
            result.winner = max(scores, key=scores.get)
            
            # 상세 정보
            result.details = {
                "local_results": local_results[:3] if local_results else [],
                "cloud_results": cloud_results[:3] if cloud_results else [],
                "hybrid_results": hybrid_results[:3] if hybrid_results else []
            }
            
            results.append(result)
            
            # 중간 결과 출력
            print(f"  🏠 로컬: {result.local_score:.3f} ({result.local_time_ms:.0f}ms) → {result.local_top_domain}")
            print(f"  ☁️ 클라우드: {result.cloud_score:.3f} ({result.cloud_time_ms:.0f}ms) → {result.cloud_top_domain}")
            print(f"  🔗 하이브리드: {result.hybrid_score:.3f} ({result.hybrid_time_ms:.0f}ms) → {result.hybrid_top_domain}")
            print(f"  🏆 승자: {result.winner}")
        
        return results
    
    def _search_local(self, query: str) -> tuple:
        """로컬 인덱스 검색"""
        start = time.time()
        results = []
        
        try:
            response = ollama.embeddings(model=self.embedding_model, prompt=query)
            query_embedding = response["embedding"]
            
            collections = self.chroma.list_collections()
            
            all_docs = []
            for col in collections:
                try:
                    collection = self.chroma.get_collection(col.name)
                    search_results = collection.query(
                        query_embeddings=[query_embedding],
                        n_results=5,
                        include=["documents", "metadatas", "distances"]
                    )
                    
                    if search_results["ids"][0]:
                        for i, doc_id in enumerate(search_results["ids"][0]):
                            # 거리를 유사도 점수로 변환 (0~1)
                            distance = search_results["distances"][0][i]
                            # cosine 거리는 0~2 범위, 0이면 완전 일치
                            similarity = max(0, 1 - (distance / 2))
                            all_docs.append({
                                "url": search_results["metadatas"][0][i].get("url", ""),
                                "title": search_results["metadatas"][0][i].get("title", ""),
                                "score": similarity,
                                "collection": col.name
                            })
                except Exception as e:
                    continue
            
            # 점수순 정렬
            all_docs.sort(key=lambda x: x["score"], reverse=True)
            results = all_docs[:5]
            
        except Exception as e:
            print(f"  ❌ 로컬 검색 오류: {e}", file=sys.stderr)
        
        elapsed_ms = (time.time() - start) * 1000
        return results, elapsed_ms
    
    def _search_cloud(self, query: str) -> tuple:
        """DuckDuckGo 검색"""
        start = time.time()
        results = []
        
        try:
            response = requests.get(
                "https://api.duckduckgo.com/",
                params={"q": query, "format": "json", "no_html": 1},
                timeout=5
            )
            
            if response.status_code == 200:
                data = response.json()
                
                # Abstract URL
                if data.get("AbstractURL"):
                    results.append({
                        "url": data["AbstractURL"],
                        "title": data.get("Heading", ""),
                        "snippet": data.get("Abstract", ""),
                        "score": 0.7
                    })
                
                # Related Topics
                for topic in data.get("RelatedTopics", [])[:5]:
                    if isinstance(topic, dict) and topic.get("FirstURL"):
                        results.append({
                            "url": topic["FirstURL"],
                            "title": topic.get("Text", "")[:100],
                            "snippet": topic.get("Text", ""),
                            "score": 0.5
                        })
                
        except Exception as e:
            print(f"  ❌ 클라우드 검색 오류: {e}", file=sys.stderr)
        
        elapsed_ms = (time.time() - start) * 1000
        return results, elapsed_ms
    
    def _search_hybrid(self, query: str) -> tuple:
        """하이브리드 검색 (로컬 + 클라우드 통합)"""
        start = time.time()
        
        # 로컬 검색
        local_results, _ = self._search_local(query)
        
        # 클라우드 검색
        cloud_results, _ = self._search_cloud(query)
        
        # 결과 통합
        merged = {}
        
        # 로컬 결과 (가중치 1.2)
        for r in local_results:
            url = r["url"]
            if url not in merged:
                merged[url] = {
                    "url": url,
                    "title": r["title"],
                    "score": r["score"] * 1.2,
                    "sources": ["local"]
                }
            else:
                merged[url]["score"] = max(merged[url]["score"], r["score"] * 1.2)
                merged[url]["sources"].append("local")
        
        # 클라우드 결과 (가중치 1.0)
        for r in cloud_results:
            url = r.get("url", "")
            if url and url not in merged:
                merged[url] = {
                    "url": url,
                    "title": r.get("title", ""),
                    "score": r.get("score", 0.5) * 1.0,
                    "sources": ["cloud"]
                }
            elif url:
                merged[url]["score"] = max(merged[url]["score"], r.get("score", 0.5))
                merged[url]["sources"].append("cloud")
                # 보너스: 양쪽 소스
                if len(merged[url]["sources"]) > 1:
                    merged[url]["score"] *= 1.1
        
        # 점수순 정렬
        results = sorted(merged.values(), key=lambda x: x["score"], reverse=True)[:5]
        
        elapsed_ms = (time.time() - start) * 1000
        return results, elapsed_ms
    
    def _extract_domain(self, url: str) -> str:
        """URL에서 도메인 추출"""
        if not url:
            return ""
        try:
            from urllib.parse import urlparse
            return urlparse(url).netloc.replace("www.", "")
        except:
            return url

def generate_report(results: List[BenchmarkResult]) -> str:
    """벤치마크 리포트 생성"""
    lines = []
    lines.append("=" * 70)
    lines.append("📊 하이브리드 검색 벤치마크 리포트")
    lines.append("=" * 70)
    
    # 카테고리별 통계
    categories = {}
    for r in results:
        cat = r.category
        if cat not in categories:
            categories[cat] = {"local": 0, "cloud": 0, "hybrid": 0, "count": 0}
        categories[cat][r.winner] += 1
        categories[cat]["count"] += 1
    
    lines.append("\n📈 카테고리별 승패:")
    for cat, stats in categories.items():
        total = stats["count"]
        lines.append(f"\n  {cat.upper()} ({total}개 쿼리):")
        lines.append(f"    🏠 로컬: {stats['local']}승 ({stats['local']/total*100:.0f}%)")
        lines.append(f"    ☁️ 클라우드: {stats['cloud']}승 ({stats['cloud']/total*100:.0f}%)")
        lines.append(f"    🔗 하이브리드: {stats['hybrid']}승 ({stats['hybrid']/total*100:.0f}%)")
    
    # 전체 통계
    total = len(results)
    local_wins = sum(1 for r in results if r.winner == "local")
    cloud_wins = sum(1 for r in results if r.winner == "cloud")
    hybrid_wins = sum(1 for r in results if r.winner == "hybrid")
    
    lines.append(f"\n{'='*70}")
    lines.append(f"📊 전체 결과 ({total}개 쿼리)")
    lines.append(f"{'='*70}")
    lines.append(f"  🏠 로컬 승리: {local_wins} ({local_wins/total*100:.0f}%)")
    lines.append(f"  ☁️ 클라우드 승리: {cloud_wins} ({cloud_wins/total*100:.0f}%)")
    lines.append(f"  🔗 하이브리드 승리: {hybrid_wins} ({hybrid_wins/total*100:.0f}%)")
    
    # 평균 점수
    avg_local = sum(r.local_score for r in results) / total
    avg_cloud = sum(r.cloud_score for r in results) / total
    avg_hybrid = sum(r.hybrid_score for r in results) / total
    
    lines.append(f"\n📈 평균 점수:")
    lines.append(f"  🏠 로컬: {avg_local:.3f}")
    lines.append(f"  ☁️ 클라우드: {avg_cloud:.3f}")
    lines.append(f"  🔗 하이브리드: {avg_hybrid:.3f}")
    
    # 평균 속도
    avg_local_time = sum(r.local_time_ms for r in results) / total
    avg_cloud_time = sum(r.cloud_time_ms for r in results) / total
    avg_hybrid_time = sum(r.hybrid_time_ms for r in results) / total
    
    lines.append(f"\n⚡ 평균 속도:")
    lines.append(f"  🏠 로컬: {avg_local_time:.0f}ms")
    lines.append(f"  ☁️ 클라우드: {avg_cloud_time:.0f}ms")
    lines.append(f"  🔗 하이브리드: {avg_hybrid_time:.0f}ms")
    
    # 결론
    lines.append(f"\n{'='*70}")
    lines.append("💡 결론")
    lines.append(f"{'='*70}")
    
    best_method = max(
        {"local": avg_local, "cloud": avg_cloud, "hybrid": avg_hybrid}.items(),
        key=lambda x: x[1]
    )[0]
    
    lines.append(f"  최고 성능: {best_method.upper()}")
    lines.append(f"  - 평균 점수: {max(avg_local, avg_cloud, avg_hybrid):.3f}")
    lines.append(f"  - 평균 속도: {min(avg_local_time, avg_cloud_time, avg_hybrid_time):.0f}ms")
    
    if best_method == "hybrid":
        lines.append(f"\n  ✅ 하이브리드 검색이 로컬과 클라우드의 장점을 결합하여 최고 성능을 달성했습니다!")
    elif best_method == "local":
        lines.append(f"\n  ✅ 로컬 인덱스가 빠르고 정확합니다. 클라우드 폴백은 불필요할 수 있습니다.")
    
    return "\n".join(lines)

def main():
    import argparse
    
    parser = argparse.ArgumentParser(description="하이브리드 검색 벤치마크")
    parser.add_argument("--local-db", default="./local-index/chroma-data", help="로컬 DB 경로")
    parser.add_argument("--output", default="benchmark-hybrid-results.json", help="결과 저장 경로")
    parser.add_argument("--verbose", "-v", action="store_true", help="상세 출력")
    
    args = parser.parse_args()
    
    print("🚀 하이브리드 검색 벤치마크 시작")
    print(f"   테스트 쿼리: {len(TEST_QUERIES)}개")
    print(f"   로컬 DB: {args.local_db}")
    print()
    
    benchmark = HybridBenchmark(local_db_path=args.local_db)
    results = benchmark.run_benchmark()
    
    # 리포트 출력
    report = generate_report(results)
    print("\n" + report)
    
    # JSON 저장
    output = {
        "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_queries": len(results),
        "results": [asdict(r) for r in results],
        "summary": {
            "local_wins": sum(1 for r in results if r.winner == "local"),
            "cloud_wins": sum(1 for r in results if r.winner == "cloud"),
            "hybrid_wins": sum(1 for r in results if r.winner == "hybrid"),
            "avg_local_score": sum(r.local_score for r in results) / len(results),
            "avg_cloud_score": sum(r.cloud_score for r in results) / len(results),
            "avg_hybrid_score": sum(r.hybrid_score for r in results) / len(results),
        }
    }
    
    with open(args.output, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    print(f"\n📄 결과 저장: {args.output}")

if __name__ == "__main__":
    main()
