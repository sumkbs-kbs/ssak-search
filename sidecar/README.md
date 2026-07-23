# Scrapling Sidecar — FastAPI + Scrapling 적응형 웹 스크래핑 서비스

Python 기반 마이크로서비스로, Cloudflare Workers webapp이 처리하기 어려운
**동적 페이지**, **Cloudflare 보호 페이지**, **JS 렌더링 콘텐츠**를 Scrapling으로 스크래핑합니다.

## 아키텍처

```
webapp (Workers) ──fetch──▶ Sidecar (Python FastAPI + Scrapling)
                                  │
                                  ├─▶ StealthyFetcher (anti-bot bypass)
                                  ├─▶ DynamicFetcher (JS rendering)
                                  ├─▶ Standard Fetcher (fast HTTP)
                                  └─▶ httpx fallback
```

## 설치 및 실행

### Option 1: Docker (권장)

```bash
cd sidecar
docker compose up -d
```

### Option 2: 로컬 Python

```bash
cd sidecar

# 가상환경 생성
python -m venv venv
source venv/bin/activate  # Windows: venv\Scripts\activate

# 설치
pip install -r requirements.txt
pip install "scrapling[fetchers]"
scrapling install  # 브라우저 다운로드

# 실행
cp .env.example .env
python -m app.main
```

## API 엔드포인트

### `POST /scrape` — 적응형 웹 스크래핑

```json
{
  "url": "https://finance.naver.com/item/main.naver?code=005930",
  "css_selector": ".no_today",
  "adaptive": false,
  "auto_save": false,
  "headless": true,
  "solve_cloudflare": false
}
```

### `POST /extract` — 콘텐츠 추출 (extractor.ts 대체)

```json
{
  "url": "https://example.com/article",
  "max_tokens": 4000,
  "include_images": false
}
```

### `POST /stock/naver` — Naver Finance 주식 데이터

```json
{
  "query": "삼성전자 주가",
  "include_chart": false,
  "include_financials": false
}
```

### `GET /health` — 상태 확인

```json
{
  "status": "ok",
  "scrapling_version": "1.5+",
  "fetchers_available": true,
  "browsers_installed": true,
  "uptime_seconds": 123.4
}
```

## webapp 연동

webapp에서 sidecar를 사용하려면 환경변수 `SIDECAR_URL`을 설정하세요:

```bash
# wrangler pages dev 실행 시
SIDECAR_URL=http://localhost:8000 npx wrangler pages dev --port 8788 dist

# 프로덕션 (Cloudflare Pages secret)
npx wrangler pages secret put SIDECAR_URL
```

설정 시 webapp의 extractor.ts가 sidecar를 우선 호출하고,
실패 시 기존 HTMLRewriter/Jina 폴백으로 동작합니다.
