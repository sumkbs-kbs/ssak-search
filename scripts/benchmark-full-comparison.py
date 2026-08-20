#!/usr/bin/env python3
"""
로컬 인덱스 vs 외부 검색 엔진 품질 비교

비교 대상:
  1. 로컬 인덱스 (ChromaDB + Ollama)
  2. DuckDuckGo (무료)
  3. Bing (무료, 제한적)
  4. Google (API 키 필요)
"""

import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional
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

# ============================================================
# 테스트 쿼리 (간소화)
# ============================================================

TEST_QUERIES = [
    {"query": "react hooks tutorial", "category": "tech"},
    {"query": "python async await", "category": "tech"},
    {"query": "docker compose networking", "category": "tech"},
    {"query": "kubernetes pod lifecycle", "category": "tech"},
    {"query": "typescript generics", "category": "tech"},
    {"query": "tailwind css grid", "category": "tech"},
    {"query": "nextjs app router", "category": "tech"},
    {"query": "vue composition api", "category": "tech"},
    {"query": "AI startup funding", "category": "news"},
    {"query": "global economy outlook", "category": "news"},
    {"query": "machine learning research", "category": "science"},
    {"query": "quantum computing", "category": "science"},
    {"query": "best programming language", "category": "general"},
    {"query": "how to learn coding", "category": "general"},
    {"query": "open source projects", "category": "general"},
]


# ============================================================
# 검색 엔진 클래스
# ============================================================

class LocalIndex:
    """ChromaDB 로컬 검색"""
    
    def __init__(self):
        self.client = chromadb.PersistentClient(path=CHROMA_PATH)
        self.collections = {col.name: col for col in self.client.list_collections()}
    
    def search(self, query: str, top_k: int = 10) -> Dict:
        start = time.time()
        
        try:
            response = ollama.embeddings(model=EMBEDDING_MODEL, prompt=query)
            embedding = response["embedding"]
        except Exception as e:
            return {"error": str(e), "results": [], "latency_ms": 0}
        
        all_results = []
        for name, col in self.collections.items():
            try:
                results = col.query(
                    query_embeddings=[embedding],
                    n_results=min(top_k, col.count()),
                    include=["metadatas", "distances"],
                )
                if results["ids"] and results["ids"][0]:
                    for meta, dist in zip(results["metadatas"][0], results["distances"][0]):
                        all_results.append({
                            "title": meta.get("title", ""),
                            "url": meta.get("url", ""),
                            "score": 1 - dist,
                            "domain": urlparse(meta.get("url", "")).netloc,
                        })
            except:
                continue
        
        all_results.sort(key=lambda x: x["score"], reverse=True)
        latency = (time.time() - start) * 1000
        
        return {"results": all_results[:top_k], "latency_ms": latency}


class DuckDuckGoSearch:
    """DuckDuckGo HTML 검색"""
    
    def search(self, query: str, top_k: int = 10) -> Dict:
        start = time.time()
        
        try:
            from duckduckgo_search import DDGS
            
            with DDGS() as ddgs:
                results = []
                for r in ddgs.text(query, max_results=top_k):
                    results.append({
                        "title": r.get("title", ""),
                        "url": r.get("href", ""),
                        "score": 0.8,  # DuckDuckGo는 점수 미제공
                        "domain": urlparse(r.get("href", "")).netloc,
                    })
            
            latency = (time.time() - start) * 1000
            return {"results": results, "latency_ms": latency}
        except Exception as e:
            return {"error": str(e), "results": [], "latency_ms": 0}


class BraveSearch:
    """Brave Search API (무료, 키 불필요)"""
    
    def search(self, query: str, top_k: int = 10) -> Dict:
        start = time.time()
        
        try:
            headers = {
                "Accept": "application/json",
                "Accept-Encoding": "gzip",
                "User-Agent": "Mozilla/5.0",
            }
            
            response = requests.get(
                "https://search.brave.com/api/suggest",
                params={"q": query},
                headers=headers,
                timeout=5,
            )
            
            # Brave suggest는 자동완성만 제공
            # 대안: DuckDuckGo lite 사용
            return {"error": "Brave API 제한", "results": [], "latency_ms": 0}
        except Exception as e:
            return {"error": str(e), "results": [], "latency_ms": 0}


class GoogleSearch:
    """Google Custom Search (API 키 필요)"""
    
    def __init__(self, api_key: Optional[str] = None, cx: Optional[str] = None):
        self.api_key = api_key or os.getenv("GOOGLE_API_KEY")
        self.cx = cx or os.getenv("GOOGLE_CX")
    
    def search(self, query: str, top_k: int = 10) -> Dict:
        if not self.api_key or not self.cx:
            return {"error": "API 키 미설정", "results": [], "latency_ms": 0}
        
        start = time.time()
        
        try:
            response = requests.get(
                "https://www.googleapis.com/customsearch/v1",
                params={
                    "key": self.api_key,
                    "cx": self.cx,
                    "q": query,
                    "num": min(top_k, 10),
                },
                timeout=5,
            )
            
            if response.status_code == 200:
                data = response.json()
                results = []
                for item in data.get("items", []):
                    results.append({
                        "title": item.get("title", ""),
                        "url": item.get("link", ""),
                        "score": 0.9,
                        "domain": urlparse(item.get("link", "")).netloc,
                    })
                
                latency = (time.time() - start) * 1000
                return {"results": results, "latency_ms": latency}
            else:
                return {"error": f"HTTP {response.status_code}", "results": [], "latency_ms": 0}
        except Exception as e:
            return {"error": str(e), "results": [], "latency_ms": 0}


# ============================================================
# 평가 함수
# ============================================================

def evaluate(results: List[Dict], query: str) -> Dict:
    """간단한 평가"""
    if not results:
        return {"count": 0, "avg_score": 0, "unique_domains": 0}
    
    domains = set(r.get("domain", "") for r in results if r.get("domain"))
    avg_score = sum(r.get("score", 0) for r in results) / len(results)
    
    return {
        "count": len(results),
        "avg_score": avg_score,
        "unique_domains": len(domains),
        "domains": list(domains)[:5],
    }


# ============================================================
# 메인
# ============================================================

def main():
    print("🚀 검색 엔진 비교 벤치마크")
    print("=" * 60)
    
    # 검색 엔진 초기화
    engines = {
        "local": LocalIndex(),
        "duckduckgo": DuckDuckGoSearch(),
    }
    
    # DuckDuckGo 설치 확인
    try:
        from duckduckgo_search import DDGS
        print("✅ DuckDuckGo 사용 가능")
    except ImportError:
        print("⚠️ DuckDuckGo 미설치 - pip install duckduckgo_search")
        del engines["duckduckgo"]
    
    # 벤치마크 실행
    results = {name: [] for name in engines}
    
    for i, q in enumerate(TEST_QUERIES):
        query = q["query"]
        category = q["category"]
        
        print(f"\n[{i+1}/{len(TEST_QUERIES)}] {query}")
        
        for name, engine in engines.items():
            result = engine.search(query, top_k=10)
            eval_result = evaluate(result.get("results", []), query)
            
            results[name].append({
                "query": query,
                "category": category,
                "eval": eval_result,
                "latency_ms": result.get("latency_ms", 0),
            })
            
            print(f"  {name}: {eval_result['count']}건, "
                  f"점수={eval_result['avg_score']:.3f}, "
                  f"도메인={eval_result['unique_domains']}, "
                  f"속도={result.get('latency_ms', 0):.0f}ms")
    
    # 결과 요약
    print("\n" + "=" * 60)
    print("📊 비교 결과 요약")
    print("=" * 60)
    
    for name, data in results.items():
        if not data:
            continue
        
        avg_count = sum(d["eval"]["count"] for d in data) / len(data)
        avg_score = sum(d["eval"]["avg_score"] for d in data) / len(data)
        avg_latency = sum(d["latency_ms"] for d in data) / len(data)
        avg_domains = sum(d["eval"]["unique_domains"] for d in data) / len(data)
        
        print(f"\n{name.upper()}:")
        print(f"  평균 결과 수: {avg_count:.1f}")
        print(f"  평균 점수: {avg_score:.3f}")
        print(f"  평균 도메인: {avg_domains:.1f}")
        print(f"  평균 속도: {avg_latency:.0f}ms")
    
    # 카테고리별 비교
    categories = set(q["category"] for q in TEST_QUERIES)
    print("\n카테고리별:")
    for cat in sorted(categories):
        print(f"\n  {cat}:")
        for name, data in results.items():
            cat_data = [d for d in data if d["category"] == cat]
            if cat_data:
                avg_score = sum(d["eval"]["avg_score"] for d in cat_data) / len(cat_data)
                avg_latency = sum(d["latency_ms"] for d in cat_data) / len(cat_data)
                print(f"    {name}: 점수={avg_score:.3f}, 속도={avg_latency:.0f}ms")
    
    # 결과 저장
    output_file = "local-index/benchmark-engines.json"
    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(results, f, indent=2, ensure_ascii=False)
    print(f"\n💾 결과 저장: {output_file}")


if __name__ == "__main__":
    main()
