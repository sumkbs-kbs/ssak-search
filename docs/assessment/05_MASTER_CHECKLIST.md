# 05 — 마스터 체크리스트 (Master Checklist)

> 작성일: 2026-08-23 | 상태: [x] 완료·검증됨 · [~] 일부 구현/추가 검증 필요 · [ ] 미구현 · [!] 문제 발견(조치됨) · [?] 확인할 자료 부족
> 전체 변경 근거는 [08_CHANGELOG.md](08_CHANGELOG.md)

## 프로젝트 실행
- [x] 의존성 설치·빌드(npm ci/build) — typecheck 0에러
- [x] 로컬 기동 절차 — `start:local`(DO 워커 자동 기동, FIX-2)
- [x] 헬스체크·검색 실호 — /api/health 200, KR/EN 검색 실측
- [!] README/PM2 단일 프로세스 기동 시 500 — FIX-2+문서로 해소(잔여: PM2 경로 자동화 없음)

## 요구사항 / 코드 구조
- [x] Tavily 호환 API 계약(search/extract/images/news/suggest/research)
- [~] 전략 패턴 라우팅(strategies/) — academic 보호 정책은 EVAL-1로 원복, 재평가 과제
- [~] 오케스트레이터 모듈화 — TieredFanout 도입됨, 레거시 fanout.ts 데드 코드 잔존

## 검색 소스 / 질의 분석
- [x] 백엔드 다양성(bing/naver/ddg/wiki/github/hn/reddit/arxiv/rss/searxng)
- [x] 질의 타입·언어 감지(detectQueryType) — 4종 쿼리 분류 실측 확인
- [~] zh/ja 커뮤니티 소스(qiita/juejin/csdn/baidu) — tier 매핑 추가됨(FIX-3), 개별 품질 미실측

## 크롤링 / 콘텐츠 추출
- [~] 스크래핑 회복력 — circuit breaker 실측, bing 차단 시 미러 폴백 동작
- [!] DBpedia 미러 무관 결과 오염 — filterMirrorResults 게이트로 완화(B-7), CJK 고도화 여지
- [ ] robots.txt 준수 로직 — 스크래핑 백엔드에 미구현(ToS 검토 과제)

## 인덱싱 / 랭킹
- [x] D1+Vectorize 하이브리드 인덱스 바인딩 — health confirmed
- [x] 도메인 authority/quality 스코어링 — FIX-4 포함, 랭킹 테스트 78개 통과
- [~] LTR v2 — 경량 모드에서 로컬 폴백(full 모드 품질 기여도 미실측)

## AI 답변 생성 / 출처 검증
- [~] Workers AI 답변 + 인라인 인용 UI — 코드/UI 존재, 인용-원문 일치 검증은 미실시
- [~] 프롬프트 인젝션 방어(answer 경로) — 심층 감사 필요(06 문서 참조)

## 다국어 / 성능
- [x] CJK 바이그램·교차언어 패널티·mkt=zh-CN — README 이력 + eval 태그 커버
- [~] 성능 — p50 1599ms 양호, p95 4423ms SLO 대조 필요(BL-3)

## 안정성 / 보안 / 개인정보
- [x] 서킷브레이커·재시도·부분 결과 반환 — 실측
- [x] SSRF 가드(assertSafeFetchUrl)·입력 크기 제한 — v2.0 이력 + 테스트 존재
- [x] 감사로그(AUDIT_SECURITY) — 라이브 실측됨
- [x] auth_required 보고 정확화(FIX-1)
- [~] 클릭로그 DO 보존기간/삭제 경로 — PRIVACY_POLICY 대조 미실시

## 테스트 / 배포 / 모니터링
- [x] unit 3,063 / integration 134 / e2e 6 전부 통과
- [x] 공식 eval 재측정(921쿼리) + README 자동 섹션 갱신(B-9)
- [!] CI NDCG 게이트 FAIL(0.3567<0.65) — 선존재 격차, 조건 표준화 과제(BL-1)
- [x] 모니터링 — /api/metrics Prometheus + Analytics Engine 바인딩 확인
- [~] 카나리 — 구현됐으나 기본 off(HEALTH_CANARY_ENABLED)

## 문서화 / 사용자 경험 / 비용
- [x] 진단 문서 체계(docs/assessment/) — 본 세션 구축
- [~] UX 브라우저 실사용 — 미실시(playwright 검증 과제)
- [~] 비용 — 무료 원칙 고수, subrequest 한계 문서화됨

## 상용화 준비
- [~] 최종 판정: 조건부 가능 — BL-1~3(게이트/WIP/p95-SLO) 해소 선행 ([10 문서](10_FINAL_READINESS_REPORT.md))
