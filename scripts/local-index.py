#!/usr/bin/env python3
"""
로컬 인덱싱 파이프라인 - ChromaDB PersistentClient + Ollama
서버 없이 로컬에서 검색 인덱스 구축
"""

import argparse
import json
import time
import hashlib
import requests
from pathlib import Path
from typing import List, Dict, Any, Optional

# ChromaDB는 PersistentClient 사용 (서버 불필요)
import chromadb

# 설정
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
COLLECTION_NAME = "search-index"
CHROMA_PATH = "./local-index/chroma-data"

# 시드 URL 데이터
SEED_URLS = {
    "tech-docs": [
        "https://developers.cloudflare.com/",
        "https://react.dev/",
        "https://vuejs.org/",
        "https://angular.io/",
        "https://svelte.dev/",
        "https://nextjs.org/",
        "https://nuxt.com/",
        "https://astro.build/",
        "https://remix.run/",
        "https://expressjs.com/",
        "https://fastify.dev/",
        "https://hono.dev/",
        "https://docs.docker.com/",
        "https://kubernetes.io/docs/",
        "https://terraform.io/docs/",
        "https://aws.amazon.com/docs/",
        "https://cloud.google.com/docs/",
        "https://learn.microsoft.com/",
        "https://developer.mozilla.org/",
        "https://typescriptlang.org/docs/",
        "https://graphql.org/learn/",
        "https://tailwindcss.com/",
        "https://vitejs.dev/",
        "https://vitest.dev/",
        "https://playwright.dev/",
        "https://cypress.io/",
        "https://jestjs.io/",
        "https://mochajs.org/",
        "https://eslint.org/",
        "https://prettier.io/",
        "https://webpack.js.org/",
        "https://rollupjs.org/",
        "https://esbuild.github.io/",
        "https://parceljs.org/",
    ],
    "programming": [
        "https://docs.python.org/3/",
        "https://doc.rust-lang.org/book/",
        "https://go.dev/doc/",
        "https://docs.oracle.com/en/java/",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
        "https://docs.swift.org/swift-book/",
        "https://kotlinlang.org/docs/",
        "https://dart.dev/",
        "https://elixir-lang.org/learn/",
        "https://www.haskell.org/tutorial/",
        "https://clojure.org/guides/getting_started",
        "https://scala-lang.org/documentation/",
        "https://learn.microsoft.com/dotnet/",
        "https://www.gnu.org/software/bash/manual/",
        "https://docs.gitlab.com/ee/",
        "https://docs.github.com/en",
    ],
    "news-intl": [
        "https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml",
        "https://feeds.bbci.co.uk/news/rss.xml",
        "https://www.theguardian.com/world/rss",
        "https://feeds.washingtonpost.com/rss/world",
        "https://www.aljazeera.com/xml/rss/all.xml",
        "https://rss.cnn.com/rss/edition.rss",
        "https://feeds.skynews.com/feeds/rss/world.xml",
        "https://www.france24.com/en/rss",
        "https://www.dw.com/en/rss/s-30978029",
    ],
    "news-kr": [
        "https://rss.naver.com/rss.xml",
        "https://www.chosun.com/arc/outboundfeeds/rss/",
        "https://www.joongang.co.kr/rss",
        "https://www.hankyung.com/rss/all-news",
        "https://www.mk.co.kr/rss/30100041/",
        "https://www.donga.com/news/RSS",
        "https://www.seoul.co.kr/rss/news.xml",
        "https://www.khan.co.kr/rss/rss_data/kh_latest.xml",
        "https://www.news1.kr/rss/",
    ],
    "news-jp": [
        "https://www.asahi.com/rss/",
        "https://www.yomiuri.co.jp/rss/",
        "https://www.nikkei.com/rss/",
        "https://mainichi.jp/rss/",
        "https://www.sankei.com/rss/",
        "https://www.tokyo-np.co.jp/rss/",
    ],
    "news-cn": [
        "https://www.sina.com.cn/rss/",
        "https://news.qq.com/rss/",
        "https://www.36kr.com/feed",
        "https://www.ifanr.com/feed",
        "https://sspai.com/feed",
        "https://www.huxiu.com/rss/",
        "https://www.chinanews.com.cn/rss/",
    ],
    "science": [
        "https://www.nature.com/nature.rss",
        "https://arxiv.org/rss/cs.AI",
        "https://arxiv.org/rss/cs.CL",
        "https://arxiv.org/rss/cs.LG",
        "https://arxiv.org/rss/cs.CV",
        "https://arxiv.org/rss/cs.SE",
    ],
}


class LocalIndexer:
    def __init__(self, chroma_path: str = CHROMA_PATH, ollama_url: str = OLLAMA_URL):
        self.ollama_url = ollama_url
        # PersistentClient 사용 (서버 불필요)
        self.client = chromadb.PersistentClient(path=chroma_path)
        self.collection = None

    def init_collection(self) -> bool:
        """ChromaDB 컬렉션 초기화"""
        try:
            self.collection = self.client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
            print(f"✅ 컬렉션 초기화: {COLLECTION_NAME} (ID: {self.collection.id})")
            return True
        except Exception as e:
            print(f"❌ 컬렉션 초기화 실패: {e}")
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

    def chunk_text(self, text: str, max_tokens: int = 300) -> List[str]:
        """텍스트 청킹 (단어 기반)"""
        words = text.split()
        chunks = []
        current_chunk = []

        for word in words:
            current_chunk.append(word)
            if len(current_chunk) >= max_tokens:
                chunks.append(" ".join(current_chunk))
                current_chunk = []

        if current_chunk:
            chunks.append(" ".join(current_chunk))

        return chunks if chunks else [text[:1000]]

    def index_url(self, url: str, title: str = "", content: str = "") -> bool:
        """단일 URL 인덱싱"""
        try:
            if not content:
                content = title or url

            chunks = self.chunk_text(content)

            for i, chunk in enumerate(chunks[:5]):  # 최대 5개 청크
                embedding = self.get_embedding(chunk)
                if not embedding:
                    continue

                doc_id = hashlib.md5(f"{url}_{i}".encode()).hexdigest()
                metadata = {
                    "url": url,
                    "title": title or url,
                    "chunk_index": i,
                    "domain": url.split("/")[2] if "/" in url else url,
                    "indexed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                }

                self.collection.upsert(
                    ids=[doc_id],
                    embeddings=[embedding],
                    metadatas=[metadata],
                    documents=[chunk],
                )

            print(f"✅ 인덱싱 완료: {url} ({len(chunks)}개 청크)")
            return True

        except Exception as e:
            print(f"❌ 인덱싱 실패 ({url}): {e}")
            return False

    def index_urls(self, urls: List[str], category: str = "all") -> Dict[str, Any]:
        """여러 URL 인덱싱"""
        results = {"success": 0, "failed": 0, "total": len(urls)}

        for i, url in enumerate(urls):
            print(f"\n[{i+1}/{len(urls)}] 인덱싱 중: {url}")

            if self.index_url(url, title=url, content=url):
                results["success"] += 1
            else:
                results["failed"] += 1

            time.sleep(0.5)

        return results

    def get_stats(self) -> Dict[str, Any]:
        """인덱스 통계"""
        if self.collection:
            return {
                "collection": COLLECTION_NAME,
                "count": self.collection.count(),
            }
        return {"collection": COLLECTION_NAME, "count": 0}


def main():
    parser = argparse.ArgumentParser(description="로컬 인덱싱 파이프라인")
    parser.add_argument(
        "--category",
        default="tech-docs",
        choices=list(SEED_URLS.keys()) + ["all"],
        help="인덱싱할 카테고리",
    )
    parser.add_argument("--limit", type=int, default=10, help="인덱싱할 URL 수 제한")
    parser.add_argument("--urls", nargs="+", help="직접 URL 목록 지정")
    parser.add_argument("--stats", action="store_true", help="인덱스 통계 출력")
    parser.add_argument("--clear", action="store_true", help="인덱스 초기화")

    args = parser.parse_args()

    indexer = LocalIndexer()

    if args.clear:
        indexer.init_collection()
        indexer.client.delete_collection(COLLECTION_NAME)
        print(f"🗑️ 컬렉션 삭제 완료: {COLLECTION_NAME}")
        return

    if not indexer.init_collection():
        return

    if args.stats:
        stats = indexer.get_stats()
        print(f"\n📊 인덱스 통계:")
        print(f"   컬렉션: {stats['collection']}")
        print(f"   문서 수: {stats['count']}")
        return

    # URL 목록 준비
    if args.urls:
        urls = args.urls
    elif args.category == "all":
        urls = []
        for cat_urls in SEED_URLS.values():
            urls.extend(cat_urls)
    else:
        urls = SEED_URLS.get(args.category, [])

    urls = urls[: args.limit]

    print(f"\n🚀 로컬 인덱싱 시작")
    print(f"   카테고리: {args.category}")
    print(f"   URL 수: {len(urls)}")
    print(f"   ChromaDB: {CHROMA_PATH} (PersistentClient)")
    print(f"   Ollama: {OLLAMA_URL}")
    print(f"   임베딩 모델: {EMBEDDING_MODEL}")
    print()

    start_time = time.time()
    results = indexer.index_urls(urls, args.category)
    elapsed = time.time() - start_time

    print(f"\n{'='*60}")
    print(f"✅ 인덱싱 완료!")
    print(f"   성공: {results['success']}/{results['total']}")
    print(f"   실패: {results['failed']}/{results['total']}")
    print(f"   소요 시간: {elapsed:.1f}초")
    print(f"{'='*60}")

    stats = indexer.get_stats()
    print(f"\n📊 현재 인덱스: {stats['count']}개 문서")


if __name__ == "__main__":
    main()
