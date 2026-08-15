# 19. 알림 배선 검증 절차 가이드 (ALERT WIRING VERIFICATION)

> 작성일: 2026-08-15 · 근거: 수정 62(드라이런 캡처) · 수정 63(실 웹훅 E2E) · 수정 70(URL 주입 보안)

## 목적

staging 파이프라인 실패 Slack 알림의 **배선(전송 경로)을 검증하는 두 가지 절차**를
한 문서로 정리한다. 두 경로는 상호보완적이며, 상황에 따라 선택하거나 단계적으로
사용한다.

- **경로 A — 드라이런 캡처 (수정 62)**: 웹훅 URL이 **없어도** 알림 페이로드와
  전송 경로를 검증한다. 로컬 캡처 서버로 POST를 돌려 페이로드 구조를 실측.
- **경로 B — 실 웹훅 E2E (수정 63 + 70)**: 웹훅 URL **1개로** 시크릿 생성 →
  staging 디스패치 → 알림 발화까지 실제 Slack 수신을 종단 검증한다.

## 검증 대상 배선 구조

```
deploy.yml [13] Notify 스텝 (수정 51)
  └─ if: steps.equivalence.outcome == 'skipped' && !cancelled()
       └─ scripts/notify-pipeline-failure.sh (수정 62 — 인라인 로직 추출)
            ├─ 경로 A: SLACK_DRY_RUN=1 → 로컬 캡처 서버 (scripts/capture-webhook.py)
            └─ 경로 B: SLACK_WEBHOOK    → 실 Slack Incoming Webhook
```

- 알림 스텝은 **파이프라인 실패 시에만 발화**한다 (동치 대조가 skipped = 이전 단계
  실패). guard(무효 CF 토큰) 실패도 발화 대상이다.
- 페이로드 구조는 수정 51과 동일: `text` + `attachments[danger].blocks`.

## 검증 경로 선택 매트릭스

| 상황 | 권장 경로 | 검증 범위 |
|---|---|---|
| 웹훅 URL이 없다 (개발/CI 회귀) | **A — 드라이런 캡처** | 페이로드 구조 · 전송 코드 경로 (수신 불가) |
| 웹훅 URL이 있다 + repo admin 권한 | **B — 실 웹훅 E2E** | 시크릿 배선 · 디스패치 · **실 Slack 수신** |
| CI 회귀 방지 (항상) | `--self-test` (둘 다) | 오프라인 스텁 단언 — ci.yml deploy-selftest 잡에 등록됨 |

---

## 경로 A — 드라이런 캡처 (웹훅 불필요, 수정 62)

### 구성

| 파일 | 역할 |
|---|---|
| `scripts/notify-pipeline-failure.sh` | deploy.yml 인라인 알림 로직을 추출한 스크립트. `SLACK_DRY_RUN=1`이면 웹훅 대신 로컬 캡처 서버로 POST |
| `scripts/capture-webhook.py` | 로컬 웹훅 캡처 서버 — POST 본문을 stdout 출력 + `{"ok":true}` 200 (Slack 수락 시맨틱과 동일) |

### 절차

```bash
# ① 캡처 서버 기동 (포트 기본 18080)
python3 scripts/capture-webhook.py --port 18080

# ② 다른 터미널에서 알림 스크립트 드라이런
SLACK_DRY_RUN=1 bash scripts/notify-pipeline-failure.sh
```

### 기대 결과

- 캡처 서버 stdout에 **POST 본문(JSON 페이로드)이 출력**된다 — `text`/`danger`/
  `run: <run-id>` 구조를 직접 확인 (실측: 424B 페이로드 수신).
- 스크립트가 `✅ DRY-RUN 알림 전송됨 (캡처 서버)` + **exit 0**.
- 웹훅 URL이 전혀 필요 없으므로, 시크릿이 없는 환경에서도 전송 경로가 검증된다.

### Env

| 변수 | 기본값 | 의미 |
|---|---|---|
| `SLACK_DRY_RUN=1` | — | 웹훅 대신 캡처 서버로 POST |
| `SLACK_DRY_RUN_URL` | `http://127.0.0.1:18080/` | 드라이런 POST 대상 |
| `SLACK_WEBHOOK` | — | 실 웹훅 URL (미설정 + 드라이런 아님 → no-op) |
| `REPO` / `RUN_URL` | GITHUB_* | 페이로드의 저장소/실행 링크 |

### CI 회귀 차단

```bash
bash scripts/notify-pipeline-failure.sh --self-test   # 5/5 (가짜 curl)
```

ci.yml의 `deploy-selftest` 잡에서 자동 실행 — 드라이런 캡처/커스텀 URL/no-op/웹훅
POST 4경로 + self-test를 오프라인으로 단언한다.

---

## 경로 B — 실 웹훅 E2E (웹훅 URL 1개, 수정 63 + 70)

### 구성

`scripts/verify-slack-alert-e2e.sh` — 아래 6단계를 한 번에 실행한다.

| 단계 | 동작 |
|---|---|
| ① 사전 확인 | gh 인증(GH_TOKEN) · repo · 웹훅 URL 형식 (`https://hooks.slack.com/services/T…/B…/…`) |
| ② 웹훅 유효성 | 테스트 메시지 POST → **HTTP 200** (Slack 수락 확인) |
| ③ 시크릿 생성 | `gh secret set ALERT_SLACK_WEBHOOK` + `secret list`로 갱신 실측 |
| ④ staging 디스패치 | `gh workflow run deploy.yml -f environment=staging` + 배포 전 baseline과 **다른 새 run ID** 탐지 |
| ⑤ run 모니터링 | 완료까지 폴링(`--wait-min`, 기본 15분) → [13] Notify 스텝 로그에서 `✅ Slack 알림 전송됨 (danger)` 실측 |
| ⑥ 결과 보고 | 마커 발견 → ✅ / 파이프라인 성공 → **미발화(정상)** / 마커 부재 → exit 1 + 수동 확인 명령 |

### ⚠️ URL 주입 — 프로세스 인자로 전달 금지 (수정 70)

웹훅 URL은 채널 쓰기 권한을 부여하는 시크릿이다. `--url '<URL>'` argv 방식은 셸
히스토리/`ps`/감사 로그에 노출되므로 **제거됐다** (전달 시 거부 메시지).

**주입 경로 (우선순위 순) — 셋 다 argv에 URL이 남지 않는다:**

```bash
# ① env (권장)
SLACK_WEBHOOK_URL='<URL>' bash scripts/verify-slack-alert-e2e.sh

# ② 파일 (600 권한 권장)
bash scripts/verify-slack-alert-e2e.sh --webhook-file /path/to/webhook.txt

# ③ stdin 파이프
printf '%s' '<URL>' | bash scripts/verify-slack-alert-e2e.sh
```

내부적으로도 curl은 `-K <config>`의 `url = "…"` 지시어로 URL을 argv 밖에서
전달하고, 출력 시 URL은 마스킹된다 (`T01***…***123456`).

### 기타 옵션

```bash
bash scripts/verify-slack-alert-e2e.sh --webhook-file <경로> --dry-run  # 계획만 출력 (실 POST/시크릿/디스패치 없음)
bash scripts/verify-slack-alert-e2e.sh --self-test                       # 2/2 (가짜 gh/curl — 알림 전달→0 / 미발화→1)
```

`--self-test`는 ci.yml `deploy-selftest` 잡에도 등록되어 CI에서 회귀를 차단한다.

### 사전 조건

| 항목 | 필요 권한 |
|---|---|
| `GH_TOKEN` (또는 gh auth login) | `repo` + `workflow` 스코프 이상 |
| repo admin | 시크릿 생성 |
| 알림 수신 Slack 채널 | 웹훅이 붙은 채널 (사용자 육안 확인 — 수신 기록은 API로 읽기 불가) |

---

## 결과 해석

| 결과 | 의미 | 조치 |
|---|---|---|
| `✅ Slack 알림 전송됨 (danger)` 마커 | 알림 배선 **종단 검증 통과** | Slack 채널 수신만 육안 확인 |
| 파이프라인 성공 + 마커 부재 | 알림 스텝 **미발화(정상)** — 실패가 없어 알림 조건이 꺼져 있음 | 그대로 두면 됨 (실패 시에만 발화) |
| 파이프라인 실패 + 마커 부재 | 알림 전송 경로 결함 | exit 1 — 수동 확인 명령이 출력됨 |
| 캡처 서버에 POST 도착 | (경로 A) 전송 코드 경로 정상 | 페이로드 구조 확인 |

---

## 문제 해결

| 증상 | 원인/확인 |
|---|---|
| `--url` 거부 메시지 | 수정 70 이후 argv 주입은 의도적 차단 — env/파일/stdin으로 바꿔 주입 |
| ② 웹훅 유효성 200 아님 | URL 형식 오류 또는 웹훅 삭제/재생성 — Slack 앱 설정 확인 |
| ③ 시크릿 갱신 안 됨 | 토큰에 `repo` 스코프 부족 — PAT 교체 |
| ④ 디스패치 후 run ID 동일 | deploy.yml 존재/이름 확인 (`gh workflow list`) |
| ⑤ 폴링 타임아웃 | `--wait-min` 상향 — staging 배포는 ~10분+ 소요 가능 |
| ⑥ 파이프라인 성공인데 마커 부재 | **정상** — 알림은 실패 시에만 발화 (위 해석표 참조) |
| 경로 A 캡처 서버 미수신 | 포트 충돌 — `--port` 변경, 방화벽 확인 |

---

## 관련 수정 / 문서

| 항목 | 내용 |
|---|---|
| 수정 51 | deploy.yml Notify 스텝 추가 (일반 실패 알림 — 동치 대조 게이트 이전 단계 실패 커버) |
| 수정 62 | `notify-pipeline-failure.sh` 추출 + 드라이런 캡처 + `capture-webhook.py` (경로 A) |
| 수정 63 | `verify-slack-alert-e2e.sh` 종단 검증 (경로 B) |
| 수정 70 | URL 주입 보안 강화 (argv 제거 → env/파일/stdin + curl -K) |
| `docs/17_CLOUDFLARE_TOKEN_ROTATION.md` | guard 실패(무효 CF 토큰) — 알림 발화 시나리오의 실제 트리거 |

### 30초 요약

1. 웹훅 URL이 없으면 → **경로 A**: `capture-webhook.py` + `SLACK_DRY_RUN=1` (페이로드 검증)
2. URL이 있고 repo admin 권한이 있으면 → **경로 B**: `SLACK_WEBHOOK_URL` env로
   `verify-slack-alert-e2e.sh` (실 Slack 수신까지 종단)
3. CI 회귀는 항상 `--self-test` (ci.yml deploy-selftest 잡에서 자동 실행)
