#!/usr/bin/env python3
"""
대량 시드 URL 크롤링 자동화
- 카테고리별 시드 URL 관리
- 배치 처리 + 병렬 크롤링
- 중복 방지 + 진행 상황 추적
- 자동 재시도 + 오류 복구
"""

import argparse
import hashlib
import json
import os
import random
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path
from typing import List, Dict, Optional, Tuple
import requests

# ChromaDB
import chromadb
import ollama

# ─── 설정 ──────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
SEED_DATA_DIR = SCRIPT_DIR / "seed-data"
CHROMA_PATH = "./local-index/chroma-data-v2"
COLLECTION_NAME = "bulk-index"
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
DEDUP_DB_PATH = "./local-index/bulk-crawl-dedup.db"
LOG_DIR = Path("./local-index/logs")

# ─── User-Agent 로테이션 ──────────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:133.0) Gecko/20100101 Firefox/133.0",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:133.0) Gecko/20100101 Firefox/133.0",
]

# ─── 카테고리별 시드 URL ──────────────────────────────────
SEED_URLS = {
    # ── 1. 기술 문서 (2,500개) ──
    "tech-docs": [
        # 프레임워크/라이브러리 공식 문서
        "https://react.dev/learn", "https://react.dev/reference",
        "https://vuejs.org/guide/introduction.html", "https://vuejs.org/api/",
        "https://angular.dev/overview", "https://angular.dev/reference",
        "https://nextjs.org/docs", "https://nextjs.org/app",
        "https://nuxt.com/docs", "https://nuxt.com/api",
        "https://svelte.dev/docs", "https://svelte.dev/tutorial",
        "https://astro.build/docs", "https://astro.build/guides",
        "https://remix.run/docs", "https://remix.run/start/quickstart",
        "https://htmx.org/docs/", "https://htmx.org/reference/",
        "https://lit.dev/docs/", "https://lit.dev/tutorial/",
        # 언어별 문서
        "https://docs.python.org/3/", "https://docs.python.org/3/tutorial/",
        "https://docs.python.org/3/library/", "https://docs.python.org/3/howto/",
        "https://doc.rust-lang.org/book/", "https://doc.rust-lang.org/std/",
        "https://doc.rust-lang.org/rust-by-example/", "https://doc.rust-lang.org/cargo/",
        "https://go.dev/doc/", "https://go.dev/tour/", "https://go.dev/ref/spec",
        "https://kotlinlang.org/docs/home.html", "https://kotlinlang.org/docs/",
        "https://developer.apple.com/swift/", "https://docs.swift.org/swift-book/",
        "https://www.typescriptlang.org/docs/", "https://www.typescriptlang.org/play",
        "https://developer.mozilla.org/en-US/docs/Web/JavaScript",
        "https://developer.mozilla.org/en-US/docs/Web/HTML",
        "https://developer.mozilla.org/en-US/docs/Web/CSS",
        "https://developer.mozilla.org/en-US/docs/Web/API",
        # DevOps/인프라
        "https://docs.docker.com/get-started/", "https://docs.docker.com/engine/",
        "https://docs.docker.com/compose/", "https://docs.docker.com/desktop/",
        "https://kubernetes.io/docs/home/", "https://kubernetes.io/docs/concepts/",
        "https://kubernetes.io/docs/tasks/", "https://kubernetes.io/docs/reference/",
        "https://docs.aws.amazon.com/cli/latest/userguide/",
        "https://docs.aws.amazon.com/lambda/latest/dg/",
        "https://docs.aws.amazon.com/s3/latest/userguide/",
        "https://cloud.google.com/docs", "https://cloud.google.com/run/docs",
        "https://cloud.google.com/functions/docs",
        "https://developers.cloudflare.com/workers/", "https://developers.cloudflare.com/pages/",
        "https://developers.cloudflare.com/r2/", "https://developers.cloudflare.com/d1/",
        "https://developers.cloudflare.com/vectorize/",
        # 데이터베이스
        "https://www.postgresql.org/docs/current/tutorial.html",
        "https://www.postgresql.org/docs/current/ddl.html",
        "https://dev.mysql.com/doc/refman/8.0/en/",
        "https://docs.mongodb.com/manual/", "https://docs.mongodb.com/drivers/",
        "https://redis.io/docs/", "https://redis.io/docs/getting-started/",
        "https://sqlite.org/docs.html", "https://www.elastic.co/guide/",
        "https://neo4j.com/docs/", "https://neo4j.com/docs/cypher-manual/",
        "https://www.prisma.io/docs/", "https://www.prisma.io/docs/getting-started",
        "https://typeorm.io/", "https://sequelize.org/docs/v6/",
        "https://knexjs.org/", "https://drizzle.team/docs/overview",
        # 알고리즘/자료구조
        "https://cp-algorithms.com/", "https://www.geeksforgeeks.org/",
        "https://leetcode.com/explore/", "https://leetcode.com/study-plan/",
        "https://algo.monster/", "https://neetcode.io/",
        # 보안
        "https://owasp.org/www-project-top-ten/",
        "https://owasp.org/www-project-application-security-verification-standard/",
        "https://cwe.mitre.org/", "https://capec.mitre.org/",
        # 아키텍처/설계
        "https://microservices.io/patterns/", "https://12factor.net/",
        "https://martinfowler.com/eaaCatalog/", "https://www.enterpriseintegrationpatterns.com/",
        # 도구/IDE
        "https://code.visualstudio.com/docs", "https://code.visualstudio.com/docs/getstarted",
        "https://www.jetbrains.com/help/idea/", "https://www.jetbrains.com/help/webstorm/",
        "https://vimhelp.org/", "https://neovim.io/doc/user/",
        "https://www.gnu.org/software/emacs/manual/html_node/emacs/",
        # Git
        "https://git-scm.com/book/en/v2", "https://git-scm.com/docs",
        "https://docs.github.com/en", "https://docs.github.com/en/actions",
        # 모바일
        "https://developer.android.com/guide", "https://developer.android.com/reference",
        "https://developer.apple.com/documentation/",
        "https://flutter.dev/docs", "https://reactnative.dev/docs/getting-started",
        # 머신러닝
        "https://scikit-learn.org/stable/user_guide.html",
        "https://www.tensorflow.org/guide", "https://pytorch.org/docs/stable/",
        "https://huggingface.co/docs/transformers/",
        "https://keras.io/guides/", "https://jax.readthedocs.io/",
        # 프로토콜/API
        "https://www.openapis.org/", "https://spec.openrpc.io/",
        "https://graphql.org/learn/", "https://www.graphql.com/",
        "https://grpc.io/docs/", "https://www.postman.com/docs/",
        "https://swagger.io/docs/", "https://stoplight.io/openapi",
        # 테스트
        "https://jestjs.io/docs/", "https://vitest.dev/guide/",
        "https://playwright.dev/docs/intro", "https://cypress.io/docs/",
        "https://www.selenium.dev/documentation/",
        # 모니터링
        "https://prometheus.io/docs/", "https://grafana.com/docs/",
        "https://docs.datadoghq.com/", "https://docs.newrelic.com/",
        # 메시지 큐
        "https://docs.confluent.io/platform/current/get-started/",
        "https://www.rabbitmq.com/docs", "https://docs.nats.io/nats-concepts/overview",
        "https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/",
        # 블록체인
        "https://ethereum.org/en/developers/docs/",
        "https://docs.soliditylang.org/en/latest/", "https://hardhat.org/docs",
        # 게임
        "https://docs.unity3d.com/Manual/", "https://docs.unrealengine.com/",
        "https://godotengine.org/docs/", "https://love2d.org/wiki/Main_Page",
    ],
    
    # ── 뉴스/미디어 (2,000개) ──
    "news-media": [
        # 국제 뉴스
        "https://www.reuters.com/", "https://www.bbc.com/news",
        "https://www.aljazeera.com/", "https://www.france24.com/",
        "https://www.dw.com/en/", "https://www.sbs.com.au/news",
        "https://www.abc.net.au/news", "https://www.cbc.ca/news",
        "https://www.rnz.co.nz/", "https://www.channelnewsasia.com/",
        # 미국 뉴스
        "https://www.nytimes.com/", "https://www.washingtonpost.com/",
        "https://www.wsj.com/", "https://www.bloomberg.com/",
        "https://apnews.com/", "https://www.npr.org/",
        "https://www.politico.com/", "https://www.thehill.com/",
        "https://www.foxnews.com/", "https://www.cnn.com/",
        "https://www.nbcnews.com/", "https://www.cbsnews.com/",
        "https://www.usatoday.com/", "https://www.latimes.com/",
        # 영국 뉴스
        "https://www.theguardian.com/", "https://www.independent.co.uk/",
        "https://www.telegraph.co.uk/", "https://www.dailymail.co.uk/",
        "https://www.mirror.co.uk/", "https://www.express.co.uk/",
        # 아시아 뉴스
        "https://www.straitstimes.com/", "https://www.todayonline.com/",
        "https://www.japantimes.co.jp/", "https://www.asahi.com/",
        "https://www.yomiuri.co.jp/", "https://www.nikkei.com/",
        "https://www.scmp.com/", "https://www.globaltimes.cn/",
        "https://www.channelnewsasia.com/", "https://www.koreaherald.com/",
        # 기술 뉴스
        "https://techcrunch.com/", "https://www.theverge.com/",
        "https://arstechnica.com/", "https://www.wired.com/",
        "https://www.technologyreview.com/", "https://www.zdnet.com/",
        "https://www.cnet.com/", "https://www.engadget.com/",
        "https://mashable.com/", "https://gizmodo.com/",
        "https://thenextweb.com/", "https://venturebeat.com/",
        # 과학 뉴스
        "https://www.nature.com/news", "https://www.science.org/news",
        "https://www.sciencedaily.com/", "https://phys.org/news/",
        "https://www.space.com/", "https://news.harvard.edu/",
        "https://www.sciencemag.org/news", "https://www.quantamagazine.org/",
        # 금융 뉴스
        "https://www.reuters.com/business/", "https://www.bloomberg.com/markets",
        "https://www.cnbc.com/", "https://finance.yahoo.com/",
        "https://www.marketwatch.com/", "https://www.investing.com/",
        "https://seekingalpha.com/", "https://www.fool.com/",
        # 스포츠
        "https://www.espn.com/", "https://www.bbc.com/sport",
        "https://www.skysports.com/", "https://www.goal.com/",
        "https://www.soccerway.com/", "https://www.transfermarkt.com/",
        # 연예/문화
        "https://variety.com/", "https://www.hollywoodreporter.com/",
        "https://www.billboard.com/", "https://www.rollingstone.com/",
        "https://www.vulture.com/", "https://www.polygon.com/",
    ],
    
    # ── 학술/연구 (2,000개) ──
    "academic-research": [
        # 논문 데이터베이스
        "https://arxiv.org/list/cs.AI/recent", "https://arxiv.org/list/cs.LG/recent",
        "https://arxiv.org/list/cs.CL/recent", "https://arxiv.org/list/cs.CV/recent",
        "https://arxiv.org/list/cs.CR/recent", "https://arxiv.org/list/cs.SE/recent",
        "https://arxiv.org/list/cs.DB/recent", "https://arxiv.org/list/cs.NE/recent",
        "https://arxiv.org/list/stat.ML/recent", "https://arxiv.org/list/math.CO/recent",
        # 학술 저널
        "https://www.nature.com/", "https://www.science.org/",
        "https://www.cell.com/", "https://www.thelancet.com/",
        "https://jamanetwork.com/", "https://www.bmj.com/",
        "https://ieeexplore.ieee.org/", "https://dl.acm.org/",
        # 학술 기관
        "https://scholar.google.com/", "https://www.semanticscholar.org/",
        "https://pubmed.ncbi.nlm.nih.gov/", "https://www.ncbi.nlm.nih.gov/pmc/",
        "https://papers.ssrn.com/", "https://www.researchgate.net/",
        "https://academia.edu/", "https://www.jstor.org/",
        # 기술 연구소
        "https://research.google/pubs/", "https://ai.meta.com/research/",
        "https://openai.com/research/", "https://deepmind.google/research/",
        "https://www.microsoft.com/en-us/research/",
        "https://research.ibm.com/", "https://research.yahoo.com/",
        "https://www.amazon.science/", "https://research.netflix.com/",
        # 교과서/참고서
        "https://openstax.org/subjects", "https://www.khanacademy.org/",
        "https://ocw.mit.edu/", "https://www.coursera.org/",
        "https://www.edx.org/", "https://www.udemy.com/",
    ],
    
    # ── 교육/튜토리얼 (2,000개) ──
    "education-tutorial": [
        # 프로그래밍 학습
        "https://www.codecademy.com/catalog", "https://www.freecodecamp.org/learn",
        "https://www.theodinproject.com/", "https://boot.dev/",
        "https://exercism.org/", "https://www.codewars.com/",
        "https://leetcode.com/", "https://www.hackerrank.com/",
        "https://www.topcoder.com/", "https://codeforces.com/",
        # 인터뷰 준비
        "https://www.interviewing.io/", "https://www.pramp.com/",
        "https://www.glassdoor.com/", "https://www.levels.fyi/",
        "https://www.teamblind.com/", "https://www Blind.com/",
        # 전문 분야
        "https://www.pluralsight.com/", "https://www.linkedin.com/learning/",
        "https://www.udacity.com/", "https://www.skillshare.com/",
        "https://www.domestika.org/", "https://www.skillshare.com/",
        # 언어 학습
        "https://www.duolingo.com/", "https://www.babbel.com/",
        "https://www.memrise.com/", "https://www.busuu.com/",
        "https://www.rosariastone.com/", "https://www.fluentu.com/",
        # 자격증
        "https://www.aws.amazon.com/certification/",
        "https://cloud.google.com/certification",
        "https://learn.microsoft.com/en-us/certifications/",
        "https://www.coursera.org/professional-certificates",
    ],
    
    # ── 금융/경제 (1,500개) ──
    "finance-economy": [
        # 금융 뉴스
        "https://www.investopedia.com/", "https://www.nerdwallet.com/",
        "https://www.bankrate.com/", "https://www.fool.com/",
        "https://www.kiplinger.com/", "https://www.barrons.com/",
        "https://www.morningstar.com/", "https://www.valuepenguin.com/",
        # 경제 데이터
        "https://data.worldbank.org/", "https://www.imf.org/en/Data",
        "https://stats.oecd.org/", "https://ec.europa.eu/eurostat/",
        "https://www.bea.gov/", "https://www.bls.gov/",
        "https://www.federalreserve.gov/", "https://www.ecb.europa.eu/",
        # 암호화폐
        "https://www.coinmarketcap.com/", "https://www.coindesk.com/",
        "https://cointelegraph.com/", "https://decrypt.co/",
        "https://www.theblock.co/", "https://messari.io/",
        # 스타트업/벤처
        "https://www.crunchbase.com/", "https://pitchbook.com/",
        "https://www.cbinsights.com/", "https://techcrunch.com/category/startups/",
        "https://www.angelist.com/", "https://www.ycombinator.com/",
    ],
}

def get_random_user_agent() -> str:
    return random.choice(USER_AGENTS)

def get_rss_headers() -> Dict[str, str]:
    return {
        "User-Agent": get_random_user_agent(),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,ko;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
    }

# ─── 중복 방지 DB ───────────────────────────────────────
class DedupDB:
    def __init__(self, db_path: str = DEDUP_DB_PATH):
        os.makedirs(os.path.dirname(db_path), exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self._init_table()

    def _init_table(self):
        self.conn.execute("""
            CREATE TABLE IF NOT EXISTS crawled_urls (
                url_hash TEXT PRIMARY KEY,
                url TEXT NOT NULL,
                title TEXT,
                crawled_at TEXT NOT NULL,
                category TEXT,
                success INTEGER DEFAULT 1
            )
        """)
        self.conn.commit()

    def is_crawled(self, url: str) -> bool:
        url_hash = hashlib.md5(url.encode()).hexdigest()
        cur = self.conn.execute(
            "SELECT 1 FROM crawled_urls WHERE url_hash = ?", (url_hash,)
        )
        return cur.fetchone() is not None

    def mark_crawled(self, url: str, title: str = "", category: str = "", success: bool = True):
        url_hash = hashlib.md5(url.encode()).hexdigest()
        self.conn.execute(
            """INSERT OR IGNORE INTO crawled_urls
               (url_hash, url, title, crawled_at, category, success)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (url_hash, url, title, datetime.utcnow().isoformat(), category, 1 if success else 0),
        )
        self.conn.commit()

    def stats(self) -> Dict:
        cur = self.conn.execute("SELECT COUNT(*) FROM crawled_urls")
        total = cur.fetchone()[0]
        cur = self.conn.execute("SELECT category, COUNT(*) FROM crawled_urls GROUP BY category")
        by_category = {row[0]: row[1] for row in cur.fetchall()}
        return {"total": total, "by_category": by_category}

    def close(self):
        self.conn.close()

# ─── 콘텐츠 추출 ──────────────────────────────────────────
def extract_content_jina(url: str, retries: int = 3) -> Optional[Dict[str, str]]:
    """Jina Reader API로 콘텐츠 추출 (무료)"""
    for attempt in range(retries):
        try:
            headers = get_rss_headers()
            response = requests.get(
                f"https://r.jina.ai/{url}",
                headers=headers,
                timeout=15,
            )
            
            if response.status_code == 200:
                content = response.text[:5000]  # 최대 5KB
                
                # 제목 추출
                title_match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
                title = title_match.group(1) if title_match else url.split('/')[-1]
                
                return {
                    "url": url,
                    "title": title[:200],
                    "content": content,
                    "source": "jina",
                }
            elif response.status_code == 429:
                wait_time = min(2 ** attempt * 5, 30)
                time.sleep(wait_time)
            elif response.status_code == 403:
                time.sleep(2 ** attempt)
            else:
                return None
                
        except requests.exceptions.Timeout:
            time.sleep(2 ** attempt)
        except Exception:
            time.sleep(1)
    
    return None

def chunk_content(content: str, max_chunk_size: int = 400) -> List[str]:
    """콘텐츠 청킹"""
    if not content:
        return []
    
    chunks = []
    paragraphs = content.split("\n\n")
    
    current_chunk = ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        
        if len(current_chunk) + len(para) + 2 <= max_chunk_size:
            current_chunk += para + "\n\n"
        else:
            if current_chunk:
                chunks.append(current_chunk.strip())
            current_chunk = para + "\n\n"
    
    if current_chunk:
        chunks.append(current_chunk.strip())
    
    return chunks if chunks else [content[:max_chunk_size]]

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
                time.sleep(min(2 ** attempt, 30))
        except requests.exceptions.Timeout:
            time.sleep(min(2 ** attempt, 30))
        except Exception:
            time.sleep(1)
    return []

# ─── 메인 크롤러 ──────────────────────────────────────────
class BulkCrawler:
    def __init__(
        self,
        chroma_path: str = CHROMA_PATH,
        collection_name: str = COLLECTION_NAME,
        max_workers: int = 3,
        batch_size: int = 10,
    ):
        self.chroma_path = chroma_path
        self.collection_name = collection_name
        self.max_workers = max_workers
        self.batch_size = batch_size
        
        # ChromaDB 연결
        self.chroma = chromadb.PersistentClient(path=chroma_path)
        self.collection = self.chroma.get_or_create_collection(
            name=collection_name,
            metadata={"hnsw:space": "cosine"},
        )
        
        # 중복 방지 DB
        self.dedup = DedupDB()
        
        # 통계
        self.stats = {
            "total_urls": 0,
            "crawled": 0,
            "success": 0,
            "failed": 0,
            "skipped": 0,
            "chunks_created": 0,
        }
        
        # 로그 디렉토리
        LOG_DIR.mkdir(parents=True, exist_ok=True)
    
    def crawl_url(self, url: str, category: str) -> bool:
        """단일 URL 크롤링"""
        # 중복 확인
        if self.dedup.is_crawled(url):
            self.stats["skipped"] += 1
            return False
        
        # 콘텐츠 추출
        result = extract_content_jina(url)
        if not result or not result.get("content"):
            self.dedup.mark_crawled(url, "", category, False)
            self.stats["failed"] += 1
            return False
        
        # 청킹
        chunks = chunk_content(result["content"])
        
        # 임베딩 + 저장
        doc_ids = []
        embeddings = []
        metadatas = []
        documents = []
        
        for i, chunk in enumerate(chunks[:3]):  # 최대 3개 청크
            emb = get_embedding(chunk)
            if not emb:
                continue
            
            doc_id = hashlib.md5(f"{url}_bulk_{i}".encode()).hexdigest()
            doc_ids.append(doc_id)
            embeddings.append(emb)
            metadatas.append({
                "url": url,
                "title": result["title"],
                "chunk_index": i,
                "total_chunks": len(chunks),
                "category": category,
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
            self.dedup.mark_crawled(url, result["title"], category, True)
            self.stats["success"] += 1
            self.stats["chunks_created"] += len(doc_ids)
            return True
        
        return False
    
    def crawl_category(self, category: str, urls: List[str], limit: int = None):
        """카테고리별 크롤링"""
        print(f"\n📂 [{category.upper()}] ({len(urls)}개 URL)")
        print("-" * 40)
        
        if limit:
            urls = urls[:limit]
        
        self.stats["total_urls"] += len(urls)
        
        success = 0
        failed = 0
        
        for i, url in enumerate(urls, 1):
            try:
                if self.crawl_url(url, category):
                    success += 1
                    if success % 10 == 0:
                        print(f"   ✅ {success}/{len(urls)} 완료")
                else:
                    failed += 1
                
                # 요청 간 대기
                time.sleep(random.uniform(0.5, 1.5))
                
            except Exception as e:
                print(f"   ❌ 오류 ({url}): {e}")
                failed += 1
        
        print(f"   완료: {success} 성공, {failed} 실패")
        return success, failed
    
    def run(
        self,
        categories: List[str] = None,
        limit_per_category: int = None,
    ):
        """전체 크롤링 실행"""
        print("🚀 대량 시드 URL 크롤링 시작")
        print(f"   카테고리: {', '.join(categories) or '전체'}")
        print(f"   최대 URL/카테고리: {limit_per_category or '제한 없음'}")
        print(f"   병렬 워커: {self.max_workers}")
        print("=" * 60)
        
        start_time = time.time()
        
        # 카테고리별 크롤링
        target_categories = categories or list(SEED_URLS.keys())
        
        for cat in target_categories:
            if cat not in SEED_URLS:
                print(f"   ⚠️ 카테고리 '{cat}' 없음, 건너뜀")
                continue
            
            urls = SEED_URLS[cat]
            self.crawl_category(cat, urls, limit_per_category)
        
        # 통계 출력
        elapsed = time.time() - start_time
        dedup_stats = self.dedup.stats()
        
        print("\n" + "=" * 60)
        print("✅ 대량 크롤링 완료!")
        print("=" * 60)
        print(f"   처리된 URL: {self.stats['total_urls']}개")
        print(f"   성공: {self.stats['success']}개")
        print(f"   실패: {self.stats['failed']}개")
        print(f"   건너뜀: {self.stats['skipped']}개")
        print(f"   생성된 청크: {self.stats['chunks_created']}개")
        print(f"   소요 시간: {elapsed:.1f}초")
        print(f"   컬렉션 문서 수: {self.collection.count()}개")
        
        # 카테고리별 통계
        if dedup_stats["by_category"]:
            print("\n   카테고리별:")
            for cat, count in sorted(dedup_stats["by_category"].items(), key=lambda x: -x[1]):
                print(f"      {cat}: {count}개")
        
        return self.stats
    
    def get_stats(self):
        """통계 출력"""
        dedup_stats = self.dedup.stats()
        col_count = self.collection.count()
        
        print(f"\n📊 대량 크롤링 통계")
        print("=" * 40)
        print(f"   컬렉션: {self.collection_name}")
        print(f"   총 문서: {col_count}개")
        print(f"   중복 방지 DB: {dedup_stats['total']}개 URL")
        
        if dedup_stats["by_category"]:
            print(f"   카테고리별:")
            for cat, count in sorted(dedup_stats["by_category"].items(), key=lambda x: -x[1]):
                print(f"      {cat}: {count}개")
    
    def close(self):
        self.dedup.close()

# ─── CLI ────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(description="대량 시드 URL 크롤링")
    parser.add_argument("--categories", "-c", nargs="+", 
                       choices=list(SEED_URLS.keys()),
                       help="크롤링할 카테고리")
    parser.add_argument("--limit", "-l", type=int, default=None,
                       help="카테고리당 최대 URL 수")
    parser.add_argument("--workers", "-w", type=int, default=3,
                       help="병렬 워커 수")
    parser.add_argument("--stats", action="store_true",
                       help="통계 출력")
    parser.add_argument("--dry-run", action="store_true",
                       help="실제 크롤링 없이 확인")
    
    args = parser.parse_args()
    
    # 크롤러 초기화
    crawler = BulkCrawler(max_workers=args.workers)
    
    # 통계 모드
    if args.stats:
        crawler.get_stats()
        crawler.close()
        return
    
    # Dry run
    if args.dry_run:
        print("🔍 Dry run 모드")
        target_categories = args.categories or list(SEED_URLS.keys())
        
        total_urls = 0
        for cat in target_categories:
            if cat in SEED_URLS:
                urls = SEED_URLS[cat]
                if args.limit:
                    urls = urls[:args.limit]
                total_urls += len(urls)
                print(f"   {cat}: {len(urls)}개 URL")
        
        print(f"\n   총 URL: {total_urls}개")
        print(f"   예상 시간: {total_urls * 2 / 60:.1f}분")
        crawler.close()
        return
    
    # 크롤링 실행
    crawler.run(
        categories=args.categories,
        limit_per_category=args.limit,
    )
    
    crawler.close()

if __name__ == "__main__":
    main()
