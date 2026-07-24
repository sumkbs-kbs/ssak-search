## 응답 시간 15초 → 3초 단축 계획

### 병목 원인 (확인 완료)

```
현재: 1.5s(검색) → 5s(답변) → 3s(지식패널) → 2s(이미지) = ~12-15초 (직렬)
목표: 1.5s(검색) → max(5s 답변, 3s 지식패널, 2s 이미지) = ~6.5초 → 캐시 시 <100ms
```

핵심 문제: 답변 생성, 지식패널, 이미지 매칭이 **서로 독립적인데도 순차 실행**되고 있음.

### 작업 1: 독립 단계 병렬화 (orchestrator.ts)
답변 생성(step 10), 지식패널(step 13), 이미지 대기(step 14)를 `Promise.all`로 병렬화. 이미지는 이미 step 3에서 시작됨. 답변과 지식패널만 병렬로 시작하 됨.

### 작업 2: OpenRouter fetch 타임아웃 추가 (llm-router.ts)
`generateOpenRouterAnswer`에 `AbortSignal.timeout(10000)` 추가. 현재 무한 대기.

### 작업 3: 답변 생성 타임아웃 캡 (answer.ts)
generateAnswer 래퍼에 12초 상한. 초과 시 extractive fallback.

### 작업 4: 인기 한국어 금융 쿼리 사전 캐싱 (cron)
상위 20개 한국 주식 쿼리를 Cloudflare Cron Trigger로 5분마다 워밍.

### 예상 효과
- 첫 요청: 15s → ~6s
- 캐시 히트: <100ms