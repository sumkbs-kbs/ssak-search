# 🔌 Ssak-Search Model Context Protocol (MCP) 통합 가이드

본 문서는 **Hermes 3 (Nous Research), Claude Desktop, Cursor, Antigravity, OpenManus, CrewAI** 등의 AI 에이전트 환경에서 `ssak-search`를 표준 **MCP (Model Context Protocol)** 서버로 등록하고 연동하는 가이드입니다.

---

## 🌟 1. 제공되는 MCP 도구 목록

| 도구 이름 (Tool Name) | 주요 파라미터 | 설명 및 특징 |
|:---|:---|:---|
| `ssak_search` | `query` (필수), `max_results` (기본 5) | **평균 200~700ms 초저지연 실시간 웹 검색**<br>한국어(네이버/다음) 및 글로벌(빙/덕덕고) 지능형 병렬 레이스 및 조기 반환 적용 |
| `ssak_extract` | `url` (필수), `extract_depth`, `section_target`, `max_token_budget` | **4단계 스텔스 봇 우회 고밀도 본문 추출**<br>HTML 태그/스크립트 100% 제거, JSON-LD 제로-토큰 추출, 목차(TOC) 및 지정 챕터 온디맨드 필터링 |
| `ssak_deep_research` | `query` (필수), `max_sources` (기본 3), `max_token_budget_per_source` | **자율 심층 리서치 도구**<br>검색과 상위 URL 고밀도 본문 추출을 원샷으로 수행하여 LLM 합성용 컨텍스트 반환 |

---

## ⚙️ 2. 클라이언트별 설정 방법

### 1) Hermes 3 & Open Source Agent (`mcp_config.json`)
에이전트 설정 파일의 `mcpServers`에 등록합니다:
```json
{
  "mcpServers": {
    "ssak-search": {
      "command": "python3",
      "args": ["/Users/mr.k/Downloads/webapp/sdk/mcp_server.py"],
      "env": {
        "SSAK_API_BASE": "http://localhost:8787"
      }
    }
  }
}
```

### 2) Claude Desktop (`claude_desktop_config.json`)
- macOS 경로: `~/Library/Application Support/Claude/claude_desktop_config.json`
```json
{
  "mcpServers": {
    "ssak-search": {
      "command": "python3",
      "args": ["/Users/mr.k/Downloads/webapp/sdk/mcp_server.py"],
      "env": {
        "SSAK_API_BASE": "http://localhost:8787"
      }
    }
  }
}
```

### 3) Cursor IDE (`.cursor/mcp.json` 또는 Features 설정)
Cursor 설정의 MCP 탭에서 `Command` 타입으로 추가:
- **Name:** `ssak-search`
- **Command:** `python3 /Users/mr.k/Downloads/webapp/sdk/mcp_server.py`

---

## 🚀 3. 로컬 서버 선행 기동

MCP 서버(`sdk/mcp_server.py`)는 로컬에서 구동 중인 `ssak-search` 백엔드(`http://localhost:8787`)와 통신합니다.  
에이전트 사용 전 터미널에서 로컬 서버를 기동해 두세요:

```bash
# Ssak-Search 로컬 엔진 기동
npm run start:local
```

---

## 🧪 4. MCP 서버 자체 동작 테스트

별도의 클라이언트 없이도 CLI에서 즉시 테스트할 수 있습니다:

```bash
python3 -c "
import subprocess, json
proc = subprocess.Popen(['python3', 'sdk/mcp_server.py'], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
proc.stdin.write(json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {}}) + '\n')
proc.stdin.flush()
print(proc.stdout.readline())
"
```
