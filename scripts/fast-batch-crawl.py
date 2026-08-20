#!/usr/bin/env python3
"""
빠른 배치 크롤링
- 100개 URL 배치 처리
- Jina Reader API로 빠른 콘텐츠 추출
- Ollama 임베딩으로 빠른 인덱싱
"""

import hashlib
import json
import os
import random
import re
import time
from datetime import datetime
from pathlib import Path
from typing import List, Dict
import requests
import chromadb
import ollama

# 설정
CHROMA_PATH = "./local-index/chroma-data-v2"
COLLECTION_NAME = "bulk-index"
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"

# User-Agent
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
]

def get_headers():
    return {"User-Agent": random.choice(USER_AGENTS)}

def extract_content(url, timeout=10):
    try:
        resp = requests.get(f"https://r.jina.ai/{url}", headers=get_headers(), timeout=timeout)
        if resp.status_code == 200:
            content = resp.text[:3000]
            title_match = re.search(r'^#\s+(.+)$', content, re.MULTILINE)
            title = title_match.group(1) if title_match else url.split('/')[-1]
            return {"url": url, "title": title[:200], "content": content}
        elif resp.status_code == 429:
            time.sleep(5)
            return None
    except:
        pass
    return None

def get_embedding(text, retries=3):
    for attempt in range(retries):
        try:
            resp = requests.post(f"{OLLAMA_URL}/api/embeddings", 
                               json={"model": EMBEDDING_MODEL, "prompt": text}, timeout=20)
            if resp.status_code == 200:
                return resp.json().get("embedding", [])
        except:
            pass
        time.sleep(0.5)
    return []

def crawl_batch(urls: List[str], batch_num: int = 1) -> Dict:
    """배치 크롤링"""
    # ChromaDB 연결
    chroma = chromadb.PersistentClient(path=CHROMA_PATH)
    collection = chroma.get_or_create_collection(name=COLLECTION_NAME, metadata={"hnsw:space": "cosine"})
    
    stats = {"success": 0, "failed": 0, "chunks": 0}
    
    print(f"\n📦 배치 {batch_num} ({len(urls)}개 URL)")
    print("-" * 40)
    
    for i, url in enumerate(urls, 1):
        try:
            result = extract_content(url)
            if not result:
                stats["failed"] += 1
                continue
            
            # 청킹
            chunks = [result["content"][j:j+400] for j in range(0, len(result["content"]), 400)]
            
            # 임베딩 + 저장
            doc_ids = []
            embeddings = []
            metadatas = []
            documents = []
            
            for j, chunk in enumerate(chunks[:2]):
                emb = get_embedding(chunk)
                if emb:
                    doc_id = hashlib.md5(f"{url}_{j}".encode()).hexdigest()
                    doc_ids.append(doc_id)
                    embeddings.append(emb)
                    metadatas.append({
                        "url": url,
                        "title": result["title"],
                        "chunk_index": j,
                        "indexed_at": datetime.utcnow().isoformat(),
                    })
                    documents.append(chunk)
            
            if doc_ids:
                collection.upsert(ids=doc_ids, embeddings=embeddings, metadatas=metadatas, documents=documents)
                stats["success"] += 1
                stats["chunks"] += len(doc_ids)
                if i % 10 == 0:
                    print(f"   [{i}/{len(urls)}] ✅ {stats['success']}개 성공")
            
            time.sleep(0.3)
            
        except Exception as e:
            stats["failed"] += 1
    
    print(f"   완료: {stats['success']} 성공, {stats['failed']} 실패, {stats['chunks']} 청크")
    return stats

def main():
    print("🚀 빠른 배치 크롤링")
    print("=" * 60)
    
    # 시드 URL 로드
    seed_urls = []
    
    # 기존 시드 데이터
    for f in ["tech-docs.json", "github.json", "wikipedia.json", "extended-tech-docs.json"]:
        try:
            with open(f"scripts/seed-data/{f}") as file:
                data = json.load(file)
                for item in (data if isinstance(data, list) else []):
                    if isinstance(item, dict) and "url" in item:
                        seed_urls.append(item["url"])
                    elif isinstance(item, str):
                        seed_urls.append(item)
        except:
            pass
    
    # 생성된 시드 데이터
    try:
        with open("scripts/seed-data/generated-seed-urls.json") as f:
            data = json.load(f)
            for item in data.get("urls", []):
                if "url" in item:
                    seed_urls.append(item["url"])
    except:
        pass
    
    # 확장 시드 데이터
    try:
        with open("scripts/seed-data/expanded-seed-urls.json") as f:
            data = json.load(f)
            for item in data.get("urls", []):
                if "url" in item:
                    seed_urls.append(item["url"])
    except:
        pass
    
    # 중복 제거
    seed_urls = list(set(seed_urls))
    
    # 현재 인덱스 확인
    chroma = chromadb.PersistentClient(path=CHROMA_PATH)
    try:
        collection = chroma.get_collection(COLLECTION_NAME)
        current_count = collection.count()
    except:
        current_count = 0
    
    print(f"   전체 시드: {len(seed_urls)}개")
    print(f"   현재 인덱스: {current_count}개")
    print(f"   목표: 10,000개")
    print(f"   필요: {10000 - current_count}개")
    
    # 배치 크롤링 (100개씩)
    batch_size = 100
    total_stats = {"success": 0, "failed": 0, "chunks": 0}
    
    for batch_num in range(0, len(seed_urls), batch_size):
        batch = seed_urls[batch_num:batch_num + batch_size]
        stats = crawl_batch(batch, batch_num // batch_size + 1)
        
        total_stats["success"] += stats["success"]
        total_stats["failed"] += stats["failed"]
        total_stats["chunks"] += stats["chunks"]
        
        # 현재 인덱스 확인
        try:
            collection = chroma.get_collection(COLLECTION_NAME)
            current_count = collection.count()
        except:
            pass
        
        print(f"\n   📊 진행 상황: {current_count}개 / 10,000개 ({current_count/100:.1f}%)")
        
        if current_count >= 10000:
            print(f"\n   🎯 목표 달성!")
            break
        
        time.sleep(1)
    
    # 최종 통계
    print("\n" + "=" * 60)
    print("✅ 배치 크롤링 완료!")
    print("=" * 60)
    print(f"   총 성공: {total_stats['success']}개")
    print(f"   총 실패: {total_stats['failed']}개")
    print(f"   총 청크: {total_stats['chunks']}개")
    print(f"   최종 인덱스: {current_count}개")

if __name__ == "__main__":
    main()
