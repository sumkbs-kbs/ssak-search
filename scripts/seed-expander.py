#!/usr/bin/env python3
"""
시드 URL 확장기
- 기존 시드 URL에서 관련 URL 자동 발견
- 페이지 내 링크 추출
- 카테고리별 확장
"""

import json
import os
import re
import time
from pathlib import Path
from typing import List, Dict, Set
import requests

# ─── 설정 ──────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
SEED_DATA_DIR = SCRIPT_DIR / "seed-data"
OUTPUT_FILE = SEED_DATA_DIR / "expanded-seed-urls.json"
DEDUP_FILE = SEED_DATA_DIR / "expanded-dedup.json"

# ─── User-Agent ──────────────────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
]

import random

def get_headers():
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
    }

def extract_links_from_page(url: str, timeout: int = 10) -> List[str]:
    """페이지에서 링크 추출"""
    try:
        response = requests.get(url, headers=get_headers(), timeout=timeout, allow_redirects=True)
        
        if response.status_code != 200:
            return []
        
        # HTML에서 링크 추출
        html = response.text
        
        # href 링크 추출
        href_pattern = r'href=["\']([^"\']+)["\']'
        links = re.findall(href_pattern, html)
        
        # 상대 URL을 절대 URL로 변환
        base_url = url.rstrip('/')
        absolute_links = []
        
        for link in links:
            if link.startswith('http'):
                absolute_links.append(link)
            elif link.startswith('//'):
                absolute_links.append(f"https:{link}")
            elif link.startswith('/'):
                absolute_links.append(f"https://{url.split('/')[2]}{link}")
            elif not link.startswith('#') and not link.startswith('javascript:'):
                absolute_links.append(f"{base_url}/{link}")
        
        return absolute_links
        
    except Exception as e:
        return []

def expand_seed_urls(seed_urls: List[str], max_per_seed: int = 5, max_total: int = 10000) -> List[Dict]:
    """시드 URL 확장"""
    expanded = []
    visited = set()
    
    print(f"   시드 URL: {len(seed_urls)}개")
    print(f"   시드당 최대: {max_per_seed}개")
    print(f"   전체 최대: {max_total}개")
    print()
    
    for i, seed_url in enumerate(seed_urls):
        if len(expanded) >= max_total:
            print(f"\n   ⏹️ 최대 URL 도달 ({max_total}개)")
            break
        
        if seed_url in visited:
            continue
        
        visited.add(seed_url)
        
        # 시드 URL 자체 추가
        expanded.append({
            "url": seed_url,
            "source": "seed",
            "depth": 0,
        })
        
        # 관련 URL 발견
        if i % 10 == 0:
            print(f"   [{i+1}/{len(seed_urls)}] 확장 중... (현재 {len(expanded)}개)")
        
        related_urls = extract_links_from_page(seed_url)
        
        # 필터링
        filtered_urls = []
        for url in related_urls:
            if url in visited:
                continue
            
            # 도메인 필터 (시드와 같은 도메인 또는 관련 도메인)
            seed_domain = seed_url.split('/')[2]
            link_domain = url.split('/')[2] if len(url.split('/')) > 2 else ''
            
            # 같은 도메인 또는 교육/기술 도메인
            if (seed_domain == link_domain or
                any(d in link_domain for d in [
                    'github.com', 'stackoverflow.com', 'developer.mozilla.org',
                    'docs.python.org', 'docs.oracle.com', 'kotlinlang.org',
                    'typescriptlang.org', 'rust-lang.org', 'go.dev',
                    'react.dev', 'vuejs.org', 'angular.dev',
                    'docker.com', 'kubernetes.io', 'cloud.google.com',
                    'aws.amazon.com', 'developers.cloudflare.com',
                    'wikipedia.org', 'arxiv.org', 'nature.com',
                    'medium.com', 'dev.to', 'hashnode.com',
                ])):
                filtered_urls.append(url)
        
        # 최대 개수만큼 추가
        for url in filtered_urls[:max_per_seed]:
            if url not in visited:
                visited.add(url)
                expanded.append({
                    "url": url,
                    "source": "expanded",
                    "depth": 1,
                    "parent": seed_url,
                })
        
        time.sleep(0.3)  # Rate limit
    
    return expanded

def main():
    print("🚀 시드 URL 확장 시작")
    print("=" * 60)
    
    # 1. 기존 시드 로드
    print("\n📂 기존 시드 로드...")
    seed_urls = []
    
    # 기존 시드 데이터 파일
    for f in ["tech-docs.json", "github.json", "wikipedia.json", "extended-tech-docs.json"]:
        try:
            with open(f"scripts/seed-data/{f}", "r") as file:
                data = json.load(file)
                if isinstance(data, list):
                    for item in data:
                        if isinstance(item, dict) and "url" in item:
                            seed_urls.append(item["url"])
                        elif isinstance(item, str):
                            seed_urls.append(item)
        except:
            pass
    
    # 생성된 시드 데이터
    try:
        with open("scripts/seed-data/generated-seed-urls.json", "r") as f:
            data = json.load(f)
            for item in data.get("urls", []):
                if "url" in item:
                    seed_urls.append(item["url"])
    except:
        pass
    
    # 중복 제거
    seed_urls = list(set(seed_urls))
    print(f"   로드된 시드: {len(seed_urls)}개")
    
    # 2. 시드 확장
    print("\n🔍 시드 확장...")
    expanded = expand_seed_urls(seed_urls, max_per_seed=3, max_total=10000)
    
    # 3. 결과 저장
    output = {
        "expanded_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "total_urls": len(expanded),
        "seed_count": len(seed_urls),
        "expanded_count": len([u for u in expanded if u.get("source") == "expanded"]),
        "urls": expanded,
    }
    
    with open(OUTPUT_FILE, "w") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)
    
    # 요약 출력
    print("\n" + "=" * 60)
    print("✅ 시드 URL 확장 완료!")
    print("=" * 60)
    print(f"   총 URL: {len(expanded)}개")
    print(f"   시드: {len(seed_urls)}개")
    print(f"   확장: {len([u for u in expanded if u.get('source') == 'expanded'])}개")
    print(f"   저장: {OUTPUT_FILE}")

if __name__ == "__main__":
    main()
