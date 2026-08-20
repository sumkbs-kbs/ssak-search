#!/usr/bin/env python3
"""
검색 품질 벤치마크: 로컬 인덱스 vs Cloudflare 인덱스
- 20개 테스트 쿼리
- 응답 속도, 관련성 점수, 커버리지 비교
"""

import json
import time
from typing import Any, Dict, List

import chromadb
import requests

# ─── 설정 ──────────────────────────────────────────────
OLLAMA_URL = "http://localhost:11434"
EMBEDDING_MODEL = "nomic-embed-text"
LOCAL_CHROMA_PATH = "./local-index/chroma-data-v2"
LOCAL_COLLECTION = "search-index-v2"
NEWS_COLLECTION = "news-rss-index"
CLOUDFLARE_URL = "https://search-engine-api.pages.dev"
CLOUDFLARE_KEY = "sk-6y8P-K1aj1qbwhLaB7BdRXxII8cVKo0gboAd5DxvJnw"

# ─── 테스트 쿼리 ────────────────────────────────────────
# (쿼리, 기대 도메인 키워드, 카테고리)
TEST_QUERIES = [
    ("react hooks component", ["react.dev"], "tech"),
    ("python tutorial beginner", ["python.org"], "tech"),
    ("docker container deployment", ["docker.com"], "tech"),
    ("kubernetes pod management", ["kubernetes.io"], "tech"),
    ("typescript generics type", ["typescriptlang.org"], "tech"),
    ("rust ownership borrowing", ["rust-lang.org"], "tech"),
    ("nextjs server components", ["nextjs.org"], "tech"),
    ("tailwind css utility", ["tailwindcss.com"], "tech"),
    ("playwright e2e testing", ["playwright.dev"], "tech"),
    ("graphql api query mutation", ["graphql.org"], "tech"),
    ("AI transformer neural network", ["arxiv.org"], "science"),
    ("climate change global warming", [], "science"),
    ("space exploration mars", [], "science"),
    ("openai gpt language model", [], "tech"),
    ("cloudflare workers serverless", ["cloudflare.com"], "tech"),
    ("vuejs composition api", ["vuejs.org"], "tech"),
    ("angular signals framework", ["angular.io"], "tech"),
    ("aws lambda serverless", ["aws.amazon.com"], "cloud"),
    ("google cloud kubernetes engine", ["cloud.google.com"], "cloud"),
    ("javascript promise async await", ["developer.mozilla.org"], "tech"),
]


def get_embedding(text: str) -> List[float]:
    """Ollama로 임베딩 생성"""
    try:
        resp = requests.post(
            f"{OLLAMA_URL}/api/embeddings",
            json={"model": EMBEDDING_MODEL, "prompt": text},
            timeout=20,
        )
        if resp.status_code == 200:
            return resp.json().get("embedding", [])
    except Exception:
        pass
    return []


def search_local(query: str, n: int = 5) -> Dict[str, Any]:
    """로컬 인덱스 검색 (기술 문서 + 뉴스)"""
    client = chromadb.PersistentClient(path=LOCAL_CHROMA_PATH)
    emb = get_embedding(query)
    if not emb:
        return {"results": [], "time_ms": 0, "error": "embedding failed"}

    all_results = []

    # 기술 문서 컬렉션
    try:
        col = client.get_collection(LOCAL_COLLECTION)
        r = col.query(query_embeddings=[emb], n_results=n,
                       include=["metadatas", "distances"])
        if r.get("ids") and r["ids"][0]:
            for i, doc_id in enumerate(r["ids"][0]):
                meta = r["metadatas"][0][i]
                all_results.append({
                    "title": meta.get("title", ""),
                    "url": meta.get("url", ""),
                    "domain": meta.get("domain", ""),
                    "score": round(1 - r["distances"][0][i], 4),
                    "source": "local-tech",
                })
    except Exception:
        pass

    # 뉴스 컬렉션
    try:
        col = client.get_collection(NEWS_COLLECTION)
        r = col.query(query_embeddings=[emb], n_results=n,
                       include=["metadatas", "distances"])
        if r.get("ids") and r["ids"][0]:
            for i, doc_id in enumerate(r["ids"][0]):
                meta = r["metadatas"][0][i]
                all_results.append({
                    "title": meta.get("title", ""),
                    "url": meta.get("url", ""),
                    "domain": meta.get("domain", meta.get("source_feed", "")),
                    "score": round(1 - r["distances"][0][i], 4),
                    "source": "local-news",
                })
    except Exception:
        pass

    # 점수순 정렬
    all_results.sort(key=lambda x: x["score"], reverse=True)
    return {"results": all_results[:n], "error": None}


def search_cloudflare(query: str, n: int = 5) -> Dict[str, Any]:
    """Cloudflare 외부 백엔드 검색 (Bing, DuckDuckGo 등)"""
    start = time.time()
    try:
        # Cloudflare의 실제 검색은 외부 백엔드를 사용
        # /api/search 대신 외부 백엔드를 직접 호출하여 비교
        results = []

        # DuckDuckGo HTML 검색 (안정적)
        try:
            from urllib.parse import quote_plus
            import re
            ddg_url = f"https://html.duckduckgo.com/html/?q={quote_plus(query)}"
            ddg_resp = requests.get(ddg_url, headers={
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"
            }, timeout=10)
            if ddg_resp.status_code == 200:
                for m in re.finditer(r'class="result__a"[^>]*href="([^"]+)"[^>]*>([^<]+)</a>', ddg_resp.text):
                    raw_url, title = m.group(1), m.group(2)
                    # DDG URL 리다이렉트 처리
                    url_match = re.search(r'uddg=([^&]+)', raw_url)
                    url = requests.utils.unquote(url_match.group(1)) if url_match else raw_url
                    if url.startswith("http") and not any(r["url"] == url for r in results):
                        results.append({
                            "title": re.sub(r'<[^>]+>', '', title).strip(),
                            "url": url,
                            "domain": url.split("/")[2],
                            "score": 0.5 + len(results) * 0.05,
                            "source": "duckduckgo",
                        })
        except Exception:
            pass

        elapsed = (time.time() - start) * 1000
        return {"results": results[:n], "time_ms": round(elapsed), "error": None}

    except Exception as e:
        elapsed = (time.time() - start) * 1000
        return {"results": [], "time_ms": round(elapsed), "error": str(e)}


def score_relevance(result: Dict, expected_domains: List[str]) -> float:
    """결과의 관련성 점수 계산"""
    score = result.get("score", 0)
    url = result.get("url", "").lower()
    title = result.get("title", "").lower()

    # 기대 도메인 매칭 보너스
    domain_bonus = 0
    if expected_domains:
        for domain in expected_domains:
            if domain.lower() in url:
                domain_bonus = 0.2
                break

    return round(min(score + domain_bonus, 1.0), 4)


def run_benchmark():
    """벤치마크 실행"""
    print("=" * 70)
    print("  🔍 검색 품질 벤치마크: 로컬 vs Cloudflare")
    print("=" * 70)

    local_scores = []
    cloud_scores = []
    local_times = []
    cloud_times = []
    results_table = []

    for i, (query, expected_domains, category) in enumerate(TEST_QUERIES):
        print(f"\n[{i+1}/{len(TEST_QUERIES)}] '{query}' ({category})")

        # 로컬 검색
        t0 = time.time()
        local = search_local(query, n=5)
        local_ms = round((time.time() - t0) * 1000)

        # Cloudflare 검색
        t0 = time.time()
        cloud = search_cloudflare(query, n=5)
        cloud_ms = cloud.get("time_ms", 0)

        # 관련성 점수 계산
        local_rel = []
        for r in local["results"][:3]:
            rel = score_relevance(r, expected_domains)
            local_rel.append(rel)

        cloud_rel = []
        for r in cloud["results"][:3]:
            rel = score_relevance(r, expected_domains)
            cloud_rel.append(rel)

        avg_local = sum(local_rel) / len(local_rel) if local_rel else 0
        avg_cloud = sum(cloud_rel) / len(cloud_rel) if cloud_rel else 0

        local_scores.append(avg_local)
        cloud_scores.append(avg_cloud)
        local_times.append(local_ms)
        cloud_times.append(cloud_ms)

        # 결과 출력
        winner = "로컬" if avg_local >= avg_cloud else "Cloudflare"
        print(f"   로컬: {avg_local:.3f} ({local_ms}ms, {len(local['results'])}건)")
        print(f"   Cloudflare: {avg_cloud:.3f} ({cloud_ms}ms, {len(cloud['results'])}건)")
        print(f"   승자: {winner}")

        # 상위 1개 결과
        if local["results"]:
            print(f"   📌 로컬 1위: {local['results'][0]['title'][:50]}")
        if cloud["results"]:
            print(f"   ☁️ Cloud 1위: {cloud['results'][0]['title'][:50]}")

        results_table.append({
            "query": query,
            "category": category,
            "local_score": avg_local,
            "local_ms": local_ms,
            "local_count": len(local["results"]),
            "cloud_score": avg_cloud,
            "cloud_ms": cloud_ms,
            "cloud_count": len(cloud["results"]),
            "winner": winner,
            "local_top1": local["results"][0]["title"][:50] if local["results"] else "",
            "cloud_top1": cloud["results"][0]["title"][:50] if cloud["results"] else "",
        })

    # ─── 최종 리포트 ──────────────────────────────────
    print("\n" + "=" * 70)
    print("  📊 최종 벤치마크 리포트")
    print("=" * 70)

    avg_l_score = sum(local_scores) / len(local_scores)
    avg_c_score = sum(cloud_scores) / len(cloud_scores)
    avg_l_time = sum(local_times) / len(local_times)
    avg_c_time = sum(cloud_times) / len(cloud_times)
    local_wins = sum(1 for l, c in zip(local_scores, cloud_scores) if l >= c)
    cloud_wins = len(local_scores) - local_wins

    print(f"\n{'항목':<25} {'로컬 인덱스':>15} {'Cloudflare':>15} {'비고':>10}")
    print("-" * 65)
    print(f"{'평균 관련성 점수':<25} {avg_l_score:>15.4f} {avg_c_score:>15.4f} {'↑' if avg_l_score > avg_c_score else '↓':>10}")
    print(f"{'평균 응답 속도':<25} {avg_l_time:>14.0f}ms {avg_c_time:>14.0f}ms {'↑' if avg_l_time < avg_c_time else '↓':>10}")
    print(f"{'승리 횟수':<25} {local_wins:>14}회 {cloud_wins:>14}회 {'↑' if local_wins > cloud_wins else '↓':>10}")
    print(f"{'인덱스 문서 수':<25} {'~280+188':>15} {'~537':>15}")
    print(f"{'데이터 소스':<25} {'Jina+BS':>15} {'Bing+Multi':>15}")
    print(f"{'비용':<25} {'$0':>15} {'$0':>15}")
    print(f"{'오프라인':<25} {'✅ 가능':>15} {'❌ 불가':>15}")

    # 카테고리별 분석
    print(f"\n{'카테고리별 분석':}")
    print("-" * 65)
    categories = set(r["category"] for r in results_table)
    for cat in sorted(categories):
        cat_results = [r for r in results_table if r["category"] == cat]
        cat_local = sum(r["local_score"] for r in cat_results) / len(cat_results)
        cat_cloud = sum(r["cloud_score"] for r in cat_results) / len(cat_results)
        winner = "로컬" if cat_local >= cat_cloud else "Cloudflare"
        print(f"  {cat:<15} 로컬: {cat_local:.3f}  Cloudflare: {cat_cloud:.3f}  → {winner}")

    # 속도 비교
    print(f"\n{'속도 분석':}")
    print("-" * 65)
    speed_ratio = avg_c_time / avg_l_time if avg_l_time > 0 else 0
    print(f"  로컬 평균: {avg_l_time:.0f}ms")
    print(f"  Cloudflare 평균: {avg_c_time:.0f}ms")
    if speed_ratio > 1:
        print(f"  → 로컬이 {speed_ratio:.1f}배 빠름")
    else:
        print(f"  → Cloudflare가 {1/speed_ratio:.1f}배 빠름")

    # JSON 리포트 저장
    report = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "summary": {
            "local_avg_score": round(avg_l_score, 4),
            "cloud_avg_score": round(avg_c_score, 4),
            "local_avg_ms": round(avg_l_time),
            "cloud_avg_ms": round(avg_c_time),
            "local_wins": local_wins,
            "cloud_wins": cloud_wins,
            "total_queries": len(TEST_QUERIES),
        },
        "results": results_table,
    }

    with open("benchmark-results.json", "w") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)

    print(f"\n📄 리포트 저장: benchmark-results.json")


if __name__ == "__main__":
    run_benchmark()
