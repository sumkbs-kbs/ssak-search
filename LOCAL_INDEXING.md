# 🏠 로컬 인덱싱 가이드

## 개요

ChromaDB + Ollama를 사용한 **완전 로컬 인덱싱 파이프라인**입니다.

### 장점

| 장점 | 설명 |
|------|------|
| **비용 $0** | 모든 것이 로컬에서 동작 |
| **오프라인** | 인터넷 불필요 |
| **빠름** | API 호출 없이 로컬 처리 |
| **프라이버시** | 데이터가 로컬에 저장 |
| **테스트 용이** | 빠른 개발/테스트 |

### 단점

| 단점 | 설명 |
|------|------|
| **리소스 사용** | CPU/메모리 필요 |
| **동기화 필요** | Cloudflare에 반영하려면 별도 동기화 |

---

## 빠른 시작

### 1. 환경 설정

```bash
# 자동 설정 (Docker + Ollama 설치/시작)
npm run local:setup

# 수동 설정
docker run -d --name chromadb -p 8000:8000 chromadb/chroma
ollama serve
ollama pull nomic-embed-text
```

### 2. 인덱싱

```bash
# 기술 문서 인덱싱
npm run local:index -- --category=tech

# 뉴스 사이트 인덱싱
npm run local:index -- --category=news

# Wikipedia 인덱싱
npm run local:index -- --category=wiki

# 모든 카테고리 인덱싱
npm run local:index -- --category=all

# URL 파일에서 인덱싱
npm run local:index -- --urls=urls.txt
```

### 3. 검색

```bash
# 검색
npm run local:search -- --search="react hooks"

# Top-K 지정
npm run local:search -- --search="react hooks" --top-k=5
```

### 4. 상태 확인

```bash
# 인덱스 상태
npm run local:stats
```

### 5. Cloudflare 동기화

```bash
# 로컬 인덱스를 Cloudflare로 동기화
npm run local:sync -- --api-url=https://search-engine-api.pages.dev

# Dry run
npm run local:sync -- --api-url=https://search-engine-api.pages.dev --dry-run
```

---

## 아키텍처

```
┌─────────────────────────────────────────────────────────┐
│                    로컬 인덱싱 구조                       │
├─────────────────────────────────────────────────────────┤
│                                                         │
│  URL/파일 → 로컬 인덱서 → ChromaDB (로컬 벡터 DB)       │
│               ↓              ↓                          │
│          Ollama 임베딩    검색 가능                       │
│          (nomic-embed)                                    │
│               ↓              ↓                          │
│          주기적 동기화 → Cloudflare (프로덕션)            │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

---

## 구성 요소

### 1. ChromaDB

**역할:** 로컬 벡터 데이터베이스

```bash
# 시작
docker run -d --name chromadb -p 8000:8000 chromadb/chroma

# 중지
docker stop chromadb

# 삭제
docker rm chromadb
```

### 2. Ollama

**역할:** 로컬 임베딩 모델

```bash
# 서버 시작
ollama serve

# 모델 다운로드
ollama pull nomic-embed-text  # 768차원, 270MB

# 모델 목록
ollama list
```

### 3. 로컬 인덱서

**역할:** 문서 수집 → 청킹 → 임베딩 → 저장

```typescript
// src/lib/local-indexing.ts
const service = new LocalIndexingService()
await service.initialize()
await service.indexDocument(doc)
const results = await service.search(query)
```

---

## 명령어 레퍼런스

| 명령어 | 설명 |
|--------|------|
| `npm run local:setup` | 로컬 환경 자동 설정 |
| `npm run local:index -- --category=tech` | 기술 문서 인덱싱 (URL만) |
| `npm run local:index -- --category=news` | 뉴스 인덱싱 (URL만) |
| `npm run local:index -- --urls=urls.txt` | URL 파일 인덱싱 |
| `npm run local:search -- --search="query"` | 검색 |
| `npm run local:stats` | 인덱스 상태 확인 |
| `npm run local:sync` | Cloudflare 동기화 |
| **v2 명령어** | **실제 콘텐츠 인덱싱** |
| `npm run local:v2:index -- --category=tech-docs` | 기술 문서 인덱싱 (실제 콘텐츠) |
| `npm run local:v2:index -- --category=programming` | 프로그래밍 인덱싱 |
| `npm run local:v2:index -- --category=science` | 과학 인덱싱 |
| `npm run local:v2:index -- --category=all` | 전체 카테고리 인덱싱 |
| `npm run local:v2:search -- --search="query"` | v2 검색 |
| `npm run local:v2:stats` | v2 인덱스 상태 |
| **뉴스 명령어** | **RSS 기반 뉴스 인덱싱** |
| `npm run news:index` | 전체 뉴스 인덱싱 |
| `npm run news:index:tech` | 기술 뉴스만 |
| `npm run news:index:kr` | 한국 뉴스만 |
| `npm run news:index:dry` | Dry run (확인만) |
| `npm run news:stats` | 뉴스 인덱스 상태 |
| `npm run news:cleanup` | 7일 이전 기사 정리 |
| **하이브리드 명령어** | **로컬 + Cloudflare 통합** |
| `npm run hybrid:search -- --search="query"` | 하이브리드 검색 |
| `npm run hybrid:benchmark` | 하이브리드 벤치마크 |
| **동기화 명령어** | **Cloudflare 동기화** |
| `npm run local:sync` | 로컬 인덱스 동기화 |
| `npm run news:sync` | 뉴스 인덱스 동기화 |

---

## 문제 해결

### ChromaDB 연결 실패

```bash
# 컨테이너 상태 확인
docker ps | grep chromadb

# 로그 확인
docker logs chromadb

# 재시작
docker restart chromadb
```

### Ollama 연결 실패

```bash
# 서버 상태 확인
curl http://localhost:11434/api/tags

# 서버 재시작
pkill ollama
ollama serve
```

### 임베딩 생성 실패

```bash
# 모델 확인
ollama list

# 모델 재다운로드
ollama pull nomic-embed-text
```

---

## 고급 설정

### 환경 변수

```bash
# ChromaDB URL
export CHROMA_URL=http://localhost:8000

# Ollama URL
export OLLAMA_BASE_URL=http://localhost:11434
```

### 커스텀 임베딩 모델

```typescript
const service = new LocalIndexingService({
  embeddingModel: 'all-minilm',  # 다른 모델 사용
})
```

### 클러스터 배포

```bash
# Docker Compose로 다중 인스턴스
version: '3.8'
services:
  chromadb:
    image: chromadb/chroma
    ports:
      - "8000:8000"
    volumes:
      - chromadb-data:/chroma/chroma
  
  ollama:
    image: ollama/ollama
    ports:
      - "11434:11434"
    volumes:
      - ollama-data:/root/.ollama

volumes:
  chromadb-data:
  ollama-data:
```

---

## 참고 자료

- [ChromaDB 문서](https://docs.trychroma.com/)
- [Ollama 문서](https://ollama.com/library/nomic-embed-text)
- [nomic-embed-text 모델](https://huggingface.co/nomic-ai/nomic-embed-text-v1)

---

*작성일: 2026-08-20*
