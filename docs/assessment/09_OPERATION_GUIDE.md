# 09 — 운영 가이드 (Operation Guide)

> 작성일: 2026-08-23 | 심층 운영 문서는 기존 자산 참조: [SLO.md](../../SLO.md) · [AUDIT.md](../../AUDIT.md) · [MONITORING_GUIDE.md](../../MONITORING_GUIDE.md) · [DEPLOYMENT_CHECKLIST.md](../../DEPLOYMENT_CHECKLIST.md)

## 설치·실행 (로컬)

```bash
npm install
npm run start:local        # 빌드 + DO워커(8787) + pages dev(8788) 자동 기동 — 권장
curl localhost:8788/api/health   # status:"ok", rate_limiter.mode:"durable_object"
# 검색 API 키: .dev.vars의 SEARCH_API_KEY (로컬) / wrangler pages secret put (운영)
```

⚠️ PM2 단독 실행은 DO 워커(`npx wrangler dev -c wrangler.do.jsonc --port 8787`) 선행 필요 — 없으면 /api/* 500.

## 설정

- 바인딩: AI(Workers AI)·RATE_LIMITER 등 DO·D1·Vectorize·KV·ANALYTICS — `wrangler.jsonc` 참조
- 시크릿: SEARCH_API_KEY/JINA_API_KEY는 Pages Secrets, CACHE_TTL_* 는 Variables
- 환경변수 예제: [.env.example](../../.env.example)

## 배포

```bash
npm run deploy             # build + wrangler pages deploy
# 배포 검증: /api/health의 build_commit 확인 + scripts/verify-do-binding.sh
```

## 모니터링

- Prometheus: `GET /api/metrics` (회로차단기·지연·CPU 예산 게이지)
- 영속 메트릭: Analytics Engine `ssak_search`(SQL API 질의법은 README §Analytics)
- 헬스 자동감시: `.github/workflows/monitor.yml`(15분 주기, Slack/PagerDuty)
- 파서 회귀: `/api/canary` (카나리 활성화 권장 — 현재 기본 off)

## 장애 대응 (런북 요약)

| 증상 | 1차 확인 | 조치 |
|---|---|---|
| /api/* 전면 500 | DO 워커 프로세스 존재? (`lsof -i :8787`) | start-local 재실행 또는 DO 워커 수동 기동 |
| 특정 백엔드 0건 | /api/metrics 회로차단기 상태 | resetTimeout(20s) 경과 대기 — 자동 half-open |
| wikipedia 부재 | 미러 폴백 로그(`recovered wikipedia gold`) | 429 창 경과 대기, mirror-still-lost 지속 시 S35 점검 |
| 지연 급등 | p95 vs SLO, lightweight 모드 여부 | 보호 백엔드 드레인 예산 재조정(02 문서 §5) |

## 롤백

```bash
npx wrangler pages deployment list --project-name=search-engine-api
npx wrangler pages deployment rollback <deployment-id>
```

- 롤백 후: /api/health build_commit 확인 + `npm run eval -- --summary --runs 3`로 품질 회귀 여부 기록
