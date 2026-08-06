# 09. 운영 가이드 (OPERATION GUIDE)

> 작성일: 2026-08-05 · **갱신: 2026-08-06** · 상세: README.md, UNIFIED_ROADMAP.md, SLO.md, AUDIT.md, DEPLOYMENT_CHECKLIST.md 참조

---

## 1. 설치
```bash
git clone <repo> && cd webapp
npm install
# sidecar (선택): BGE-Reranker/LightGBM/Ollama
docker compose -f sidecar/docker-compose.yml up -d
```

## 2. 로컬 실행
```bash
npm run typecheck          # 0 에러 게이트
npm test                   # 유닛 1,165건
npm run build              # dist/_worker.js
npm run preview            # wrangler pages dev (포트 8788)
# 또는 PM2
pm2 start ecosystem.config.cjs
curl http://localhost:3000/api/health
```

## 3. 환경 변수 / 시크릿
| 변수 | 용도 | 필수 |
|---|---|---|
| `SEARCH_API_KEY` | API 인증 (미설정 = open mode) | 배포 시 필수 |
| `TENANTS_CONFIG` | 멀티테넌트 키 JSON | 선택 |
| `JINA_API_KEY` | 추출 품질 | 선택 |
| `CACHE_TTL_GENERAL`/`CACHE_TTL_NEWS` | 캐시 TTL (기본 1800/300s) | 선택 |
| `SUBREQUEST_QUOTA_PER_REQUEST` | 서브리퀘스트 상한 (기본 50, paid 1000) | 선택 |
| `HEALTH_CANARY_ENABLED` | 캐나리 파서 회귀 감지 | 선택 |
| `SENTRY_DSN` | 오류 추적 | 선택 |
| `SIDECAR_RERANK_URL`/`SIDECAR_RERANK_TOKEN` | 자체 reranker | 선택 |
| `PAGERDUTY_ROUTING_KEY` | 백엔드 장애 알림 | 선택 |
| `ALERT_SLACK_WEBHOOK` | Slack 알림 (GitHub Secret) | 선택 |
| `CLOUDFLARE_API_TOKEN`/`ACCOUNT_ID` | 배포 | 배포 시 필수 |

## 4. 배포
```bash
npm run deploy   # build + wrangler pages deploy
# 필수 인프라 (Dashboard):
# 1) DO 8종 바인딩 (RATE_LIMITER 등) — verify-do-binding.sh
# 2) Analytics Engine 데이터셋 — verify-analytics-binding.ts
# 3) Vectorize (search-engine-dense, semantic-cache-dense) — 생성됨
# 4) D1, KV(CACHE_KV), R2, Queue(INDEX_QUEUE)
# 5) 배포 후 /api/health 필드 확인:
#    features.rate_limiter_do, analytics_engine, index.total_documents
```
> ✅ **현재 상태 (2026-08-06 재검증)**: 프로덕션 `https://search-engine-api.pages.dev` **가동 중 (HTTP 200)**.
> status는 `partial_outage`로 표시되나 이는 **키 미설정 brave의 false-positive가 원인**이었으며
> 2026-08-06 수정(선택적 백엔드 `unconfigured` 처리)으로 전역 상태가 `degraded`/`ok`로 정상화됩니다.
> 실제 잔여 인프라 작업: RATE_LIMITER/PAGES_DO 등 DO 바인딩 + open mode 해제 → **복구 체크리스트: docs/11_PRODUCTION_RECOVERY_CHECKLIST.md**

## 5. 모니터링
| 도구 | 용도 | 확인법 |
|---|---|---|
| `/api/health` | 백엔드·바인딩·인덱스 상태 | curl / 모니터 워크플로우 (15분) |
| `/api/metrics` | Prometheus (QPS·지연·회로·캐시) | Grafana/스크랩 |
| Analytics Engine | 영속 메트릭 (SQL API) | scripts/analytics-queries.sql |
| Sentry | 오류·성능 트레이스 | 대시보드 |
| Logpush | 구조화 로그 (DD 등) | AUDIT.md |
| GitHub Actions | eval 주간·모니터·부하 | Actions 탭 |
| Slack/PagerDuty | 장애 알림 | 워크플로우 설정 |

## 6. 장애 대응 런북
| 증상 | 1차 조치 | 확인 |
|---|---|---|
| 검색 전체 실패 | `/api/health` 확인 → 백엔드 차단 여부 | 회로 상태 |
| 특정 백엔드 0건 | canary 확인 → 마크업 변경 추정 → 스냅샷 갱신 | canary 이슈 |
| 레이트리밋 비정상 | DO 바인딩 여부 확인 (features.rate_limiter_do) | verify-do-binding |
| p95 상승 | 캐시 히트율·서브리퀘스트 로그 확인 | 메트릭 |
| AI 답변 실패 | 폴백 체인 (추출 요약) 동작 확인 | 응답 로그 |
| eval 회귀 | `npm run eval:ci` → 실패 쿼리 분석 | eval.yml 게이트 |

## 7. 롤백
- 배포 롤백: GitHub Actions redeploy 이전 커밋 (`workflow_dispatch`로 이전 SHA)
- 기능 롤백: A/B variant(control)로 LTR off, `ENABLE_AUTO_PRO` 미설정 유지
- 데이터 롤백: D1 백업 → 복원 (Cloudflare D1 export/import)
- 캐시 무효화: `invalidateCache` (admin) / TTL 자연 만료

## 8. 용량 관리
- 서브리퀘스트: 기본 depth(basic)는 추정 ~8, advanced/Pro는 30+ (free 50 한도) — **수치 실측 검증 필요** → paid tier 1000 권장
- 캐시: 메모리 500건 FIFO, KV TTL, 시맨틱 LRU 1,000건
- rate limit: IP 10/분, 키 30/분 (DO 필요)
- 부하: k6 8명 동시, p95 <3s 목표

## 9. 보안 운영
- 키는 Pages **Secret**(암호화)로만 — Variables 금지
- open mode 배포 금지 (SEARCH_API_KEY 필수)
- 감사 로그: Logpush로 보안 이벤트 송출 (AUDIT.md)
- 로그 보존 30일 권장 + 개인정보 삭제 정책 (P10)
