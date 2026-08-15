#!/usr/bin/env python3
"""capture-webhook.py — 로컬 웹훅 캡처 서버 (수정 62)

GH Actions 알림 스텝(scripts/notify-pipeline-failure.sh)의 **드라이런** 검증용.
실 Slack 웹훅 URL 없이도, 알림 스크립트가 실제로 보내는 페이로드(JSON)를
로컬에서 캡처해 구조를 검증할 수 있다.

  # ① 캡처 서버 기동 (포트 기본 18080)
  python3 scripts/capture-webhook.py --port 18080

  # ② 다른 터미널에서 알림 스크립트 드라이런
  SLACK_DRY_RUN=1 bash scripts/notify-pipeline-failure.sh

  # ③ 캡처 서버 stdout 에 POST 본문이 출력됨 → 페이로드 구조 확인

POST 본문을 stdout 으로 출력하고 {"ok":true} + 200 을 반환한다 (Slack Incoming
Webhook 과 동일한 수락 시맨틱 — 200 = 메시지 수락).
"""
import argparse
import http.server
import sys


class CaptureHandler(http.server.BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        length = int(self.headers.get("Content-Length", 0) or 0)
        body = self.rfile.read(length).decode("utf-8", "replace")
        print(f"[capture] POST {self.path} Content-Type={self.headers.get('Content-Type', '')} {length}B", flush=True)
        print(body, flush=True)
        print("", flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(b'{"ok":true}')

    def log_message(self, *args: object) -> None:
        # 기본 access log 억제 (capture 라인만 남긴다)
        pass


def main() -> None:
    parser = argparse.ArgumentParser(description="로컬 웹훅 캡처 서버 — 알림 드라이런 검증")
    parser.add_argument("--port", type=int, default=18080, help="수신 포트 (기본 18080)")
    args = parser.parse_args()
    server = http.server.HTTPServer(("127.0.0.1", args.port), CaptureHandler)
    print(f"[capture-webhook] listening on http://127.0.0.1:{args.port} — Ctrl+C 로 종료", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[capture-webhook] 종료", flush=True)
        sys.exit(0)


if __name__ == "__main__":
    main()
