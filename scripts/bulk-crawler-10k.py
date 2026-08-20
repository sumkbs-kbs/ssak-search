#!/usr/bin/env python3
"""
10,000개 URL 대량 크롤러
- 체크포인트 및 재시작 지원
- 병렬 크롤링 (동시 5개)
- anti-bot 회피 (User-Agent 로테이션, 헤더, 지연)
- 실시간 진행률 표시
- ChromaDB에 즉시 인덱싱
"""

import argparse
import hashlib
import json
import os
import random
import sqlite3
import sys
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple
from urllib.parse import urlparse

import requests

# ============================================================
# 설정
# ============================================================

# Jina Reader API (무료, 키 불필요)
JINA_API_URL = "https://r.jina.ai/"

# Ollama (임베딩)
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"

# ChromaDB
CHROMA_PATH = "local-index/chroma-data-v2"
COLLECTION_NAME = "bulk-index-10k"

# 로그
LOG_DIR = Path("local-index/logs")
LOG_DIR.mkdir(parents=True, exist_ok=True)

# ============================================================
# Anti-Bot 회피
# ============================================================

USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36 Edg/125.0.0.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
]

def get_random_headers() -> Dict[str, str]:
    """랜덤 User-Agent와 헤더 반환"""
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }

# ============================================================
# 체크포인트 관리
# ============================================================

class CheckpointManager:
    """체크포인트 관리 클래스"""
    
    def __init__(self, checkpoint_file: str):
        self.checkpoint_file = Path(checkpoint_file)
        self.checkpoint_file.parent.mkdir(parents=True, exist_ok=True)
        self.data = self._load()
    
    def _load(self) -> Dict:
        """체크포인트 로드"""
        if self.checkpoint_file.exists():
            with open(self.checkpoint_file, "r") as f:
                return json.load(f)
        return {
            "completed_urls": [],
            "failed_urls": [],
            "last_index": 0,
            "stats": {
                "total": 0,
                "success": 0,
                "failed": 0,
                "skipped": 0,
            }
        }
    
    def save(self):
        """체크포인트 저장"""
        with open(self.checkpoint_file, "w") as f:
            json.dump(self.data, f, indent=2, ensure_ascii=False)
    
    def is_completed(self, url: str) -> bool:
        """URL이 이미 완료되었는지 확인"""
        return url in self.data["completed_urls"]
    
    def mark_completed(self, url: str):
        """URL 완료로 표시"""
        if url not in self.data["completed_urls"]:
            self.data["completed_urls"].append(url)
            self.data["stats"]["success"] += 1
    
    def mark_failed(self, url: str):
        """URL 실패로 표시"""
        if url not in self.data["failed_urls"]:
            self.data["failed_urls"].append(url)
            self.data["stats"]["failed"] += 1
    
    def mark_skipped(self):
        """URL 건너뜀 표시"""
        self.data["stats"]["skipped"] += 1
    
    def get_completed_count(self) -> int:
        """완료된 URL 수 반환"""
        return len(self.data["completed_urls"])
    
    def get_failed_urls(self) -> List[str]:
        """실패한 URL 목록 반환"""
        return self.data["failed_urls"]
    
    def reset_failed(self):
        """실패 목록 초기화"""
        self.data["failed_urls"] = []
        self.data["stats"]["failed"] = 0


# ============================================================
# 콘텐츠 추출
# ============================================================

def extract_content_bs4(url: str, timeout: int = 15) -> Optional[Dict[str, str]]:
    """requests + BeautifulSoup으로 콘텐츠 추출 (메인 방법)"""
    try:
        from bs4 import BeautifulSoup
        
        headers = get_random_headers()
        response = requests.get(url, headers=headers, timeout=timeout, allow_redirects=True)
        
        if response.status_code != 200:
            return None
        
        soup = BeautifulSoup(response.text, "html.parser")
        
        # 불필요한 태그 제거
        for tag in soup(["script", "style", "nav", "footer", "header", "aside", "iframe", "noscript"]):
            tag.decompose()
        
        # 제목 추출
        title = ""
        if soup.title:
            title = soup.title.string or ""
        if not title:
            h1 = soup.find("h1")
            if h1:
                title = h1.get_text(strip=True)
        
        # 본문 추출 (우선순위: article > main > div.content > body)
        content = ""
        article = (
            soup.find("article") or 
            soup.find("main") or 
            soup.find("div", class_=lambda x: x and "content" in x.lower()) or
            soup.find("div", id=lambda x: x and "content" in x.lower()) or
            soup.find("body")
        )
        if article:
            content = article.get_text(separator="\n", strip=True)
        
        # 콘텐츠 정리 (빈 줄 제거, 공백 정리)
        lines = [line.strip() for line in content.split("\n") if line.strip()]
        content = "\n".join(lines)
        
        if not content or len(content) < 100:
            return None
        
        return {
            "title": title[:500],
            "content": content[:10000],
            "url": url,
        }
    except Exception:
        return None


def extract_content_jina(url: str, timeout: int = 30) -> Optional[Dict[str, str]]:
    """Jina Reader API로 콘텐츠 추출 (폴백)"""
    try:
        headers = get_random_headers()
        headers["Accept"] = "application/json"
        
        response = requests.get(
            f"{JINA_API_URL}{url}",
            headers=headers,
            timeout=timeout,
        )
        
        if response.status_code == 200:
            data = response.json()
            return {
                "title": data.get("data", {}).get("title", ""),
                "content": data.get("data", {}).get("content", ""),
                "url": url,
            }
        else:
            return None
    except Exception:
        return None


def extract_content(url: str) -> Optional[Dict[str, str]]:
    """콘텐츠 추출 (BeautifulSoup → Jina 폴백)"""
    # BeautifulSoup 시도 (빠르고 안정적)
    result = extract_content_bs4(url)
    if result and result.get("content"):
        return result
    
    # Jina 폴백
    return extract_content_jina(url)


# ============================================================
# 임베딩 생성
# ============================================================

def generate_embedding(text: str) -> Optional[List[float]]:
    """Ollama로 임베딩 생성"""
    try:
        response = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={
                "model": EMBEDDING_MODEL,
                "prompt": text[:2000],  # 텍스트 제한
            },
            timeout=30,
        )
        
        if response.status_code == 200:
            return response.json().get("embedding")
        return None
    except Exception:
        return None


# ============================================================
# ChromaDB 인덱싱
# ============================================================

def index_to_chromadb(
    collection,
    url: str,
    title: str,
    content: str,
    embedding: List[float],
    category: str,
):
    """ChromaDB에 인덱싱"""
    try:
        # ID 생성 (URL 기반)
        doc_id = hashlib.md5(url.encode()).hexdigest()
        
        # 청킹 (400 단어씩)
        words = content.split()
        chunks = []
        for i in range(0, len(words), 400):
            chunk = " ".join(words[i:i+400])
            if len(chunk) > 50:
                chunks.append(chunk)
        
        if not chunks:
            chunks = [content[:2000]]
        
        # 각 청크 임베딩 및 인덱싱
        for i, chunk in enumerate(chunks):
            chunk_id = f"{doc_id}_chunk_{i}"
            chunk_embedding = generate_embedding(chunk)
            
            if chunk_embedding:
                collection.upsert(
                    ids=[chunk_id],
                    embeddings=[chunk_embedding],
                    metadatas=[{
                        "url": url,
                        "title": title[:500],
                        "category": category,
                        "chunk_index": i,
                        "total_chunks": len(chunks),
                        "indexed_at": datetime.now().isoformat(),
                    }],
                    documents=[chunk[:2000]],
                )
        
        return True
    except Exception as e:
        print(f"  ❌ 인덱싱 실패: {e}")
        return False


# ============================================================
# 메인 크롤러
# ============================================================

class BulkCrawler10K:
    """10,000개 URL 대량 크롤러"""
    
    def __init__(
        self,
        seed_file: str,
        max_workers: int = 5,
        delay_min: float = 1.0,
        delay_max: float = 3.0,
        checkpoint_file: str = "local-index/bulk-crawl-10k-checkpoint.json",
        category: Optional[str] = None,
        limit: Optional[int] = None,
    ):
        self.seed_file = Path(seed_file)
        self.max_workers = max_workers
        self.delay_min = delay_min
        self.delay_max = delay_max
        self.checkpoint = CheckpointManager(checkpoint_file)
        self.category = category
        self.limit = limit
        
        # 통계
        self.stats = {
            "total": 0,
            "success": 0,
            "failed": 0,
            "skipped": 0,
            "start_time": time.time(),
        }
        
        # 로그 파일
        self.log_file = LOG_DIR / f"bulk-crawl-10k-{datetime.now().strftime('%Y%m%d-%H%M%S')}.log"
    
    def load_urls(self) -> List[Tuple[str, str]]:
        """시드 파일에서 URL 로드"""
        with open(self.seed_file, "r") as f:
            data = json.load(f)
        
        urls = []
        for category, category_urls in data.items():
            if self.category and category != self.category:
                continue
            
            for url in category_urls:
                urls.append((url, category))
        
        if self.limit:
            urls = urls[:self.limit]
        
        return urls
    
    def crawl_single(self, url: str, category: str, collection=None) -> bool:
        """단일 URL 크롤링"""
        # 체크포인트 확인
        if self.checkpoint.is_completed(url):
            self.stats["skipped"] += 1
            self.checkpoint.mark_skipped()
            return True
        
        try:
            # 콘텐츠 추출
            content_data = extract_content(url)
            if not content_data or not content_data.get("content"):
                self.stats["failed"] += 1
                self.checkpoint.mark_failed(url)
                return False
            
            # 임베딩 생성
            embedding = generate_embedding(content_data["content"])
            if not embedding:
                self.stats["failed"] += 1
                self.checkpoint.mark_failed(url)
                return False
            
            # ChromaDB에 저장
            if collection:
                index_to_chromadb(
                    collection=collection,
                    url=url,
                    title=content_data.get("title", ""),
                    content=content_data["content"],
                    embedding=embedding,
                    category=category,
                )
            
            self.checkpoint.mark_completed(url)
            self.stats["success"] += 1
            
            return True
            
        except Exception as e:
            self.stats["failed"] += 1
            self.checkpoint.mark_failed(url)
            return False
    
    def run(self):
        """크롤링 실행"""
        print("🚀 10,000개 URL 대량 크롤러 시작")
        print("=" * 60)
        
        # URL 로드
        urls = self.load_urls()
        self.stats["total"] = len(urls)
        
        print(f"\n📊 총 URL: {len(urls)}개")
        print(f"📊 이미 완료: {self.checkpoint.get_completed_count()}개")
        print(f"📊 남은 URL: {len(urls) - self.checkpoint.get_completed_count()}개")
        print(f"📊 병렬 워커: {self.max_workers}개")
        print(f"📊 딜레이: {self.delay_min}~{self.delay_max}초")
        
        # ChromaDB 연결
        import chromadb
        client = chromadb.PersistentClient(path=CHROMA_PATH)
        collection = client.get_or_create_collection(
            name=COLLECTION_NAME,
            metadata={"hnsw:space": "cosine"},
        )
        
        print(f"\n📁 컬렉션: {COLLECTION_NAME} ({collection.count()}개 문서)")
        
        # 크롤링 실행
        print("\n🔄 크롤링 시작...")
        
        completed = 0
        failed = 0
        
        # 병렬 크롤링
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            futures = {}
            for url, category in urls:
                if self.checkpoint.is_completed(url):
                    continue
                
                future = executor.submit(self.crawl_single, url, category, collection)
                futures[future] = (url, category)
            
            for future in as_completed(futures):
                url, category = futures[future]
                
                try:
                    success = future.result()
                    if success:
                        completed += 1
                    else:
                        failed += 1
                except Exception as e:
                    failed += 1
                
                # 진행률 표시
                total_done = completed + failed + self.checkpoint.get_completed_count()
                if total_done % 10 == 0:
                    progress = (total_done / self.stats["total"]) * 100
                    elapsed = time.time() - self.stats["start_time"]
                    rate = total_done / elapsed if elapsed > 0 else 0
                    remaining = (self.stats["total"] - total_done) / rate if rate > 0 else 0
                    
                    print(
                        f"\r  📊 진행: {total_done}/{self.stats['total']} "
                        f"({progress:.1f}%) | "
                        f"성공: {completed} | 실패: {failed} | "
                        f"속도: {rate:.1f}개/초 | "
                        f"남은 시간: {remaining/60:.1f}분",
                        end="",
                        flush=True,
                    )
                
                # 딜레이
                time.sleep(random.uniform(self.delay_min, self.delay_max))
                
                # 체크포인트 저장 (10개마다)
                if (completed + failed) % 10 == 0:
                    self.checkpoint.save()
        
        print("\n")
        
        # 최종 체크포인트 저장
        self.checkpoint.save()
        
        # 결과 출력
        self._print_results()
    
    def _print_results(self):
        """결과 출력"""
        elapsed = time.time() - self.stats["start_time"]
        
        print("📊 크롤링 완료!")
        print("=" * 60)
        print(f"  총 URL: {self.stats['total']}개")
        print(f"  성공: {self.checkpoint.get_completed_count()}개")
        print(f"  실패: {len(self.checkpoint.get_failed_urls())}개")
        print(f"  건너뜀: {self.stats['skipped']}개")
        print(f"  소요 시간: {elapsed/60:.1f}분")
        print(f"  평균 속도: {self.stats['total']/elapsed:.2f}개/초")
        
        # 실패 URL 목록
        failed_urls = self.checkpoint.get_failed_urls()
        if failed_urls:
            print(f"\n❌ 실패 URL ({len(failed_urls)}개):")
            for url in failed_urls[:20]:
                print(f"    - {url}")
            if len(failed_urls) > 20:
                print(f"    ... 외 {len(failed_urls)-20}개")
        
        # 로그 저장
        with open(self.log_file, "w") as f:
            json.dump({
                "timestamp": datetime.now().isoformat(),
                "stats": self.stats,
                "checkpoint": self.checkpoint.data,
            }, f, indent=2, ensure_ascii=False)
        
        print(f"\n📝 로그: {self.log_file}")


# ============================================================
# CLI
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="10,000개 URL 대량 크롤러")
    parser.add_argument("--seed-file", default="scripts/seed-data/seed-urls-10k.json", help="시드 URL 파일")
    parser.add_argument("--max-workers", type=int, default=5, help="병렬 워커 수")
    parser.add_argument("--delay-min", type=float, default=1.0, help="최소 딜레이 (초)")
    parser.add_argument("--delay-max", type=float, default=3.0, help="최대 딜레이 (초)")
    parser.add_argument("--checkpoint", default="local-index/bulk-crawl-10k-checkpoint.json", help="체크포인트 파일")
    parser.add_argument("--category", help="특정 카테고리만 크롤링")
    parser.add_argument("--limit", type=int, help="최대 URL 수")
    parser.add_argument("--retry-failed", action="store_true", help="실패한 URL 재시도")
    
    args = parser.parse_args()
    
    # 크롤러 생성
    crawler = BulkCrawler10K(
        seed_file=args.seed_file,
        max_workers=args.max_workers,
        delay_min=args.delay_min,
        delay_max=args.delay_max,
        checkpoint_file=args.checkpoint,
        category=args.category,
        limit=args.limit,
    )
    
    # 실패 재시도
    if args.retry_failed:
        crawler.checkpoint.reset_failed()
        print("🔄 실패 목록 초기화 완료")
    
    # 실행
    crawler.run()


if __name__ == "__main__":
    main()
