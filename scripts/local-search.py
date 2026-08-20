#!/usr/bin/env python3
"""
로컬 검색 스크립트 - ChromaDB PersistentClient + Ollama
서버 없이 로컬에서 검색
"""

import argparse
import json
import time
import requests
from typing import List, Dict, Any

# ChromaDB는 PersistentClient 사용
import chromadb

# 설정
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
COLLECTION_NAME = "search-index"
CHROMA_PATH = "./local-index/chroma-data"


class LocalSearcher:
    def __init__(self, chroma_path: str = CHROMA_PATH, ollama_url: str = OLLAMA_URL):
        self.ollama_url = ollama_url
        self.client = chromadb.PersistentClient(path=chroma_path)
        self.collection = None

    def init_collection(self) -> bool:
        """ChromaDB 컬렉션 연결"""
        try:
            self.collection = self.client.get_collection(name=COLLECTION_NAME)
            print(f"✅ 컬렉션 연결: {COLLECTION_NAME}")
            return True
        except Exception as e:
            print(f"❌ 컬렉션 없음: {e}")
            return False

    def get_embedding(self, text: str) -> List[float]:
        """Ollama로 임베딩 생성"""
        try:
            response = requests.post(
                f"{self.ollama_url}/api/embeddings",
                json={"model": EMBEDDING_MODEL, "prompt": text},
            )
            if response.status_code == 200:
                return response.json().get("embedding", [])
            else:
                print(f"⚠️ 임베딩 생성 실패: {response.text}")
                return []
        except Exception as e:
            print(f"⚠️ Ollama 연결 실패: {e}")
            return []

    def search(self, query: str, n_results: int = 10) -> List[Dict[str, Any]]:
        """검색 실행"""
        try:
            query_embedding = self.get_embedding(query)
            if not query_embedding:
                return []

            results = self.collection.query(
                query_embeddings=[query_embedding],
                n_results=n_results,
                include=["documents", "metadatas", "distances"],
            )

            output = []
            if results.get("ids") and results["ids"][0]:
                for i, doc_id in enumerate(results["ids"][0]):
                    output.append(
                        {
                            "id": doc_id,
                            "score": 1 - results["distances"][0][i],
                            "document": results["documents"][0][i]
                            if results.get("documents")
                            else "",
                            "metadata": results["metadatas"][0][i]
                            if results.get("metadatas")
                            else {},
                        }
                    )
            return output

        except Exception as e:
            print(f"❌ 검색 오류: {e}")
            return []

    def get_stats(self) -> Dict[str, Any]:
        """인덱스 통계"""
        if self.collection:
            return {"collection": COLLECTION_NAME, "count": self.collection.count()}
        return {"collection": COLLECTION_NAME, "count": 0}


def main():
    parser = argparse.ArgumentParser(description="로컬 검색 스크립트")
    parser.add_argument("--search", "-s", required=True, help="검색 쿼리")
    parser.add_argument("--limit", "-n", type=int, default=10, help="검색 결과 수")
    parser.add_argument("--json", "-j", action="store_true", help="JSON 형식으로 출력")
    parser.add_argument("--stats", action="store_true", help="인덱스 통계 출력")

    args = parser.parse_args()

    searcher = LocalSearcher()

    if args.stats:
        if searcher.init_collection():
            stats = searcher.get_stats()
            print(f"\n📊 인덱스 통계:")
            print(f"   컬렉션: {stats['collection']}")
            print(f"   문서 수: {stats['count']}")
        return

    if not searcher.init_collection():
        print("❌ 컬렉션 연결 실패. 먼저 인덱싱을 실행하세요.")
        return

    print(f"\n🔍 검색: {args.search}")
    print(f"   결과 수: {args.limit}")
    print()

    start_time = time.time()
    results = searcher.search(args.search, args.limit)
    elapsed = time.time() - start_time

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        print(f"{'='*60}")
        print(f"✅ 검색 완료 ({elapsed:.3f}초, {len(results)}개 결과)")
        print(f"{'='*60}\n")

        for i, result in enumerate(results):
            metadata = result.get("metadata", {})
            url = metadata.get("url", "N/A")
            title = metadata.get("title", "N/A")
            score = result.get("score", 0)

            print(f"{i+1}. [{score:.4f}] {title}")
            print(f"   URL: {url}")
            doc = result.get("document", "")
            print(f"   문서: {doc[:120]}...")
            print()


if __name__ == "__main__":
    main()
