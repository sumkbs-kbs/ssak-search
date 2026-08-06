# 03. 목표 아키텍처 (TARGET ARCHITECTURE)

> 작성일: 2026-08-05 · 현재 구조(Cloudflare Workers 단일 배포)를 유지하면서 확장·안정화하는 목표 설계

---

## 1. 전체 구성도 (Mermaid)

```mermaid
flowchart TB
    subgraph Client
        A1[웹 대시보드/채팅]
        A2[에이전트 Hermes/OpenAI SDK]
        A3[API 소비자]
    end

    subgraph Edge [Cloudflare Edge]
        GW[API Gateway<br/>Hono 라우팅 + CORS + 보안 헤더]
        AUTH[인증·권한 서비스<br/>API Key / 테넌트 / rate-limit DO]
        WAF[보안 필터<br/>SSRF DoH · 입력검증 · blacklist]
    end

    subgraph SearchCore [검색 코어]
        ORCH[검색 오케스트레이터<br/>single-flight · 캐시 · 폴백]
        QA[질의 분석기<br/>타입·언어·분해·엔티티]
        FAN[팬아웃 관리자<br/>subrequest 예산 · 타임아웃]
        RANK[랭킹 서비스<br/>BM25 · 권위 · 신선도 · LTR]
        DEDUP[중복 제거기]
        KG[지식그래프 패널]
    end

    subgraph Sources [검색 소스 어댑터 (무료)]
        S1[Naver/Bing/DDG 스크래퍼]
        S2[Wikipedia/arXiv/OpenAlex/Scholar]
        S3[GitHub/HackerNews/Reddit]
        S4[Yahoo Finance/Naver Finance]
        S5[뉴스 RSS / YouTube / 이미지]
    end

    subgraph OwnIndex [자체 인덱스]
        CR[웹 크롤러 DO<br/>robots.txt · sitemap · 폴리트니스]
        EX[콘텐츠 추출기<br/>HTMLRewriter → Jina 폴백]
        CL[문서 정제기 · 청커 · 중복탐지]
        IDX[(Vectorize + D1<br/>BM25 + RRF)]
        Q[인덱싱 큐]
    end

    subgraph AI [AI 계층]
        RR[재랭킹 서비스<br/>Workers AI + BGE sidecar]
        FA[사실 교차검증기]
        ANS[LLM 답변 생성기<br/>Workers AI → 추출 → DDG]
        CIT[인용 검증기<br/>llm-judge 배치]
    end

    subgraph Data [데이터]
        CACHE[(캐시: 메모리/CacheAPI/KV/시맨틱)]
        PROF[(사용자 프로필 DO)]
        EXP[(A/B 실험 DO)]
        LOG[(구조화 로그<br/>Analytics Engine · Logpush)]
        MET[(Prometheus 메트릭)]
    end

    A1 --> GW
    A2 --> GW
    A3 --> GW
    GW --> WAF --> AUTH
    AUTH --> ORCH
    ORCH --> QA
    ORCH --> FAN
    FAN --> S1 & S2 & S3 & S4 & S5
    FAN --> IDX
    ORCH --> CACHE
    ORCH --> DEDUP --> RANK
    RANK --> RR --> ANS
    QA --> FA
    FA --> CIT
    ANS --> GW
    RANK --> KG
    CR --> Q --> CL --> IDX
    CR --> EX
    ORCH --> PROF
    ORCH --> EXP
    GW --> LOG
    GW --> MET
```

## 2. 검색 요청 처리 흐름

```
1. 요청 → Gateway (보안 헤더, CORS, 입력 크기/도메인 수 검증)
2. 인증 (API Key / open mode) + 레이트 리밋 (DO 없으면 isolate 폴백)
3. 캐시 조회 (메모리 single-flight → Cache API → KV → 시맨틱) — news/finance 우회
4. 질의 분석 (타입/언어/분해/엔티티) → 서브쿼리
5. 팬아웃 (전략별 백엔드 병렬, subrequest 예산 내 shed)
6. 병합 → 중복 제거 → BM25+권위+신선도 랭킹 → LTR → rerank
7. 답변 생성 (Workers AI → 추출 요약 → DDG) + 인용/신뢰도
8. 응답 + 캐시 저장(fire-and-forget) + 메트릭/감사 로그
```

## 3. 데이터 수집·인덱싱 흐름
```
시드(API/크롤러/sitemap/검색결과 자동인덱스)
  → robots.txt 검사 → 크롤 → 본문 추출 → 정제·청킹
  → 중복 탐지 → 임베딩(Vectorize) + 원문(D1)
  → 4시간 재크롤링 + 중요도 기반 스케줄
```

## 4. 컴포넌트별 책임 (요약)
| 컴포넌트 | 현재 구현 | 목표 |
|---|---|---|
| API Gateway | Hono 라우팅, CORS, 보안 헤더 | 동일 + 요청 스키마 검증(zod) |
| 인증·권한 | 키/테넌트/rate-limit | **DO 바인딩 필수화**, 키 로테이션 |
| 검색 오케스트레이터 | orchestrator.ts | 멀티리전 대응, 폴백 정책 중앙화 |
| 질의 분석기 | understanding/* | 오탈자·동의어 사전 추가 |
| 소스 어댑터 | lib/*-search.ts | 어댑터 계약 표준화(health/회로 연동) |
| 크롤러 | crawler-do.ts | 일 1만 URL, 콘텐츠 유사도 중복 탐지 |
| 재랭킹 | retrieval/reranker.ts | 배포 실측 튜닝 |
| 사실 교차검증 | (부분) | **2+소스 주장 일치 검증 신설** |
| 인용 검증 | eval/llm-judge.ts | 런타임 인용-원문 매칭 |
| 캐시 | 4-tier | 히트율 메트릭 게이트 |
| 로그·모니터링 | logger/metrics/sentry | 대시보드 실측 + 알림 검증 |

## 5. 장애 대응 구조
- 백엔드 장애 → 서킷 브레이커(RateLimiterDO, 3단계 백오프) → 자동 폴백(DDG/추출요약)
- 파서 회귀 → canary 감지 → 자동 force-open + Slack/GitHub Issue
- 캐시 스탬피드 → single-flight (INFLIGHT_SEARCHES)
- 전체 백엔드 실패 → 404 + no_results (에이전트 계약)
- **멀티리전 장애** → 미구현 (D.3)

## 6. 확장 전략
1. **수평**: 멀티리전 배포(US+APAC) + Load Balancer geo-steering
2. **자체 인덱스**: 크롤러 스케일아웃, 1M URL → 검색 소스 독립성 확보
3. **subrequest 예산**: paid tier 1,000 또는 자체 인덱스로 외부 호출 감축 (27→10 목표)
4. **캐시 계층**: 시맨틱 캐시 히트율 30%+ → p95 <100ms
5. **랭킹**: LTR 7일 학습 → NDCG +5%

## 7. 보안 경계
- **Trust boundary 1 (Public→Edge)**: 입력 검증, rate limit, blacklist, SSRF DoH 검사
- **Trust boundary 2 (Edge→Backend)**: 크롤러 robots.txt 준수, URL 화이트리스트, 프롬프트 인젝션 콘텐츠 격리
- **Trust boundary 3 (Edge→AI)**: 검색 콘텐츠를 지시문과 분리, 시스템 프롬프트 불변
- 비밀: SEARCH_API_KEY 등은 Pages Secret(암호화)만 사용

## 8. 배포 구조
- 현재: GitHub Actions deploy → Cloudflare Pages (단일 리전)
- 목표: 2개 계정 배포 + LB + D1 read-replica + Vectorize 복제 (D.3)

## 9. 현재→목표 전환 방법
1. **즉시**: 프로덕션 헬스체크 복구 + DO 8종 Dashboard 바인딩 (P1/P2)
2. **1개월**: 백엔드 가용성 안정화 (P3/P8), CJK 커버리지 (P4), 골든셋 300+
3. **3개월**: 교차검증·인용검증 런타임화, 오탈자/동의어 사전
4. **6개월**: 멀티리전, LTR 실측, 크롤러 10만 URL
