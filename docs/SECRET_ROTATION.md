# SECRET_ROTATION.md — 시크릿 사고 대응 절차

> 발견: 2026-08-27 — README.md에 read 스코프 프로덕션 API 키가 평문 커밋되어 있던 사고에 대한 정규 대응 절차.
> 원칙: **노출된 시크릿은 커밋 제거가 아니라 폐기(revoke) + 교체(rotate)로만 정리된다.** 문서에서 지우는 것은 조치가 아니다.

---

## 1. 즉시 폐기·무효화 (Revoke)

현재 운영 정책(2026-08-24 기준 README §1): 닫힌 모드 — 모든 `/api/*`에 Bearer 키 필요.

1. 노출 키가 유효한지 확인하면 안 된다(손상으로 간주). 즉시 폐기 대상.
2. 새 admin/write 키가 있다면 해당 키로 신규 read 키 발급:
   ```bash
   curl -X POST https://search-engine-api.pages.dev/api/keys \
     -H "Authorization: Bearer $ADMIN_KEY" \
     -H "Content-Type: application/json" \
     -d '{"name":"prod-read-rotated-2026-08-27","scope":"read"}'
   ```
3. 신규 키를 로컬 보관 위치에만 저장:
   ```bash
   mkdir -p ~/.ssak-search && chmod 700 ~/.ssak-search
   umask 077; echo '<NEW_KEY>' > ~/.ssak-search/api-key.txt
   ```
4. 사용부(`/api/*` 호출하는 스크립트, Hermes Agent 설정, CI secret)를 신규 키로 교체한 뒤, 구 키를 API 키 저장소(API_KEY_DO)에서 비활성화한다.

## 2. Git 히스토리 소거 (Purge history)

커밋 제거만으로는 히스토리에 문자열이 남는다. 리라이트가 필요하다.

- 스크립트: `scripts/purge-secret-from-history.sh` 사용(dry-run 기본).
```bash
bash scripts/purge-secret-from-history.sh            # dry-run — 계획만 출력
bash scripts/purge-secret-from-history.sh --confirm  # 실제 리라이트 실행
```
- 리라이트 후 원격 반영은 운영자 승인 하에만(공동 작업자가 없는 개인 리포 전제):
```bash
git push --force-with-lease origin main
git push --force-with-lease --tags
```
- 필수 사후 조치: GitHub에서 캐시된 뷰/PR diff 잔재 제거 요청(GitHub Support: "Sensitive data removal"), 오래된 CI artifact/logs에서 키 문자열 검색(`gh api .../actions/artifacts` 목록 확인), 본인 로컬 클론 외 존재하는 모든 클론 재클론 통보.

## 3. 재발 방지 (Prevent)

- **CI 게이트**: `.github/workflows/secrets-scan.yml` — gitleaks 전체 히스토리 스캔을 all push/PR에 강제.
- **로컬 프리커밋**(선택, 권장):
  ```bash
  pip install gitleaks           # 또는 brew install gitleaks
  gitleaks protect --staged      # 커밋 전 스테이징 스캔
  ```
- **보관 규칙**: 프로덕션 시크릿은 `~/.ssak-search/`(mode 700/600) 또는 Cloudflare Secrets 생성기 경로만. 리포·문서·이슈·로그에 절대 평문 삽입 금지. 문서에는 `sk-...REDACTED` 형식만 허용.
- **감사**: `AUDIT.md` 절차대로 인증 실패/비정상 사용 로그(401 급증, 미등록 키) 주기 검토.

## 4. 사고 타임라인 기록 (사후 템플릿)

| 항목 | 값 |
|---|---|
| 발견 시각 | 2026-08-27 (계획 리뷰 중) |
| 노출 경로 | README.md 프로덕션 배포 가이드 §1 |
| 스코프 | read (`/api/*` 읽기 호출 가능) |
| 폐기된 키 | read 스코프 키 1개(본 리포에 평문 기재 금지 — 패턴은 `scripts/purge-secret-from-history.sh` 참조) |
| 조치 | 문서 제거 → 회전 → 히스토리 소거 → 스캔 CI 도입 |
| 재발 방지 | gitleaks CI + 본 문서 절차 |
