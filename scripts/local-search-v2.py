#!/usr/bin/env python3
"""
로컬 검색 스크립트 v2 — 실제 콘텐츠 기반 검색
ChromaDB PersistentClient + Ollama nomic-embed-text
"""

import argparse
import json
import time
from typing import Any, Dict, List

import chromadb
import requests

# ─── 설정 ──────────────────────────────────────────────
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
COLLECTION_NAME = "search-index-v2"
CHROMA_PATH = "./local-index/chroma-data-v2"
# --collection 옵션으로 변경 가능


def get_embedding(text: str) -> List[float]:
    """Ollama로 임베딩 생성"""
    try:
        resp = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBEDDING_MODEL, "prompt": text},
            timeout=10,
        )
        if resp.status_code == 200:
            return resp.json().get("embedding", [])
    except Exception:
        pass
    return []


def search(query: str, n_results: int = 10) -> List[Dict[str, Any]]:
    """로컬 검색 실행"""
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    collection = client.get_collection(name=COLLECTION_NAME)

    query_emb = get_embedding(query)
    if not query_emb:
        print("❌ 임베딩 생성 실패")
        return []

    results = collection.query(
        query_embeddings=[query_emb],
        n_results=n_results,
        include=["documents", "metadatas", "distances"],
    )

    output = []
    if results.get("ids") and results["ids"][0]:
        for i, doc_id in enumerate(results["ids"][0]):
            meta = results["metadatas"][0][i] if results.get("metadatas") else {}
            output.append(
                {
                    "id": doc_id,
                    "score": round(1 - results["distances"][0][i], 4),
                    "title": meta.get("title", ""),
                    "url": meta.get("url", ""),
                    "domain": meta.get("domain", ""),
                    "word_count": meta.get("word_count", 0),
                    "extraction_source": meta.get("extraction_source", ""),
                    "document": results["documents"][0][i] if results.get("documents") else "",
                }
            )
    return output


def main():
    parser = argparse.ArgumentParser(description="로컬 검색 v2")
    parser.add_argument("--search", "-s", required=True, help="검색 쿼리")
    parser.add_argument("--limit", "-n", type=int, default=10, help="결과 수")
    parser.add_argument("--json", "-j", action="store_true", help="JSON 출력")
    parser.add_argument("--stats", action="store_true", help="인덱스 통계")
    parser.add_argument("--verbose", "-v", action="store_true", help="본문 포함")

    args = parser.parse_args()

    if args.stats:
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        collection = client.get_collection(name=COLLECTION_NAME)
        print(f"📊 인덱스 통계:")
        print(f"   컬렉션: {COLLECTION_NAME}")
        print(f"   문서 수: {collection.count()}")
        return

    print(f"🔍 검색: {args.search}")
    start = time.time()
    results = search(args.search, args.limit)
    elapsed = time.time() - start

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return

    print(f"   결과: {len(results)}개 ({elapsed:.3f}초)\n")
    print(f"{'='*70}")

    for i, r in enumerate(results):
        print(f"\n{i+1}. [{r['score']}] {r['title']}")
        print(f"   URL: {r['url']}")
        print(f"   도메인: {r['domain']} | 단어수: {r['word_count']} | 추출: {r['extraction_source']}")
        if args.verbose:
            doc = r["document"]
            print(f"   본문: {doc[:300]}...")
        else:
            doc = r["document"]
            print(f"   미리보기: {doc[:150]}...")

    print(f"\n{'='*70}")


if __name__ == "__main__":
    main()
