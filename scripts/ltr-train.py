#!/usr/bin/env python3
"""
LTR v2 모델 학습
- 합성 클릭 피드백 데이터 생성 (부트스트래핑)
- LightGBM LambdaRank 학습
- 모델 검증 및 내보내기
"""

import json
import math
import os
import random
import time
from pathlib import Path
from typing import List, Dict, Tuple
import numpy as np

# ─── 설정 ──────────────────────────────────────────────
SCRIPT_DIR = Path(__file__).parent
MODEL_DIR = Path("./local-index/ltr-models")
TRAINING_DATA_DIR = MODEL_DIR / "training-data"

# ─── 피처 이름 (feature-store-v2.ts와 동일) ──────────────────────────────────────
FEATURE_NAMES = [
    # Query features (0-4)
    'q_len',                    # 0  query length (normalized)
    'q_terms',                  # 1  query token count (normalized)
    'q_has_question',           # 2  0/1 — query is a question
    'q_has_number',             # 3  0/1 — query contains numbers
    'q_has_cjk',                # 4  0/1 — query contains CJK chars

    # Document features (5-10)
    'title_len',                # 5  title length (normalized)
    'content_len',              # 6  content length (normalized)
    'snippet_len',              # 7  snippet length (normalized)
    'has_date',                 # 8  0/1 — document has published date
    'date_recency',             # 9  days since publication (normalized)
    'has_images',               # 10 0/1 — document has images

    # Query-document interaction (11-17)
    'title_overlap',            # 11 query terms in title [0,1]
    'content_overlap',          # 12 query terms in content [0,1]
    'snippet_overlap',          # 13 query terms in snippet [0,1]
    'title_exact_match',        # 14 exact query in title [0,1]
    'bm25_title',               # 15 BM25 score on title (normalized)
    'bm25_content',             # 16 BM25 score on content (normalized)
    'tfidf_avg',                # 17 average TF-IDF of query terms (normalized)

    # Authority features (18-20)
    'domain_authority',         # 18 authority bonus [0,0.3]
    'domain_age_proxy',         # 19 proxy for domain age (0-1)
    'is_major_domain',          # 20 0/1 — top 100 domain

    # Position & source features (21-24)
    'result_source',            # 21 source backend ordinal [0,1]
    'result_position',          # 22 1-based position (for debiasing)
    'is_news_source',           # 23 0/1 — from news backend
    'is_academic_source',       # 24 0/1 — from academic backend

    # Context features (25-28)
    'query_type_num',           # 25 query type ordinal [0,1]
    'is_news',                  # 26 0/1
    'is_finance',               # 27 0/1
    'korean',                   # 28 0/1
    'chinese',                  # 29 0/1

    # User features (30-31)
    'user_visited',             # 30 0/1 — user has visited domain
    'user_visits_norm',         # 31 normalized visit count
]

NUM_FEATURES = len(FEATURE_NAMES)

# ─── 합성 데이터 생성 ──────────────────────────────────────

# 샘플 쿼리와 결과
SAMPLE_QUERIES = [
    {"query": "react hooks tutorial", "type": "technical"},
    {"query": "python async await", "type": "technical"},
    {"query": "docker compose networking", "type": "technical"},
    {"query": "kubernetes pod lifecycle", "type": "technical"},
    {"query": "rust ownership borrowing", "type": "technical"},
    {"query": "typescript generics", "type": "technical"},
    {"query": "git rebase vs merge", "type": "technical"},
    {"query": "nginx reverse proxy", "type": "technical"},
    {"query": "graphql subscriptions", "type": "technical"},
    {"query": "tailwind css grid", "type": "technical"},
    {"query": "climate change effects", "type": "factual"},
    {"query": "quantum computing basics", "type": "factual"},
    {"query": "machine learning algorithms", "type": "academic"},
    {"query": "neural network architecture", "type": "academic"},
    {"query": "stock market analysis", "type": "financial"},
    {"query": "bitcoin price forecast", "type": "financial"},
    {"query": "한국 경제 전망", "type": "news"},
    {"query": "AI 기술 트렌드", "type": "news"},
    {"query": "什么是人工智能", "type": "general"},
    {"query": "latest tech news", "type": "news"},
]

SAMPLE_DOMAINS = {
    "high_quality": [
        "react.dev", "docs.python.org", "developer.mozilla.org",
        "kubernetes.io", "docs.docker.com", "github.com",
        "stackoverflow.com", "arxiv.org", "nature.com",
        "wikipedia.org", "reuters.com", "bbc.com",
    ],
    "medium_quality": [
        "medium.com", "dev.to", "hashnode.com",
        "geeksforgeeks.org", "w3schools.com", "tutorialspoint.com",
        "freecodecamp.org", "realpython.com", "rust-lang.org",
    ],
    "low_quality": [
        "example.com", "test-blog.com", "random-site.org",
        "unknown-source.com", "spam-site.net", "fake-news.com",
    ],
}


def generate_synthetic_features(
    query: str,
    query_type: str,
    domain_tier: str,
    position: int,
    has_click: bool,
) -> List[float]:
    """합성 피처 벡터 생성"""
    features = [0.0] * NUM_FEATURES
    
    # Query features
    features[0] = min(1.0, len(query) / 100)  # q_len
    features[1] = min(1.0, len(query.split()) / 10)  # q_terms
    features[2] = 1.0 if '?' in query else 0.0  # q_has_question
    features[3] = 1.0 if any(c.isdigit() for c in query) else 0.0  # q_has_number
    features[4] = 1.0 if any('\uac00' <= c <= '\ud7af' or '\u4e00' <= c <= '\u9fff' for c in query) else 0.0  # q_has_cjk
    
    # Document features
    if domain_tier == "high_quality":
        features[5] = random.uniform(0.6, 0.9)  # title_len
        features[6] = random.uniform(0.5, 0.9)  # content_len
        features[7] = random.uniform(0.6, 0.9)  # snippet_len
        features[8] = random.choice([0, 1])  # has_date
        features[9] = random.uniform(0.7, 1.0)  # date_recency
        features[10] = random.choice([0, 1])  # has_images
    elif domain_tier == "medium_quality":
        features[5] = random.uniform(0.4, 0.7)
        features[6] = random.uniform(0.3, 0.7)
        features[7] = random.uniform(0.4, 0.7)
        features[8] = random.choice([0, 0, 1])
        features[9] = random.uniform(0.5, 0.8)
        features[10] = random.choice([0, 1])
    else:
        features[5] = random.uniform(0.1, 0.4)
        features[6] = random.uniform(0.1, 0.3)
        features[7] = random.uniform(0.1, 0.3)
        features[8] = 0
        features[9] = random.uniform(0.1, 0.4)
        features[10] = 0
    
    # Query-document interaction
    if has_click:
        features[11] = random.uniform(0.6, 1.0)  # title_overlap
        features[12] = random.uniform(0.5, 0.9)  # content_overlap
        features[13] = random.uniform(0.6, 1.0)  # snippet_overlap
        features[14] = random.choice([0, 1])  # title_exact_match
        features[15] = random.uniform(0.5, 0.9)  # bm25_title
        features[16] = random.uniform(0.4, 0.8)  # bm25_content
        features[17] = random.uniform(0.4, 0.7)  # tfidf_avg
    else:
        features[11] = random.uniform(0.1, 0.5)
        features[12] = random.uniform(0.1, 0.4)
        features[13] = random.uniform(0.1, 0.5)
        features[14] = random.choice([0, 0, 0, 1])
        features[15] = random.uniform(0.1, 0.4)
        features[16] = random.uniform(0.1, 0.3)
        features[17] = random.uniform(0.1, 0.3)
    
    # Authority features
    if domain_tier == "high_quality":
        features[18] = random.uniform(0.2, 0.3)  # domain_authority
        features[19] = random.uniform(0.7, 0.9)  # domain_age_proxy
        features[20] = random.choice([0, 1])  # is_major_domain
    elif domain_tier == "medium_quality":
        features[18] = random.uniform(0.05, 0.15)
        features[19] = random.uniform(0.4, 0.7)
        features[20] = 0
    else:
        features[18] = random.uniform(0.0, 0.05)
        features[19] = random.uniform(0.1, 0.3)
        features[20] = 0
    
    # Position features
    features[21] = random.uniform(0.0, 0.3)  # result_source
    features[22] = min(1.0, position / 10)  # result_position
    features[23] = 1.0 if query_type == "news" else 0.0  # is_news_source
    features[24] = 1.0 if query_type == "academic" else 0.0  # is_academic_source
    
    # Context features
    type_map = {"general": 0, "academic": 1, "news": 2, "financial": 3, "technical": 4, "factual": 5}
    features[25] = type_map.get(query_type, 0) / 5  # query_type_num
    features[26] = 1.0 if query_type == "news" else 0.0  # is_news
    features[27] = 1.0 if query_type == "financial" else 0.0  # is_finance
    features[28] = features[4]  # korean
    features[29] = 1.0 if '\u4e00' <= query[0] <= '\u9fff' and features[4] else 0.0  # chinese
    
    # User features
    features[30] = random.choice([0, 0, 0, 1])  # user_visited
    features[31] = random.uniform(0.0, 0.3) if features[30] == 0 else random.uniform(0.3, 0.8)  # user_visits_norm
    
    return features


def generate_synthetic_training_data(num_queries: int = 200, results_per_query: int = 10) -> List[Dict]:
    """합성 학습 데이터 생성"""
    training_data = []
    
    for i in range(num_queries):
        sample = random.choice(SAMPLE_QUERIES)
        query = sample["query"]
        query_type = sample["type"]
        
        group_id = f"synthetic_{i:04d}"
        
        # 각 쿼리에 대해 10개 결과 생성
        for j in range(results_per_query):
            position = j + 1
            
            # 도메인 품질 결정 (상위 결과일수록 고품질)
            if j < 3:
                domain_tier = "high_quality"
                click_prob = 0.7 if j == 0 else (0.5 if j == 1 else 0.3)
            elif j < 7:
                domain_tier = "medium_quality"
                click_prob = 0.15
            else:
                domain_tier = "low_quality"
                click_prob = 0.05
            
            # 클릭 여부 결정
            has_click = random.random() < click_prob
            
            # 피처 생성
            features = generate_synthetic_features(
                query, query_type, domain_tier, position, has_click
            )
            
            training_data.append({
                "group": group_id,
                "query": query,
                "url": f"https://{random.choice(SAMPLE_DOMAINS[domain_tier])}/page/{j}",
                "position": position,
                "features": features,
                "label": 1 if has_click else 0,
            })
    
    return training_data


# ─── LightGBM 학습 ──────────────────────────────────────

def train_lightgbm(training_data: List[Dict]) -> Dict:
    """LightGBM LambdaRank 학습"""
    try:
        import lightgbm as lgb
    except ImportError:
        print("❌ lightgbm 미설치. 설치: pip install lightgbm")
        return {"error": "lightgbm not installed"}
    
    # 그룹별로 분리
    groups = {}
    for item in training_data:
        group = item["group"]
        if group not in groups:
            groups[group] = []
        groups[group].append(item)
    
    # 2개 이상 결과가 있는 그룹만 사용
    valid_groups = {g: items for g, items in groups.items() if len(items) >= 2}
    
    if len(valid_groups) < 2:
        return {"error": "need >=2 groups with >=2 items each"}
    
    # 데이터 준비
    X = []
    y = []
    group_sizes = []
    
    for items in valid_groups.values():
        group_sizes.append(len(items))
        for item in items:
            X.append(item["features"])
            y.append(item["label"])
    
    X = np.array(X, dtype=np.float64)
    y = np.array(y, dtype=np.int32)
    
    # LightGBM 학습
    params = {
        "objective": "lambdarank",
        "metric": "ndcg",
        "learning_rate": 0.05,
        "num_leaves": 31,
        "min_data_in_leaf": 20,
        "feature_fraction": 0.9,
        "bagging_fraction": 0.9,
        "bagging_freq": 1,
        "verbose": -1,
    }
    
    train_set = lgb.Dataset(
        X, label=y, group=group_sizes, feature_name=FEATURE_NAMES
    )
    
    model = lgb.train(
        params, train_set, num_boost_round=150
    )
    
    # 모델 저장
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    model_path = MODEL_DIR / "ltr_model_v2.txt"
    model.save_model(str(model_path))
    
    # 피처 중요도
    importance = model.feature_importance(importance_type="gain")
    feature_importance = sorted(
        zip(FEATURE_NAMES, importance), key=lambda x: -x[1]
    )
    
    # 검증 (간단한 NDCG 계산)
    predictions = model.predict(X)
    
    return {
        "trained": True,
        "samples": len(X),
        "groups": len(valid_groups),
        "model_path": str(model_path),
        "feature_importance": feature_importance[:10],
        "ndcg_estimate": calculate_ndcg(predictions, y, group_sizes),
    }


def calculate_ndcg(predictions: np.ndarray, labels: np.ndarray, group_sizes: List[int]) -> float:
    """간단한 NDCG@10 계산"""
    ndcg_scores = []
    idx = 0
    
    for size in group_sizes:
        group_pred = predictions[idx:idx+size]
        group_label = labels[idx:idx+size]
        idx += size
        
        # 상위 10개만 사용
        top_k = min(10, size)
        top_indices = np.argsort(-group_pred)[:top_k]
        top_labels = group_label[top_indices]
        
        # NDCG 계산
        dcg = sum((2**l - 1) / math.log2(i + 2) for i, l in enumerate(top_labels))
        
        # 이상적 DCG
        ideal_labels = sorted(group_label, reverse=True)[:top_k]
        idcg = sum((2**l - 1) / math.log2(i + 2) for i, l in enumerate(ideal_labels))
        
        if idcg > 0:
            ndcg_scores.append(dcg / idcg)
    
    return sum(ndcg_scores) / len(ndcg_scores) if ndcg_scores else 0


# ─── 메인 ──────────────────────────────────────────────

def main():
    print("🚀 LTR v2 모델 학습")
    print("=" * 60)
    
    # 1. 합성 데이터 생성
    print("\n📊 합성 클릭 피드백 데이터 생성...")
    training_data = generate_synthetic_training_data(num_queries=200, results_per_query=10)
    
    print(f"   생성된 학습 데이터:")
    print(f"     - 전체 샘플: {len(training_data)}개")
    print(f"     - 클릭(양성): {sum(1 for d in training_data if d['label'] == 1)}개")
    print(f"     - 비클릭(음성): {sum(1 for d in training_data if d['label'] == 0)}개")
    print(f"     - 고유 쿼리: {len(set(d['query'] for d in training_data))}개")
    print(f"     - 고유 그룹: {len(set(d['group'] for d in training_data))}개")
    
    # 학습 데이터 저장
    TRAINING_DATA_DIR.mkdir(parents=True, exist_ok=True)
    training_file = TRAINING_DATA_DIR / "synthetic-training-data.json"
    with open(training_file, "w") as f:
        json.dump(training_data, f, indent=2)
    print(f"     - 저장: {training_file}")
    
    # 2. LightGBM 학습
    print("\n🏋️ LightGBM LambdaRank 학습...")
    result = train_lightgbm(training_data)
    
    if "error" in result:
        print(f"   ❌ 학습 실패: {result['error']}")
        return
    
    print(f"   ✅ 학습 성공!")
    print(f"     - 샘플: {result['samples']}개")
    print(f"     - 그룹: {result['groups']}개")
    print(f"     - 모델 경로: {result['model_path']}")
    print(f"     - 추정 NDCG@10: {result['ndcg_estimate']:.4f}")
    
    # 3. 피처 중요도
    print("\n📈 피처 중요도 (상위 10개):")
    for name, score in result["feature_importance"]:
        print(f"   {name:25s}: {score:.4f}")
    
    # 4. 모델 메타데이터
    metadata = {
        "version": "v2.0",
        "trained_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "num_features": NUM_FEATURES,
        "feature_names": FEATURE_NAMES,
        "training_stats": {
            "total_samples": result["samples"],
            "total_groups": result["groups"],
            "estimated_ndcg": result["ndcg_estimate"],
        },
        "lightgbm_params": {
            "objective": "lambdarank",
            "metric": "ndcg",
            "learning_rate": 0.05,
            "num_leaves": 31,
            "num_boost_round": 150,
        },
    }
    
    metadata_file = MODEL_DIR / "model-metadata.json"
    with open(metadata_file, "w") as f:
        json.dump(metadata, f, indent=2)
    
    print(f"\n✅ 모델 메타데이터 저장: {metadata_file}")
    
    # 5. LightGBM 모델을 JSON으로도 내보내기 (sidecar용)
    try:
        import lightgbm as lgb
        model_json = MODEL_DIR / "ltr_model_v2.json"
        model = lgb.Booster(model_file=str(MODEL_DIR / "ltr_model_v2.txt"))
        model.dump_model(str(model_json))
        print(f"✅ 모델 JSON 내보내기: {model_json}")
    except Exception as e:
        print(f"⚠️ JSON 내보내기 실패 (무시 가능): {e}")
    
    print("\n" + "=" * 60)
    print("✅ LTR v2 모델 학습 완료!")
    print("=" * 60)

if __name__ == "__main__":
    main()
