#!/usr/bin/env python3
"""
로컬 인덱스 vs Cloudflare 인덱스 검색 품질 벤치마크

비교 항목:
  1. 검색 정확도 (관련성 점수)
  2. 응답 속도
  3. 커버리지 (검색 결과 수)
  4. 도메인 다양성
  5. 언어별 성능
  6. 카테고리별 성능
"""

import argparse
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import urlparse

import ollama
import chromadb
import requests

# ============================================================
# 설정
# ============================================================

OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
CHROMA_PATH = "local-index/chroma-data-v2"
CLOUDFLARE_API = "https://search-engine-api.pages.dev/api"
API_KEY = None  # 나중에 설정

# ============================================================
# 테스트 쿼리
# ============================================================

TEST_QUERIES = {
    "tech-en": [
        {"query": "react hooks tutorial", "expected_domains": ["react.dev", "reactjs.org"]},
        {"query": "python async await", "expected_domains": ["docs.python.org"]},
        {"query": "docker compose networking", "expected_domains": ["docs.docker.com"]},
        {"query": "kubernetes pod lifecycle", "expected_domains": ["kubernetes.io"]},
        {"query": "typescript generics", "expected_domains": ["typescriptlang.org"]},
        {"query": "tailwind css grid", "expected_domains": ["tailwindcss.com"]},
        {"query": "nextjs app router", "expected_domains": ["nextjs.org"]},
        {"query": "vue composition api", "expected_domains": ["vuejs.org"]},
        {"query": "svelte stores", "expected_domains": ["svelte.dev"]},
        {"query": "rust ownership borrowing", "expected_domains": ["rust-lang.org"]},
    ],
    "tech-ko": [
        {"query": "삼성전자 반도체 기술", "expected_domains": ["samsung.com"]},
        {"query": "네이버 개발자 API", "expected_domains": ["developers.naver.com"]},
        {"query": "카카오 클라우드", "expected_domains": ["kakaocloud.com"]},
        {"query": "코딩 테스트 준비", "expected_domains": ["programmers.co.kr", "boj.kr"]},
        {"query": "리눅스 서버 설정", "expected_domains": []},
    ],
    "news": [
        {"query": "AI startup funding 2026", "expected_domains": ["techcrunch.com"]},
        {"query": "global economy outlook", "expected_domains": ["bloomberg.com", "reuters.com"]},
        {"query": "한국 경제 전망", "expected_domains": ["mk.co.kr", "hankyung.com"]},
        {"query": "tech layoffs latest", "expected_domains": []},
        {"query": "crypto market news", "expected_domains": []},
    ],
    "science": [
        {"query": "machine learning research paper", "expected_domains": ["arxiv.org"]},
        {"query": "quantum computing breakthrough", "expected_domains": []},
        {"query": "climate change data", "expected_domains": ["nature.com"]},
        {"query": "neural network architecture", "expected_domains": ["arxiv.org"]},
        {"query": "CRISPR gene editing", "expected_domains": []},
    ],
    "general": [
        {"query": "best programming language 2026", "expected_domains": []},
        {"query": "how to learn coding", "expected_domains": ["freecodecamp.org", "codecademy.com"]},
        {"query": "remote work tools", "expected_domains": []},
        {"query": "productivity apps", "expected_domains": []},
        {"query": "open source projects", "expected_domains": ["github.com"]},
    ],
}


# ============================================================
# 로컬 인덱스 검색
# ============================================================

class LocalIndexSearch:
    """ChromaDB 기반 로컬 검색"""
    
    def __init__(self):
        self.client = chromadb.PersistentClient(path=CHROMA_PATH)
        self.collections = {}
        
        # 모든 컬렉션 로드
        for col in self.client.list_collections():
            self.collections[col.name] = col
    
    def search(self, query: str, top_k: int = 10) -> Dict:
        """검색 실행"""
        start_time = time.time()
        
        # 임베딩 생성
        try:
            response = ollama.embeddings(model=EMBEDDING_MODEL, prompt=query)
            query_embedding = response["embedding"]
        except Exception as e:
            return {"error": str(e), "results": [], "latency_ms": 0}
        
        # 모든 컬렉션에서 검색
        all_results = []
        for name, col in self.collections.items():
            try:
                results = col.query(
                    query_embeddings=[query_embedding],
                    n_results=min(top_k, col.count()),
                    include=["documents", "metadatas", "distances"],
                )
                
                if results["ids"] and results["ids"][0]:
                    for i, (id, doc, meta, dist) in enumerate(zip(
                        results["ids"][0],
                        results["documents"][0],
                        results["metadatas"][0],
                        results["distances"][0],
                    )):
                        all_results.append({
                            "id": id,
                            "title": meta.get("title", ""),
                            "url": meta.get("url", ""),
                            "content": doc[:500] if doc else "",
                            "score": 1 - dist,  # 거리를 점수로 변환
                            "collection": name,
                            "domain": urlparse(meta.get("url", "")).netloc,
                        })
            except Exception as e:
                continue
        
        # 점수순 정렬
        all_results.sort(key=lambda x: x["score"], reverse=True)
        all_results = all_results[:top_k]
        
        latency_ms = (time.time() - start_time) * 1000
        
        return {
            "results": all_results,
            "total": len(all_results),
            "latency_ms": latency_ms,
            "collections_searched": len(self.collections),
        }


# ============================================================
# Cloudflare 인덱스 검색
# ============================================================

class CloudflareIndexSearch:
    """Cloudflare Vectorize 기반 검색"""
    
    def __init__(self, api_key: Optional[str] = None):
        self.api_url = f"{CLOUDFLARE_API}/index/search"
        self.api_key = api_key or os.getenv("SEARCH_API_KEY")
    
    def search(self, query: str, top_k: int = 10) -> Dict:
        """검색 실행"""
        start_time = time.time()
        
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["X-API-Key"] = self.api_key
        
        try:
            response = requests.get(
                self.api_url,
                params={"q": query, "limit": top_k},
                headers=headers,
                timeout=10,
            )
            
            if response.status_code == 200:
                data = response.json()
                results = []
                
                for r in data.get("results", []):
                    results.append({
                        "id": r.get("id", ""),
                        "title": r.get("title", ""),
                        "url": r.get("url", ""),
                        "content": r.get("content", "")[:500],
                        "score": r.get("score", 0),
                        "collection": "cloudflare",
                        "domain": urlparse(r.get("url", "")).netloc,
                    })
                
                latency_ms = (time.time() - start_time) * 1000
                
                return {
                    "results": results,
                    "total": len(results),
                    "latency_ms": latency_ms,
                    "collections_searched": 1,
                }
            else:
                return {"error": f"HTTP {response.status_code}", "results": [], "latency_ms": 0}
        except Exception as e:
            return {"error": str(e), "results": [], "latency_ms": 0}


# ============================================================
# 벤치마크 평가
# ============================================================

def evaluate_results(
    query: str,
    results: List[Dict],
    expected_domains: List[str],
) -> Dict:
    """검색 결과 평가"""
    
    if not results:
        return {
            "precision": 0,
            "recall": 0,
            "mrr": 0,
            "ndcg": 0,
            "domain_coverage": 0,
            "avg_score": 0,
        }
    
    # 도메인 매칭
    matched_domains = set()
    first_match_rank = None
    
    for i, r in enumerate(results):
        domain = r.get("domain", "")
        if domain:
            matched_domains.add(domain)
        
        if expected_domains and domain in expected_domains:
            if first_match_rank is None:
                first_match_rank = i + 1
    
    # Precision@10
    relevant_count = sum(1 for r in results if r.get("score", 0) > 0.5)
    precision = relevant_count / len(results) if results else 0
    
    # Recall (예상 도메인 중 найденные)
    if expected_domains:
        found = sum(1 for d in expected_domains if d in matched_domains)
        recall = found / len(expected_domains)
    else:
        recall = 1.0  # 예상 도메인이 없으면 완료
    
    # MRR (Mean Reciprocal Rank)
    mrr = 1 / first_match_rank if first_match_rank else 0
    
    # NDCG@10 (간단한 버전)
    # 관련 문서가 상위에 있으면 높은 점수
    dcg = sum(1 / (i + 2) for i, r in enumerate(results) if r.get("score", 0) > 0.5)
    ideal_dcg = sum(1 / (i + 2) for i in range(min(10, len(results))))
    ndcg = dcg / ideal_dcg if ideal_dcg > 0 else 0
    
    # 도메인 커버리지
    unique_domains = len(set(r.get("domain", "") for r in results if r.get("domain")))
    domain_coverage = unique_domains / len(results) if results else 0
    
    # 평균 점수
    avg_score = sum(r.get("score", 0) for r in results) / len(results)
    
    return {
        "precision": precision,
        "recall": recall,
        "mrr": mrr,
        "ndcg": ndcg,
        "domain_coverage": domain_coverage,
        "avg_score": avg_score,
        "unique_domains": unique_domains,
        "first_match_rank": first_match_rank,
    }


# ============================================================
# 메인 벤치마크
# ============================================================

class BenchmarkRunner:
    """벤치마크 실행기"""
    
    def __init__(self, local_search, cloudflare_search):
        self.local = local_search
        self.cloudflare = cloudflare_search
        self.results = {
            "local": [],
            "cloudflare": [],
            "timestamp": datetime.now().isoformat(),
        }
    
    def run_benchmark(self, queries: Dict[str, List[Dict]], top_k: int = 10):
        """벤치마크 실행"""
        print("🚀 검색 품질 벤치마크 시작")
        print("=" * 60)
        
        total_queries = sum(len(v) for v in queries.values())
        current = 0
        
        for category, query_list in queries.items():
            print(f"\n📂 카테고리: {category}")
            print("-" * 40)
            
            for q in query_list:
                current += 1
                query = q["query"]
                expected = q.get("expected_domains", [])
                
                print(f"  [{current}/{total_queries}] {query}")
                
                # 로컬 검색
                local_result = self.local.search(query, top_k)
                local_eval = evaluate_results(query, local_result.get("results", []), expected)
                
                # Cloudflare 검색
                cf_result = self.cloudflare.search(query, top_k)
                cf_eval = evaluate_results(query, cf_result.get("results", []), expected)
                
                # 결과 저장
                self.results["local"].append({
                    "category": category,
                    "query": query,
                    "expected_domains": expected,
                    "metrics": local_eval,
                    "latency_ms": local_result.get("latency_ms", 0),
                    "result_count": local_result.get("total", 0),
                })
                
                self.results["cloudflare"].append({
                    "category": category,
                    "query": query,
                    "expected_domains": expected,
                    "metrics": cf_eval,
                    "latency_ms": cf_result.get("latency_ms", 0),
                    "result_count": cf_result.get("total", 0),
                })
                
                # 출력
                print(f"    로컬: NDCG={local_eval['ndcg']:.3f}, MRR={local_eval['mrr']:.3f}, "
                      f"속도={local_result.get('latency_ms', 0):.0f}ms")
                print(f"    클라우드: NDCG={cf_eval['ndcg']:.3f}, MRR={cf_eval['mrr']:.3f}, "
                      f"속도={cf_result.get('latency_ms', 0):.0f}ms")
        
        # 전체 결과 요약
        self._print_summary()
    
    def _print_summary(self):
        """결과 요약 출력"""
        print("\n" + "=" * 60)
        print("📊 벤치마크 결과 요약")
        print("=" * 60)
        
        for source in ["local", "cloudflare"]:
            data = self.results[source]
            if not data:
                continue
            
            # 전체 평균
            avg_ndcg = sum(d["metrics"]["ndcg"] for d in data) / len(data)
            avg_mrr = sum(d["metrics"]["mrr"] for d in data) / len(data)
            avg_precision = sum(d["metrics"]["precision"] for d in data) / len(data)
            avg_latency = sum(d["latency_ms"] for d in data) / len(data)
            avg_results = sum(d["result_count"] for d in data) / len(data)
            
            print(f"\n{'로컬 인덱스' if source == 'local' else 'Cloudflare 인덱스'}:")
            print(f"  NDCG@10: {avg_ndcg:.3f}")
            print(f"  MRR: {avg_mrr:.3f}")
            print(f"  Precision@10: {avg_precision:.3f}")
            print(f"  평균 속도: {avg_latency:.0f}ms")
            print(f"  평균 결과 수: {avg_results:.1f}")
            
            # 카테고리별
            categories = set(d["category"] for d in data)
            print(f"\n  카테고리별:")
            for cat in sorted(categories):
                cat_data = [d for d in data if d["category"] == cat]
                cat_ndcg = sum(d["metrics"]["ndcg"] for d in cat_data) / len(cat_data)
                cat_latency = sum(d["latency_ms"] for d in cat_data) / len(cat_data)
                print(f"    {cat}: NDCG={cat_ndcg:.3f}, 속도={cat_latency:.0f}ms")
        
        # 승자 비교
        local_avg = sum(d["metrics"]["ndcg"] for d in self.results["local"]) / len(self.results["local"])
        cf_avg = sum(d["metrics"]["ndcg"] for d in self.results["cloudflare"]) / len(self.results["cloudflare"])
        
        print(f"\n{'='*60}")
        print(f"🏆 승자: {'로컬 인덱스' if local_avg > cf_avg else 'Cloudflare 인덱스'}")
        print(f"   로컬 NDCG: {local_avg:.3f} vs 클라우드 NDCG: {cf_avg:.3f}")
        print(f"   차이: {abs(local_avg - cf_avg):.3f} ({'로컬' if local_avg > cf_avg else '클라우드'} 우위)")
    
    def save_results(self, output_file: str):
        """결과 저장"""
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(self.results, f, indent=2, ensure_ascii=False)
        print(f"\n💾 결과 저장: {output_file}")


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="로컬 vs Cloudflare 검색 품질 벤치마크")
    parser.add_argument("--top-k", type=int, default=10, help="상위 K개 결과")
    parser.add_argument("--output", default="local-index/benchmark-index-quality.json", help="결과 파일")
    parser.add_argument("--category", help="특정 카테고리만 테스트")
    parser.add_argument("--api-key", help="Cloudflare API 키")
    
    args = parser.parse_args()
    
    # 검색 엔진 초기화
    local = LocalIndexSearch()
    cloudflare = CloudflareIndexSearch(args.api_key)
    
    # 테스트 쿼리 필터링
    queries = TEST_QUERIES
    if args.category:
        if args.category in queries:
            queries = {args.category: queries[args.category]}
        else:
            print(f"❌ 카테고리 '{args.category}'를 찾을 수 없습니다.")
            print(f"   사용 가능한 카테고리: {list(TEST_QUERIES.keys())}")
            sys.exit(1)
    
    # 벤치마크 실행
    runner = BenchmarkRunner(local, cloudflare)
    runner.run_benchmark(queries, args.top_k)
    
    # 결과 저장
    runner.save_results(args.output)


if __name__ == "__main__":
    main()
