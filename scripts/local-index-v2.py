#!/usr/bin/env python3
"""
로컬 인덱싱 파이프라인 v2 — 실제 콘텐츠 인덱싱
- Jina Reader API (r.jina.ai)로 깔끔한 마크다운 추출
- BeautifulSoup HTML 폴백
- 문단/헤더 기반 스마트 청킹
- ChromaDB PersistentClient + Ollama nomic-embed-text
"""

import argparse
import hashlib
import json
import re
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

import chromadb
import requests

# ─── 설정 ──────────────────────────────────────────────
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
COLLECTION_NAME = "search-index-v2"
CHROMA_PATH = "./local-index/chroma-data-v2"

JINA_READER_URL = "https://r.jina.ai/"
JINA_TIMEOUT = 15  # 초
CHUNK_MAX_TOKENS = 500  # 토큰 대략치 (단어 수 * 1.3)
CHUNK_MIN_CHARS = 80  # 최소 문자 수
BATCH_UPSERT = 20  # ChromaDB 배치 업서트 크기

# ─── 시드 URL 데이터 ────────────────────────────────────
SEED_URLS: Dict[str, List[str]] = {
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
    "science": [
        "https://www.nature.com/nature.rss",
        "https://arxiv.org/rss/cs.AI",
        "https://arxiv.org/rss/cs.CL",
        "https://arxiv.org/rss/cs.LG",
        "https://arxiv.org/rss/cs.CV",
        "https://arxiv.org/rss/cs.SE",
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
}


# ─── 콘텐츠 추출 ────────────────────────────────────────
def extract_via_jina(url: str, retries: int = 2) -> Optional[Dict[str, str]]:
    """Jina Reader API로 깔끔한 마크다운 추출 (무료, 키 불필요)"""
    for attempt in range(retries):
        try:
            resp = requests.get(
                f"{JINA_READER_URL}{url}",
                headers={"Accept": "text/markdown"},
                timeout=JINA_TIMEOUT,
            )
            if resp.status_code != 200:
                if attempt < retries - 1:
                    time.sleep(1)
                continue

            text = resp.text.strip()
            if not text or len(text) < 50:
                return None

            # Jina 형식: "Title: ...\nURL Source: ...\nMarkdown Content:\n..."
            title = ""
            content = text

            title_match = re.match(r"^Title:\s*(.+)$", text, re.MULTILINE)
            if title_match:
                title = title_match.group(1).strip()

            # Markdown Content: 이후 추출
            mc_idx = text.find("Markdown Content:")
            if mc_idx >= 0:
                content = text[mc_idx + len("Markdown Content:") :].strip()

            return {"title": title, "content": content, "source": "jina"}

        except Exception:
            if attempt < retries - 1:
                time.sleep(1)
            continue
    return None


def extract_via_beautifulsoup(url: str) -> Optional[Dict[str, str]]:
    """BeautifulSoup으로 HTML에서 텍스트 추출 (폴백)"""
    try:
        from bs4 import BeautifulSoup

        resp = requests.get(
            url,
            headers={
                "User-Agent": "Mozilla/5.0 (compatible; SearchBot/1.0)"
            },
            timeout=10,
            allow_redirects=True,
        )
        if resp.status_code != 200:
            return None

        content_type = resp.headers.get("Content-Type", "")
        if "text/html" not in content_type and "application/xhtml" not in content_type:
            # RSS/XML 등非 HTML — 텍스트 그대로 반환
            return {"title": url.split("/")[-1] or url, "content": resp.text[:5000], "source": "raw"}

        soup = BeautifulSoup(resp.text, "lxml")

        # 불필요한 태그 제거
        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe"]):
            tag.decompose()

        # 제목 추출
        title = ""
        if soup.title and soup.title.string:
            title = soup.title.string.strip()
        h1 = soup.find("h1")
        if h1:
            title = h1.get_text(strip=True) or title

        # 본문 텍스트 추출
        # article, main 태그 우선
        main = soup.find("article") or soup.find("main") or soup.find("body")
        if main is None:
            return None

        # 텍스트 추출 (줄바꿈 보존)
        text = main.get_text(separator="\n", strip=True)
        # 연속 빈 줄 제거
        text = re.sub(r"\n{3,}", "\n\n", text)

        if len(text) < 50:
            return None

        return {"title": title, "content": text[:10000], "source": "beautifulsoup"}

    except Exception:
        return None


def extract_content(url: str) -> Optional[Dict[str, str]]:
    """콘텐츠 추출 (Jina 우선, BeautifulSoup 폴백)"""
    # 1차: Jina Reader
    result = extract_via_jina(url)
    if result and len(result["content"]) > 100:
        return result

    # 2차: BeautifulSoup
    result = extract_via_beautifulsoup(url)
    if result and len(result["content"]) > 50:
        return result

    return None


# ─── 스마트 청킹 ────────────────────────────────────────
def smart_chunk(text: str, max_words: int = 400) -> List[str]:
    """
    마크다운/텍스트를 스마트하게 청킹
    - 헤더(##, ###) 기준 분할
    - 문단(\n\n) 기준 분할
    - 최소/최대 길이 유지
    """
    if not text or len(text) < CHUNK_MIN_CHARS:
        return [text] if text else []

    # 헤더 기준 1차 분할
    sections = re.split(r"\n(?=#{1,3}\s)", text)

    chunks: List[str] = []
    current = ""

    for section in sections:
        section = section.strip()
        if not section:
            continue

        section_words = len(section.split())

        # 섹션이 작으면 현재 청크에 합침
        if len(current.split()) + section_words < max_words:
            current = f"{current}\n\n{section}".strip() if current else section
        else:
            # 현재 청크를 저장하고 새 청크 시작
            if current and len(current) >= CHUNK_MIN_CHARS:
                chunks.append(current)
            # 섹션이 너무 크면 문단 기준 재분할
            if section_words > max_words:
                chunks.extend(_split_by_paragraphs(section, max_words))
                current = ""
            else:
                current = section

    if current and len(current) >= CHUNK_MIN_CHARS:
        chunks.append(current)

    return chunks if chunks else [text[:2000]]


def _split_by_paragraphs(text: str, max_words: int) -> List[str]:
    """문단 기준 재분할"""
    paragraphs = text.split("\n\n")
    chunks: List[str] = []
    current = ""

    for para in paragraphs:
        para = para.strip()
        if not para:
            continue

        if len(current.split()) + len(para.split()) < max_words:
            current = f"{current}\n\n{para}".strip() if current else para
        else:
            if current and len(current) >= CHUNK_MIN_CHARS:
                chunks.append(current)
            current = para

    if current and len(current) >= CHUNK_MIN_CHARS:
        chunks.append(current)

    return chunks


# ─── 임베딩 ────────────────────────────────────────────
def get_embedding(text: str, ollama_url: str = OLLAMA_URL, retries: int = 3) -> List[float]:
    """Ollama로 임베딩 생성 (재시도 포함)"""
    for attempt in range(retries):
        try:
            resp = requests.post(
                f"{ollama_url}/api/embeddings",
                json={"model": EMBEDDING_MODEL, "prompt": text},
                timeout=20,
            )
            if resp.status_code == 200:
                return resp.json().get("embedding", [])
            # 503/429 — 잠시 대기 후 재시도
            if resp.status_code in (429, 503):
                time.sleep(2 ** attempt)
                continue
        except requests.exceptions.Timeout:
            time.sleep(2 ** attempt)
        except Exception:
            time.sleep(1)
    return []


# ─── 메인 인덱서 ────────────────────────────────────────
class LocalIndexerV2:
    def __init__(
        self,
        chroma_path: str = CHROMA_PATH,
        ollama_url: str = OLLAMA_URL,
    ):
        self.ollama_url = ollama_url
        self.client = chromadb.PersistentClient(path=chroma_path)
        self.collection = None
        self.stats = {
            "total_urls": 0,
            "success": 0,
            "failed": 0,
            "total_chunks": 0,
            "total_chars": 0,
        }

    def init_collection(self) -> bool:
        """컬렉션 초기화"""
        try:
            self.collection = self.client.get_or_create_collection(
                name=COLLECTION_NAME,
                metadata={"hnsw:space": "cosine"},
            )
            print(f"✅ 컬렉션: {COLLECTION_NAME} (ID: {self.collection.id})")
            return True
        except Exception as e:
            print(f"❌ 컬렉션 초기화 실패: {e}")
            return False

    def index_url(self, url: str) -> bool:
        """단일 URL 인덱싱 (콘텐츠 추출 → 청킹 → 임베딩 → 저장)"""
        # 1. 콘텐츠 추출
        extracted = extract_content(url)
        if not extracted:
            print(f"   ⚠️ 콘텐츠 추출 실패: {url}")
            return False

        title = extracted["title"]
        content = extracted["content"]
        source = extracted["source"]

        # 2. 스마트 청킹
        chunks = smart_chunk(content)
        if not chunks:
            print(f"   ⚠️ 청크 생성 실패: {url}")
            return False

        # 3. 각 청크 임베딩 + 저장
        doc_ids = []
        embeddings = []
        metadatas = []
        documents = []

        for i, chunk in enumerate(chunks[:10]):  # 최대 10개 청크
            emb = get_embedding(chunk, self.ollama_url)
            if not emb:
                continue

            doc_id = hashlib.md5(f"{url}_v2_{i}".encode()).hexdigest()
            doc_ids.append(doc_id)
            embeddings.append(emb)
            metadatas.append(
                {
                    "url": url,
                    "title": title,
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "domain": _extract_domain(url),
                    "content_length": len(content),
                    "word_count": len(content.split()),
                    "extraction_source": source,
                    "indexed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
                }
            )
            documents.append(chunk)

        if not doc_ids:
            print(f"   ⚠️ 임베딩 생성 실패: {url}")
            return False

        # 4. ChromaDB 배치 업서트
        self.collection.upsert(
            ids=doc_ids,
            embeddings=embeddings,
            metadatas=metadatas,
            documents=documents,
        )

        words = len(content.split())
        print(
            f"   ✅ {title[:50]} — {len(chunks)}개 청크, {words}단어 ({source})"
        )

        self.stats["success"] += 1
        self.stats["total_chunks"] += len(doc_ids)
        self.stats["total_chars"] += len(content)
        return True

    def index_urls(self, urls: List[str]) -> Dict[str, Any]:
        """여러 URL 인덱싱"""
        self.stats["total_urls"] = len(urls)

        for i, url in enumerate(urls):
            print(f"\n[{i+1}/{len(urls)}] {url}")
            if self.index_url(url):
                pass
            else:
                self.stats["failed"] += 1
            time.sleep(0.8)  # Ollama rate limit 방지

        return self.stats

    def get_stats(self) -> Dict[str, Any]:
        """인덱스 통계"""
        count = self.collection.count() if self.collection else 0
        return {"collection": COLLECTION_NAME, "count": count}

    def clear(self):
        """컬렉션 초기화"""
        try:
            self.client.delete_collection(COLLECTION_NAME)
            print(f"🗑️ 컬렉션 삭제: {COLLECTION_NAME}")
        except Exception:
            pass


def _extract_domain(url: str) -> str:
    """URL에서 도메인 추출"""
    try:
        from urllib.parse import urlparse

        return urlparse(url).netloc
    except Exception:
        return url


# ─── CLI ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="로컬 인덱싱 v2 — 실제 콘텐츠 인덱싱")
    parser.add_argument(
        "--category",
        default="tech-docs",
        choices=list(SEED_URLS.keys()) + ["all"],
        help="인덱싱할 카테고리",
    )
    parser.add_argument("--limit", type=int, default=10, help="URL 수 제한")
    parser.add_argument("--urls", nargs="+", help="직접 URL 목록 지정")
    parser.add_argument("--stats", action="store_true", help="인덱스 통계")
    parser.add_argument("--clear", action="store_true", help="컬렉션 초기화")
    parser.add_argument("--json", action="store_true", help="JSON 출력")

    args = parser.parse_args()

    indexer = LocalIndexerV2()

    if args.clear:
        indexer.init_collection()
        indexer.clear()
        return

    if not indexer.init_collection():
        return

    if args.stats:
        stats = indexer.get_stats()
        if args.json:
            print(json.dumps(stats, indent=2))
        else:
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

    print(f"🚀 로컬 인덱싱 v2 (실제 콘텐츠)")
    print(f"   카테고리: {args.category}")
    print(f"   URL 수: {len(urls)}")
    print(f"   ChromaDB: {CHROMA_PATH}")
    print(f"   콘텐츠 추출: Jina Reader → BeautifulSoup 폴백")
    print(f"   임베딩: Ollama {EMBEDDING_MODEL}")
    print(f"{'='*60}")

    start = time.time()
    stats = indexer.index_urls(urls)
    elapsed = time.time() - start

    print(f"\n{'='*60}")
    print(f"✅ 인덱싱 완료!")
    print(f"   성공: {stats['success']}/{stats['total_urls']}")
    print(f"   실패: {stats['failed']}/{stats['total_urls']}")
    print(f"   총 청크: {stats['total_chunks']}")
    print(f"   총 문자: {stats['total_chars']:,}")
    print(f"   소요 시간: {elapsed:.1f}초")
    print(f"{'='*60}")

    final = indexer.get_stats()
    print(f"\n📊 인덱스: {final['count']}개 문서")


if __name__ == "__main__":
    main()
