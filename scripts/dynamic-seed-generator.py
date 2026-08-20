#!/usr/bin/env python3
"""
동적 시드 URL 생성기
- Google News RSS로 뉴스 URL 자동 생성
- Wikipedia API로 백과사전 URL 자동 생성
- GitHub API로 기술 문서 URL 자동 생성
- arXiv API로 학술 논문 URL 자동 생성
"""

import json
import os
import time
from pathlib import Path
from typing import List, Dict
import requests
import feedparser

# ─── 설정 ──────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
SEED_DATA_DIR = SCRIPT_DIR / "seed-data"
OUTPUT_FILE = SEED_DATA_DIR / "generated-seed-urls.json"

# ─── Google News RSS ──────────────────────────────────────
GOOGLE_NEWS_RSS_QUERIES = [
    # 기술
    "artificial intelligence", "machine learning", "deep learning",
    "python programming", "javascript", "typescript", "rust programming",
    "docker container", "kubernetes", "cloud computing",
    "blockchain", "cryptocurrency", "web3", "NFT",
    "cybersecurity", "data science", "big data", "quantum computing",
    "augmented reality", "virtual reality", "metaverse",
    "robotics", "autonomous vehicles", "IoT", "edge computing",
    "5G", "6G", "satellite internet", "space technology",
    # 비즈니스
    "startup funding", "venture capital", "IPO", "M&A",
    "tech stocks", "market analysis", "economic outlook",
    "inflation", "interest rates", "Federal Reserve",
    "cryptocurrency market", "Bitcoin", "Ethereum",
    # 과학
    "climate change", "renewable energy", "solar power",
    "gene editing", "CRISPR", "biotechnology",
    "space exploration", "NASA", "SpaceX", "Mars",
    "quantum physics", "particle physics",
    # 한국어
    "한국 경제", "한국 기술", "한국 스타트업", "한국 AI",
    "삼성전자", "SK하이닉스", "네이버", "카카오",
    "코스피", "코스닥", "가상화폐", "블록체인",
    "인공지능", "머신러닝", "클라우드", "빅데이터",
    # 중국어
    "人工智能", "机器学习", "深度学习", "量子计算",
    "区块链", "加密货币", "5G", "新能源",
    "电动汽车", "自动驾驶", "机器人", "半导体",
    # 일본어
    "人工知能", "機械学習", "量子コンピューティング",
    "ブロックチェーン", "暗号資産", "5G", "再生可能エネルギー",
]

def generate_google_news_urls(max_per_query: int = 10) -> List[Dict]:
    """Google News RSS로 뉴스 URL 생성"""
    urls = []
    
    for query in GOOGLE_NEWS_RSS_QUERIES:
        try:
            encoded_query = requests.utils.quote(query)
            rss_url = f"https://news.google.com/rss/search?q={encoded_query}&hl=en&gl=US&ceid=US:en"
            
            feed = feedparser.parse(rss_url)
            
            for entry in feed.entries[:max_per_query]:
                urls.append({
                    "url": entry.get("link", ""),
                    "title": entry.get("title", ""),
                    "source": "google-news",
                    "query": query,
                })
            
            time.sleep(0.5)  # Rate limit
            
        except Exception as e:
            print(f"   ⚠️ Google News 오류 ({query}): {e}")
    
    return urls

# ─── Wikipedia API ──────────────────────────────────────────
WIKIPEDIA_CATEGORIES = [
    "Artificial_intelligence", "Machine_learning", "Computer_programming",
    "Web_development", "Data_science", "Cybersecurity", "Cloud_computing",
    "Blockchain", "Quantum_computing", "Robotics", "Internet_of_things",
    "Software_engineering", "Computer_networks", "Database_management",
    "Operating_systems", "Computer_graphics", "Natural_language_processing",
    "Computer_vision", "Speech_recognition", "Autonomous_vehicles",
    "Renewable_energy", "Climate_change", "Biotechnology", "Nanotechnology",
    "Space_exploration", "Genetics", "Neuroscience", "Physics",
    "Mathematics", "Statistics", "Economics", "Finance",
    "Business", "Entrepreneurship", "Marketing", "Management",
    "Psychology", "Sociology", "Philosophy", "History",
    "Geography", "Politics", "International_relations", "Law",
    "Medicine", "Health", "Education", "Culture",
    "Art", "Music", "Literature", "Film",
    "Technology", "Innovation", "Digital_transformation",
    "Korean_technology", "Korean_economy", "Korean_culture",
    "Japanese_technology", "Japanese_economy", "Japanese_culture",
    "Chinese_technology", "Chinese_economy", "Chinese_culture",
]

def generate_wikipedia_urls(max_per_category: int = 20) -> List[Dict]:
    """Wikipedia API로 백과사전 URL 생성"""
    urls = []
    
    for category in WIKIPEDIA_CATEGORIES:
        try:
            # Wikipedia API로 카테고리 내 문서 조회
            api_url = "https://en.wikipedia.org/w/api.php"
            params = {
                "action": "query",
                "list": "categorymembers",
                "cmtitle": f"Category:{category}",
                "cmlimit": max_per_category,
                "format": "json",
            }
            
            response = requests.get(api_url, params=params, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                members = data.get("query", {}).get("categorymembers", [])
                
                for member in members:
                    if member.get("ns") == 0:  # 문서만
                        title = member.get("title", "")
                        url = f"https://en.wikipedia.org/wiki/{title.replace(' ', '_')}"
                        urls.append({
                            "url": url,
                            "title": title,
                            "source": "wikipedia",
                            "category": category,
                        })
            
            time.sleep(0.5)  # Rate limit
            
        except Exception as e:
            print(f"   ⚠️ Wikipedia 오류 ({category}): {e}")
    
    return urls

# ─── GitHub API ──────────────────────────────────────────
GITHUB_SEARCH_QUERIES = [
    "machine learning", "deep learning", "neural network",
    "natural language processing", "computer vision",
    "reinforcement learning", "generative AI", "LLM",
    "transformer", "attention mechanism", "diffusion model",
    "recommender system", "time series", "anomaly detection",
    "data pipeline", "ETL", "data engineering",
    "MLOps", "model deployment", "model serving",
    "API development", "REST API", "GraphQL", "gRPC",
    "web framework", "microservices", "serverless",
    "container", "kubernetes", "docker", "terraform",
    "CI/CD", "DevOps", "infrastructure as code",
    "database", "SQL", "NoSQL", "Redis", "MongoDB",
    "search engine", "information retrieval", "indexing",
    "caching", "load balancing", "distributed system",
    "blockchain", "smart contract", "DeFi",
    "web3", "NFT", "cryptocurrency",
    "cybersecurity", "cryptography", "encryption",
    "operating system", "compiler", "interpreter",
    "programming language", "type system", "memory management",
]

def generate_github_urls(max_per_query: int = 20) -> List[Dict]:
    """GitHub API로 기술 문서 URL 생성"""
    urls = []
    
    for query in GITHUB_SEARCH_QUERIES:
        try:
            # GitHub Search API
            api_url = "https://api.github.com/search/repositories"
            params = {
                "q": query,
                "sort": "stars",
                "order": "desc",
                "per_page": max_per_query,
            }
            
            headers = {
                "Accept": "application/vnd.github.v3+json",
                "User-Agent": "BulkSeedGenerator/1.0",
            }
            
            response = requests.get(api_url, params=params, headers=headers, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                items = data.get("items", [])
                
                for item in items:
                    # README URL
                    readme_url = item.get("html_url", "") + "/blob/main/README.md"
                    urls.append({
                        "url": readme_url,
                        "title": item.get("full_name", ""),
                        "source": "github",
                        "stars": item.get("stargazers_count", 0),
                        "description": item.get("description", "")[:200],
                    })
            
            time.sleep(1)  # Rate limit (10 req/min for unauthenticated)
            
        except Exception as e:
            print(f"   ⚠️ GitHub 오류 ({query}): {e}")
    
    return urls

# ─── arXiv API ──────────────────────────────────────────
ARXIV_CATEGORIES = [
    "cs.AI", "cs.LG", "cs.CL", "cs.CV", "cs.CR",
    "cs.SE", "cs.DB", "cs.NE", "stat.ML", "math.CO",
    "physics.comp-ph", "q-bio.GN", "q-fin.CP",
    "eess.SP", "eess.AS", "eess.IV",
]

def generate_arxiv_urls(max_per_category: int = 50) -> List[Dict]:
    """arXiv API로 학술 논문 URL 생성"""
    urls = []
    
    for category in ARXIV_CATEGORIES:
        try:
            # arXiv API
            api_url = "http://export.arxiv.org/api/query"
            params = {
                "search_query": f"cat:{category}",
                "start": 0,
                "max_results": max_per_category,
                "sortBy": "submittedDate",
                "sortOrder": "descending",
            }
            
            response = requests.get(api_url, params=params, timeout=15)
            
            if response.status_code == 200:
                feed = feedparser.parse(response.text)
                
                for entry in feed.entries:
                    urls.append({
                        "url": entry.get("id", ""),
                        "title": entry.get("title", "").strip(),
                        "source": "arxiv",
                        "category": category,
                        "authors": [a.get("name", "") for a in entry.get("authors", [])],
                        "summary": entry.get("summary", "")[:200],
                    })
            
            time.sleep(1)  # Rate limit
            
        except Exception as e:
            print(f"   ⚠️ arXiv 오류 ({category}): {e}")
    
    return urls

# ─── 메인 ──────────────────────────────────────────────
def main():
    print("🚀 동적 시드 URL 생성 시작")
    print("=" * 60)
    
    all_urls = []
    
    # 1. Google News
    print("\n📰 Google News RSS...")
    news_urls = generate_google_news_urls(max_per_query=15)
    all_urls.extend(news_urls)
    print(f"   생성: {len(news_urls)}개")
    
    # 2. Wikipedia
    print("\n📚 Wikipedia...")
    wiki_urls = generate_wikipedia_urls(max_per_category=15)
    all_urls.extend(wiki_urls)
    print(f"   생성: {len(wiki_urls)}개")
    
    # 3. GitHub
    print("\n💻 GitHub...")
    github_urls = generate_github_urls(max_per_query=10)
    all_urls.extend(github_urls)
    print(f"   생성: {len(github_urls)}개")
    
    # 4. arXiv
    print("\n📄 arXiv...")
    arxiv_urls = generate_arxiv_urls(max_per_category=30)
    all_urls.extend(arxiv_urls)
    print(f"   생성: {len(arxiv_urls)}개")
    
    # 결과 저장
    output = {
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_urls": len(all_urls),
        "by_source": {},
        "urls": all_urls,
    }
    
    # 소스별 통계
    for url in all_urls:
        source = url.get("source", "unknown")
        output["by_source"][source] = output["by_source"].get(source, 0) + 1
    
    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    # 요약 출력
    print("\n" + "=" * 60)
    print("✅ 동적 시드 URL 생성 완료!")
    print("=" * 60)
    print(f"   총 URL: {len(all_urls)}개")
    print(f"   소스별:")
    for source, count in sorted(output["by_source"].items(), key=lambda x: -x[1]):
        print(f"      {source}: {count}개")
    print(f"\n   저장: {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
