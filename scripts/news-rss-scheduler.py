#!/usr/bin/env python3
"""
뉴스 RSS 스케줄러
매일 자동으로 RSS 피드를 인덱싱하고 Cloudflare로 동기화

사용법:
  # 전체 뉴스 인덱싱
  python news-rss-scheduler.py

  # 특정 카테고리만
  python news-rss-scheduler.py --category kr

  # Cloudflare 동기화 포함
  python news-rss-scheduler.py --sync --api-key=YOUR_KEY

  # 스케줄 모드 (매일 새벽 2시)
  python news-rss-scheduler.py --schedule

  # Dry run (인덱싱 없이 확인)
  python news-rss-scheduler.py --dry-run
"""

import argparse
import hashlib
import json
import os
import re
import sqlite3
import time
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any, Dict, List, Optional, Set

import chromadb
import feedparser
import requests

# ─── 설정 ──────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
FEEDS_CONFIG = SCRIPT_DIR / "news-rss-feeds.json"
CHROMA_PATH = "./local-index/chroma-data-v2"
COLLECTION_NAME = "news-rss-index"
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
DEDUP_DB_PATH = "./local-index/news-rss-dedup.db"
DEFAULT_API_URL = "https://search-engine-api.pages.dev"


# ─── 중복 방지 DB ───────────────────────────────────────
class DedupDB:
    """SQLite 기반 중복 방지 DB"""

    def __init__(self, db_path: str = DEDUP_DB_PATH):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self._init_table()

    def _init_table(self):
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS indexed_articles (
                article_id TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT,
                indexed_at TEXT NOT NULL,
                source_feed TEXT
            )
        """)
        self.conn.execute("""
            CREATE INDEX IF NOT EXISTS idx_url ON indexed_articles(url)
        """)
        self.conn.commit()

    def is_indexed(self, article_id: str) -> bool:
        cur = self.conn.execute(
            "SELECT 1 FROM indexed_articles WHERE article_id = ?", (article_id,)
        )
        return cur.fetchone() is not None

    def mark_indexed(self, article_id: str, url: str, title: str, source_feed: str):
        self.conn.execute(
            """INSERT OR IGNORE INTO indexed_articles
               (article_id, url, title, indexed_at, source_feed)
               VALUES (?, ?, ?, ?, ?)""",
            (article_id, url, title, datetime.utcnow().isoformat(), source_feed),
        )
        self.conn.commit()

    def cleanup_old(self, days: int = 7):
        cutoff = (datetime.utcnow() - timedelta(days=days)).isoformat()
        self.conn.execute("DELETE FROM indexed_articles WHERE indexed_at < ?", (cutoff,))
        self.conn.commit()

    def stats(self) -> Dict[str, Any]:
        cur = self.conn.execute("SELECT COUNT(*) FROM indexed_articles")
        total = cur.fetchone()[0]
        cur = self.conn.execute(
            "SELECT source_feed, COUNT(*) FROM indexed_articles GROUP BY source_feed"
        )
        by_feed = {row[0]: row[1] for row in cur.fetchall()}
        return {"total": total, "by_feed": by_feed}

    def close(self):
        self.conn.close()


# ─── User-Agent 로테이션 ─────────────────────────────────
USER_AGENTS = [
    # Chrome (Windows)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    # Chrome (Mac)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    # Firefox (Windows)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    # Firefox (Mac)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
    # Safari (Mac)
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Safari/605.1.15",
    # Edge (Windows)
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    # Chrome (Linux)
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    # Firefox (Linux)
    "Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
]

import random

def get_random_user_agent() -> str:
    """랜덤 User-Agent 반환"""
    return random.choice(USER_AGENTS)


def get_rss_headers(referer: str = None) -> Dict[str, str]:
    """RSS 피드 요청용 헤더 생성"""
    headers = {
        "User-Agent": get_random_user_agent(),
        "Accept": "application/rss+xml, application/xml, text/xml, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    if referer:
        headers["Referer"] = referer
    return headers


# ─── 임베딩 ────────────────────────────────────────────
def get_embedding(text: str, retries: int = 3) -> List[float]:
    """Ollama로 임베딩 생성"""
    for attempt in range(retries):
        try:
            resp = requests.post(
                f"{OLLAMA_URL}/api/embeddings",
                json={"model": EMBEDDING_MODEL, "prompt": text},
                timeout=20,
            )
            if resp.status_code == 200:
                return resp.json().get("embedding", [])
            if resp.status_code in (429, 503):
                wait_time = min(2 ** attempt, 30)  # 최대 30초
                time.sleep(wait_time)
        except requests.exceptions.Timeout:
            time.sleep(min(2 ** attempt, 30))
        except Exception:
            time.sleep(1)
    return []


# ─── RSS 파싱 ──────────────────────────────────────────
def fetch_rss(feed_url: str, max_articles: int = 20, retries: int = 3) -> List[Dict[str, str]]:
    """RSS 피드에서 기사 목록 추출 (anti-bot 회피 로직 포함)"""
    for attempt in range(retries):
        try:
            # 랜덤 헤더로 요청
            headers = get_rss_headers(referer=feed_url)
            
            # feedparser 대신 requests로 직접 요청
            resp = requests.get(
                feed_url,
                headers=headers,
                timeout=15,
                allow_redirects=True,
            )
            
            # 상태 코드 확인
            if resp.status_code == 429:
                wait_time = min(2 ** attempt * 5, 60)  # 최대 60초
                print(f"   ⏳ Rate limit (429), {wait_time}초 대기...")
                time.sleep(wait_time)
                continue
            elif resp.status_code == 403:
                print(f"   ⚠️ 접근 차단 (403), 다른 User-Agent로 재시도...")
                time.sleep(2 ** attempt)
                continue
            elif resp.status_code != 200:
                print(f"   ⚠️ HTTP {resp.status_code}")
                return []
            
            # feedparser로 파싱
            feed = feedparser.parse(resp.content)
            articles = []

            for entry in feed.entries[:max_articles]:
                title = entry.get("title", "").strip()
                link = entry.get("link", "").strip()
                summary = entry.get("summary", entry.get("description", "")).strip()
                published = entry.get("published", entry.get("updated", ""))

                # HTML 태그 제거
                summary = re.sub(r"<[^>]+>", "", summary)
                summary = re.sub(r"\s+", " ", summary).strip()

                if not title or not link:
                    continue

                articles.append({
                    "title": title,
                    "url": link,
                    "summary": summary[:500],
                    "published": published,
                })

            return articles

        except requests.exceptions.Timeout:
            print(f"   ⏳ 타임아웃, 재시도 {attempt + 1}/{retries}...")
            time.sleep(2 ** attempt)
        except requests.exceptions.ConnectionError:
            print(f"   ⚠️ 연결 오류, 재시도 {attempt + 1}/{retries}...")
            time.sleep(2 ** attempt)
        except Exception as e:
            print(f"   ⚠️ RSS 파싱 실패 ({feed_url}): {e}")
            return []
    
    print(f"   ❌ 최대 재시도 횟수 초과 ({feed_url})")
    return []


# ─── 청킹 ──────────────────────────────────────────────
def chunk_article(title: str, summary: str, url: str, max_words: int = 300) -> List[str]:
    """기사 텍스트를 청킹"""
    # 제목 + 요약 결합
    full_text = f"{title}\n\n{summary}" if summary else title

    if len(full_text.split()) <= max_words:
        return [full_text]

    # 문장 기준 분할
    sentences = re.split(r"(?<=[.!?])\s+", full_text)
    chunks = []
    current = ""

    for sent in sentences:
        if len(current.split()) + len(sent.split()) < max_words:
            current = f"{current} {sent}".strip()
        else:
            if current:
                chunks.append(current)
            current = sent

    if current:
        chunks.append(current)

    return chunks if chunks else [full_text[:1500]]


# ─── 메인 스케줄러 ──────────────────────────────────────
class NewsRSSScheduler:
    def __init__(
        self,
        chroma_path: str = CHROMA_PATH,
        collection_name: str = COLLECTION_NAME,
    ):
        self.client = chromadb.PersistentClient(path=chroma_path)
        self.collection = self.client.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"},
        )
        self.dedup = DedupDB()
        self.config = self._load_config()
        self.stats = {
            "feeds_processed": 0,
            "articles_found": 0,
            "articles_indexed": 0,
            "articles_skipped": 0,
            "chunks_created": 0,
            "errors": 0,
        }

    def _load_config(self) -> Dict:
        """설정 파일 로드"""
        try:
            with open(FEEDS_CONFIG) as f:
                return json.load(f)
        except Exception:
            return {"feeds": {}, "settings": {"max_articles_per_feed": 20}}

    def process_feed(
        self, feed_info: Dict[str, str], max_articles: int = 20
    ) -> List[Dict[str, Any]]:
        """단일 RSS 피드 처리"""
        name = feed_info["name"]
        url = feed_info["url"]
        lang = feed_info.get("lang", "en")
        category = feed_info.get("category", "general")

        # RSS 기사 가져오기
        articles = fetch_rss(url, max_articles)
        if not articles:
            return []

        indexed = []
        for article in articles:
            # 중복 확인
            article_id = hashlib.md5(article["url"].encode()).hexdigest()
            if self.dedup.is_indexed(article_id):
                self.stats["articles_skipped"] += 1
                continue

            # 청킹
            chunks = chunk_article(
                article["title"], article["summary"], article["url"]
            )

            # 임베딩 + 저장
            doc_ids = []
            embeddings = []
            metadatas = []
            documents = []

            for i, chunk in enumerate(chunks[:3]):  # 최대 3개 청크
                emb = get_embedding(chunk)
                if not emb:
                    continue

                doc_id = hashlib.md5(f"{article['url']}_news_{i}".encode()).hexdigest()
                doc_ids.append(doc_id)
                embeddings.append(emb)
                metadatas.append({
                    "url": article["url"],
                    "title": article["title"],
                    "chunk_index": i,
                    "total_chunks": len(chunks),
                    "source_feed": name,
                    "lang": lang,
                    "category": category,
                    "published": article.get("published", ""),
                    "indexed_at": datetime.utcnow().isoformat(),
                    "content_length": len(chunk),
                    "word_count": len(chunk.split()),
                })
                documents.append(chunk)

            if doc_ids:
                self.collection.upsert(
                    ids=doc_ids,
                    embeddings=embeddings,
                    metadatas=metadatas,
                    documents=documents,
                )
                self.dedup.mark_indexed(
                    article_id, article["url"], article["title"], name
                )
                self.stats["articles_indexed"] += 1
                self.stats["chunks_created"] += len(doc_ids)
                indexed.append(article)

            time.sleep(0.5)  # Ollama rate limit

        return indexed

    def run(
        self,
        categories: Optional[List[str]] = None,
        max_articles: int = 20,
        dry_run: bool = False,
    ) -> Dict[str, Any]:
        """스케줄러 실행"""
        feeds = self.config.get("feeds", {})
        settings = self.config.get("settings", {})

        # 카테고리 필터
        if categories:
            target_feeds = {}
            for cat in categories:
                if cat in feeds:
                    target_feeds[cat] = feeds[cat]
        else:
            target_feeds = feeds

        print(f"\n🚀 뉴스 RSS 스케줄러 시작")
        print(f"   카테고리: {', '.join(target_feeds.keys()) or '전체'}")
        print(f"   피드 수: {sum(len(v) for v in target_feeds.values())}")
        print(f"   최대 기사/피드: {max_articles}")
        print(f"{'='*60}\n")

        for cat_name, cat_feeds in target_feeds.items():
            print(f"\n📂 [{cat_name.upper()}] ({len(cat_feeds)}개 피드)")
            print(f"{'-'*40}")

            for feed_info in cat_feeds:
                feed_name = feed_info["name"]
                print(f"\n   📰 {feed_name}")

                if dry_run:
                    articles = fetch_rss(feed_info["url"], max_articles)
                    print(f"      기사 수: {len(articles)} (dry run)")
                    for a in articles[:3]:
                        print(f"        - {a['title'][:60]}")
                    continue

                try:
                    indexed = self.process_feed(feed_info, max_articles)
                    self.stats["feeds_processed"] += 1
                    self.stats["articles_found"] += len(
                        fetch_rss(feed_info["url"], max_articles)
                    )
                    print(f"      ✅ {len(indexed)}개 기사 인덱싱")
                except Exception as e:
                    print(f"      ❌ 오류: {e}")
                    self.stats["errors"] += 1

                # 피드 간 대기 (한국 뉴스는 더 길게)
                feed_lang = feed_info.get("lang", "en")
                if feed_lang == "ko":
                    delay = random.uniform(2.0, 4.0)  # 한국 뉴스: 2~4초
                else:
                    delay = random.uniform(1.0, 2.0)  # 기타: 1~2초
                time.sleep(delay)

        return self.stats

    def sync_to_cloudflare(self, api_key: str, batch_size: int = 5):
        """Cloudflare로 동기화"""
        print(f"\n🚀 Cloudflare 동기화 시작")

        # 로컬 인덱스에서 뉴스 URL 추출
        all_data = self.collection.get(include=["metadatas"])
        urls = list(set(
            meta["url"]
            for meta in all_data.get("metadatas", [])
            if meta and meta.get("url")
        ))

        if not urls:
            print("   ⚠️ 동기화할 URL이 없습니다.")
            return

        print(f"   URL 수: {len(urls)}")

        for i in range(0, len(urls), batch_size):
            batch = urls[i : i + batch_size]
            try:
                resp = requests.post(
                    f"{DEFAULT_API_URL}/api/index",
                    headers={
                        "Content-Type": "application/json",
                        "Authorization": f"Bearer {api_key}",
                    },
                    json={"urls": batch},
                    timeout=60,
                )
                if resp.status_code == 200:
                    data = resp.json()
                    succeeded = data.get("stats", {}).get("succeeded", 0)
                    print(f"   ✅ 배치 {i // batch_size + 1}: {succeeded}개 동기화")
                else:
                    print(f"   ❌ 배치 실패: HTTP {resp.status_code}")
            except Exception as e:
                print(f"   ❌ 배치 오류: {e}")

            time.sleep(3)

    def get_stats(self):
        """통계 출력"""
        col_count = self.collection.count()
        dedup_stats = self.dedup.stats()

        print(f"\n📊 뉴스 RSS 인덱스 통계")
        print(f"{'='*40}")
        print(f"   컬렉션: {COLLECTION_NAME}")
        print(f"   총 문서: {col_count}")
        print(f"   중복 방지 DB: {dedup_stats['total']}개 기사")
        if dedup_stats["by_feed"]:
            print(f"   피드별:")
            for feed, count in sorted(dedup_stats["by_feed"].items(), key=lambda x: -x[1]):
                print(f"      {feed}: {count}개")

    def close(self):
        self.dedup.close()


# ─── CLI ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="뉴스 RSS 스케줄러")
    parser.add_argument(
        "--category", "-c",
        nargs="+",
        choices=["intl", "kr", "jp", "cn", "tech", "science", "business"],
        help="인덱싱할 카테고리 (미지정 시 전체)",
    )
    parser.add_argument("--limit", type=int, default=20, help="피드당 최대 기사 수")
    parser.add_argument("--dry-run", action="store_true", help="인덱싱 없이 확인")
    parser.add_argument("--stats", action="store_true", help="통계 출력")
    parser.add_argument("--sync", action="store_true", help="Cloudflare 동기화")
    parser.add_argument("--api-key", help="Cloudflare API 키")
    parser.add_argument("--cleanup", type=int, metavar="DAYS", help="N일 이전 기사 정리")
    parser.add_argument("--schedule", action="store_true", help="스케줄 모드 (매일 새벽 2시)")

    args = parser.parse_args()

    scheduler = NewsRSSScheduler()

    try:
        if args.stats:
            scheduler.get_stats()
            return

        if args.cleanup:
            scheduler.dedup.cleanup_old(args.cleanup)
            print(f"🗑️ {args.cleanup}일 이전 기사 정리 완료")
            return

        if args.schedule:
            print("⏰ 스케줄 모드: 매일 새벽 2시에 실행됩니다.")
            print("   (시스템 cron 사용 권장: 0 2 * * * python3 news-rss-scheduler.py)")
            print("   중단하려면 Ctrl+C")
            while True:
                now = datetime.now()
                target = now.replace(hour=2, minute=0, second=0, microsecond=0)
                if target <= now:
                    target += timedelta(days=1)
                wait_seconds = (target - now).total_seconds()
                print(f"\n   ⏳ 다음 실행: {target.strftime('%Y-%m-%d %H:%M')} ({wait_seconds/3600:.1f}시간 후)")
                time.sleep(min(wait_seconds, 3600))  # 1시간마다 확인

                if datetime.now().hour == 2 and datetime.now().minute < 5:
                    stats = scheduler.run(
                        categories=args.category,
                        max_articles=args.limit,
                        dry_run=args.dry_run,
                    )
                    if args.sync and args.api_key:
                        scheduler.sync_to_cloudflare(args.api_key)
                    print(f"\n📊 실행 결과: {json.dumps(stats, indent=2)}")
        else:
            stats = scheduler.run(
                categories=args.category,
                max_articles=args.limit,
                dry_run=args.dry_run,
            )

            print(f"\n{'='*60}")
            print(f"✅ 뉴스 RSS 인덱싱 완료!")
            print(f"   처리된 피드: {stats['feeds_processed']}")
            print(f"   발견된 기사: {stats['articles_found']}")
            print(f"   인덱싱된 기사: {stats['articles_indexed']}")
            print(f"   건너뛴 기사: {stats['articles_skipped']}")
            print(f"   생성된 청크: {stats['chunks_created']}")
            print(f"   오류: {stats['errors']}")
            print(f"{'='*60}")

            if args.sync and args.api_key:
                scheduler.sync_to_cloudflare(args.api_key)

            scheduler.get_stats()

    finally:
        scheduler.close()


if __name__ == "__main__":
    main()
